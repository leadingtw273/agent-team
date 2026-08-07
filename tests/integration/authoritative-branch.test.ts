/**
 * C015x decision 1 (acceptance criterion ①): real-git, hermetic integration tests for
 * `LocalGitAdapter.resolveAuthoritativeBranch` -- the git-level half (steps ②-⑤) of the
 * coordinator's five-step authoritative-base-resolution design (see that method's own header,
 * src/adapters/git/local.ts, and `GitPort.resolveAuthoritativeBranch`'s, application/ports/git.ts).
 *
 * Step ②'s identity check compares `git remote get-url <remote>`'s *reported* URL against
 * `expectedRepository` -- genuinely reaching a real `github.com` host in a hermetic test is neither
 * possible nor desirable, so the "identity passes, then fetch genuinely lands the commit" test below
 * uses a tiny `fakeGitRemoteUrl` wrapper (a thin Node script standing in for `git` itself, matching
 * this file's own `createFixture`'s established "real git, real filesystem, no network" discipline)
 * that intercepts only `remote get-url` calls to report a fixed `https://github.com/...` URL, while
 * every other invocation (`fetch`, `rev-parse`, `check-ref-format`, ...) is forwarded verbatim to the
 * real `git` binary against the real local bare-repo remote already wired up by `createFixture`.
 * This is an honest test of "given a remote whose *reported* URL matches `expectedRepository`, the
 * fetch/resolve steps genuinely succeed using whatever that remote actually resolves to" -- it never
 * fakes the fetch/resolve outcome itself, only the one line of output the identity check reads.
 */
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalGitAdapter } from "../../src/adapters/git/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

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

interface Fixture {
  readonly root: string;
  readonly repository: string;
  readonly remote: string;
}

/** Mirrors `tests/integration/local-git-adapter.test.ts`'s own `createFixture` exactly (a real,
 * initialized repo pushed to a real local bare "remote"), trimmed to only what this file needs. */
async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "agent-team-authoritative-branch-"));
  temporaryDirectories.push(root);
  const repository = join(root, "primary");
  const remote = join(root, "remote.git");
  await mkdir(repository);
  await runGit(root, ["init", "--bare", "--initial-branch=main", remote]);
  await runGit(repository, ["init", "--initial-branch=main"]);
  await runGit(repository, ["config", "user.name", "Agent Team Test"]);
  await runGit(repository, ["config", "user.email", "agent-team@example.invalid"]);
  await writeFile(join(repository, "README.md"), "sentinel\n", "utf8");
  await runGit(repository, ["add", "--", "."]);
  await runGit(repository, ["commit", "-m", "initial"]);
  await runGit(repository, ["remote", "add", "origin", remote]);
  await runGit(repository, ["push", "-u", "origin", "main"]);
  return { root, repository, remote };
}

/**
 * Writes a small executable Node script standing in for `git` -- forwards every invocation to the
 * real `git` binary verbatim (same argv, same cwd, same env, same exit code) *except* a `remote
 * get-url <name>` call, which instead prints `fakeUrl` and exits 0. `LocalGitAdapter`'s own
 * `gitHardenFlags` are always prepended to the real arguments, so this scans the whole argv for the
 * `["remote","get-url",...]` subsequence rather than assuming fixed positions.
 */
async function writeFakeGitRemoteUrlWrapper(root: string, fakeUrl: string): Promise<string> {
  const scriptPath = join(root, "fake-git.mjs");
  const script = `#!/usr/bin/env node
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
const idx = args.findIndex((value, index) => value === "remote" && args[index + 1] === "get-url");
if (idx !== -1) {
  process.stdout.write(${JSON.stringify(fakeUrl)} + "\\n");
  process.exit(0);
}
const child = spawn("git", args, { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
`;
  await writeFile(scriptPath, script, "utf8");
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

describe("LocalGitAdapter.resolveAuthoritativeBranch (C015x decision 1)", () => {
  it("fails closed on invalid input without ever invoking git", async () => {
    const fixture = await createFixture();
    const adapter = new LocalGitAdapter();

    const emptyKey = await adapter.resolveAuthoritativeBranch(
      {
        rootPath: fixture.repository,
        remote: "origin",
        branch: "main",
        expectedRepository: "owner/repo",
      },
      { idempotencyKey: "" },
    );
    const badRemote = await adapter.resolveAuthoritativeBranch(
      {
        rootPath: fixture.repository,
        remote: "-not-a-remote",
        branch: "main",
        expectedRepository: "owner/repo",
      },
      mutation("bad-remote"),
    );
    const badBranch = await adapter.resolveAuthoritativeBranch(
      {
        rootPath: fixture.repository,
        remote: "origin",
        branch: "-not-a-branch",
        expectedRepository: "owner/repo",
      },
      mutation("bad-branch"),
    );
    const badRepository = await adapter.resolveAuthoritativeBranch(
      {
        rootPath: fixture.repository,
        remote: "origin",
        branch: "main",
        expectedRepository: "not-owner-slash-repo",
      },
      mutation("bad-repository"),
    );

    expect(emptyKey.ok ? "ok" : emptyKey.error.code).toBe("external_failure");
    expect(badRemote.ok ? "ok" : badRemote.error.code).toBe("external_failure");
    expect(badBranch.ok ? "ok" : badBranch.error.code).toBe("external_failure");
    expect(badRepository.ok ? "ok" : badRepository.error.code).toBe("external_failure");
  });

  it("fails closed (conflict) when the local remote's real URL is not even github.com-shaped", async () => {
    // `createFixture`'s own `origin` is a real local bare-repo *path* -- exactly the shape a
    // production repository must never have (see `validRepository`'s own github.com-only
    // assumption, src/adapters/github/adapter.ts), and exactly the shape this step must reject.
    const fixture = await createFixture();
    const adapter = new LocalGitAdapter();

    const result = await adapter.resolveAuthoritativeBranch(
      {
        rootPath: fixture.repository,
        remote: "origin",
        branch: "main",
        expectedRepository: "owner/repo",
      },
      mutation("non-github-remote"),
    );

    expect(result.ok ? "ok" : result.error.code).toBe("conflict");
  });

  it("fails closed (conflict) when the remote is genuinely github.com-shaped but for a different owner/repo", async () => {
    const fixture = await createFixture();
    await runGit(fixture.repository, [
      "remote",
      "set-url",
      "origin",
      "https://github.com/someone-else/other-repo.git",
    ]);
    const adapter = new LocalGitAdapter();

    const result = await adapter.resolveAuthoritativeBranch(
      {
        rootPath: fixture.repository,
        remote: "origin",
        branch: "main",
        expectedRepository: "owner/repo",
      },
      mutation("wrong-owner-repo"),
    );

    // Identity mismatch is caught before any fetch is ever attempted -- no network call, no hang,
    // resolved purely from the string comparison.
    expect(result.ok ? "ok" : result.error.code).toBe("conflict");
  });

  it("fails closed when the branch does not exist on the remote (fetch fails, never trusts a stale local ref)", async () => {
    const fixture = await createFixture();
    const adapter = new LocalGitAdapter();

    const result = await adapter.resolveAuthoritativeBranch(
      {
        rootPath: fixture.repository,
        remote: "origin",
        branch: "this-branch-does-not-exist-anywhere",
        expectedRepository: "owner/repo",
      },
      mutation("missing-branch"),
    );

    expect(result.ok).toBe(false);
  });

  it("resolves the real, locally-fetched commit once identity passes and the branch genuinely exists (steps ②-⑤ all succeed)", async () => {
    const fixture = await createFixture();
    // A second, later commit on the *remote* (bare repo) that this test's local `origin`
    // remote-tracking ref does not yet know about -- the whole point of C015x: a stale local
    // clone must not be trusted, the fetch must genuinely bring this new commit down.
    const secondClone = join(fixture.root, "second-clone");
    await runGit(fixture.root, ["clone", "--quiet", fixture.remote, secondClone]);
    await runGit(secondClone, ["config", "user.name", "Agent Team Test"]);
    await runGit(secondClone, ["config", "user.email", "agent-team@example.invalid"]);
    await writeFile(join(secondClone, "second.txt"), "advance main\n", "utf8");
    await runGit(secondClone, ["add", "--", "."]);
    await runGit(secondClone, ["commit", "-m", "advance main"]);
    await runGit(secondClone, ["push", "origin", "main"]);
    const advancedSha = (await runGit(secondClone, ["rev-parse", "HEAD"])).trim();

    const fakeGit = await writeFakeGitRemoteUrlWrapper(
      fixture.root,
      "https://github.com/owner/repo.git",
    );
    const adapter = new LocalGitAdapter({ executable: fakeGit });

    const result = await adapter.resolveAuthoritativeBranch(
      {
        rootPath: fixture.repository,
        remote: "origin",
        branch: "main",
        expectedRepository: "owner/repo",
      },
      mutation("full-success"),
    );

    expect(result).toEqual({
      ok: true,
      value: { remote: "origin", branch: "main", sha: advancedSha },
    });
    // The commit is genuinely present locally now, not merely known by SHA -- `createWorktree`'s
    // `startPoint` and `getEffectiveTreeDiff`'s `baseRevision` both need this.
    const catFile = await runGit(fixture.repository, ["cat-file", "-e", advancedSha]).then(
      () => true,
      () => false,
    );
    expect(catFile).toBe(true);
  });
});
