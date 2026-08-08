/**
 * E102-3: exercises `VisualEvidenceBuilder` through the *real* `ChildProcessRunner` and a *real*
 * git repository -- unlike tests/unit/visual-evidence-builder.test.ts (a fully scripted, in-process
 * fake `ProcessPort` proving the builder's own decision logic) and
 * tests/integration/visual-evidence-builder-sandbox.test.ts (gated on a sibling sandbox checkout +
 * Playwright), this file needs nothing but `git` and `node` on PATH -- always runnable, no gating.
 * `commands.visualReview` here points at a tiny, throwaway Node script this file writes into the
 * fixture worktree itself, standing in for a real project's trusted command while still going
 * through the real, un-faked argv-template-render -> `ProcessPort.spawn` -> real subprocess path.
 *
 * This file exists because the real gitignore gate has one non-obvious edge (a bare,
 * not-yet-existing directory path is ambiguous to `git check-ignore` without a trailing slash --
 * a fully faked `ProcessPort` unit test cannot catch this; it was caught for real only by this
 * suite's sibling sandbox-gated test) -- keeping a real-git regression test unconditionally
 * runnable, not gated on the sandbox checkout, is deliberate.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  VisualEvidenceBuilder,
  type VisualEvidenceBuildRequest,
} from "../../src/application/pipelines/visual-evidence-builder.js";
import { ChildProcessRunner } from "../../src/adapters/process/index.js";
import { createClock, parseInstant } from "../../src/domain/foundation/index.js";

const run = promisify(execFile);
const issueId =
  "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab" as VisualEvidenceBuildRequest["issueId"];
const criterion = "AC1-status-page-renders-healthy";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-e102-3-real-executor-"));
  temporaryDirectories.push(directory);
  return directory;
}

const fixtureScript = `
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
const args = process.argv.slice(2);
const dir = args.find((a) => a.startsWith("--dir=")).slice("--dir=".length);
const pngBytes = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.from("real-executor-fixture")]);
const filePath = join(dir, "status-none.png");
writeFileSync(filePath, pngBytes);
// Mirrors the real sandbox's own \`generate-manifest.ts\` convention exactly: the path is
// worktree-relative, computed from the process's own cwd (the builder always spawns trusted
// commands with \`workingDirectory\` set to the worktree root) -- never a value passed in
// separately, so it is automatically correct whether this runs against the staging or (on a
// reuse path) any other directory.
const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd() }).toString().trim();
const manifest = {
  commitSha,
  environment: { runner: "real-executor-fixture", operatingSystem: "linux" },
  artifacts: [
    {
      path: relative(process.cwd(), filePath).split(sep).join("/"),
      mediaType: "image/png",
      sha256: "0".repeat(64),
      title: "Status page",
      acceptanceCriteria: ["${criterion}"],
    },
  ],
};
writeFileSync(join(dir, "visual-manifest.json"), JSON.stringify(manifest, null, 2));
`;

async function initRepo(
  directory: string,
  options: { gitignoreEvidence: boolean },
): Promise<string> {
  await run("git", ["init", "--quiet", "--initial-branch=main", directory]);
  await run("git", ["-C", directory, "config", "user.email", "test@example.com"]);
  await run("git", ["-C", directory, "config", "user.name", "Test"]);
  if (options.gitignoreEvidence) {
    await writeFile(join(directory, ".gitignore"), ".agent-team/evidence/\n");
  }
  await writeFile(join(directory, "write-fixture.mjs"), fixtureScript);
  await run("git", ["-C", directory, "add", "-A"]);
  await run("git", ["-C", directory, "commit", "-m", "init", "--quiet"]);
  const { stdout } = await run("git", ["-C", directory, "rev-parse", "HEAD"]);
  return stdout.trim();
}

describe("VisualEvidenceBuilder with the real ChildProcessRunner + real git (unconditional, no sandbox needed)", () => {
  it("runs a real subprocess, passes the real gitignore gate, and leaves the tree clean", async () => {
    const worktreePath = await temporaryDirectory();
    const headSha = await initRepo(worktreePath, { gitignoreEvidence: true });
    const deadline = parseInstant(new Date(Date.now() + 60_000).toISOString());
    if (!deadline.ok) throw new Error(deadline.error.code);
    const artifactRepoRelativePath = `.agent-team/evidence/${issueId}/${headSha}/status-none.png`;

    const builder = new VisualEvidenceBuilder({
      process: new ChildProcessRunner(),
      clock: createClock(),
    });
    const result = await builder.build({
      worktreePath,
      issueId,
      headSha,
      commands: [{ executable: "node", arguments: ["write-fixture.mjs", "--dir={{evidenceDir}}"] }],
      allowedAcceptanceCriteria: [criterion],
      deadlineAt: deadline.value,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.evidenceDirectory).toBe(
      join(worktreePath, ".agent-team", "evidence", issueId, headSha),
    );
    const bytes = await readFile(join(worktreePath, artifactRepoRelativePath));
    expect(bytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const { stdout: status } = await run("git", ["-C", worktreePath, "status", "--porcelain"]);
    expect(status.trim()).toBe("");
  });

  it("real git check-ignore fails closed when the evidence root is not gitignored (regression guard: bare, not-yet-existing directory paths are ambiguous without a trailing slash)", async () => {
    const worktreePath = await temporaryDirectory();
    const headSha = await initRepo(worktreePath, { gitignoreEvidence: false });
    const deadline = parseInstant(new Date(Date.now() + 60_000).toISOString());
    if (!deadline.ok) throw new Error(deadline.error.code);

    const builder = new VisualEvidenceBuilder({
      process: new ChildProcessRunner(),
      clock: createClock(),
    });
    const result = await builder.build({
      worktreePath,
      issueId,
      headSha,
      commands: [{ executable: "node", arguments: ["write-fixture.mjs", "--dir={{evidenceDir}}"] }],
      allowedAcceptanceCriteria: [criterion],
      deadlineAt: deadline.value,
    });

    expect(result).toMatchObject({
      ok: false,
      failure: { reason: "evidence_directory_not_ignored" },
    });
  });
});
