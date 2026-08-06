import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path";

import type {
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

const defaultTimeoutMs = 30_000;
const defaultMaxOutputBytes = 64 * 1024 * 1024;
const revisionPattern = /^[^\u0000\r\n]{1,1024}$/u;
const remotePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;
const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

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

  constructor(options: LocalGitAdapterOptions = {}) {
    this.#executable = options.executable ?? "git";
    this.#timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? defaultTimeoutMs));
    this.#maxOutputBytes = Math.max(
      1024,
      Math.trunc(options.maxOutputBytes ?? defaultMaxOutputBytes),
    );
  }

  async #run(
    cwd: string,
    arguments_: readonly string[],
    options: ReadOptions = {},
  ): Promise<Result<GitCommandResult, DomainError>> {
    if (options.signal?.aborted === true) return failure("interrupted");
    return new Promise((resolveResult) => {
      execFile(
        this.#executable,
        [...arguments_],
        {
          cwd,
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

  async #inspectVerifiedWorktree(
    worktree: GitWorktree,
    options: ReadOptions = {},
  ): Promise<Result<GitRepositorySnapshot, DomainError>> {
    if (!validAbsolutePath(worktree.path) || !validAbsolutePath(worktree.repositoryRoot)) {
      return failure("external_failure");
    }
    const [worktreePath, repositoryRoot] = await Promise.all([
      canonicalPath(worktree.path),
      canonicalPath(worktree.repositoryRoot),
    ]);
    if (worktreePath === undefined || repositoryRoot === undefined) return failure("not_found");
    if (worktreePath === repositoryRoot) return failure("conflict");
    const [snapshot, worktreeGit, worktreeCommon, repositoryGit, repositoryCommon] =
      await Promise.all([
        this.inspectRepository({ rootPath: worktreePath }, options),
        this.#run(worktreePath, ["rev-parse", "--path-format=absolute", "--git-dir"], options),
        this.#run(
          worktreePath,
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          options,
        ),
        this.#run(repositoryRoot, ["rev-parse", "--path-format=absolute", "--git-dir"], options),
        this.#run(
          repositoryRoot,
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          options,
        ),
      ]);
    if (!snapshot.ok) return snapshot;
    if (!worktreeGit.ok) return worktreeGit;
    if (!worktreeCommon.ok) return worktreeCommon;
    if (!repositoryGit.ok) return repositoryGit;
    if (!repositoryCommon.ok) return repositoryCommon;
    const [worktreeGitPath, left, repositoryGitPath, right] = await Promise.all([
      canonicalPath(worktreeGit.value.stdout.trim()),
      canonicalPath(worktreeCommon.value.stdout.trim()),
      canonicalPath(repositoryGit.value.stdout.trim()),
      canonicalPath(repositoryCommon.value.stdout.trim()),
    ]);
    if (
      worktreeGitPath === undefined ||
      left === undefined ||
      repositoryGitPath === undefined ||
      right === undefined ||
      left !== right ||
      repositoryGitPath !== right ||
      worktreeGitPath === left ||
      isDescendant(repositoryRoot, worktreePath) ||
      snapshot.value.branch !== worktree.branch
    ) {
      return failure("conflict");
    }
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
    const status = await this.#run(
      worktree.path,
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
    const staged = await this.#run(worktree.path, ["add", "--", ...paths], options);
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
    const base = await this.#resolveCommit(worktree.path, baseRevision, options);
    if (!base.ok) return base;
    const output = await this.#run(
      worktree.path,
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
    const committed = await this.#run(
      command.worktree.path,
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
    const remoteCheck = await this.#run(
      worktree.path,
      ["remote", "get-url", "--push", remote],
      options,
    );
    if (!remoteCheck.ok) return remoteCheck;
    if (!safeRemoteUrl(remoteCheck.value.stdout.trim())) return failure("external_failure");
    const existingRemote = await this.#run(
      worktree.path,
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
    const pushed = await this.#run(
      worktree.path,
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
    const readBack = await this.#run(
      worktree.path,
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
