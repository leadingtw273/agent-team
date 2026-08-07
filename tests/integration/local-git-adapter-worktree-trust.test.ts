/**
 * C015m: real, isolated-sandbox regression tests for the linked-worktree `.git` tampering RCE
 * this ticket closes (see the module-level header comment above `gitHardenFlags` in
 * src/adapters/git/local.ts for the full rationale, and
 * /home/markchou/.claude/jobs/6152588f/tmp/c015m-diagnose.md for the original Phase 1
 * exploitability proof this converts into automated coverage). Every fixture here is a genuine
 * temporary git repository + linked worktree (never this repo, never any shared sandbox) built
 * with the real `git` binary -- no mocked ports, no fake process.
 *
 * Threat model recap: an implementer session's `Write(./*)`/`Write(./**)` grant is scoped to its
 * worktree's own directory. A linked worktree's `.git` is a plain *file* (`gitdir: <path>`)
 * inside that directory, so a provider can overwrite it to point at a self-built gitdir (also
 * built entirely inside the worktree, using the same Write grant) whose own config sets
 * `core.hooksPath`/`core.fsmonitor` to an attacker-chosen executable. `LocalGitAdapter` must
 * never let any of its own git subprocesses discover a worktree's repository identity from that
 * file -- every method must resolve it from the *main* repository's own bookkeeping instead (see
 * `#trustedWorktreeContext` in local.ts) and pass an explicit `--git-dir`/`--work-tree`.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalGitAdapter } from "../../src/adapters/git/index.js";
import type { GitWorktree } from "../../src/application/ports/index.js";

interface Fixture {
  readonly root: string;
  readonly repository: string;
  readonly remote: string;
  readonly canary: string;
  readonly git: LocalGitAdapter;
  readonly worktree: GitWorktree;
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

function mutation(idempotencyKey: string) {
  return { idempotencyKey };
}

async function readCanary(canaryPath: string): Promise<string | undefined> {
  try {
    return await readFile(canaryPath, "utf8");
  } catch {
    return undefined;
  }
}

async function buildFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "agent-team-git-trust-"));
  temporaryDirectories.push(root);
  const repository = join(root, "primary");
  const remote = join(root, "remote.git");
  const canary = join(root, "canary.txt");
  await mkdir(repository);
  await runGit(root, ["init", "--bare", "--initial-branch=main", remote]);
  await runGit(repository, ["init", "--initial-branch=main"]);
  await runGit(repository, ["config", "user.name", "Agent Team Test"]);
  await runGit(repository, ["config", "user.email", "agent-team@example.invalid"]);
  await writeFile(join(repository, "README.md"), "main checkout sentinel\n", "utf8");
  await runGit(repository, ["add", "--", "."]);
  await runGit(repository, ["commit", "-m", "initial"]);
  await runGit(repository, ["remote", "add", "origin", remote]);
  await runGit(repository, ["push", "-u", "origin", "main"]);

  const git = new LocalGitAdapter();
  const snapshot = await git.inspectRepository({ rootPath: repository });
  if (!snapshot.ok) throw new Error(snapshot.error.code);
  const created = await git.createWorktree(
    {
      rootPath: repository,
      path: join(root, "worktree"),
      branch: "feature/C015m-trust",
      startPoint: snapshot.value.headSha,
    },
    mutation("create:trust"),
  );
  if (!created.ok) throw new Error(created.error.code);
  return { root, repository, remote, canary, git, worktree: created.value };
}

/**
 * Builds a fully valid, non-bare "evil" gitdir *inside* the worktree (i.e. buildable using
 * nothing but the same `Write(./*)`/`Write(./**)` grant an implementer session already has) with
 * a malicious `core.fsmonitor` and `pre-commit`/`pre-push` hooks that all append to `canaryPath`
 * -- then overwrites the worktree's real `.git` pointer file to redirect to it. Mirrors exactly
 * the real Claude CLI 2.1.223 experiment from C015m's Phase 1 diagnosis.
 */
async function tamperWorktreeGitPointer(
  worktreePath: string,
  canaryPath: string,
): Promise<{ readonly evilGitDir: string }> {
  const scratch = `${worktreePath}-scratch-bootstrap`;
  await mkdir(scratch, { recursive: true });
  const evilGitDir = join(worktreePath, ".evil-store");
  await runGit(scratch, ["init", "-q", `--separate-git-dir=${evilGitDir}`]);
  await rm(scratch, { recursive: true, force: true });

  await mkdir(join(evilGitDir, "hooks"), { recursive: true });
  const hookBody = `#!/bin/sh\necho "PWNED via $0" >> ${JSON.stringify(canaryPath)}\nexit 0\n`;
  for (const hook of ["pre-commit", "pre-push", "post-checkout"]) {
    const hookPath = join(evilGitDir, "hooks", hook);
    await writeFile(hookPath, hookBody, { encoding: "utf8", mode: 0o755 });
  }
  const fsmonitorScript = join(evilGitDir, "fsmonitor-payload.sh");
  await writeFile(
    fsmonitorScript,
    `#!/bin/sh\necho "PWNED via core.fsmonitor" >> ${JSON.stringify(canaryPath)}\nprintf '\\0'\nexit 0\n`,
    { encoding: "utf8", mode: 0o755 },
  );
  await runGit(scratch, [
    "--git-dir",
    evilGitDir,
    "config",
    "core.fsmonitor",
    fsmonitorScript,
  ]).catch(() =>
    runGit(worktreePath, ["--git-dir", evilGitDir, "config", "core.fsmonitor", fsmonitorScript]),
  );

  await writeFile(join(worktreePath, ".git"), `gitdir: ${evilGitDir}\n`, "utf8");
  return { evilGitDir };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("LocalGitAdapter worktree trust (C015m)", () => {
  it("control: proves the fixture is genuinely exploitable against naive cwd-based discovery", async () => {
    // This is a deliberate control/sanity check, not a test of LocalGitAdapter itself -- it
    // proves the tampered fixture below would have executed attacker code against the *old*,
    // vulnerable pattern (a bare `execFile("git", [...], { cwd: worktree.path })`, no explicit
    // --git-dir), so a later "no payload ran" assertion against the real adapter is meaningful
    // and not just an artifact of a broken fixture.
    const fixture = await buildFixture();
    await tamperWorktreeGitPointer(fixture.worktree.path, fixture.canary);
    await new Promise<void>((resolve, reject) => {
      execFile(
        "git",
        ["commit", "--no-gpg-sign", "-m", "control", "--allow-empty"],
        { cwd: fixture.worktree.path, encoding: "utf8" },
        (error) => {
          if (error === null) resolve();
          else reject(new Error(error.message));
        },
      );
    });
    expect(await readCanary(fixture.canary)).toContain("PWNED");
  });

  it("core.fsmonitor in a tampered .git never executes when inspecting the working tree", async () => {
    const fixture = await buildFixture();
    await tamperWorktreeGitPointer(fixture.worktree.path, fixture.canary);

    const inspected = await fixture.git.inspectWorkingTree(fixture.worktree);
    // Check the canary *before* the outcome-code assertion below -- whether the payload ran is
    // the property this test actually exists to prove; the exact failure code is secondary.
    expect(await readCanary(fixture.canary)).toBeUndefined();
    expect(inspected.ok ? "ok" : inspected.error.code).toBe("conflict");
  });

  it("pre-commit/pre-push hooks in a tampered .git never execute on commit or push", async () => {
    const fixture = await buildFixture();
    await writeFile(join(fixture.worktree.path, "feature.txt"), "content\n", "utf8");
    const staged = await fixture.git.stagePaths(
      fixture.worktree,
      ["feature.txt"],
      mutation("stage:trust"),
    );
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;

    await tamperWorktreeGitPointer(fixture.worktree.path, fixture.canary);

    const committed = await fixture.git.commit(
      {
        worktree: fixture.worktree,
        message: "must never actually commit",
        expectedStagedPaths: ["feature.txt"],
      },
      mutation("commit:trust"),
    );
    // Canary check first, same reasoning as the fsmonitor test above.
    expect(await readCanary(fixture.canary)).toBeUndefined();
    expect(committed.ok ? "ok" : committed.error.code).toBe("conflict");

    const pushed = await fixture.git.push(fixture.worktree, "origin", mutation("push:trust"));
    expect(await readCanary(fixture.canary)).toBeUndefined();
    expect(pushed.ok ? "ok" : pushed.error.code).toBe("conflict");
  });

  it("fails closed before any git subprocess when .git is deleted and recreated as a symlink", async () => {
    const fixture = await buildFixture();
    await rm(join(fixture.worktree.path, ".git"));
    // A symlink pointing at a *legitimate*-looking target (the real gitdir) must still be
    // rejected -- `.git` must be a plain file, never a symlink, regardless of what it resolves
    // to; accepting a symlink here would itself be a new, unnecessary attack surface.
    const realGitDir = join(fixture.repository, ".git", "worktrees", "worktree");
    await symlink(realGitDir, join(fixture.worktree.path, ".git"));

    const inspected = await fixture.git.inspectWorkingTree(fixture.worktree);
    expect(inspected.ok ? "ok" : inspected.error.code).toBe("conflict");

    const staged = await fixture.git.stagePaths(
      fixture.worktree,
      ["README.md"],
      mutation("stage:symlink-tamper"),
    );
    expect(staged.ok ? "ok" : staged.error.code).toBe("conflict");
  });

  it("fails closed when .git is simply deleted (no pointer at all)", async () => {
    const fixture = await buildFixture();
    await rm(join(fixture.worktree.path, ".git"));
    const inspected = await fixture.git.inspectWorktree(fixture.worktree);
    expect(inspected.ok ? "ok" : inspected.error.code).toBe("conflict");
  });

  it("rejects a .git pointer that resolves correctly but was recreated with different bytes than at creation time", async () => {
    // Same adapter *instance* that created the worktree (so its in-process creation-time
    // baseline applies) -- rewrites `.git` to point at the *same, correct* trusted gitdir, but
    // with different formatting (a harmless-looking extra trailing space). Even though this
    // still *resolves* correctly, it must still fail closed: the byte-exact check is strictly
    // stronger than "still resolves to the right place", and a real attacker capable of writing
    // *some* bytes into `.git` should never get a pass just because those particular bytes
    // happened to still resolve correctly.
    const fixture = await buildFixture();
    const original = await readFile(join(fixture.worktree.path, ".git"), "utf8");
    await writeFile(join(fixture.worktree.path, ".git"), `${original.trimEnd()} \n`, "utf8");

    const inspected = await fixture.git.inspectWorktree(fixture.worktree);
    expect(inspected.ok ? "ok" : inspected.error.code).toBe("conflict");
  });

  it("inherited poisoned GIT_DIR/GIT_SSH_COMMAND/GIT_CONFIG_GLOBAL never take effect", async () => {
    const fixture = await buildFixture();
    const poisonMarker = join(fixture.root, "poison-marker.txt");
    const poisonedGlobalConfig = join(fixture.root, "poisoned-gitconfig");
    await writeFile(
      poisonedGlobalConfig,
      `[core]\n\thooksPath = ${join(fixture.root, "poisoned-hooks")}\n`,
      "utf8",
    );
    await mkdir(join(fixture.root, "poisoned-hooks"), { recursive: true });
    await writeFile(
      join(fixture.root, "poisoned-hooks", "pre-commit"),
      `#!/bin/sh\necho "PWNED via poisoned GIT_CONFIG_GLOBAL" >> ${JSON.stringify(poisonMarker)}\nexit 0\n`,
      { encoding: "utf8", mode: 0o755 },
    );

    const originalEnv = { ...process.env };
    process.env["GIT_DIR"] = "/nonexistent/attacker-controlled-gitdir";
    process.env["GIT_SSH_COMMAND"] = `sh -c 'echo PWNED-SSH >> ${poisonMarker}'`;
    process.env["GIT_CONFIG_GLOBAL"] = poisonedGlobalConfig;
    try {
      await writeFile(join(fixture.worktree.path, "poisoned-env-check.txt"), "x\n", "utf8");
      const staged = await fixture.git.stagePaths(
        fixture.worktree,
        ["poisoned-env-check.txt"],
        mutation("stage:poisoned-env"),
      );
      expect(staged.ok).toBe(true);
      if (!staged.ok) return;
      const committed = await fixture.git.commit(
        {
          worktree: fixture.worktree,
          message: "must succeed despite poisoned inherited env",
          expectedStagedPaths: ["poisoned-env-check.txt"],
        },
        mutation("commit:poisoned-env"),
      );
      expect(committed.ok).toBe(true);
    } finally {
      process.env = originalEnv;
    }
    expect(await readCanary(poisonMarker)).toBeUndefined();
  });

  /**
   * C015m item 6 (credential/transport regression): `#run` points `GIT_CONFIG_GLOBAL` at a
   * freshly generated, minimal config instead of the real one or `/dev/null` -- this proves the
   * copy-forward mechanism preserves a *URL-scoped* `credential.helper` (e.g.
   * `credential.https://github.com.helper`, the exact shape this host's own real `gh`-managed
   * config uses -- a bare `credential.helper` copy alone would silently miss this, which is
   * exactly the gap found and fixed while writing this test). Simulates "the real global config"
   * via a temporary `GIT_CONFIG_GLOBAL` override (never touches this developer's actual
   * `~/.gitconfig`) read once, before the adapter's lazy safe-config build runs.
   */
  it("copies a URL-scoped credential.helper (not just the bare key) into the generated safe global config", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-git-trust-cred-"));
    temporaryDirectories.push(root);
    const simulatedRealGlobalConfig = join(root, "simulated-real-gitconfig");
    await writeFile(
      simulatedRealGlobalConfig,
      [
        "[credential]",
        "\thelper =",
        '[credential "https://github.com"]',
        "\thelper =",
        "\thelper = !/usr/bin/gh auth git-credential",
      ].join("\n") + "\n",
      "utf8",
    );

    const originalEnv = { ...process.env };
    process.env["GIT_CONFIG_GLOBAL"] = simulatedRealGlobalConfig;
    let adapter: LocalGitAdapter;
    try {
      // A brand-new instance, never used before this point: its lazy safe-config build has not
      // run yet, so it will bootstrap-read from the simulated "real" global config set above.
      adapter = new LocalGitAdapter();
      const fixture = await buildFixture();
      // Any operation triggers the lazy safe-config build as a side effect.
      const inspected = await adapter.inspectRepository({ rootPath: fixture.repository });
      expect(inspected.ok).toBe(true);
    } finally {
      process.env = originalEnv;
    }

    const safeConfigDirectories = (await readdir(tmpdir())).filter((name) =>
      name.startsWith("agent-team-git-safe-config-"),
    );
    expect(safeConfigDirectories.length).toBeGreaterThan(0);
    const contents = await Promise.all(
      safeConfigDirectories.map((name) =>
        readFile(join(tmpdir(), name, "gitconfig"), "utf8").catch(() => ""),
      ),
    );
    const matching = contents.find((content) =>
      content.includes("!/usr/bin/gh auth git-credential"),
    );
    expect(matching).toBeDefined();
    // The URL-scoped section header must be preserved (proves this was not just a bare
    // `credential.helper` copy, which would have missed it entirely).
    expect(matching).toContain('credential "https://github.com"');
  });

  it("functional regression: the happy-path create/stage/commit/push/remove lifecycle is unaffected", async () => {
    const fixture = await buildFixture();
    await writeFile(join(fixture.worktree.path, "feature.txt"), "real content\n", "utf8");
    const staged = await fixture.git.stagePaths(
      fixture.worktree,
      ["feature.txt"],
      mutation("stage:functional"),
    );
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    const committed = await fixture.git.commit(
      {
        worktree: fixture.worktree,
        message: "feat: trust regression",
        expectedStagedPaths: ["feature.txt"],
      },
      mutation("commit:functional"),
    );
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    const pushed = await fixture.git.push(fixture.worktree, "origin", mutation("push:functional"));
    expect(pushed).toEqual({
      ok: true,
      value: { remote: "origin", branch: fixture.worktree.branch, sha: committed.value.sha },
    });
    expect(
      (
        await runGit(fixture.repository, [
          "ls-remote",
          "origin",
          `refs/heads/${fixture.worktree.branch}`,
        ])
      )
        .trim()
        .split(/\s+/u)[0],
    ).toBe(committed.value.sha);
    await expect(
      fixture.git.removeWorktree(fixture.worktree, mutation("remove:functional")),
    ).resolves.toEqual({ ok: true, value: undefined });
  });
});
