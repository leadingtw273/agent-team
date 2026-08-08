/**
 * E102-3: Visual Evidence Builder -- turns a trusted project's `commands.visualReview` (already a
 * schema field on `TrustedProjectConfig`, but never actually executed by anything before this
 * ticket) into the `VisualManifest` + `visual_artifact` evidence blocks `ReviewerPipeline.run()`
 * (reviewer.ts) requires for a `visual_review`/`dual_review` job. Runs at dispatch/resume time,
 * bound to one specific worktree + Head SHA -- never at CI time and never from a pre-produced
 * artifact, so what the visual reviewer sees always matches the exact commit under review.
 *
 * Data flow (see resume-composition.ts's `resumeReview` for the one caller):
 *   trusted `commands.visualReview` (argv template, never a shell string) -> `#run` executes each
 *   command via `ProcessPort.spawn` (shell:false, no string concatenation) with cwd = the target
 *   worktree and the `{{evidenceDir}}` token in each argument rewritten to an absolute staging
 *   directory -> the trusted command(s) write PNGs plus one `visual-manifest.json` (this file's
 *   own fixed contract, see `manifestFileName`) into that staging directory -> this builder
 *   independently re-hashes and re-validates every artifact (PNG magic bytes, real SHA-256, no
 *   symlinks, acceptance criteria drawn only from the issue's own approved set) -> rewrites the
 *   manifest's paths from the staging directory to the final one -> atomically renames staging to
 *   final -> returns a schema-valid `VisualManifest` plus matching `visual_artifact`
 *   `ReviewEvidenceBlock`s for `ReviewerPipelineRequest`.
 *
 * Security invariants (all fail closed, never silently degrade):
 * - The target worktree's `.agent-team/evidence/` directory must already be git-ignored --
 *   verified with `git check-ignore` (via the same controlled `ProcessPort`, never a raw shell
 *   call) *before* anything is written. A project that has not gitignored this path could
 *   otherwise have every captured screenshot pollute its own diff/PR -- see this file's own
 *   `#evidenceDirectoryIgnored`.
 * - `commands.visualReview`'s `ProjectCommand[]` is already a `{executable, arguments}` argv array
 *   on `TrustedProjectConfig` (application/projects/schema.ts) -- `executable` already excludes
 *   every shell name (`bash`/`sh`/`zsh`/...) and every `arguments` entry already excludes control
 *   characters. This builder's only addition is `renderArgvTemplate`'s literal, non-shell
 *   substring substitution of the `{{evidenceDir}}` token -- never string concatenation into a
 *   command line, and never anything passed through `shell: true`.
 * - Every artifact this builder accepts must be a regular file (never a symlink), begin with the
 *   real PNG magic bytes, and have a SHA-256 this builder computed itself by re-reading the bytes
 *   -- the trusted command's own self-reported hash (if any) is never trusted blindly.
 * - Every artifact's `acceptanceCriteria` must be non-empty and a subset of the reviewed issue's
 *   own approved acceptance criteria -- a command cannot bind a screenshot to an AC the issue does
 *   not actually have.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import {
  domainError,
  err,
  ok,
  type Clock,
  type DomainError,
  type Identifier,
  type Instant,
  type Result,
} from "../../domain/foundation/index.js";
import { issueIdSchema, repositoryRelativePathSchema } from "../../domain/project/index.js";
import { headShaSchema } from "../../domain/review/index.js";
import { visualManifestSchema, type VisualManifest } from "../../domain/checkpoint/index.js";
import type { ProjectCommand } from "../projects/index.js";
import type { ProcessPort } from "../ports/index.js";
import type { ReviewEvidenceBlock } from "./reviewer-model.js";

/** The one placeholder token a project's `commands.visualReview` arguments may contain -- rewritten
 * to the absolute staging directory path via plain substring replacement (never shell expansion,
 * never a template engine) before each command is spawned. An argument may embed it as part of a
 * larger string (e.g. `--out={{evidenceDir}}/shot.png`), not only as a whole argument. */
export const evidenceDirectoryToken = "{{evidenceDir}}";

/** Fixed filename contract: the last thing every `commands.visualReview` pipeline must write,
 * directly inside the (`{{evidenceDir}}`-rewritten) staging directory, is a Visual Manifest v1
 * JSON document (schema: `visualManifestSchema`) naming every PNG it also wrote there. This
 * builder never infers artifacts by directory-scanning -- the trusted command is the only thing
 * that knows which files it wrote are meant to be evidence at all versus scratch/debug output. */
export const visualEvidenceManifestFileName = "visual-manifest.json";

const evidenceRootSegments = Object.freeze([".agent-team", "evidence"]);
const maxCommandOutputBytes = 16 * 1024 * 1024;
const maxManifestFileBytes = 8 * 1024 * 1024;
const pngMagicBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface VisualEvidenceBuilderPorts {
  readonly process: ProcessPort;
  readonly clock: Clock;
}

export interface VisualEvidenceBuildRequest {
  /** Absolute path to the target worktree -- the same `GitWorktree.path` the reviewer pipeline
   * itself will run against. Every command runs with this as its working directory. */
  readonly worktreePath: string;
  readonly issueId: Identifier<"issue">;
  /** The exact commit under review -- both the value this builder cross-checks the worktree's own
   * live `git rev-parse HEAD` against before running any command, and the `commitSha` written into
   * the final `VisualManifest`. */
  readonly headSha: string;
  /** `TrustedProjectConfig.commands.visualReview` -- run in array order, each one must exit 0. */
  readonly commands: readonly ProjectCommand[];
  /** The reviewed issue's own approved acceptance criteria -- every artifact's
   * `acceptanceCriteria` must be a non-empty subset of exactly this set. */
  readonly allowedAcceptanceCriteria: readonly string[];
  readonly deadlineAt: Instant;
  readonly signal?: AbortSignal;
}

export type VisualEvidenceBuildFailureReason =
  | "no_commands_configured"
  | "invalid_request"
  | "evidence_directory_not_ignored"
  | "worktree_head_mismatch"
  | "command_failed"
  | "manifest_missing"
  | "manifest_invalid"
  | "artifact_invalid"
  | "existing_evidence_invalid"
  | "filesystem_error"
  | "interrupted";

export interface VisualEvidenceBuildFailure {
  readonly reason: VisualEvidenceBuildFailureReason;
  readonly error: DomainError;
  /** Short, non-secret diagnostic text (e.g. which command/artifact) -- never raw command
   * stdout/stderr (that can carry the trusted project's own output verbatim, which this builder
   * has no redaction pass over) and never persisted anywhere by this module itself. */
  readonly detail?: string;
}

export interface VisualEvidenceBuildSuccess {
  readonly visualManifest: VisualManifest;
  readonly evidence: readonly Extract<ReviewEvidenceBlock, { kind: "file" }>[];
  readonly evidenceDirectory: string;
  /** `true` when a prior, still-valid build for this exact issue+headSha was found and reused
   * without re-running any command (idempotent resume) -- `false` when this call actually ran the
   * configured commands. */
  readonly reused: boolean;
}

export type VisualEvidenceBuildResult =
  | Readonly<{ ok: true; value: VisualEvidenceBuildSuccess }>
  | Readonly<{ ok: false; failure: VisualEvidenceBuildFailure }>;

function failureDetail(
  reason: VisualEvidenceBuildFailureReason,
  code: Parameters<typeof domainError>[0],
  detail?: string,
): VisualEvidenceBuildFailure {
  return Object.freeze({
    reason,
    error: domainError(code),
    ...(detail === undefined ? {} : { detail }),
  });
}

function failure(
  reason: VisualEvidenceBuildFailureReason,
  code: Parameters<typeof domainError>[0],
  detail?: string,
): VisualEvidenceBuildResult {
  return Object.freeze({ ok: false, failure: failureDetail(reason, code, detail) });
}

function toResult(failureValue: VisualEvidenceBuildFailure): VisualEvidenceBuildResult {
  return Object.freeze({ ok: false, failure: failureValue });
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Rewrites every `{{evidenceDir}}` occurrence in every argument to the absolute staging
 * directory. Plain substring replacement on an already-tokenized argv array -- never shell
 * interpolation, never re-joined into a single command string. */
export function renderArgvTemplate(
  args: readonly string[],
  evidenceDirectory: string,
): readonly string[] {
  return Object.freeze(
    args.map((argument) => argument.split(evidenceDirectoryToken).join(evidenceDirectory)),
  );
}

function validBuildRequest(request: VisualEvidenceBuildRequest): boolean {
  return (
    isAbsolute(request.worktreePath) &&
    request.worktreePath.length <= 4_096 &&
    issueIdSchema.safeParse(request.issueId).success &&
    headShaSchema.safeParse(request.headSha).success &&
    request.commands.length > 0 &&
    request.commands.length <= 50 &&
    request.allowedAcceptanceCriteria.length > 0 &&
    new Set(request.allowedAcceptanceCriteria).size === request.allowedAcceptanceCriteria.length
  );
}

interface RawManifestArtifact {
  readonly path: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly title: string;
  readonly acceptanceCriteria: readonly string[];
}

interface RawManifest {
  readonly commitSha: string;
  readonly environment: VisualManifest["environment"];
  readonly artifacts: readonly RawManifestArtifact[];
}

/** Loose, structural read of the trusted command's own manifest JSON -- deliberately *not*
 * `visualManifestSchema.safeParse` directly, because the raw document's `issueId` is whatever
 * placeholder the trusted command used and its `artifacts[].path` values are staging-directory
 * paths -- both get rewritten before this builder ever validates the *final* document against
 * `visualManifestSchema`. Structural-only checks here (never trusts array/object shape blindly). */
function parseRawManifest(json: unknown): RawManifest | undefined {
  if (typeof json !== "object" || json === null) return undefined;
  const record = json as Record<string, unknown>;
  const commitSha = record["commitSha"];
  const environment = record["environment"];
  const artifacts = record["artifacts"];
  if (
    typeof commitSha !== "string" ||
    typeof environment !== "object" ||
    environment === null ||
    !Array.isArray(artifacts) ||
    artifacts.length === 0
  ) {
    return undefined;
  }
  const parsedArtifacts: RawManifestArtifact[] = [];
  for (const entry of artifacts) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const artifact = entry as Record<string, unknown>;
    const path = artifact["path"];
    const mediaType = artifact["mediaType"];
    const sha256 = artifact["sha256"];
    const title = artifact["title"];
    const acceptanceCriteria = artifact["acceptanceCriteria"];
    if (
      typeof path !== "string" ||
      typeof mediaType !== "string" ||
      typeof sha256 !== "string" ||
      typeof title !== "string" ||
      !Array.isArray(acceptanceCriteria) ||
      !acceptanceCriteria.every((criterion): criterion is string => typeof criterion === "string")
    ) {
      return undefined;
    }
    parsedArtifacts.push({ path, mediaType, sha256, title, acceptanceCriteria });
  }
  return Object.freeze({
    commitSha,
    environment: environment as VisualManifest["environment"],
    artifacts: Object.freeze(parsedArtifacts),
  });
}

async function sha256OfFile(path: string): Promise<Result<string, DomainError>> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      return err(domainError("invariant_violation"));
    }
    const bytes = await readFile(path);
    if (bytes.byteLength === 0 || bytes.subarray(0, pngMagicBytes.length).compare(pngMagicBytes) !== 0) {
      return err(domainError("invariant_violation"));
    }
    return ok(createHash("sha256").update(bytes).digest("hex"));
  } catch {
    return err(domainError("external_failure"));
  }
}

export class VisualEvidenceBuilder {
  readonly #ports: VisualEvidenceBuilderPorts;

  constructor(ports: VisualEvidenceBuilderPorts) {
    this.#ports = ports;
  }

  async build(request: VisualEvidenceBuildRequest): Promise<VisualEvidenceBuildResult> {
    if (!validBuildRequest(request)) return failure("invalid_request", "invariant_violation");
    if (isAborted(request.signal)) return failure("interrupted", "interrupted");

    const evidenceRelativeRoot = evidenceRootSegments.join("/");
    const ignored = await this.#evidenceDirectoryIgnored(request);
    if (!ignored.ok) return toResult(ignored.error);

    const finalDirectory = join(request.worktreePath, ...evidenceRootSegments, request.issueId, request.headSha);
    const stagingDirectory = join(
      request.worktreePath,
      ...evidenceRootSegments,
      request.issueId,
      `.staging-${request.headSha}`,
    );

    const existing = await this.#tryReuseExisting(request, finalDirectory);
    if (existing !== undefined) return existing;

    try {
      await rm(stagingDirectory, { recursive: true, force: true });
      await mkdir(stagingDirectory, { recursive: true });
    } catch {
      return failure("filesystem_error", "external_failure", evidenceRelativeRoot);
    }

    const headCheck = await this.#runControlled(request, "git", ["rev-parse", "HEAD"]);
    if (!headCheck.ok) {
      await this.#cleanupStaging(stagingDirectory);
      return toResult(headCheck.error);
    }
    if (headCheck.value.trim().toLowerCase() !== request.headSha.toLowerCase()) {
      await this.#cleanupStaging(stagingDirectory);
      return failure("worktree_head_mismatch", "conflict");
    }

    for (const command of request.commands) {
      if (isAborted(request.signal)) {
        await this.#cleanupStaging(stagingDirectory);
        return failure("interrupted", "interrupted");
      }
      const rendered = renderArgvTemplate(command.arguments, stagingDirectory);
      const ranCommand = await this.#runControlled(request, command.executable, rendered);
      if (!ranCommand.ok) {
        await this.#cleanupStaging(stagingDirectory);
        return toResult(ranCommand.error);
      }
    }

    const manifestPath = join(stagingDirectory, visualEvidenceManifestFileName);
    let rawManifestBytes: Buffer;
    try {
      const stats = await lstat(manifestPath);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > maxManifestFileBytes) {
        await this.#cleanupStaging(stagingDirectory);
        return failure("manifest_missing", "invariant_violation", visualEvidenceManifestFileName);
      }
      rawManifestBytes = await readFile(manifestPath);
    } catch {
      await this.#cleanupStaging(stagingDirectory);
      return failure("manifest_missing", "invariant_violation", visualEvidenceManifestFileName);
    }

    let rawJson: unknown;
    try {
      rawJson = JSON.parse(rawManifestBytes.toString("utf8"));
    } catch {
      await this.#cleanupStaging(stagingDirectory);
      return failure("manifest_invalid", "invariant_violation", "manifest is not valid JSON");
    }
    const rawManifest = parseRawManifest(rawJson);
    if (rawManifest === undefined) {
      await this.#cleanupStaging(stagingDirectory);
      return failure("manifest_invalid", "invariant_violation", "manifest shape mismatch");
    }
    if (rawManifest.commitSha.toLowerCase() !== request.headSha.toLowerCase()) {
      await this.#cleanupStaging(stagingDirectory);
      return failure("manifest_invalid", "conflict", "manifest commitSha mismatch");
    }

    const stagingRelativePrefix = relative(request.worktreePath, stagingDirectory).split(sep).join("/");
    const finalRelativePrefix = relative(request.worktreePath, finalDirectory).split(sep).join("/");
    const allowed = new Set(request.allowedAcceptanceCriteria);
    const finalArtifacts: VisualManifest["artifacts"][number][] = [];

    for (const artifact of rawManifest.artifacts) {
      if (
        artifact.mediaType !== "image/png" ||
        artifact.acceptanceCriteria.length === 0 ||
        !artifact.acceptanceCriteria.every((criterion) => allowed.has(criterion)) ||
        !artifact.path.startsWith(`${stagingRelativePrefix}/`)
      ) {
        await this.#cleanupStaging(stagingDirectory);
        return failure("artifact_invalid", "invariant_violation", artifact.path);
      }
      const stagingAbsolutePath = join(request.worktreePath, artifact.path);
      const digest = await sha256OfFile(stagingAbsolutePath);
      if (!digest.ok) {
        await this.#cleanupStaging(stagingDirectory);
        return failure("artifact_invalid", digest.error.code, artifact.path);
      }
      const finalRelativePath = `${finalRelativePrefix}${artifact.path.slice(stagingRelativePrefix.length)}`;
      const parsedPath = repositoryRelativePathSchema.safeParse(finalRelativePath);
      if (!parsedPath.success) {
        await this.#cleanupStaging(stagingDirectory);
        return failure("artifact_invalid", "invariant_violation", finalRelativePath);
      }
      finalArtifacts.push({
        path: parsedPath.data,
        mediaType: "image/png",
        sha256: digest.value,
        title: artifact.title,
        acceptanceCriteria: [...artifact.acceptanceCriteria],
      });
    }

    const finalManifest = {
      schemaVersion: 1 as const,
      issueId: request.issueId,
      commitSha: request.headSha.toLowerCase(),
      generatedAt: this.#ports.clock.now(),
      environment: rawManifest.environment,
      artifacts: finalArtifacts,
    };
    const validatedManifest = visualManifestSchema.safeParse(finalManifest);
    if (!validatedManifest.success) {
      await this.#cleanupStaging(stagingDirectory);
      return failure("manifest_invalid", "invariant_violation", "final manifest failed schema validation");
    }

    try {
      await writeFile(
        manifestPath,
        `${JSON.stringify(validatedManifest.data, null, 2)}\n`,
        "utf8",
      );
      await rename(stagingDirectory, finalDirectory);
    } catch {
      // A concurrent build (another resume cycle for the identical issue+headSha) may have won
      // the race and already produced a valid `finalDirectory` -- re-validate it rather than
      // assuming failure; if it is not valid, fail closed and deliberately leave the staging
      // directory in place (under the gitignored evidence root -- harmless to leave, and useful
      // forensic evidence for a human) rather than guess which side was "right".
      const raced = await this.#tryReuseExisting(request, finalDirectory);
      if (raced !== undefined) {
        await this.#cleanupStaging(stagingDirectory);
        return raced;
      }
      return failure("filesystem_error", "external_failure", "atomic rename failed");
    }

    return Object.freeze({
      ok: true,
      value: Object.freeze({
        visualManifest: validatedManifest.data,
        evidence: evidenceBlocksFor(request.worktreePath, validatedManifest.data),
        evidenceDirectory: finalDirectory,
        reused: false,
      }),
    });
  }

  async #evidenceDirectoryIgnored(
    request: VisualEvidenceBuildRequest,
  ): Promise<Result<true, VisualEvidenceBuildFailure>> {
    const relativeRoot = evidenceRootSegments.join("/");
    // A trailing slash is deliberate and load-bearing: `.agent-team/evidence` does not exist on
    // disk yet at gate time, so git cannot otherwise infer it denotes a directory, and a
    // `.gitignore` pattern ending in `/` (the documented, correct way to ignore a whole directory)
    // then fails to match a bare, extension-less path git can't classify -- confirmed against a
    // real git binary, not merely inferred from documentation.
    const relativeRootAsDirectory = `${relativeRoot}/`;
    const spawned = await this.#ports.process.spawn(
      {
        executable: "git",
        arguments: ["check-ignore", "--quiet", "--", relativeRootAsDirectory],
        workingDirectory: request.worktreePath,
        deadlineAt: request.deadlineAt,
        maxOutputBytes: maxCommandOutputBytes,
      },
      request.signal === undefined ? {} : { signal: request.signal },
    );
    if (!spawned.ok) {
      return err(
        failureDetail("filesystem_error", "external_failure", "git check-ignore unavailable"),
      );
    }
    // Drain fully -- exit code alone decides the outcome, but the output must be fully consumed
    // for `.wait()` below to observe the process's actual close (see `ChildProcessRunner`'s own
    // contract, mirrored by every provider runner's identical drain-then-wait sequence).
    const iterator = spawned.value.output[Symbol.asyncIterator]();
    for (let step = await iterator.next(); step.done !== true; step = await iterator.next()) {
      // intentionally empty
    }
    const exit = await spawned.value.wait(
      request.signal === undefined ? {} : { signal: request.signal },
    );
    if (!exit.ok) return err(failureDetail("filesystem_error", exit.error.code));
    if (exit.value.exitCode !== 0) {
      return err(
        failureDetail("evidence_directory_not_ignored", "invariant_violation", relativeRoot),
      );
    }
    return ok(true);
  }

  async #runControlled(
    request: VisualEvidenceBuildRequest,
    executable: string,
    args: readonly string[],
  ): Promise<Result<string, VisualEvidenceBuildFailure>> {
    const spawned = await this.#ports.process.spawn(
      {
        executable,
        arguments: [...args],
        workingDirectory: request.worktreePath,
        deadlineAt: request.deadlineAt,
        maxOutputBytes: maxCommandOutputBytes,
      },
      request.signal === undefined ? {} : { signal: request.signal },
    );
    if (!spawned.ok) {
      return err(failureDetail("command_failed", "external_failure", executable));
    }
    let stdout = "";
    for await (const chunk of spawned.value.output) {
      if (chunk.stream === "stdout") stdout += Buffer.from(chunk.bytes).toString("utf8");
    }
    const exit = await spawned.value.wait(
      request.signal === undefined ? {} : { signal: request.signal },
    );
    if (!exit.ok) return err(failureDetail("command_failed", exit.error.code, executable));
    if (exit.value.exitCode !== 0 || exit.value.signal !== null || exit.value.outputTruncated) {
      return err(failureDetail("command_failed", "external_failure", executable));
    }
    return ok(stdout);
  }

  async #cleanupStaging(stagingDirectory: string): Promise<void> {
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
  }

  /** Validates a pre-existing `finalDirectory` (a prior, already-renamed build for this exact
   * issue+headSha) exactly as strictly as a fresh build would have -- returns `undefined` (meaning
   * "no usable existing evidence, proceed with a fresh build") if anything about it fails to
   * verify, rather than ever silently trusting a directory this call did not itself just produce. */
  async #tryReuseExisting(
    request: VisualEvidenceBuildRequest,
    finalDirectory: string,
  ): Promise<VisualEvidenceBuildResult | undefined> {
    let manifestBytes: Buffer;
    try {
      const manifestPath = join(finalDirectory, visualEvidenceManifestFileName);
      const stats = await lstat(manifestPath);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > maxManifestFileBytes) {
        return undefined;
      }
      manifestBytes = await readFile(manifestPath);
    } catch {
      return undefined;
    }
    let json: unknown;
    try {
      json = JSON.parse(manifestBytes.toString("utf8"));
    } catch {
      return failure("existing_evidence_invalid", "invariant_violation", "existing manifest not JSON");
    }
    const parsed = visualManifestSchema.safeParse(json);
    if (!parsed.success) {
      return failure("existing_evidence_invalid", "invariant_violation", "existing manifest schema");
    }
    if (
      parsed.data.issueId !== request.issueId ||
      parsed.data.commitSha.toLowerCase() !== request.headSha.toLowerCase()
    ) {
      return failure("existing_evidence_invalid", "conflict", "existing manifest identity mismatch");
    }
    const allowed = new Set(request.allowedAcceptanceCriteria);
    for (const artifact of parsed.data.artifacts) {
      if (!artifact.acceptanceCriteria.every((criterion) => allowed.has(criterion))) {
        return failure("existing_evidence_invalid", "conflict", artifact.path);
      }
      const absolutePath = join(request.worktreePath, artifact.path);
      const digest = await sha256OfFile(absolutePath);
      if (!digest.ok || digest.value !== artifact.sha256) {
        return failure("existing_evidence_invalid", "conflict", artifact.path);
      }
    }
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        visualManifest: parsed.data,
        evidence: evidenceBlocksFor(request.worktreePath, parsed.data),
        evidenceDirectory: finalDirectory,
        reused: true,
      }),
    });
  }
}

function evidenceBlocksFor(
  worktreePath: string,
  manifest: VisualManifest,
): readonly Extract<ReviewEvidenceBlock, { kind: "file" }>[] {
  return Object.freeze(
    manifest.artifacts.map((artifact) => ({
      kind: "file" as const,
      category: "visual_artifact" as const,
      source: `agent-team:visual-evidence:${artifact.path}`,
      mediaType: artifact.mediaType,
      path: join(worktreePath, artifact.path),
      sha256: artifact.sha256,
      repositoryPath: artifact.path,
    })),
  );
}
