/**
 * E102-3: real, end-to-end proof that `VisualEvidenceBuilder` actually drives the real Agent
 * Team sandbox's own compiled CLIs (`dist/scripts/screenshot.js` -- a real headless Playwright
 * screenshot, not a fake -- and `dist/scripts/generate-manifest.js`) through the exact same
 * `ChildProcessRunner`/argv-template contract production uses, end to end: real `git`
 * check-ignore gate, real subprocess spawn (no fake `ProcessPort` anywhere in this file, unlike
 * tests/unit/visual-evidence-builder.test.ts's fixture-command-based coverage of the builder's own
 * decision logic), real Playwright screenshot bytes, real SHA-256 re-verification, real atomic
 * rename.
 *
 * Gated, not part of the mandatory `tests/unit`/`tests/contract` merge gate: this needs a local
 * checkout of the (separate, sibling) `agent-team-sandbox` repository already built
 * (`dist/scripts/*.js` present) and a working Playwright Chromium install in that repo's own
 * `node_modules` -- neither is guaranteed to exist in every environment this repository's tests
 * run in. Skips cleanly (never fails the suite) when the sandbox checkout is not found at its
 * known local path; if the checkout exists but Chromium cannot launch, the one test in this file
 * fails loudly rather than silently skipping (that combination signals a real, fixable local
 * environment problem, not "sandbox not present").
 */
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { VisualEvidenceBuilder } from "../../src/application/pipelines/visual-evidence-builder.js";
import { ChildProcessRunner } from "../../src/adapters/process/index.js";
import { createClock, parseInstant } from "../../src/domain/foundation/index.js";

const run = promisify(execFile);

/** Fixed, this-machine-only path to the sibling sandbox checkout (see memory
 * `project_agent_team.md`/E002-E003) -- not configurable via env because this test is explicitly
 * a local, gated convenience check, never a CI dependency. */
const sandboxRepositoryPath = "/home/markchou/project/agent-team-sandbox";
const sandboxDistScriptsPath = join(sandboxRepositoryPath, "dist", "scripts", "screenshot.js");
const sandboxAvailable = existsSync(sandboxDistScriptsPath);

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

/** Builds a throwaway target-worktree fixture: a real git repo containing a copy of the
 * sandbox's compiled `dist/`+`fixtures/` (small, ~200KB -- copied, not symlinked, so this test
 * never risks writing into the real sandbox checkout) plus a symlink to the sandbox's own
 * `node_modules` (large, includes the Playwright browser download -- symlinked, never copied). */
async function buildSandboxWorktreeFixture(): Promise<string> {
  const worktreePath = await temporaryDirectory("agent-team-e102-3-sandbox-worktree-");
  await cp(join(sandboxRepositoryPath, "dist"), join(worktreePath, "dist"), { recursive: true });
  await cp(join(sandboxRepositoryPath, "fixtures"), join(worktreePath, "fixtures"), {
    recursive: true,
  });
  await writeFile(join(worktreePath, "package.json"), JSON.stringify({ type: "module" }));
  await symlink(
    join(sandboxRepositoryPath, "node_modules"),
    join(worktreePath, "node_modules"),
    "dir",
  );
  await writeFile(join(worktreePath, ".gitignore"), ".agent-team/evidence/\n");
  await run("git", ["init", "--quiet", "--initial-branch=main", worktreePath]);
  await run("git", ["-C", worktreePath, "config", "user.email", "test@example.com"]);
  await run("git", ["-C", worktreePath, "config", "user.name", "Test"]);
  await run("git", ["-C", worktreePath, "add", "-A"]);
  await run("git", ["-C", worktreePath, "commit", "--quiet", "-m", "sandbox fixture"]);
  return worktreePath;
}

describe.skipIf(!sandboxAvailable)(
  "VisualEvidenceBuilder against the real agent-team-sandbox CLIs (gated, local-only)",
  () => {
    it("runs the real screenshot + generate-manifest CLIs through the real ChildProcessRunner and produces verified evidence", async () => {
      const worktreePath = await buildSandboxWorktreeFixture();
      const { stdout: headShaOutput } = await run("git", ["-C", worktreePath, "rev-parse", "HEAD"]);
      const headSha = headShaOutput.trim();
      const deadline = parseInstant(new Date(Date.now() + 5 * 60_000).toISOString());
      if (!deadline.ok) throw new Error(deadline.error.code);

      const builder = new VisualEvidenceBuilder({
        process: new ChildProcessRunner(),
        clock: createClock(),
      });

      const result = await builder.build({
        worktreePath,
        issueId: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab" as never,
        headSha,
        commands: [
          {
            executable: "node",
            arguments: ["dist/scripts/screenshot.js", "--mode=none", "--out={{evidenceDir}}"],
          },
          {
            executable: "node",
            arguments: [
              "dist/scripts/generate-manifest.js",
              "--dir={{evidenceDir}}",
              "--out={{evidenceDir}}/visual-manifest.json",
            ],
          },
        ],
        // Matches `generate-manifest.ts`'s own fixed `ARTIFACT_METADATA` mapping for
        // `status-none.png` -- see that file's own header in the sandbox repo.
        allowedAcceptanceCriteria: ["sandbox-e2e:E101:AC1-status-page-renders-healthy"],
        deadlineAt: deadline.value,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.visualManifest.artifacts).toHaveLength(1);
      const [artifact] = result.value.visualManifest.artifacts;
      if (artifact === undefined) throw new Error("expected one artifact");
      expect(artifact.path).toBe(
        `.agent-team/evidence/issue_018f47d2-77a4-7cc1-8ef2-0123456789ab/${headSha}/status-none.png`,
      );

      // A real PNG (Playwright's own screenshot bytes), not a fixture stand-in.
      const pngBytes = await readFile(join(worktreePath, artifact.path));
      expect(pngBytes.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );

      const { stdout: status } = await run("git", ["-C", worktreePath, "status", "--porcelain"]);
      expect(status.trim()).toBe("");
    }, 120_000);
  },
);
