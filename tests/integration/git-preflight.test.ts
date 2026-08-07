import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GitPreflight, LocalGitAdapter } from "../../src/adapters/git/index.js";
import type { GitWorkingTreeChange, GitWorktree } from "../../src/application/ports/index.js";

interface Fixture {
  readonly root: string;
  readonly repository: string;
  readonly worktree: GitWorktree;
  readonly git: LocalGitAdapter;
}

const temporaryDirectories: string[] = [];

function runGit(cwd: string, arguments_: readonly string[]): Promise<string> {
  return new Promise((resolveOutput, rejectOutput) => {
    execFile("git", [...arguments_], { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error === null) resolveOutput(stdout);
      else rejectOutput(new Error(stderr));
    });
  });
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "agent-team-preflight-"));
  temporaryDirectories.push(root);
  const repository = join(root, "primary");
  await mkdir(repository);
  await runGit(repository, ["init", "--initial-branch=main"]);
  await runGit(repository, ["config", "user.name", "Agent Team Test"]);
  await runGit(repository, ["config", "user.email", "agent-team@example.invalid"]);
  await mkdir(join(repository, "src"));
  await mkdir(join(repository, "docs"));
  await writeFile(join(repository, "src", "base.ts"), "export const base = true;\n", "utf8");
  await writeFile(join(repository, "src", "rename.ts"), "export const rename = true;\n", "utf8");
  await writeFile(join(repository, "docs", "base.md"), "# Base\n", "utf8");
  await runGit(repository, ["add", "--", "."]);
  await runGit(repository, ["commit", "-m", "initial"]);

  const git = new LocalGitAdapter();
  const snapshot = await git.inspectRepository({ rootPath: repository });
  if (!snapshot.ok) throw new Error(snapshot.error.code);
  const created = await git.createWorktree(
    {
      rootPath: repository,
      path: join(root, "worktree"),
      branch: "feature/FIX-6-preflight",
      startPoint: snapshot.value.headSha,
    },
    { idempotencyKey: "create:preflight" },
  );
  if (!created.ok) throw new Error(created.error.code);
  return { root, repository, worktree: created.value, git };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Git preflight", () => {
  it("allows declared, expected, secret-free files and an internal symlink", async () => {
    const environment = await fixture();
    await writeFile(
      join(environment.worktree.path, "src", "base.ts"),
      "export const base = false;\n",
      "utf8",
    );
    await writeFile(
      join(environment.worktree.path, "src", "new.ts"),
      "export const added = true;\n",
      "utf8",
    );
    await symlink("base.ts", join(environment.worktree.path, "src", "base-link"));

    const result = await new GitPreflight(environment.git).inspect({
      worktree: environment.worktree,
      declaredRegions: [{ path: "src", coverage: "subtree" }],
      expectedUntrackedPaths: ["src/new.ts", "src/base-link"],
      knownSecrets: ["known-secret-value"],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        headSha: environment.worktree.headSha,
        allowed: true,
        scopeVerified: true,
        changedPaths: ["src/base-link", "src/base.ts", "src/new.ts"],
        findings: [],
      },
    });
  });

  it("reports scope, untracked, secret, unsafe symlink, and peer overlap without secret text", async () => {
    const environment = await fixture();
    const secret = ["github", "pat", "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"].join("_");
    await writeFile(join(environment.worktree.path, "src", "token.ts"), secret, "utf8");
    await writeFile(join(environment.worktree.path, "docs", "outside.md"), "outside\n", "utf8");
    await writeFile(join(environment.root, "outside-target"), "outside\n", "utf8");
    await symlink("../../outside-target", join(environment.worktree.path, "src", "escape-link"));
    const peerChange: GitWorkingTreeChange = {
      path: "src/token.ts",
      kind: "modified",
      mode: "file",
      staged: false,
    };

    const result = await new GitPreflight(environment.git).inspect({
      worktree: environment.worktree,
      declaredRegions: [{ path: "src", coverage: "subtree" }],
      expectedUntrackedPaths: ["src/token.ts", "src/escape-link"],
      concurrentJobs: [{ jobId: "job-peer", changes: [peerChange] }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.allowed).toBe(false);
    expect(result.value.findings).toEqual([
      { code: "outside_declared_region", path: "docs/outside.md" },
      { code: "unexpected_untracked", path: "docs/outside.md" },
      { code: "unsafe_symlink", path: "src/escape-link" },
      { code: "overlapping_job_change", path: "src/token.ts", otherJobId: "job-peer" },
      { code: "suspected_secret", path: "src/token.ts" },
    ]);
    expect(JSON.stringify(result.value)).not.toContain(secret);
  });

  it("checks both sides of a rename against the declared region", async () => {
    const environment = await fixture();
    await rename(
      join(environment.worktree.path, "src", "rename.ts"),
      join(environment.worktree.path, "docs", "renamed.ts"),
    );
    const staged = await environment.git.stagePaths(
      environment.worktree,
      ["src/rename.ts", "docs/renamed.ts"],
      { idempotencyKey: "stage:rename" },
    );
    expect(staged.ok).toBe(true);

    const result = await new GitPreflight(environment.git).inspect({
      worktree: environment.worktree,
      declaredRegions: [{ path: "src", coverage: "subtree" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findings).toContainEqual({
      code: "outside_declared_region",
      path: "docs/renamed.ts",
    });
    expect(result.value.findings).toContainEqual({
      code: "preexisting_staged_change",
      path: "docs/renamed.ts",
    });
    expect(result.value.changedPaths).toEqual(["docs/renamed.ts", "src/rename.ts"]);
  });

  it("allows sequential work without declared regions but marks scope unverified", async () => {
    const environment = await fixture();
    await writeFile(
      join(environment.worktree.path, "src", "base.ts"),
      "export const sequential = true;\n",
      "utf8",
    );
    const result = await new GitPreflight(environment.git).inspect({
      worktree: environment.worktree,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ allowed: true, scopeVerified: false, findings: [] });
  });

  it("fails closed for oversized files, dangling symlinks, and malformed policy input", async () => {
    const environment = await fixture();
    await writeFile(join(environment.worktree.path, "src", "large.bin"), "12345", "utf8");
    await symlink("missing.ts", join(environment.worktree.path, "src", "dangling"));
    const preflight = new GitPreflight(environment.git, { maximumScanBytes: 4 });
    const result = await preflight.inspect({
      worktree: environment.worktree,
      declaredRegions: [{ path: "src", coverage: "subtree" }],
      expectedUntrackedPaths: ["src/large.bin", "src/dangling"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findings).toEqual([
      { code: "unsafe_symlink", path: "src/dangling" },
      { code: "unscannable_file", path: "src/large.bin" },
    ]);

    const malformed = await preflight.inspect({
      worktree: environment.worktree,
      knownSecrets: ["x"],
    });
    expect(malformed.ok ? "ok" : malformed.error.code).toBe("external_failure");
  });

  /**
   * C015m: `.gitattributes` selects which clean/process filter or diff driver `git` runs for a
   * path (see `git help gitattributes`) -- a provider-writable `.gitattributes` is a
   * config-driven code-execution surface in its own right if a trusted repository's config ever
   * defines an executable filter/diff driver. This ticket's policy: reject *any* change to *any*
   * `.gitattributes` file unconditionally, with a fixed, dedicated finding code -- regardless of
   * `declaredRegions` (it must fail closed even if a task's own declared regions happen to cover
   * the repository root).
   */
  it("rejects any .gitattributes change unconditionally, even inside a declared region", async () => {
    const environment = await fixture();
    await writeFile(join(environment.worktree.path, ".gitattributes"), "* -text\n", "utf8");
    await mkdir(join(environment.worktree.path, "src", "nested"));
    await writeFile(
      join(environment.worktree.path, "src", "nested", ".gitattributes"),
      "*.bin filter=lfs\n",
      "utf8",
    );

    const result = await new GitPreflight(environment.git).inspect({
      worktree: environment.worktree,
      // Both changed paths are deliberately *inside* their own declared region -- proves the
      // rejection is unconditional, not just an incidental outside_declared_region finding.
      declaredRegions: [
        { path: ".gitattributes", coverage: "exact" },
        { path: "src", coverage: "subtree" },
      ],
      expectedUntrackedPaths: [".gitattributes", "src/nested/.gitattributes"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.allowed).toBe(false);
    expect(result.value.findings).toEqual([
      { code: "gitattributes_modified", path: ".gitattributes" },
      { code: "gitattributes_modified", path: "src/nested/.gitattributes" },
    ]);
  });
});
