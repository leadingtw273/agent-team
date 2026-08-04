import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalGitAdapter } from "../../src/adapters/git/index.js";
import type { GitWorktree } from "../../src/application/ports/index.js";

interface GitFixture {
  readonly root: string;
  readonly repository: string;
  readonly remote: string;
}

const temporaryDirectories: string[] = [];

function runGit(cwd: string, arguments_: readonly string[]): Promise<string> {
  return new Promise((resolveOutput, rejectOutput) => {
    execFile("git", [...arguments_], { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error === null) {
        resolveOutput(stdout);
      } else {
        rejectOutput(new Error(stderr));
      }
    });
  });
}

function mutation(idempotencyKey: string) {
  return { idempotencyKey };
}

async function createFixture(): Promise<GitFixture> {
  const root = await mkdtemp(join(tmpdir(), "agent-team-git-adapter-"));
  temporaryDirectories.push(root);
  const repository = join(root, "primary");
  const remote = join(root, "remote.git");
  await mkdir(repository);
  await runGit(root, ["init", "--bare", "--initial-branch=main", remote]);
  await runGit(repository, ["init", "--initial-branch=main"]);
  await runGit(repository, ["config", "user.name", "Agent Team Test"]);
  await runGit(repository, ["config", "user.email", "agent-team@example.invalid"]);
  await writeFile(join(repository, "README.md"), "main checkout sentinel\n", "utf8");
  await writeFile(join(repository, "delete.txt"), "delete me\n", "utf8");
  await writeFile(join(repository, "rename-old.txt"), "rename me without content change\n", "utf8");
  await writeFile(join(repository, "script.sh"), "#!/bin/sh\nexit 0\n", "utf8");
  await runGit(repository, ["add", "--", "."]);
  await runGit(repository, ["commit", "-m", "initial"]);
  await runGit(repository, ["remote", "add", "origin", remote]);
  await runGit(repository, ["push", "-u", "origin", "main"]);
  return { root, repository, remote };
}

async function createWorktree(
  adapter: LocalGitAdapter,
  fixture: GitFixture,
  branch = "feature/FIX-1-local-git",
): Promise<GitWorktree> {
  const repository = await adapter.inspectRepository({ rootPath: fixture.repository });
  if (!repository.ok) throw new Error(repository.error.code);
  const created = await adapter.createWorktree(
    {
      rootPath: fixture.repository,
      path: join(fixture.root, "worktree"),
      branch,
      startPoint: repository.value.headSha,
    },
    mutation(`create:${branch}`),
  );
  if (!created.ok) throw new Error(created.error.code);
  return created.value;
}

beforeEach(() => {
  temporaryDirectories.splice(0);
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("local Git adapter", () => {
  it("runs the worktree, diff, commit, push, and removal lifecycle without touching primary", async () => {
    const fixture = await createFixture();
    const adapter = new LocalGitAdapter();
    const primaryBefore = await adapter.inspectRepository({ rootPath: fixture.repository });
    expect(primaryBefore.ok).toBe(true);
    if (!primaryBefore.ok) return;
    const worktree = await createWorktree(adapter, fixture);

    await rename(join(worktree.path, "rename-old.txt"), join(worktree.path, "renamed.txt"));
    await rm(join(worktree.path, "delete.txt"));
    await chmod(join(worktree.path, "script.sh"), 0o755);
    await writeFile(join(worktree.path, "new file.txt"), "new content\n", "utf8");
    await symlink("README.md", join(worktree.path, "readme-link"));

    const unstaged = await adapter.inspectWorkingTree(worktree);
    expect(unstaged.ok).toBe(true);
    if (!unstaged.ok) return;
    expect(unstaged.value.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "new file.txt", kind: "untracked", staged: false }),
        expect.objectContaining({ path: "readme-link", kind: "untracked", mode: "symlink" }),
        expect.objectContaining({ path: "script.sh", kind: "modified", mode: "executable" }),
      ]),
    );

    const staged = await adapter.stagePaths(
      worktree,
      ["delete.txt", "rename-old.txt", "renamed.txt", "script.sh", "new file.txt", "readme-link"],
      mutation("stage:lifecycle"),
    );
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(staged.value.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "delete.txt", kind: "deleted", staged: true }),
        expect.objectContaining({
          path: "renamed.txt",
          previousPath: "rename-old.txt",
          kind: "renamed",
          staged: true,
        }),
        expect.objectContaining({ path: "readme-link", kind: "added", mode: "symlink" }),
        expect.objectContaining({ path: "script.sh", kind: "modified", mode: "executable" }),
      ]),
    );
    const expectedStagedPaths = staged.value.changes
      .filter((change) => change.staged)
      .map((change) => change.path);
    const committed = await adapter.commit(
      { worktree, message: "feat: exercise local Git adapter", expectedStagedPaths },
      mutation("commit:lifecycle"),
    );
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;

    const primaryAfter = await adapter.inspectRepository({ rootPath: fixture.repository });
    expect(primaryAfter).toEqual(primaryBefore);
    expect(await readFile(join(fixture.repository, "README.md"), "utf8")).toBe(
      "main checkout sentinel\n",
    );
    expect(await runGit(fixture.repository, ["status", "--porcelain=v1"])).toBe("");

    const diff = await adapter.getEffectiveTreeDiff(
      { rootPath: fixture.repository },
      primaryBefore.value.headSha,
      committed.value.sha,
    );
    expect(diff.ok).toBe(true);
    if (!diff.ok) return;
    const added = diff.value.find((change) => change.after?.path === "new file.txt");
    const deleted = diff.value.find((change) => change.before?.path === "delete.txt");
    const renamedChange = diff.value.find((change) => change.after?.path === "renamed.txt");
    const modeChange = diff.value.find((change) => change.after?.path === "script.sh");
    expect(added?.before).toBeNull();
    expect(deleted?.after).toBeNull();
    expect(renamedChange?.before?.path).toBe("rename-old.txt");
    expect(modeChange?.before?.mode).toBe("100644");
    expect(modeChange?.after?.mode).toBe("100755");

    const pushed = await adapter.push(worktree, "origin", mutation("push:lifecycle"));
    expect(pushed).toEqual({
      ok: true,
      value: {
        remote: "origin",
        branch: worktree.branch,
        sha: committed.value.sha,
      },
    });
    expect(
      (await runGit(fixture.repository, ["ls-remote", "origin", `refs/heads/${worktree.branch}`]))
        .trim()
        .split(/\s+/u)[0],
    ).toBe(committed.value.sha);

    await expect(adapter.removeWorktree(worktree, mutation("remove:lifecycle"))).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(await adapter.inspectRepository({ rootPath: fixture.repository })).toEqual(
      primaryBefore,
    );
  });

  it("makes create idempotent but rejects a forged branch or the primary checkout", async () => {
    const fixture = await createFixture();
    const adapter = new LocalGitAdapter();
    const worktree = await createWorktree(adapter, fixture, "feature/FIX-2-idempotent");
    const repeated = await adapter.createWorktree(
      {
        rootPath: fixture.repository,
        path: worktree.path,
        branch: worktree.branch,
        startPoint: worktree.headSha,
      },
      mutation("create:repeated"),
    );
    expect(repeated).toEqual({ ok: true, value: worktree });

    const forged = await adapter.inspectWorktree({ ...worktree, branch: "feature/wrong" });
    expect(forged.ok ? "ok" : forged.error.code).toBe("conflict");
    const swappedPrimary = await adapter.inspectWorktree({
      repositoryRoot: worktree.path,
      path: fixture.repository,
      branch: "main",
      headSha: worktree.headSha,
    });
    expect(swappedPrimary.ok ? "ok" : swappedPrimary.error.code).toBe("conflict");
    const primaryCollision = await adapter.createWorktree(
      {
        rootPath: fixture.repository,
        path: fixture.repository,
        branch: "feature/FIX-3-collision",
        startPoint: worktree.headSha,
      },
      mutation("create:collision"),
    );
    expect(primaryCollision.ok ? "ok" : primaryCollision.error.code).toBe("conflict");
    const nestedCollision = await adapter.createWorktree(
      {
        rootPath: fixture.repository,
        path: join(fixture.repository, "nested-worktree"),
        branch: "feature/FIX-3-nested-collision",
        startPoint: worktree.headSha,
      },
      mutation("create:nested-collision"),
    );
    expect(nestedCollision.ok ? "ok" : nestedCollision.error.code).toBe("conflict");
    expect(await runGit(fixture.repository, ["status", "--porcelain=v1"])).toBe("");
    expect(await adapter.removeWorktree(worktree, mutation("remove:idempotent"))).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("refuses commits with an incomplete staged allowlist and refuses dirty removal", async () => {
    const fixture = await createFixture();
    const adapter = new LocalGitAdapter();
    const worktree = await createWorktree(adapter, fixture, "feature/FIX-4-staging");
    await writeFile(join(worktree.path, "a.txt"), "a\n", "utf8");
    await writeFile(join(worktree.path, "b.txt"), "b\n", "utf8");
    const staged = await adapter.stagePaths(
      worktree,
      ["a.txt", "b.txt"],
      mutation("stage:two-files"),
    );
    expect(staged.ok).toBe(true);

    const rejected = await adapter.commit(
      { worktree, message: "must not commit b", expectedStagedPaths: ["a.txt"] },
      mutation("commit:incomplete"),
    );
    expect(rejected.ok ? "ok" : rejected.error.code).toBe("conflict");
    const removal = await adapter.removeWorktree(worktree, mutation("remove:dirty"));
    expect(removal.ok ? "ok" : removal.error.code).toBe("conflict");
    expect((await runGit(worktree.path, ["rev-list", "--count", "HEAD"])).trim()).toBe("1");
  });

  it("maps an aborted request and a missing Git binary without leaking process errors", async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    controller.abort();
    const interrupted = await new LocalGitAdapter().inspectRepository(
      { rootPath: fixture.repository },
      { signal: controller.signal },
    );
    expect(interrupted.ok ? "ok" : interrupted.error.code).toBe("interrupted");

    const unavailable = await new LocalGitAdapter({
      executable: "agent-team-git-command-that-does-not-exist",
    }).inspectRepository({ rootPath: fixture.repository });
    expect(unavailable.ok ? "ok" : unavailable.error.code).toBe("unavailable");
  });

  it("rejects option-like revisions and executable remote helper URLs", async () => {
    const fixture = await createFixture();
    const adapter = new LocalGitAdapter();
    const invalidRevision = await adapter.getEffectiveTreeDiff(
      { rootPath: fixture.repository },
      "--output=/tmp/agent-team-must-not-write",
      "HEAD",
    );
    expect(invalidRevision.ok ? "ok" : invalidRevision.error.code).toBe("external_failure");

    const worktree = await createWorktree(adapter, fixture, "feature/FIX-5-remote-safety");
    const marker = join(fixture.root, "remote-helper-executed");
    await runGit(worktree.path, ["remote", "add", "dangerous", `ext::sh -c touch% ${marker}`]);
    const pushed = await adapter.push(worktree, "dangerous", mutation("push:dangerous"));
    expect(pushed.ok ? "ok" : pushed.error.code).toBe("external_failure");
    await expect(access(marker)).rejects.toThrow();
    expect(await adapter.removeWorktree(worktree, mutation("remove:remote-safety"))).toEqual({
      ok: true,
      value: undefined,
    });
  });
});
