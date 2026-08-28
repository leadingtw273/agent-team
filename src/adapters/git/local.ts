import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, lstat, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path";

import type {
  AuthoritativeBranchHead,
  AuthoritativeBranchRequest,
  CreateWorktreeCommand,
  GitCommitCommand,
  GitCommitReceipt,
  GitCommitSnapshot,
  GitPort,
  GitPushReceipt,
  GitRepositoryRef,
  GitRepositorySnapshot,
  GitTextFileAtRevision,
  GitWorkingTreeChange,
  GitWorkingTreeSnapshot,
  GitWorktree,
  ReadGitTextFileCommand,
} from "../../application/ports/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type DomainErrorCode,
  type Result,
} from "../../domain/foundation/index.js";
import { repositoryRelativePathSchema } from "../../domain/project/index.js";
import {
  effectiveTreeDiffSchema,
  type EffectiveTreeChange,
  type GitFileMode,
  type GitObjectId,
} from "../../domain/review/index.js";
import type { MutationOptions, ReadOptions } from "../../application/ports/common.js";
import { runWithInProcessSerialization } from "../../infrastructure/files/index.js";

const defaultTimeoutMs = 30_000;
const defaultMaxOutputBytes = 64 * 1024 * 1024;
const revisionPattern = /^[^\u0000\r\n]{1,1024}$/u;
const remotePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;
const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/**
 * C015m (security-critical -- read this before touching `#run`, `#trustedWorktreeContext`, or
 * `#runOnWorktree`): a linked worktree's `.git` is a plain *file* (`gitdir: <path>`), not a
 * directory, and it lives inside the worktree directory the implementer's `Write(./*)`/
 * `Write(./**)` grant covers. A real Claude CLI 2.1.223 experiment (see C015m's Phase 1
 * diagnosis, `/home/markchou/.claude/jobs/6152588f/tmp/c015m-diagnose.md`) proved that
 * overwriting this one file to point at a self-built gitdir -- entirely buildable using nothing
 * but the implementer's own already-granted Write access inside the worktree -- lets a
 * `core.hooksPath`/`core.fsmonitor` entry in that attacker-built gitdir's own config execute
 * arbitrary code with this process's own OS privileges, the moment *any* subsequent `git`
 * command (including a plain read-only `git status`) resolves its repository via the normal
 * "look at cwd's `.git`" discovery mechanism -- `git status`/`git add` don't trigger vanilla
 * hooks, but `git commit`/`git push` do (both were reproduced actually executing attacker code),
 * and `core.fsmonitor` alone makes even `git status` a live RCE. `git status` never reports the
 * `.git` file's own tampering, and a `.gitignore` entry hides the whole fake-gitdir footprint
 * from every existing scope/preflight check -- there is no existing safeguard that would have
 * caught this.
 *
 * A follow-up review (see `/home/markchou/.claude/jobs/6152588f/tmp/codex-c015m-review.log`)
 * proved the originally-proposed fix (env sanitization + a `hooksPath`/`fsmonitor` denylist
 * alone) is insufficient: it is a "guess every dangerous config key" denylist against git's
 * entire config-driven execution surface (`credential.helper`, `core.sshCommand`,
 * `include.path`, ...), and every single one of `LocalGitAdapter`'s methods that used
 * `worktree.path` as `cwd` was still individually vulnerable, because cwd-based repository
 * *discovery* itself is what reads the untrusted `.git` file in the first place.
 *
 * The fix implemented here is the one the review confirmed as the actual root-cause closure:
 * repository identity for any given worktree is *never* discovered from the worktree's own
 * `.git` file. Instead, `#trustedWorktreeContext` re-derives the worktree's real, private gitdir
 * straight from the *main* repository's own `<common-dir>/worktrees/<name>/gitdir` bookkeeping
 * file -- a location the implementer's Write/Edit grant can never reach, because it lives
 * entirely outside the worktree directory that grant is scoped to -- and every subsequent git
 * subprocess for that worktree is invoked with an *explicit* `--git-dir=<trusted>
 * --work-tree=<trusted>`, which the official git documentation confirms disables repository
 * discovery entirely: https://git-scm.com/docs/git#Documentation/git.txt---git-dirltpathgt .
 * This was verified empirically (isolated sandbox, real git 2.43.0): with the tampered `.git`
 * still in place (self-built gitdir, malicious `core.fsmonitor` *and* `hooks/pre-commit`),
 * passing an explicit `--git-dir`/`--work-tree` to `status`/`add`/`commit` never triggers either
 * payload -- git never even opens the tampered `.git` file.
 *
 * `-c core.hooksPath=/dev/null`/`-c core.fsmonitor=false`/`--no-pager` (see `gitHardenFlags`
 * below) and the minimized, `GIT_*`-stripped `env` (see `#run`) are kept as an explicit *second*
 * layer of defense-in-depth -- not because they are believed necessary once every call is routed
 * through an explicit trusted `--git-dir`, but because a bug in the trust-resolution logic itself
 * should not immediately become an RCE. Do not remove either layer independently; do not add a
 * new `LocalGitAdapter` method that calls `#run` with a bare `worktree.path` as `cwd` without
 * going through `#runOnWorktree` -- that reopens exactly this hole.
 */
const gitHardenFlags: readonly string[] = Object.freeze([
  "--no-pager",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
]);

/** Every `GIT_*` environment variable is git's own control surface (repository location,
 * transport, credentials, config sources, ...). `LocalGitAdapter` must never let whatever
 * happens to be inherited in `process.env` decide any of that -- see the header comment above for
 * why. This strips every inherited `GIT_*` key (case-sensitive: that is git's own convention) so
 * `#run`'s explicit overrides are the only `GIT_*` values that can ever reach the child process. */
function withoutInheritedGitEnv(source: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const filtered: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith("GIT_")) filtered[key] = value;
  }
  return filtered;
}

interface TrustedWorktreeContext {
  readonly gitDir: string;
  readonly workTree: string;
}

/** C015m: a single, module-level (never per-instance) exit listener that cleans up every safe
 * global config directory any `LocalGitAdapter` instance in this process has created -- avoids
 * accumulating one `process.once("exit", ...)` listener per instance (a real
 * `MaxListenersExceededWarning` this file's own test suite tripped during development, since
 * many short-lived adapter instances are created in a single test-runner process; production's
 * one-adapter-per-CLI-invocation shape would not have hit the warning threshold, but the
 * unbounded-listener pattern was still worth fixing outright). */
const safeGlobalConfigDirectoriesPendingCleanup = new Set<string>();
let safeGlobalConfigCleanupRegistered = false;

function scheduleSafeGlobalConfigCleanup(directory: string): void {
  safeGlobalConfigDirectoriesPendingCleanup.add(directory);
  if (safeGlobalConfigCleanupRegistered) return;
  safeGlobalConfigCleanupRegistered = true;
  process.once("exit", () => {
    for (const pending of safeGlobalConfigDirectoriesPendingCleanup) {
      try {
        rmSync(pending, { recursive: true, force: true });
      } catch {
        // best-effort only -- see #buildSafeGlobalConfig's own comment.
      }
    }
  });
}

/** C015m: parses `git worktree list --porcelain` output (run against the *main* repository,
 * never against the worktree itself) and reports whether one of its `worktree <path>` lines,
 * canonicalized, matches the given canonical worktree path exactly. */
async function worktreeListedAt(porcelain: string, workTree: string): Promise<boolean> {
  const listed = porcelain
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
  for (const path of listed) {
    if ((await canonicalPath(path)) === workTree) return true;
  }
  return false;
}

interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface LocalGitAdapterOptions {
  readonly executable?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

function failure<Value>(code: DomainErrorCode): Result<Value, DomainError> {
  return err(domainError(code));
}

function mutationAllowed(options: MutationOptions): boolean {
  return options.idempotencyKey.trim().length > 0;
}

function commandError(error: unknown, stderr: string): DomainError {
  if (typeof error === "object" && error !== null) {
    const name = "name" in error ? error.name : undefined;
    const code = "code" in error ? error.code : undefined;
    const killed = "killed" in error ? error.killed : undefined;
    if (name === "AbortError") return domainError("interrupted");
    if (code === "ENOENT") return domainError("unavailable");
    if (killed === true) return domainError("timeout");
  }
  const normalized = stderr.toLowerCase();
  if (normalized.includes("not a git repository") || normalized.includes("does not exist")) {
    return domainError("not_found");
  }
  if (
    normalized.includes("permission denied") ||
    normalized.includes("authentication failed") ||
    normalized.includes("could not read username") ||
    normalized.includes("publickey")
  ) {
    return domainError("permission_denied");
  }
  if (
    normalized.includes("already exists") ||
    normalized.includes("already checked out") ||
    normalized.includes("non-fast-forward") ||
    normalized.includes("would be overwritten") ||
    normalized.includes("has modifications") ||
    normalized.includes("contains modified or untracked files")
  ) {
    return domainError("conflict");
  }
  return domainError("external_failure");
}

function validAbsolutePath(path: string): boolean {
  return (
    path.length > 1 &&
    path.length <= 4096 &&
    isAbsolute(path) &&
    normalize(path) === path &&
    !path.includes("\u0000")
  );
}

function isDescendant(parent: string, candidate: string): boolean {
  return candidate.startsWith(`${parent}${sep}`);
}

async function canonicalPath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

async function canonicalFuturePath(path: string): Promise<string | undefined> {
  if (!validAbsolutePath(path)) return undefined;
  const existing = await canonicalPath(path);
  if (existing !== undefined) return existing;
  const parent = await canonicalPath(dirname(path));
  return parent === undefined ? undefined : join(parent, basename(path));
}

function validRelativePath(path: string): boolean {
  const parsed = repositoryRelativePathSchema.safeParse(path);
  return parsed.success && parsed.data === path;
}

function validRevision(revision: string): boolean {
  return revisionPattern.test(revision) && !revision.startsWith("-");
}

function safeRemoteUrl(value: string): boolean {
  if (validAbsolutePath(value)) return true;
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\u0000\r\n]+$/u.test(value)) return true;
  try {
    const url = new URL(value);
    if (url.protocol === "https:") {
      return url.username === "" && url.password === "";
    }
    return url.protocol === "ssh:" && url.password === "";
  } catch {
    return false;
  }
}

/** C015x decision 1: `expectedRepository` always originates from `Project.sourceControl.repository`,
 * which is already validated upstream by the (deliberately looser) `projectSchema` -- this file
 * never trusts a caller regardless, so it independently re-checks the exact two-segment
 * "owner/repo" shape every GitHub repository identifier actually has. */
const githubOwnerRepoPattern = /^[^/\s]+\/[^/\s]+$/u;

/**
 * C015x decision 1 step ②: extracts "owner/repo" from a `git remote get-url` result, covering the
 * three URL forms `git` itself produces for a GitHub remote (HTTPS, the `git@` SSH shorthand, and
 * the explicit `ssh://` form). Deliberately GitHub-only (mirrors `validRepository`'s own
 * `github.com`-only assumption, src/adapters/github/adapter.ts) -- GitHub Enterprise/other hosts
 * are out of this ticket's scope. Returns `undefined` (never throws) for anything that does not
 * parse as one of these three forms, which the caller treats as a hard mismatch.
 */
function githubOwnerRepoFromRemoteUrl(url: string): string | undefined {
  const patterns = [
    /^https:\/\/(?:[^@/\s]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/iu,
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/iu,
    /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(url.trim());
    if (match === null) continue;
    const [, owner, repo] = match;
    if (owner === undefined || repo === undefined) continue;
    return `${owner}/${repo}`;
  }
  return undefined;
}

function objectId(value: string): GitObjectId | undefined {
  if (!shaPattern.test(value)) return undefined;
  return value.length === 40 ? { algorithm: "sha1", value } : { algorithm: "sha256", value };
}

function fileMode(value: string): GitFileMode | undefined {
  return value === "100644" || value === "100755" || value === "120000" || value === "160000"
    ? value
    : undefined;
}

function workingMode(value: string): GitWorkingTreeChange["mode"] | undefined {
  switch (value) {
    case "100644":
      return "file";
    case "100755":
      return "executable";
    case "120000":
      return "symlink";
    case "160000":
      return "submodule";
    default:
      return undefined;
  }
}

function selectedMode(...modes: readonly string[]): GitWorkingTreeChange["mode"] | undefined {
  return workingMode(modes.find((mode) => mode !== "000000") ?? "");
}

function changeKind(status: string): GitWorkingTreeChange["kind"] | undefined {
  if (status.includes("R")) return "renamed";
  if (status.includes("A")) return "added";
  if (status.includes("D")) return "deleted";
  if (/[MTCU]/u.test(status)) return "modified";
  return undefined;
}

async function untrackedMode(
  root: string,
  path: string,
): Promise<GitWorkingTreeChange["mode"] | undefined> {
  try {
    const stat = await lstat(join(root, path));
    if (stat.isSymbolicLink()) return "symlink";
    if (!stat.isFile()) return undefined;
    return (stat.mode & 0o111) === 0 ? "file" : "executable";
  } catch {
    return undefined;
  }
}

async function parseWorkingTree(
  root: string,
  output: string,
): Promise<readonly GitWorkingTreeChange[] | undefined> {
  const records = output.split("\0");
  const changes: GitWorkingTreeChange[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length === 0) continue;
    if (record.startsWith("? ")) {
      const path = record.slice(2);
      if (!validRelativePath(path)) return undefined;
      const mode = await untrackedMode(root, path);
      if (mode === undefined) return undefined;
      changes.push({ path, kind: "untracked", mode, staged: false });
      continue;
    }
    if (record.startsWith("u ") || record.startsWith("! ")) return undefined;

    const ordinary =
      /^1 ([^ ]{2}) ([^ ]+) ([0-7]{6}) ([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) (.*)$/u.exec(
        record,
      );
    if (ordinary !== null) {
      const [, status, , headMode, indexMode, worktreeMode, , , path] = ordinary;
      if (status === undefined || path === undefined || !validRelativePath(path)) return undefined;
      const kind = changeKind(status);
      const mode = selectedMode(worktreeMode ?? "", indexMode ?? "", headMode ?? "");
      if (kind === undefined || mode === undefined) return undefined;
      changes.push({ path, kind, mode, staged: !status.startsWith(".") });
      continue;
    }

    const renamed =
      /^2 ([^ ]{2}) ([^ ]+) ([0-7]{6}) ([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([RC][0-9]+) (.*)$/u.exec(
        record,
      );
    if (renamed !== null) {
      const [, status, , headMode, indexMode, worktreeMode, , , , path] = renamed;
      const previousPath = records[index + 1];
      index += 1;
      if (
        status === undefined ||
        path === undefined ||
        previousPath === undefined ||
        !validRelativePath(path) ||
        !validRelativePath(previousPath)
      ) {
        return undefined;
      }
      const mode = selectedMode(worktreeMode ?? "", indexMode ?? "", headMode ?? "");
      if (mode === undefined) return undefined;
      changes.push({ path, previousPath, kind: "renamed", mode, staged: !status.startsWith(".") });
      continue;
    }
    return undefined;
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

function parseEffectiveTreeDiff(output: string): readonly EffectiveTreeChange[] | undefined {
  const records = output.split("\0");
  const changes: EffectiveTreeChange[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const header = records[index];
    if (header === undefined || header.length === 0) continue;
    const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z][0-9]*)$/u.exec(header);
    const firstPath = records[index + 1];
    if (match === null || firstPath === undefined || !validRelativePath(firstPath))
      return undefined;
    index += 1;
    const [, oldModeValue, newModeValue, oldIdValue, newIdValue, statusValue] = match;
    if (
      oldModeValue === undefined ||
      newModeValue === undefined ||
      oldIdValue === undefined ||
      newIdValue === undefined ||
      statusValue === undefined
    ) {
      return undefined;
    }
    const status = statusValue[0];
    const oldMode = fileMode(oldModeValue);
    const newMode = fileMode(newModeValue);
    const oldId = objectId(oldIdValue);
    const newId = objectId(newIdValue);
    if (status === "A") {
      if (newMode === undefined || newId === undefined) return undefined;
      changes.push({ before: null, after: { path: firstPath, mode: newMode, objectId: newId } });
    } else if (status === "D") {
      if (oldMode === undefined || oldId === undefined) return undefined;
      changes.push({ before: { path: firstPath, mode: oldMode, objectId: oldId }, after: null });
    } else if (status === "R" || status === "C") {
      const secondPath = records[index + 1];
      index += 1;
      if (
        secondPath === undefined ||
        !validRelativePath(secondPath) ||
        oldMode === undefined ||
        oldId === undefined ||
        newMode === undefined ||
        newId === undefined
      ) {
        return undefined;
      }
      changes.push({
        before: status === "R" ? { path: firstPath, mode: oldMode, objectId: oldId } : null,
        after: { path: secondPath, mode: newMode, objectId: newId },
      });
    } else if (status === "M" || status === "T") {
      if (
        oldMode === undefined ||
        oldId === undefined ||
        newMode === undefined ||
        newId === undefined
      ) {
        return undefined;
      }
      changes.push({
        before: { path: firstPath, mode: oldMode, objectId: oldId },
        after: { path: firstPath, mode: newMode, objectId: newId },
      });
    } else {
      return undefined;
    }
  }
  const parsed = effectiveTreeDiffSchema.safeParse(changes);
  return parsed.success ? parsed.data : undefined;
}

export class LocalGitAdapter implements GitPort {
  readonly #executable: string;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;
  /** C015m: lazily built once per adapter instance -- see `#buildSafeGlobalConfig`'s own comment
   * for what this contains and why it exists instead of pointing `GIT_CONFIG_GLOBAL` at
   * `/dev/null`. */
  #safeGlobalConfigPathPromise: Promise<string> | undefined;
  /** C015m: `createWorktree` records the exact bytes of a freshly created worktree's `.git`
   * pointer file here, keyed by canonical worktree path, immediately after creation (before any
   * provider has ever run) -- see `#verifyWorktreeGitPointer`'s own comment for how this is used
   * and why a resume-cycle process (a fresh `LocalGitAdapter` instance that never ran this
   * worktree's `createWorktree`) still gets a meaningful check without it. */
  readonly #worktreeGitPointerBaselines = new Map<string, Buffer>();

  constructor(options: LocalGitAdapterOptions = {}) {
    this.#executable = options.executable ?? "git";
    this.#timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? defaultTimeoutMs));
    this.#maxOutputBytes = Math.max(
      1024,
      Math.trunc(options.maxOutputBytes ?? defaultMaxOutputBytes),
    );
  }

  /**
   * C015m: runs `git` with none of `#run`'s hardening -- this must only ever be used to read the
   * *real*, already-established global git config (via `--global --get`/`--get-all`), which
   * requires the genuinely inherited environment (e.g. `HOME`, to resolve `~/.gitconfig`) and is
   * always called before this adapter instance has touched any worktree, so nothing a provider
   * does can influence it. Never call this with a worktree-derived `cwd` or with any argument
   * that isn't a fixed `--global --get*` read.
   */
  async #runBootstrap(arguments_: readonly string[]): Promise<GitCommandResult | undefined> {
    return new Promise((resolve) => {
      execFile(
        this.#executable,
        [...arguments_],
        {
          cwd: tmpdir(),
          encoding: "utf8",
          maxBuffer: this.#maxOutputBytes,
          timeout: this.#timeoutMs,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          resolve(error === null ? { stdout, stderr } : undefined);
        },
      );
    });
  }

  async #realGlobalConfigValues(arguments_: readonly string[]): Promise<readonly string[]> {
    const result = await this.#runBootstrap(arguments_);
    if (result === undefined) return [];
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  /**
   * C015m: `#run` points `GIT_CONFIG_GLOBAL` at this file, never at `/dev/null` -- zeroing global
   * config entirely was the first thing tried, and it broke two things real deployments of this
   * tool already depend on: the operator's `gh`-managed HTTPS credential helper (push would need
   * interactive re-authentication, which this non-interactive pipeline cannot do), and commit
   * author identity when a repository doesn't set `user.name`/`user.email` at the repository
   * level (this was hit for real while writing this ticket's own verification tests). This file
   * is generated once per adapter instance, in a fresh `mkdtemp` directory the implementer's
   * Write/Edit grant can never reach (an absolute path outside every worktree), and contains
   * *only* whatever `credential.helper`/`user.name`/`user.email` values the real global config
   * already had -- copied via git's own `--file`/`--add` config-writing (never hand-formatted
   * INI text, so there is no escaping bug to get wrong). No secret/token value is ever written
   * here: a `credential.helper` line only *names* a helper program (e.g.
   * `!/usr/bin/gh auth git-credential`); the helper itself supplies credentials later,
   * out-of-band -- never via this file, never via a command-line argument (so a token can never
   * appear in `ps` output or get committed into any repository's own config).
   */
  async #safeGlobalConfigPath(): Promise<string> {
    this.#safeGlobalConfigPathPromise ??= this.#buildSafeGlobalConfig();
    return this.#safeGlobalConfigPathPromise;
  }

  async #buildSafeGlobalConfig(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "agent-team-git-safe-config-"));
    // Best-effort cleanup on normal process exit -- this directory holds no secret values (see
    // this method's own header comment), so leaving it in the rare case of a hard kill is not a
    // security concern, only tidiness.
    scheduleSafeGlobalConfigCleanup(directory);
    const configPath = join(directory, "gitconfig");
    await writeFile(configPath, "", { encoding: "utf8", mode: 0o600 });
    // C015m: the real, already-working credential helper on a `gh`-managed host is not
    // necessarily the bare `credential.helper` key -- it is commonly URL-scoped
    // (`credential.<url>.helper`, e.g. `credential.https://github.com.helper`), which
    // `--get-all credential.helper` alone would silently miss (found while verifying this ticket
    // against this host's own real global config). `--get-regexp '^credential\.'` catches every
    // credential-related key regardless of URL-scoping, in original declaration order --
    // including an intentional empty-value "reset" line some hosts use to override a broader
    // helper for one URL, which is why entries are replayed with `--add` even when a value is
    // empty, rather than deduplicated or reordered.
    for (const [key, value] of await this.#realGlobalConfigEntries([
      "config",
      "--global",
      "--get-regexp",
      "-z",
      "^credential\\.",
    ])) {
      await this.#runBootstrap(["config", "--file", configPath, "--add", key, value]);
    }
    const userName = await this.#realGlobalConfigValues([
      "config",
      "--global",
      "--get",
      "user.name",
    ]);
    const userEmail = await this.#realGlobalConfigValues([
      "config",
      "--global",
      "--get",
      "user.email",
    ]);
    for (const name of userName) {
      await this.#runBootstrap(["config", "--file", configPath, "user.name", name]);
    }
    for (const email of userEmail) {
      await this.#runBootstrap(["config", "--file", configPath, "user.email", email]);
    }
    return configPath;
  }

  /** Parses `git config --get-regexp -z ...` output: NUL-separated records, each
   * `<key>\n<value>` (an unset/empty value is a bare key with nothing after the newline). */
  async #realGlobalConfigEntries(
    arguments_: readonly string[],
  ): Promise<readonly (readonly [string, string])[]> {
    const result = await this.#runBootstrap(arguments_);
    if (result === undefined) return [];
    return result.stdout
      .split("\0")
      .filter((record) => record.length > 0)
      .map((record) => {
        const separator = record.indexOf("\n");
        return separator === -1
          ? ([record, ""] as const)
          : ([record.slice(0, separator), record.slice(separator + 1)] as const);
      });
  }

  async #run(
    cwd: string,
    arguments_: readonly string[],
    options: ReadOptions = {},
  ): Promise<Result<GitCommandResult, DomainError>> {
    if (options.signal?.aborted === true) return failure("interrupted");
    const globalConfigPath = await this.#safeGlobalConfigPath();
    const env: NodeJS.ProcessEnv = {
      ...withoutInheritedGitEnv(process.env),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: globalConfigPath,
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
    };
    return new Promise((resolveResult) => {
      execFile(
        this.#executable,
        [...gitHardenFlags, ...arguments_],
        {
          cwd,
          env,
          encoding: "utf8",
          maxBuffer: this.#maxOutputBytes,
          timeout: this.#timeoutMs,
          windowsHide: true,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
        (error, stdout, stderr) => {
          if (error !== null) {
            resolveResult(err(commandError(error, stderr)));
            return;
          }
          resolveResult(ok({ stdout, stderr }));
        },
      );
    });
  }

  /**
   * C015m: the actual root-cause fix -- see the module-level header comment above `gitHardenFlags`
   * for the full rationale. Derives the worktree's real, private gitdir straight from the *main*
   * repository's own `<common-dir>/worktrees/<name>/gitdir` bookkeeping (never from the
   * worktree's own `.git` file), cross-checks it against `git worktree list --porcelain` run
   * *from the main repository* (also never from the worktree), and additionally verifies the
   * worktree's own `.git` file is a plain, non-symlink file that itself agrees with the trusted
   * answer -- entirely via `fs` reads, never by spawning git against the untrusted path. Every
   * `LocalGitAdapter` method that touches a worktree's files must route through this (via
   * `#runOnWorktree`) instead of ever passing `worktree.path` to `#run` directly.
   */
  async #trustedWorktreeContext(
    worktree: GitWorktree,
    options: ReadOptions,
  ): Promise<Result<TrustedWorktreeContext, DomainError>> {
    if (!validAbsolutePath(worktree.path) || !validAbsolutePath(worktree.repositoryRoot)) {
      return failure("external_failure");
    }
    const [workTree, repositoryRoot] = await Promise.all([
      canonicalPath(worktree.path),
      canonicalPath(worktree.repositoryRoot),
    ]);
    if (workTree === undefined || repositoryRoot === undefined) return failure("not_found");
    if (workTree === repositoryRoot) return failure("conflict");

    const commonDirectory = await this.#run(
      repositoryRoot,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      options,
    );
    if (!commonDirectory.ok) return commonDirectory;
    const commonDirectoryPath = await canonicalPath(commonDirectory.value.stdout.trim());
    if (commonDirectoryPath === undefined) return failure("not_found");

    const registered = await this.#run(
      repositoryRoot,
      ["worktree", "list", "--porcelain"],
      options,
    );
    if (!registered.ok) return registered;
    if (!(await worktreeListedAt(registered.value.stdout, workTree))) return failure("conflict");

    const gitDir = await this.#findRegisteredWorktreeGitDir(commonDirectoryPath, workTree);
    if (!gitDir.ok) return gitDir;

    const pointerCheck = await this.#verifyWorktreeGitPointer(workTree, gitDir.value);
    if (!pointerCheck.ok) return pointerCheck;

    return ok({ gitDir: gitDir.value, workTree });
  }

  /** C015m: reads `<commonDirectory>/worktrees/*\/gitdir` -- git's own bookkeeping of which
   * private gitdir belongs to which worktree path, maintained entirely inside the main
   * repository's own `.git`, never reachable by the implementer's Write/Edit grant -- and returns
   * the one whose recorded worktree path matches `workTree` exactly. Fails closed (never guesses)
   * if zero or more than one entry claims the same worktree path. */
  async #findRegisteredWorktreeGitDir(
    commonDirectory: string,
    workTree: string,
  ): Promise<Result<string, DomainError>> {
    let entries: readonly string[];
    try {
      entries = await readdir(join(commonDirectory, "worktrees"));
    } catch {
      return failure("not_found");
    }
    const matches: string[] = [];
    for (const name of entries) {
      const candidateGitDir = join(commonDirectory, "worktrees", name);
      let claimedPointer: string;
      try {
        claimedPointer = (await readFile(join(candidateGitDir, "gitdir"), "utf8")).trim();
      } catch {
        continue;
      }
      if (basename(claimedPointer) !== ".git") continue;
      const claimedWorktree = await canonicalPath(dirname(claimedPointer));
      if (claimedWorktree === workTree) matches.push(candidateGitDir);
    }
    if (matches.length !== 1) return failure("conflict");
    const canonicalGitDir = await canonicalPath(matches[0] ?? "");
    return canonicalGitDir === undefined ? failure("not_found") : ok(canonicalGitDir);
  }

  /**
   * C015m: defense-in-depth only -- by the time this runs, `#trustedWorktreeContext` has already
   * derived the trusted gitdir without ever looking at this file, so a mismatch here can no
   * longer cause an RCE. It is still worth refusing on: a `.git` that is missing, is a symlink or
   * directory instead of a plain file, fails to parse as a single `gitdir: <absolute path>` line,
   * or resolves to anything other than the trusted gitdir is a strong signal something touched
   * `.git` outside of git's own normal bookkeeping, and every one of those is treated as fail
   * closed, never "best effort". When this same adapter instance created the worktree itself (see
   * `createWorktree`), the *exact bytes* are also compared against the creation-time baseline --
   * a resume-cycle process that never ran this worktree's `createWorktree` has no such baseline
   * and only gets the resolved-path check, which is still sufficient to catch tampering (it just
   * cannot distinguish tampering from "bytes changed but still happen to resolve correctly",
   * which is not a real attack shape). Entirely `fs`-based -- never spawns git against `workTree`.
   */
  async #verifyWorktreeGitPointer(
    workTree: string,
    trustedGitDir: string,
  ): Promise<Result<void, DomainError>> {
    const pointerPath = join(workTree, ".git");
    let stat;
    try {
      stat = await lstat(pointerPath);
    } catch {
      return failure("conflict");
    }
    if (!stat.isFile()) return failure("conflict");
    let bytes: Buffer;
    try {
      bytes = await readFile(pointerPath);
    } catch {
      return failure("conflict");
    }
    const baseline = this.#worktreeGitPointerBaselines.get(workTree);
    if (baseline !== undefined && !bytes.equals(baseline)) return failure("conflict");
    const match = /^gitdir: (.+?)\r?\n?$/u.exec(bytes.toString("utf8"));
    const claimedPath = match?.[1];
    if (claimedPath === undefined || !isAbsolute(claimedPath)) return failure("conflict");
    const resolvedClaim = await canonicalPath(claimedPath);
    if (resolvedClaim === undefined || resolvedClaim !== trustedGitDir) return failure("conflict");
    return ok(undefined);
  }

  /** C015m: the only way any `LocalGitAdapter` method may run a git subcommand whose effect
   * concerns a worktree's own files/index/HEAD -- resolves trust first, then passes an explicit
   * `--git-dir`/`--work-tree` (which the git documentation confirms disables repository
   * discovery entirely), never relying on `cwd`-based discovery of the worktree's own `.git`. */
  async #runOnWorktree(
    worktree: GitWorktree,
    arguments_: readonly string[],
    options: ReadOptions,
  ): Promise<Result<GitCommandResult, DomainError>> {
    const trusted = await this.#trustedWorktreeContext(worktree, options);
    if (!trusted.ok) return trusted;
    return this.#run(
      trusted.value.workTree,
      ["--git-dir", trusted.value.gitDir, "--work-tree", trusted.value.workTree, ...arguments_],
      options,
    );
  }

  /** C015m: the trusted-context equivalent of `inspectRepository`, for when the "repository" in
   * question is a worktree whose identity must come from `#trustedWorktreeContext`, not from
   * `cwd`-based discovery against the worktree's own (possibly tampered) `.git`. */
  async #inspectRepositoryAtTrustedContext(
    trusted: TrustedWorktreeContext,
    options: ReadOptions,
  ): Promise<Result<GitRepositorySnapshot, DomainError>> {
    const gitDirArguments = ["--git-dir", trusted.gitDir, "--work-tree", trusted.workTree];
    const [bare, head, branch, status] = await Promise.all([
      this.#run(
        trusted.workTree,
        [...gitDirArguments, "rev-parse", "--is-bare-repository"],
        options,
      ),
      this.#run(
        trusted.workTree,
        [...gitDirArguments, "rev-parse", "--verify", "HEAD^{commit}"],
        options,
      ),
      this.#run(trusted.workTree, [...gitDirArguments, "branch", "--show-current"], options),
      this.#run(
        trusted.workTree,
        [...gitDirArguments, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
        options,
      ),
    ]);
    if (!bare.ok) return bare;
    if (!head.ok) return head;
    if (!branch.ok) return branch;
    if (!status.ok) return status;
    const headSha = head.value.stdout.trim();
    if (bare.value.stdout.trim() !== "false" || !shaPattern.test(headSha)) {
      return failure("external_failure");
    }
    return ok({
      rootPath: trusted.workTree,
      headSha,
      branch: branch.value.stdout.trim() || "(detached)",
      clean: status.value.stdout.length === 0,
    });
  }

  async #repositoryRoot(
    repository: GitRepositoryRef,
    options: ReadOptions = {},
  ): Promise<Result<string, DomainError>> {
    if (!validAbsolutePath(repository.rootPath)) return failure("external_failure");
    const requested = await canonicalPath(repository.rootPath);
    if (requested === undefined) return failure("not_found");
    const result = await this.#run(requested, ["rev-parse", "--show-toplevel"], options);
    if (!result.ok) return result;
    const discovered = await canonicalPath(result.value.stdout.trim());
    return discovered === requested ? ok(discovered) : failure("conflict");
  }

  async #primaryRepositoryRoot(
    repository: GitRepositoryRef,
    options: ReadOptions = {},
  ): Promise<Result<string, DomainError>> {
    const root = await this.#repositoryRoot(repository, options);
    if (!root.ok) return root;
    const [gitDirectory, commonDirectory] = await Promise.all([
      this.#run(root.value, ["rev-parse", "--path-format=absolute", "--git-dir"], options),
      this.#run(root.value, ["rev-parse", "--path-format=absolute", "--git-common-dir"], options),
    ]);
    if (!gitDirectory.ok) return gitDirectory;
    if (!commonDirectory.ok) return commonDirectory;
    const [gitPath, commonPath] = await Promise.all([
      canonicalPath(gitDirectory.value.stdout.trim()),
      canonicalPath(commonDirectory.value.stdout.trim()),
    ]);
    return gitPath !== undefined && gitPath === commonPath ? root : failure("conflict");
  }

  async #resolveCommit(
    root: string,
    revision: string,
    options: ReadOptions = {},
  ): Promise<Result<string, DomainError>> {
    if (!validRevision(revision)) return failure("external_failure");
    const resolved = await this.#run(
      root,
      ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`],
      options,
    );
    if (!resolved.ok) return resolved;
    const sha = resolved.value.stdout.trim();
    return shaPattern.test(sha) ? ok(sha) : failure("external_failure");
  }

  /** C015m: the `#runOnWorktree`-routed equivalent of `#resolveCommit`, for the one caller
   * (`getStagedTreeDiff`) that needs to resolve a revision against a worktree's own index/HEAD
   * rather than the main repository. */
  async #resolveCommitOnWorktree(
    worktree: GitWorktree,
    revision: string,
    options: ReadOptions,
  ): Promise<Result<string, DomainError>> {
    if (!validRevision(revision)) return failure("external_failure");
    const resolved = await this.#runOnWorktree(
      worktree,
      ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`],
      options,
    );
    if (!resolved.ok) return resolved;
    const sha = resolved.value.stdout.trim();
    return shaPattern.test(sha) ? ok(sha) : failure("external_failure");
  }

  async inspectRepository(
    repository: GitRepositoryRef,
    options: ReadOptions = {},
  ): Promise<Result<GitRepositorySnapshot, DomainError>> {
    const root = await this.#repositoryRoot(repository, options);
    if (!root.ok) return root;
    const [bare, head, branch, status] = await Promise.all([
      this.#run(root.value, ["rev-parse", "--is-bare-repository"], options),
      this.#run(root.value, ["rev-parse", "--verify", "HEAD^{commit}"], options),
      this.#run(root.value, ["branch", "--show-current"], options),
      this.#run(root.value, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], options),
    ]);
    if (!bare.ok) return bare;
    if (!head.ok) return head;
    if (!branch.ok) return branch;
    if (!status.ok) return status;
    const headSha = head.value.stdout.trim();
    if (bare.value.stdout.trim() !== "false" || !shaPattern.test(headSha)) {
      return failure("external_failure");
    }
    return ok({
      rootPath: root.value,
      headSha,
      branch: branch.value.stdout.trim() || "(detached)",
      clean: status.value.stdout.length === 0,
    });
  }

  /**
   * C015x decision 1 (steps ②-⑤): see `GitPort.resolveAuthoritativeBranch`'s own header
   * (application/ports/git.ts) for the full rationale. `+refs/heads/<branch>:refs/remotes/
   * <remote>/<branch>` is a *forced* refspec (the leading `+`) -- this must always land the
   * remote's exact current tip into the local remote-tracking ref regardless of whatever that ref
   * previously pointed to (a non-fast-forward local history for a force-pushed or rebased default
   * branch must never be silently rejected here); it does not touch any other ref. `#resolveCommit`
   * immediately after the fetch is what performs step ⑤ (confirms the object is genuinely present
   * as a commit, not merely a claimed SHA) -- a fetch that reports success but somehow left the ref
   * unresolvable still fails closed here, never silently trusted.
   */
  async resolveAuthoritativeBranch(
    request: AuthoritativeBranchRequest,
    options: MutationOptions,
  ): Promise<Result<AuthoritativeBranchHead, DomainError>> {
    if (
      !mutationAllowed(options) ||
      !remotePattern.test(request.remote) ||
      request.branch.startsWith("-") ||
      !githubOwnerRepoPattern.test(request.expectedRepository)
    ) {
      return failure("external_failure");
    }
    const root = await this.#repositoryRoot(request, options);
    if (!root.ok) return root;

    const branchCheck = await this.#run(root.value, [
      "check-ref-format",
      "--branch",
      request.branch,
    ]);
    if (!branchCheck.ok) return failure("external_failure");

    // Step ②: the local `origin` (or whatever `remote` names) must genuinely resolve to
    // `expectedRepository` -- never assumed, per the coordinator's own root-cause finding that a
    // stale/unverified local assumption is exactly what caused this ticket's incident.
    const remoteUrl = await this.#run(root.value, ["remote", "get-url", request.remote], options);
    if (!remoteUrl.ok) return remoteUrl;
    const trimmedRemoteUrl = remoteUrl.value.stdout.trim();
    if (!safeRemoteUrl(trimmedRemoteUrl)) return failure("external_failure");
    const remoteRepository = githubOwnerRepoFromRemoteUrl(trimmedRemoteUrl);
    if (remoteRepository?.toLowerCase() !== request.expectedRepository.toLowerCase()) {
      return failure("conflict");
    }

    // Step ③: a real `git fetch` (never `ls-remote`) -- the resulting commit must be physically
    // present in the local object store afterward, not merely known by SHA.
    const trackingRef = `refs/remotes/${request.remote}/${request.branch}`;
    const fetched = await this.#run(
      root.value,
      [
        "fetch",
        "--no-tags",
        "--quiet",
        request.remote,
        `+refs/heads/${request.branch}:${trackingRef}`,
      ],
      options,
    );
    if (!fetched.ok) return fetched;

    // Steps ④+⑤: resolve the just-fetched ref and confirm it is a real, locally-present commit.
    const resolved = await this.#resolveCommit(root.value, trackingRef, options);
    if (!resolved.ok) return resolved;

    return ok({ remote: request.remote, branch: request.branch, sha: resolved.value });
  }

  /**
   * C015m: previously ran its own ad-hoc `rev-parse --git-dir`/`--git-common-dir` comparison
   * with `cwd` set to the worktree's own (untrusted) path -- exactly the discovery-based pattern
   * the module header comment explains is the actual vulnerability. Now delegates entirely to
   * `#trustedWorktreeContext`, which establishes the same "this worktree genuinely belongs to
   * this repository" fact by cross-referencing the *main* repository's own bookkeeping instead,
   * and never spawns git against the worktree path until that trust is established.
   */
  async #inspectVerifiedWorktree(
    worktree: GitWorktree,
    options: ReadOptions = {},
  ): Promise<Result<GitRepositorySnapshot, DomainError>> {
    const trusted = await this.#trustedWorktreeContext(worktree, options);
    if (!trusted.ok) return trusted;
    const snapshot = await this.#inspectRepositoryAtTrustedContext(trusted.value, options);
    if (!snapshot.ok) return snapshot;
    if (snapshot.value.branch !== worktree.branch) return failure("conflict");
    return snapshot;
  }

  async createWorktree(
    command: CreateWorktreeCommand,
    options: MutationOptions,
  ): Promise<Result<GitWorktree, DomainError>> {
    if (
      !mutationAllowed(options) ||
      !validAbsolutePath(command.path) ||
      !validRevision(command.startPoint) ||
      command.branch.startsWith("-")
    ) {
      return failure("external_failure");
    }
    const root = await this.#primaryRepositoryRoot(command, options);
    if (!root.ok) return root;
    return runWithInProcessSerialization(`git-worktree:${root.value}`, async () => {
      const target = await canonicalFuturePath(command.path);
      if (target === undefined || target === root.value || isDescendant(root.value, target)) {
        return failure("conflict");
      }
      const branchCheck = await this.#run(root.value, [
        "check-ref-format",
        "--branch",
        command.branch,
      ]);
      if (!branchCheck.ok) return failure("external_failure");

      const existing = await canonicalPath(target);
      if (existing !== undefined) {
        // C015m: record this instance's own baseline for the pointer-readback check *before*
        // establishing trust, not after -- an idempotent re-`createWorktree` call is this
        // instance's first encounter with this worktree's `.git`, exactly like a fresh creation
        // below; capturing it here (rather than opportunistically inside a passing check) keeps
        // "baseline capture" a single, explicit, creation-time-only concept.
        await this.#captureWorktreeGitPointerBaseline(existing);
        const inspected = await this.#inspectVerifiedWorktree(
          {
            repositoryRoot: root.value,
            path: existing,
            branch: command.branch,
            headSha: "",
          },
          options,
        );
        return inspected.ok
          ? ok({
              repositoryRoot: root.value,
              path: existing,
              branch: inspected.value.branch,
              headSha: inspected.value.headSha,
            })
          : failure("conflict");
      }

      const start = await this.#resolveCommit(root.value, command.startPoint, options);
      if (!start.ok) return start;
      const added = await this.#run(
        root.value,
        ["worktree", "add", "-b", command.branch, "--", target, start.value],
        options,
      );
      if (!added.ok) return added;
      // C015m: capture the exact bytes of the freshly created worktree's `.git` pointer file right
      // now -- this is the one moment in the whole lifecycle guaranteed to be untouched by any
      // provider (the worktree did not exist a moment ago). `#verifyWorktreeGitPointer` compares
      // every later read against this, for the strictest possible check available within this
      // process's lifetime.
      const canonicalTarget = await canonicalPath(target);
      if (canonicalTarget !== undefined) {
        await this.#captureWorktreeGitPointerBaseline(canonicalTarget);
      }
      const snapshot = await this.#inspectVerifiedWorktree(
        { repositoryRoot: root.value, path: target, branch: command.branch, headSha: "" },
        options,
      );
      return snapshot.ok
        ? ok({
            repositoryRoot: root.value,
            path: target,
            branch: snapshot.value.branch,
            headSha: snapshot.value.headSha,
          })
        : snapshot;
    });
  }

  async #captureWorktreeGitPointerBaseline(canonicalWorktreePath: string): Promise<void> {
    try {
      this.#worktreeGitPointerBaselines.set(
        canonicalWorktreePath,
        await readFile(join(canonicalWorktreePath, ".git")),
      );
    } catch {
      // Best-effort only: if `.git` is genuinely unreadable here, the very next
      // `#verifyWorktreeGitPointer` call (inside `#inspectVerifiedWorktree`, right after this
      // returns) reads the same path and fails closed on the same error -- there is no silent
      // gap, just no baseline to compare future calls against.
    }
  }

  inspectWorktree(
    worktree: GitWorktree,
    options: ReadOptions = {},
  ): Promise<Result<GitRepositorySnapshot, DomainError>> {
    return this.#inspectVerifiedWorktree(worktree, options);
  }

  async inspectWorkingTree(
    worktree: GitWorktree,
    options: ReadOptions = {},
  ): Promise<Result<GitWorkingTreeSnapshot, DomainError>> {
    const snapshot = await this.#inspectVerifiedWorktree(worktree, options);
    if (!snapshot.ok) return snapshot;
    const status = await this.#runOnWorktree(
      worktree,
      ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
      options,
    );
    if (!status.ok) return status;
    const changes = await parseWorkingTree(worktree.path, status.value.stdout);
    return changes === undefined
      ? failure("external_failure")
      : ok({ headSha: snapshot.value.headSha, changes });
  }

  async readTextFileAtRevision(
    command: ReadGitTextFileCommand,
    options: ReadOptions = {},
  ): Promise<Result<GitTextFileAtRevision, DomainError>> {
    if (
      !validRevision(command.revision) ||
      !validRelativePath(command.path) ||
      !Number.isSafeInteger(command.maxBytes) ||
      command.maxBytes <= 0 ||
      command.maxBytes > 16 * 1024 * 1024
    ) {
      return failure("external_failure");
    }
    const root = await this.#repositoryRoot(command, options);
    if (!root.ok) return root;
    const revisionSha = await this.#resolveCommit(root.value, command.revision, options);
    if (!revisionSha.ok) return revisionSha;
    const content = await this.#run(
      root.value,
      ["cat-file", "blob", `${revisionSha.value}:${command.path}`],
      options,
    );
    if (!content.ok) return content;
    const byteLength = Buffer.byteLength(content.value.stdout, "utf8");
    if (
      byteLength > command.maxBytes ||
      content.value.stdout.includes("\u0000") ||
      content.value.stdout.includes("\ufffd")
    ) {
      return failure("external_failure");
    }
    return ok({
      revisionSha: revisionSha.value,
      path: command.path,
      content: content.value.stdout,
      byteLength,
    });
  }

  async stagePaths(
    worktree: GitWorktree,
    paths: readonly string[],
    options: MutationOptions,
  ): Promise<Result<GitWorkingTreeSnapshot, DomainError>> {
    if (
      !mutationAllowed(options) ||
      paths.length === 0 ||
      new Set(paths).size !== paths.length ||
      paths.some((path) => !validRelativePath(path))
    ) {
      return failure("external_failure");
    }
    const verified = await this.#inspectVerifiedWorktree(worktree, options);
    if (!verified.ok) return verified;
    const staged = await this.#runOnWorktree(worktree, ["add", "--", ...paths], options);
    return staged.ok ? this.inspectWorkingTree(worktree, options) : staged;
  }

  async getEffectiveTreeDiff(
    repository: GitRepositoryRef,
    baseRevision: string,
    headRevision: string,
    options: ReadOptions = {},
  ): Promise<Result<readonly EffectiveTreeChange[], DomainError>> {
    if (!validRevision(baseRevision) || !validRevision(headRevision)) {
      return failure("external_failure");
    }
    const root = await this.#repositoryRoot(repository, options);
    if (!root.ok) return root;
    const [base, head] = await Promise.all([
      this.#resolveCommit(root.value, baseRevision, options),
      this.#resolveCommit(root.value, headRevision, options),
    ]);
    if (!base.ok) return base;
    if (!head.ok) return head;
    const output = await this.#run(
      root.value,
      [
        "diff-tree",
        "-r",
        "--no-commit-id",
        "--raw",
        "-z",
        "--find-renames=50%",
        base.value,
        head.value,
      ],
      options,
    );
    if (!output.ok) return output;
    const changes = parseEffectiveTreeDiff(output.value.stdout);
    return changes === undefined ? failure("external_failure") : ok(changes);
  }

  async getStagedTreeDiff(
    worktree: GitWorktree,
    baseRevision: string,
    options: ReadOptions = {},
  ): Promise<Result<readonly EffectiveTreeChange[], DomainError>> {
    if (!validRevision(baseRevision)) return failure("external_failure");
    const verified = await this.#inspectVerifiedWorktree(worktree, options);
    if (!verified.ok) return verified;
    const base = await this.#resolveCommitOnWorktree(worktree, baseRevision, options);
    if (!base.ok) return base;
    const output = await this.#runOnWorktree(
      worktree,
      ["diff", "--cached", "--raw", "--no-abbrev", "-z", "--find-renames=50%", base.value],
      options,
    );
    if (!output.ok) return output;
    const changes = parseEffectiveTreeDiff(output.value.stdout);
    return changes === undefined ? failure("external_failure") : ok(changes);
  }

  async inspectCommit(
    repository: GitRepositoryRef,
    revision: string,
    options: ReadOptions = {},
  ): Promise<Result<GitCommitSnapshot, DomainError>> {
    const root = await this.#repositoryRoot(repository, options);
    if (!root.ok) return root;
    const resolved = await this.#resolveCommit(root.value, revision, options);
    if (!resolved.ok) return resolved;
    const inspected = await this.#run(
      root.value,
      ["show", "-s", "--format=%H%x00%T%x00%P%x00%B%x00", resolved.value],
      options,
    );
    if (!inspected.ok) return inspected;
    const [sha, treeSha, parents, rawMessage, terminator, trailing] =
      inspected.value.stdout.split("\0");
    if (
      sha === undefined ||
      treeSha === undefined ||
      parents === undefined ||
      rawMessage === undefined ||
      terminator === undefined ||
      trailing !== undefined ||
      terminator.trim().length !== 0 ||
      !shaPattern.test(sha) ||
      !shaPattern.test(treeSha)
    ) {
      return failure("external_failure");
    }
    const parentShas = parents.length === 0 ? [] : parents.split(" ");
    if (parentShas.some((parent) => !shaPattern.test(parent))) {
      return failure("external_failure");
    }
    const message = rawMessage.endsWith("\n") ? rawMessage.slice(0, -1) : rawMessage;
    return ok({ sha, treeSha, parentShas, message });
  }

  async commit(
    command: GitCommitCommand,
    options: MutationOptions,
  ): Promise<Result<GitCommitReceipt, DomainError>> {
    const expected = [...command.expectedStagedPaths].sort();
    if (
      !mutationAllowed(options) ||
      command.message.trim().length === 0 ||
      command.message.length > 10_000 ||
      command.message.includes("\u0000") ||
      expected.length === 0 ||
      new Set(expected).size !== expected.length ||
      expected.some((path) => !validRelativePath(path))
    ) {
      return failure("external_failure");
    }
    const before = await this.inspectWorkingTree(command.worktree, options);
    if (!before.ok) return before;
    const actual = before.value.changes
      .filter((change) => change.staged)
      .map((change) => change.path)
      .sort();
    if (
      actual.length !== expected.length ||
      actual.some((path, index) => path !== expected[index])
    ) {
      return failure("conflict");
    }
    const committed = await this.#runOnWorktree(
      command.worktree,
      ["commit", "--no-gpg-sign", "-m", command.message],
      options,
    );
    if (!committed.ok) return committed;
    const after = await this.#inspectVerifiedWorktree(command.worktree, options);
    if (!after.ok) return after;
    const remaining = await this.inspectWorkingTree(command.worktree, options);
    if (!remaining.ok) return remaining;
    if (remaining.value.changes.some((change) => change.staged)) return failure("external_failure");
    return ok({ sha: after.value.headSha, branch: after.value.branch });
  }

  async push(
    worktree: GitWorktree,
    remote: string,
    options: MutationOptions,
  ): Promise<Result<GitPushReceipt, DomainError>> {
    if (!mutationAllowed(options) || !remotePattern.test(remote)) {
      return failure("external_failure");
    }
    const snapshot = await this.#inspectVerifiedWorktree(worktree, options);
    if (!snapshot.ok) return snapshot;
    const remoteCheck = await this.#runOnWorktree(
      worktree,
      ["remote", "get-url", "--push", remote],
      options,
    );
    if (!remoteCheck.ok) return remoteCheck;
    if (!safeRemoteUrl(remoteCheck.value.stdout.trim())) return failure("external_failure");
    const existingRemote = await this.#runOnWorktree(
      worktree,
      [
        "-c",
        "protocol.ext.allow=never",
        "ls-remote",
        remote,
        `refs/heads/${snapshot.value.branch}`,
      ],
      options,
    );
    if (!existingRemote.ok) return existingRemote;
    const existingRemoteSha = existingRemote.value.stdout.trim().split(/\s+/u)[0];
    if (existingRemoteSha === snapshot.value.headSha) {
      return ok({ remote, branch: snapshot.value.branch, sha: snapshot.value.headSha });
    }
    const pushed = await this.#runOnWorktree(
      worktree,
      [
        "-c",
        "protocol.ext.allow=never",
        "push",
        "--porcelain",
        remote,
        `HEAD:refs/heads/${snapshot.value.branch}`,
      ],
      options,
    );
    if (!pushed.ok) return pushed;
    const readBack = await this.#runOnWorktree(
      worktree,
      [
        "-c",
        "protocol.ext.allow=never",
        "ls-remote",
        "--exit-code",
        remote,
        `refs/heads/${snapshot.value.branch}`,
      ],
      options,
    );
    if (!readBack.ok) return readBack;
    const remoteSha = readBack.value.stdout.trim().split(/\s+/u)[0];
    return remoteSha === snapshot.value.headSha
      ? ok({ remote, branch: snapshot.value.branch, sha: snapshot.value.headSha })
      : failure("external_failure");
  }

  async removeWorktree(
    worktree: GitWorktree,
    options: MutationOptions,
  ): Promise<Result<void, DomainError>> {
    if (!mutationAllowed(options)) return failure("external_failure");
    const snapshot = await this.#inspectVerifiedWorktree(worktree, options);
    if (!snapshot.ok) return snapshot;
    if (!snapshot.value.clean) return failure("conflict");
    const removed = await this.#run(
      worktree.repositoryRoot,
      ["worktree", "remove", "--", worktree.path],
      options,
    );
    if (!removed.ok) return removed;
    return (await canonicalPath(worktree.path)) === undefined
      ? ok(undefined)
      : failure("external_failure");
  }
}
