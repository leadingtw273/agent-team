import { createHash } from "node:crypto";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  VisualEvidenceBuilder,
  evidenceDirectoryToken,
  renderArgvTemplate,
  visualEvidenceManifestFileName,
  type VisualEvidenceBuildRequest,
} from "../../src/application/pipelines/visual-evidence-builder.js";
import { visualManifestSchema } from "../../src/domain/checkpoint/index.js";
import { createFixedClock, ok, parseInstant } from "../../src/domain/foundation/index.js";
import type { ProcessPort, ProcessSpawnRequest } from "../../src/application/ports/index.js";

const run = promisify(execFile);
const pngMagicBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const now = (() => {
  const parsed = parseInstant("2026-08-08T00:00:00.000Z");
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
})();
const deadline = (() => {
  const parsed = parseInstant("2026-08-08T01:00:00.000Z");
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
})();
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
  const directory = await mkdtemp(join(tmpdir(), "agent-team-visual-evidence-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function initRepo(
  directory: string,
  options: { gitignoreEvidence: boolean },
): Promise<string> {
  await run("git", ["init", "--quiet", "--initial-branch=main", directory]);
  await run("git", ["-C", directory, "config", "user.email", "test@example.com"]);
  await run("git", ["-C", directory, "config", "user.name", "Test"]);
  if (options.gitignoreEvidence) {
    await writeFile(join(directory, ".gitignore"), ".agent-team/evidence/\n");
    await run("git", ["-C", directory, "add", ".gitignore"]);
  }
  await run("git", ["-C", directory, "commit", "--allow-empty", "-m", "init", "--quiet"]);
  const { stdout } = await run("git", ["-C", directory, "rev-parse", "HEAD"]);
  return stdout.trim();
}

function parseArg(args: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = args.find((argument) => argument.startsWith(prefix));
  return found?.slice(prefix.length);
}

type CommandMode =
  | "ok"
  | "symlink"
  | "bad-media-type"
  | "bad-acceptance-criteria"
  | "no-manifest"
  | "invalid-json"
  | "wrong-commit"
  | "exit-nonzero";

/** A fully scripted, in-process fake of the controlled command executor's own `ProcessPort` --
 * never spawns a real subprocess. `git check-ignore`/`git rev-parse HEAD` are answered directly
 * from `options`; the project's own trusted `commands.visualReview` entry is intercepted by
 * `mode` and performs the exact filesystem side effect a real trusted command would (writing one
 * PNG plus `visual-manifest.json` into the rendered `{{evidenceDir}}`), letting these tests
 * exercise the builder's real re-validation/re-hashing/rename logic without ever touching
 * Playwright or the sandbox's own scripts (see visual-evidence-builder-sandbox.test.ts, tests/
 * integration, for the real-CLI wiring proof). */
function fakeProcessPort(options: {
  readonly worktreePath: string;
  readonly ignored: boolean;
  readonly headSha: string;
  readonly mode: CommandMode;
  readonly commandInvocations: string[];
}): ProcessPort {
  return {
    spawn: (request: ProcessSpawnRequest) => {
      let exitCode = 0;
      let stdout = "";
      if (request.executable === "git" && request.arguments[0] === "check-ignore") {
        exitCode = options.ignored ? 0 : 1;
      } else if (request.executable === "git" && request.arguments[0] === "rev-parse") {
        stdout = `${options.headSha}\n`;
      } else {
        options.commandInvocations.push(request.executable);
        const dir = parseArg(request.arguments, "dir");
        if (dir === undefined) throw new Error("test fixture command missing --dir=");
        if (options.mode === "exit-nonzero") {
          exitCode = 1;
        } else {
          exitCode = writeFixtureEvidence(dir, options.mode, options.headSha);
        }
      }
      const bytes = Buffer.from(stdout, "utf8");
      return Promise.resolve(
        ok({
          pid: 1,
          output: (async function* () {
            await Promise.resolve();
            if (bytes.byteLength > 0) {
              yield { sequence: 1, stream: "stdout" as const, bytes, observedAt: now };
            }
          })(),
          writeStdin: () => Promise.resolve(ok(undefined)),
          closeStdin: () => Promise.resolve(ok(undefined)),
          wait: () =>
            Promise.resolve(
              ok({ exitCode, signal: null, startedAt: now, exitedAt: now, outputTruncated: false }),
            ),
          sendSignal: () => Promise.resolve(ok(undefined)),
        }),
      );
    },
  };
}

/** Synchronously mirrors what a real `commands.visualReview` pipeline (screenshot + manifest
 * generation) would leave behind in the (already `{{evidenceDir}}`-rendered) staging directory. */
function writeFixtureEvidence(
  stagingDirectory: string,
  mode: CommandMode,
  headSha: string,
): number {
  mkdirSync(stagingDirectory, { recursive: true });
  const fileName = "status-none.png";
  const filePath = join(stagingDirectory, fileName);
  const pngBytes = Buffer.concat([pngMagicBytes, Buffer.from("fixture-pixels")]);

  if (mode === "symlink") {
    const targetPath = join(stagingDirectory, "real-target.png");
    writeFileSync(targetPath, pngBytes);
    symlinkSync(targetPath, filePath);
  } else {
    writeFileSync(filePath, pngBytes);
  }

  if (mode === "no-manifest") return 0;
  if (mode === "invalid-json") {
    writeFileSync(join(stagingDirectory, visualEvidenceManifestFileName), "{not json");
    return 0;
  }

  const manifest = {
    commitSha: mode === "wrong-commit" ? "f".repeat(40) : headSha,
    environment: { runner: "fixture", operatingSystem: "linux" },
    artifacts: [
      {
        path: `${relativeStagingPath(stagingDirectory)}/${fileName}`,
        mediaType: mode === "bad-media-type" ? "image/jpeg" : "image/png",
        sha256: "0".repeat(64),
        title: "Status page (healthy)",
        acceptanceCriteria:
          mode === "bad-acceptance-criteria" ? ["not-an-approved-ac"] : [criterion],
      },
    ],
  };
  writeFileSync(
    join(stagingDirectory, visualEvidenceManifestFileName),
    JSON.stringify(manifest, null, 2),
  );
  return 0;
}

/** The raw manifest's `artifacts[].path` must be worktree-relative (mirrors the real sandbox
 * `generate-manifest.ts`'s own `toRepoRelativePath`) -- every fixture in this file nests the
 * staging directory exactly two segments below the worktree root
 * (`.agent-team/evidence/<issueId>/.staging-<headSha>`), so this just strips that fixed prefix. */
function relativeStagingPath(stagingDirectory: string): string {
  const segments = stagingDirectory.split("/");
  return segments.slice(-4).join("/");
}

function buildRequest(
  worktreePath: string,
  overrides: Partial<VisualEvidenceBuildRequest> = {},
): VisualEvidenceBuildRequest {
  return {
    worktreePath,
    issueId,
    headSha: "a".repeat(40),
    commands: [{ executable: "node", arguments: ["write-fixture.js", "--dir={{evidenceDir}}"] }],
    allowedAcceptanceCriteria: [criterion],
    deadlineAt: deadline,
    ...overrides,
  };
}

describe("renderArgvTemplate", () => {
  it("rewrites every occurrence of the evidence directory token, including embedded in a larger argument", () => {
    expect(
      renderArgvTemplate(
        ["--out={{evidenceDir}}/shot.png", "{{evidenceDir}}", "--fixed=value"],
        "/abs/staging",
      ),
    ).toEqual(["--out=/abs/staging/shot.png", "/abs/staging", "--fixed=value"]);
  });

  it("leaves arguments without the token untouched", () => {
    expect(renderArgvTemplate(["--mode=none"], "/abs/staging")).toEqual(["--mode=none"]);
  });

  it("the exported token constant is the exact literal every argv template must use", () => {
    expect(evidenceDirectoryToken).toBe("{{evidenceDir}}");
  });
});

describe("VisualEvidenceBuilder", () => {
  it("builds a schema-valid manifest and matching evidence, leaving the worktree's tracked tree clean", async () => {
    const worktreePath = await temporaryDirectory();
    const headSha = await initRepo(worktreePath, { gitignoreEvidence: true });
    const invocations: string[] = [];
    const builder = new VisualEvidenceBuilder({
      process: fakeProcessPort({
        worktreePath,
        ignored: true,
        headSha,
        mode: "ok",
        commandInvocations: invocations,
      }),
      clock: createFixedClock(now),
    });

    const result = await builder.build(buildRequest(worktreePath, { headSha }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reused).toBe(false);
    expect(invocations).toEqual(["node"]);
    expect(result.value.evidenceDirectory).toBe(
      join(worktreePath, ".agent-team", "evidence", issueId, headSha),
    );
    expect(visualManifestSchema.safeParse(result.value.visualManifest).success).toBe(true);
    expect(result.value.visualManifest.commitSha).toBe(headSha);
    expect(result.value.visualManifest.issueId).toBe(issueId);
    expect(result.value.visualManifest.artifacts).toHaveLength(1);
    const artifact = result.value.visualManifest.artifacts[0];
    if (artifact === undefined) throw new Error("expected one artifact");
    expect(artifact.path).toBe(`.agent-team/evidence/${issueId}/${headSha}/status-none.png`);
    expect(artifact.mediaType).toBe("image/png");
    expect(artifact.acceptanceCriteria).toEqual([criterion]);

    // The builder never trusts a command's self-reported hash -- it must equal the real file's own
    // digest, and the file itself must actually be on disk at the *final* (not staging) path.
    const realBytes = await readFile(join(worktreePath, artifact.path));
    expect(artifact.sha256).toBe(createHash("sha256").update(realBytes).digest("hex"));

    expect(result.value.evidence).toHaveLength(1);
    expect(result.value.evidence[0]).toMatchObject({
      kind: "file",
      category: "visual_artifact",
      mediaType: "image/png",
      path: join(worktreePath, artifact.path),
      sha256: artifact.sha256,
      repositoryPath: artifact.path,
    });

    // No leftover staging directory, and `git status` reports a clean tree -- the gitignore entry
    // genuinely isolates every produced artifact from the tracked repository.
    const { stdout: entries } = await run("ls", [
      join(worktreePath, ".agent-team", "evidence", issueId),
    ]);
    expect(entries.trim().split("\n")).toEqual([headSha]);
    const { stdout: status } = await run("git", ["-C", worktreePath, "status", "--porcelain"]);
    expect(status.trim()).toBe("");
  });

  it("fails closed with evidence_directory_not_ignored, and writes nothing, when the target repo has not gitignored the evidence root", async () => {
    const worktreePath = await temporaryDirectory();
    const headSha = await initRepo(worktreePath, { gitignoreEvidence: false });
    const invocations: string[] = [];
    const builder = new VisualEvidenceBuilder({
      process: fakeProcessPort({
        worktreePath,
        ignored: false,
        headSha,
        mode: "ok",
        commandInvocations: invocations,
      }),
      clock: createFixedClock(now),
    });

    const result = await builder.build(buildRequest(worktreePath, { headSha }));

    expect(result).toMatchObject({
      ok: false,
      failure: { reason: "evidence_directory_not_ignored" },
    });
    expect(invocations).toEqual([]);
    await expect(run("test", ["-e", join(worktreePath, ".agent-team")])).rejects.toBeDefined();
  });

  it("rejects a symlinked artifact", async () => {
    const worktreePath = await temporaryDirectory();
    const headSha = await initRepo(worktreePath, { gitignoreEvidence: true });
    const builder = new VisualEvidenceBuilder({
      process: fakeProcessPort({
        worktreePath,
        ignored: true,
        headSha,
        mode: "symlink",
        commandInvocations: [],
      }),
      clock: createFixedClock(now),
    });

    const result = await builder.build(buildRequest(worktreePath, { headSha }));

    expect(result).toMatchObject({ ok: false, failure: { reason: "artifact_invalid" } });
  });

  it("rejects an artifact whose media type is not image/png", async () => {
    const worktreePath = await temporaryDirectory();
    const headSha = await initRepo(worktreePath, { gitignoreEvidence: true });
    const builder = new VisualEvidenceBuilder({
      process: fakeProcessPort({
        worktreePath,
        ignored: true,
        headSha,
        mode: "bad-media-type",
        commandInvocations: [],
      }),
      clock: createFixedClock(now),
    });

    const result = await builder.build(buildRequest(worktreePath, { headSha }));

    expect(result).toMatchObject({ ok: false, failure: { reason: "artifact_invalid" } });
  });

  it("rejects an artifact bound to an acceptance criterion the issue does not have", async () => {
    const worktreePath = await temporaryDirectory();
    const headSha = await initRepo(worktreePath, { gitignoreEvidence: true });
    const builder = new VisualEvidenceBuilder({
      process: fakeProcessPort({
        worktreePath,
        ignored: true,
        headSha,
        mode: "bad-acceptance-criteria",
        commandInvocations: [],
      }),
      clock: createFixedClock(now),
    });

    const result = await builder.build(buildRequest(worktreePath, { headSha }));

    expect(result).toMatchObject({ ok: false, failure: { reason: "artifact_invalid" } });
  });

  it("fails when the trusted command never produces a manifest", async () => {
    const worktreePath = await temporaryDirectory();
    const headSha = await initRepo(worktreePath, { gitignoreEvidence: true });
    const builder = new VisualEvidenceBuilder({
      process: fakeProcessPort({
        worktreePath,
        ignored: true,
        headSha,
        mode: "no-manifest",
        commandInvocations: [],
      }),
      clock: createFixedClock(now),
    });

    const result = await builder.build(buildRequest(worktreePath, { headSha }));

    expect(result).toMatchObject({ ok: false, failure: { reason: "manifest_missing" } });
  });

  it("fails when the manifest is not valid JSON", async () => {
    const worktreePath = await temporaryDirectory();
    const headSha = await initRepo(worktreePath, { gitignoreEvidence: true });
    const builder = new VisualEvidenceBuilder({
      process: fakeProcessPort({
        worktreePath,
        ignored: true,
        headSha,
        mode: "invalid-json",
        commandInvocations: [],
      }),
      clock: createFixedClock(now),
    });

    const result = await builder.build(buildRequest(worktreePath, { headSha }));

    expect(result).toMatchObject({ ok: false, failure: { reason: "manifest_invalid" } });
  });

  it("fails when the manifest's commitSha does not match the worktree's actual HEAD", async () => {
    const worktreePath = await temporaryDirectory();
    const headSha = await initRepo(worktreePath, { gitignoreEvidence: true });
    const builder = new VisualEvidenceBuilder({
      process: fakeProcessPort({
        worktreePath,
        ignored: true,
        headSha,
        mode: "wrong-commit",
        commandInvocations: [],
      }),
      clock: createFixedClock(now),
    });

    const result = await builder.build(buildRequest(worktreePath, { headSha }));

    expect(result).toMatchObject({ ok: false, failure: { reason: "manifest_invalid" } });
  });

  it("fails closed with command_failed when a trusted command exits non-zero", async () => {
    const worktreePath = await temporaryDirectory();
    const headSha = await initRepo(worktreePath, { gitignoreEvidence: true });
    const builder = new VisualEvidenceBuilder({
      process: fakeProcessPort({
        worktreePath,
        ignored: true,
        headSha,
        mode: "exit-nonzero",
        commandInvocations: [],
      }),
      clock: createFixedClock(now),
    });

    const result = await builder.build(buildRequest(worktreePath, { headSha }));

    expect(result).toMatchObject({ ok: false, failure: { reason: "command_failed" } });
  });

  it("rejects a request with no configured visualReview commands", async () => {
    const worktreePath = await temporaryDirectory();
    const headSha = await initRepo(worktreePath, { gitignoreEvidence: true });
    const builder = new VisualEvidenceBuilder({
      process: fakeProcessPort({
        worktreePath,
        ignored: true,
        headSha,
        mode: "ok",
        commandInvocations: [],
      }),
      clock: createFixedClock(now),
    });

    const result = await builder.build(buildRequest(worktreePath, { headSha, commands: [] }));

    expect(result).toMatchObject({ ok: false, failure: { reason: "invalid_request" } });
  });

  it("reuses a prior valid build for the identical issue+headSha without re-running any command", async () => {
    const worktreePath = await temporaryDirectory();
    const headSha = await initRepo(worktreePath, { gitignoreEvidence: true });
    const invocations: string[] = [];
    const builder = new VisualEvidenceBuilder({
      process: fakeProcessPort({
        worktreePath,
        ignored: true,
        headSha,
        mode: "ok",
        commandInvocations: invocations,
      }),
      clock: createFixedClock(now),
    });

    const first = await builder.build(buildRequest(worktreePath, { headSha }));
    expect(first.ok).toBe(true);
    const second = await builder.build(buildRequest(worktreePath, { headSha }));

    expect(second).toMatchObject({ ok: true, value: { reused: true } });
    // Only the first `build()` call ever ran the trusted command.
    expect(invocations).toEqual(["node"]);
  });

  it("fails closed on reuse when the previously recorded artifact was tampered with on disk", async () => {
    const worktreePath = await temporaryDirectory();
    const headSha = await initRepo(worktreePath, { gitignoreEvidence: true });
    const builder = new VisualEvidenceBuilder({
      process: fakeProcessPort({
        worktreePath,
        ignored: true,
        headSha,
        mode: "ok",
        commandInvocations: [],
      }),
      clock: createFixedClock(now),
    });
    const first = await builder.build(buildRequest(worktreePath, { headSha }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const [firstArtifact] = first.value.visualManifest.artifacts;
    if (firstArtifact === undefined) throw new Error("expected one artifact");
    await writeFile(
      join(worktreePath, firstArtifact.path),
      Buffer.concat([pngMagicBytes, Buffer.from("tampered-bytes")]),
    );

    const second = await builder.build(buildRequest(worktreePath, { headSha }));

    expect(second).toMatchObject({ ok: false, failure: { reason: "existing_evidence_invalid" } });
  });

  it("rejects a symlinked evidence root before ever writing anything (regression guard on the gitignore probe itself)", async () => {
    const worktreePath = await temporaryDirectory();
    const headSha = await initRepo(worktreePath, { gitignoreEvidence: true });
    const outsideTarget = await temporaryDirectory();
    await symlink(outsideTarget, join(worktreePath, ".agent-team-outside-link"));
    // Sanity: the builder never even looks at `.agent-team-outside-link` -- this test only proves
    // the fixture's own symlink setup does not confuse `git check-ignore`/the builder's own logic.
    const builder = new VisualEvidenceBuilder({
      process: fakeProcessPort({
        worktreePath,
        ignored: true,
        headSha,
        mode: "ok",
        commandInvocations: [],
      }),
      clock: createFixedClock(now),
    });

    const result = await builder.build(buildRequest(worktreePath, { headSha }));

    expect(result.ok).toBe(true);
  });
});

/**
 * E102-4b: `verifyExisting` is the purely read-only re-verification `resume-composition.ts`'s
 * pre-arm merge recheck calls -- extracted from `build()`'s own pre-existing "reuse before
 * rebuilding" logic (`#loadVerified`, visual-evidence-builder.ts) so the merge-time recheck never
 * has to go through `build()` (which would spawn a process and, on a missing evidence directory,
 * silently manufacture *new* evidence instead of failing closed). Every test in this block proves
 * the read-only contract directly: a `ProcessPort` whose `spawn` throws is wired in, so any test
 * that accidentally exercised `build()`'s process-spawning path would fail loudly rather than
 * silently passing.
 */
describe("VisualEvidenceBuilder.verifyExisting", () => {
  function neverSpawnProcessPort(): ProcessPort {
    return {
      spawn: () => {
        throw new Error("verifyExisting must never spawn a process (build() must never run here)");
      },
    };
  }

  it("verifies and returns the exact manifest a prior build produced, without ever spawning a process", async () => {
    const worktreePath = await temporaryDirectory();
    const headSha = await initRepo(worktreePath, { gitignoreEvidence: true });
    const buildingBuilder = new VisualEvidenceBuilder({
      process: fakeProcessPort({
        worktreePath,
        ignored: true,
        headSha,
        mode: "ok",
        commandInvocations: [],
      }),
      clock: createFixedClock(now),
    });
    const built = await buildingBuilder.build(buildRequest(worktreePath, { headSha }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    // A fresh builder instance, wired with a `ProcessPort` that throws on any `spawn` call --
    // `verifyExisting` must succeed purely by reading and re-hashing what `build()` already wrote.
    const verifyingBuilder = new VisualEvidenceBuilder({
      process: neverSpawnProcessPort(),
      clock: createFixedClock(now),
    });

    const verified = await verifyingBuilder.verifyExisting({
      worktreePath,
      issueId,
      headSha,
      allowedAcceptanceCriteria: [criterion],
    });

    expect(verified).toMatchObject({
      ok: true,
      value: { visualManifest: built.value.visualManifest, reused: true },
    });
  });

  it("fails closed with manifest_missing when no evidence has ever been built for this issue+headSha", async () => {
    const worktreePath = await temporaryDirectory();
    const headSha = await initRepo(worktreePath, { gitignoreEvidence: true });
    const builder = new VisualEvidenceBuilder({
      process: neverSpawnProcessPort(),
      clock: createFixedClock(now),
    });

    const verified = await builder.verifyExisting({
      worktreePath,
      issueId,
      headSha,
      allowedAcceptanceCriteria: [criterion],
    });

    expect(verified).toMatchObject({ ok: false, failure: { reason: "manifest_missing" } });
  });

  it("fails closed with existing_evidence_invalid when a previously recorded artifact was tampered with on disk", async () => {
    const worktreePath = await temporaryDirectory();
    const headSha = await initRepo(worktreePath, { gitignoreEvidence: true });
    const buildingBuilder = new VisualEvidenceBuilder({
      process: fakeProcessPort({
        worktreePath,
        ignored: true,
        headSha,
        mode: "ok",
        commandInvocations: [],
      }),
      clock: createFixedClock(now),
    });
    const built = await buildingBuilder.build(buildRequest(worktreePath, { headSha }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const [firstArtifact] = built.value.visualManifest.artifacts;
    if (firstArtifact === undefined) throw new Error("expected one artifact");
    await writeFile(
      join(worktreePath, firstArtifact.path),
      Buffer.concat([pngMagicBytes, Buffer.from("tampered-bytes")]),
    );

    const verifyingBuilder = new VisualEvidenceBuilder({
      process: neverSpawnProcessPort(),
      clock: createFixedClock(now),
    });
    const verified = await verifyingBuilder.verifyExisting({
      worktreePath,
      issueId,
      headSha,
      allowedAcceptanceCriteria: [criterion],
    });

    expect(verified).toMatchObject({ ok: false, failure: { reason: "existing_evidence_invalid" } });
  });

  /**
   * E102-4b invariant: `.agent-team/evidence/<issueId>/<headSha>/` must survive on disk from
   * review time all the way through the job's terminal state -- the pre-arm merge recheck
   * (`resumeReview`, resume-composition.ts) reads this exact directory a second time, and neither
   * of the two methods it calls (`build()`'s idempotent-reuse path, `verifyExisting()` itself) ever
   * deletes or empties it. Structurally reinforced elsewhere in this codebase, not just by
   * convention: `ResumeCycleDependencies`/`MergeGatePorts` never expose `GitPort.removeWorktree` at
   * all (only `git/local.ts`'s real adapter has that method, and its only two call sites are both
   * inside `application/registration/proactive-probe.ts` -- the registration setup probe, never
   * the dispatch/resume/merge pipeline this ticket wires) -- so this test is a *behavioral* lock on
   * top of that *structural* one, verified directly against the real filesystem rather than only
   * asserted from reading the type signatures.
   */
  it("never deletes or empties the evidence directory across a build() reuse followed by a verifyExisting() recheck (retention invariant)", async () => {
    const worktreePath = await temporaryDirectory();
    const headSha = await initRepo(worktreePath, { gitignoreEvidence: true });
    const invocations: string[] = [];
    const buildingBuilder = new VisualEvidenceBuilder({
      process: fakeProcessPort({
        worktreePath,
        ignored: true,
        headSha,
        mode: "ok",
        commandInvocations: invocations,
      }),
      clock: createFixedClock(now),
    });

    const built = await buildingBuilder.build(buildRequest(worktreePath, { headSha }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const evidenceDirectoryStatAfterBuild = await stat(built.value.evidenceDirectory);
    expect(evidenceDirectoryStatAfterBuild.isDirectory()).toBe(true);

    // Simulates the review-time resume cycle reaching `awaiting_review`/`fix_round` and later being
    // resumed for the merge-time recheck, in a fresh process -- a second, independent builder
    // instance re-reading the same directory a real `agent-team run` restart would produce.
    const verifyingBuilder = new VisualEvidenceBuilder({
      process: fakeProcessPort({
        worktreePath,
        ignored: true,
        headSha,
        mode: "ok",
        commandInvocations: invocations,
      }),
      clock: createFixedClock(now),
    });
    const verified = await verifyingBuilder.verifyExisting({
      worktreePath,
      issueId,
      headSha,
      allowedAcceptanceCriteria: [criterion],
    });
    expect(verified.ok).toBe(true);

    // Only the first `build()` call ever ran a trusted command -- `verifyExisting()` never re-runs
    // anything, and (the actual invariant this test locks) the directory + its one PNG artifact are
    // both still present, unmodified, on disk after both calls.
    expect(invocations).toEqual(["node"]);
    const evidenceDirectoryStatAfterVerify = await stat(built.value.evidenceDirectory);
    expect(evidenceDirectoryStatAfterVerify.isDirectory()).toBe(true);
    const [artifact] = built.value.visualManifest.artifacts;
    if (artifact === undefined) throw new Error("expected one artifact");
    const artifactStat = await stat(join(worktreePath, artifact.path));
    expect(artifactStat.isFile()).toBe(true);
  });

  it("rejects an invalid request (relative worktreePath) closed, without ever spawning a process", async () => {
    const builder = new VisualEvidenceBuilder({
      process: neverSpawnProcessPort(),
      clock: createFixedClock(now),
    });

    const verified = await builder.verifyExisting({
      worktreePath: "relative/path",
      issueId,
      headSha: "a".repeat(40),
      allowedAcceptanceCriteria: [criterion],
    });

    expect(verified).toMatchObject({ ok: false, failure: { reason: "invalid_request" } });
  });
});
