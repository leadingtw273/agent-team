/**
 * E102-5: the application-level caller that finally wires `LinearUploadClient`
 * (adapters/linear/upload.ts, A004) to a real invocation -- before this ticket, that class had
 * zero callers anywhere in this codebase (built-but-unwired). This module's
 * `LinearVisualPublicationCoordinator.publish()` is the one place a `visual_review`/`dual_review`
 * job's `VisualManifest` + PNG evidence (E102-3's `VisualEvidenceBuilder`) is ever sent to Linear,
 * and `resume-composition.ts`'s `resumeReview` calls it -- and requires it to succeed -- before
 * `reviewer.run()` is ever invoked. See that file's own call site comment for the exact gate.
 *
 * Two-part publication, not one: the manifest itself is **never** uploaded through
 * `LinearUploadClient.uploadArtifact` -- that method's own `mediaTypePattern`
 * (`/^(?:image|video)\/...$/`) structurally rejects `application/json`, so a manifest document
 * cannot be a Linear file-upload artifact at all. This coordinator instead:
 *   1. uploads every PNG artifact the manifest lists via the existing `uploadArtifact` (each one
 *      gets its own Linear comment, produced by that method itself), then
 *   2. posts one additional, deterministic summary comment -- rendered by `renderManifestComment`
 *      below -- listing every artifact's title/acceptance-criteria/asset URL, via the same
 *      `LinearCommentWriter.appendComment` the upload client's comments already use.
 * This is a disclosed design decision (not an oversight): "上傳 manifest" is realized as "publish
 * the manifest's content as a Linear comment", the only mechanism this project's real Linear schema
 * actually supports for non-image/video content.
 *
 * Idempotent-retry contract (see linear-publication-store.ts's own header for exactly why a
 * receipt-store gate -- not any Linear-side mechanism -- is the actual idempotency guarantee):
 * `publish()` always calls `store.load()` first and returns that receipt unchanged (`reused: true`)
 * if its `manifestDigest` matches the manifest being published now, and never re-uploads anything.
 * Only when no matching receipt exists does it perform the uploads + manifest comment, and only
 * once *all* of those durably succeed does it call `store.create()`.
 *
 * Orphan-asset contract (acceptance criterion: an orphan must be identifiable and must never be
 * allowed to pass): once at least one artifact has actually been uploaded to Linear, any later
 * failure in this same `publish()` call (the manifest comment itself, or the final
 * `store.create()`) is reported with `failure.orphan: true` -- real Linear-side assets/comments now
 * exist that no durable local record describes. `resumeReview` maps `orphan: true` to a distinct
 * `requires_manual` reasonCode (`visual_publication_orphan`, job-progress-store.ts) so an operator
 * can find and act on it, and -- fail-closed by construction -- the reviewer is never started
 * either way (`orphan: false` failures use `visual_publication_failed` instead, but both always
 * return `ok: false`).
 */
import { createHash } from "node:crypto";
import { basename, isAbsolute, join } from "node:path";
import { lstat, readFile } from "node:fs/promises";

import {
  domainError,
  err,
  ok,
  type DomainError,
  type Identifier,
  type Result,
} from "../../domain/foundation/index.js";
import { issueIdSchema } from "../../domain/project/index.js";
import { projectIdSchema } from "../../domain/jobs/index.js";
import { visualManifestSchema, type VisualManifest } from "../../domain/checkpoint/index.js";
import type { WorkManagementArtifact } from "../../application/ports/index.js";
import type { LinearProjectContext } from "../linear/model.js";
import type {
  LinearArtifactUploadReceipt,
  LinearCommentWriter,
  LinearUploadRequestOptions,
} from "../linear/upload.js";
import {
  type LinearPublicationArtifactReceipt,
  type LinearPublicationReceiptRecord,
  type LinearPublicationStorePort,
} from "./linear-publication-store.js";

/** The narrow slice of `LinearUploadClient` (upload.ts) this coordinator actually calls -- kept
 * structural (`Pick`-shaped, declared here rather than imported as a type alias of the concrete
 * class) so a test fake only needs this one method, never a real `LinearGraphqlTransport`. */
export interface LinearArtifactUploader {
  uploadArtifact(
    context: LinearProjectContext,
    issueId: string,
    artifact: WorkManagementArtifact,
    idempotencyKey: string,
    options?: LinearUploadRequestOptions,
  ): Promise<Result<LinearArtifactUploadReceipt, DomainError>>;
}

export interface LinearPublicationRequest {
  readonly context: LinearProjectContext;
  readonly projectId: Identifier<"project">;
  /** Domain issueId -- must equal `visualManifest.issueId`. */
  readonly issueId: Identifier<"issue">;
  /** Linear's own issue id -- the `issueId` parameter every `adapters/linear/*` write call
   * actually expects (never the domain `Identifier<"issue">` above). */
  readonly externalIssueId: string;
  /** Absolute path to the worktree `visualManifest.artifacts[].path` is relative to -- the same
   * `GitWorktree.path`/`VisualEvidenceBuildRequest.worktreePath` the evidence builder itself used. */
  readonly worktreePath: string;
  readonly visualManifest: VisualManifest;
  readonly signal?: AbortSignal;
}

export type LinearPublicationFailureReason =
  | "invalid_request"
  | "receipt_load_failed"
  | "receipt_conflict"
  | "artifact_read_failed"
  | "artifact_changed"
  | "upload_failed"
  | "manifest_comment_failed"
  | "receipt_persist_failed";

export interface LinearPublicationFailure {
  readonly reason: LinearPublicationFailureReason;
  readonly error: DomainError;
  /** `true` only when at least one artifact/comment has already been durably created on Linear by
   * *this* call before the failure -- see this file's own header ("Orphan-asset contract"). */
  readonly orphan: boolean;
  /** Short, non-secret diagnostic text (e.g. an artifact path) -- never raw provider output. */
  readonly detail?: string;
}

export interface LinearPublicationSuccess {
  readonly receipt: LinearPublicationReceiptRecord;
  /** `true` when a prior, still-valid receipt for this exact issue+headSha+manifest content was
   * found and reused without uploading or commenting anything again. */
  readonly reused: boolean;
}

export type LinearPublicationResult =
  | Readonly<{ ok: true; value: LinearPublicationSuccess }>
  | Readonly<{ ok: false; failure: LinearPublicationFailure }>;

function failure(
  reason: LinearPublicationFailureReason,
  error: DomainError,
  orphan: boolean,
  detail?: string,
): LinearPublicationResult {
  return Object.freeze({
    ok: false,
    failure: Object.freeze({ reason, error, orphan, ...(detail === undefined ? {} : { detail }) }),
  });
}

function validRequest(request: LinearPublicationRequest): boolean {
  return (
    isAbsolute(request.worktreePath) &&
    request.worktreePath.length <= 4_096 &&
    projectIdSchema.safeParse(request.projectId).success &&
    issueIdSchema.safeParse(request.issueId).success &&
    request.externalIssueId.trim().length > 0 &&
    request.externalIssueId.length <= 255 &&
    visualManifestSchema.safeParse(request.visualManifest).success &&
    request.issueId === request.visualManifest.issueId
  );
}

/** Deliberately excludes `generatedAt`/`environment` -- see linear-publication-store.ts's own
 * `manifestDigest` field header for why. Sorted by `path` (never trusts the manifest's own array
 * order) so two structurally-identical manifests always digest identically regardless of how their
 * `artifacts` array happened to be ordered. */
function manifestDigestInput(manifest: VisualManifest) {
  return {
    issueId: manifest.issueId,
    commitSha: manifest.commitSha,
    artifacts: [...manifest.artifacts]
      .map((artifact) => ({
        path: artifact.path,
        mediaType: artifact.mediaType,
        sha256: artifact.sha256,
        title: artifact.title,
        acceptanceCriteria: [...artifact.acceptanceCriteria].sort(),
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
}

export function sha256OfManifest(manifest: VisualManifest): string {
  return createHash("sha256")
    .update(JSON.stringify(manifestDigestInput(manifest)), "utf8")
    .digest("hex");
}

function artifactIdempotencyKey(externalIssueId: string, headSha: string, path: string): string {
  return `linear-publication:${externalIssueId}:${headSha}:artifact:${path}`;
}

function manifestIdempotencyKey(externalIssueId: string, headSha: string): string {
  return `linear-publication:${externalIssueId}:${headSha}:manifest`;
}

function escapedMarkdownText(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

/** The manifest summary comment body -- deterministic given the same manifest + upload receipts,
 * so a human reading Linear sees the same content this coordinator digested into
 * `manifestComment.sha256`. Never re-posted once a receipt exists (see this file's own header). */
export function renderManifestComment(
  manifest: VisualManifest,
  artifacts: readonly Readonly<{ path: string; assetUrl: string }>[],
): string {
  const assetUrlByPath = new Map(artifacts.map((artifact) => [artifact.path, artifact.assetUrl]));
  const rows = [...manifest.artifacts]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((artifact) => {
      const assetUrl = assetUrlByPath.get(artifact.path);
      const link = assetUrl === undefined ? "-" : `[image](<${assetUrl}>)`;
      const criteria = artifact.acceptanceCriteria.map(escapedMarkdownText).join("、");
      return `| ${escapedMarkdownText(artifact.title)} | ${criteria} | ${link} |`;
    });
  return [
    `### 視覺證據 Manifest：issue \`${manifest.issueId}\` @ \`${manifest.commitSha}\``,
    "",
    `- Runner：\`${manifest.environment.runner}\` / OS：\`${manifest.environment.operatingSystem}\``,
    "",
    "| 檔案 | 驗收標準 | 連結 |",
    "| --- | --- | --- |",
    ...rows,
    "",
    `<!-- agent-team:visual-manifest:${manifest.commitSha} -->`,
  ].join("\n");
}

async function readArtifactBytes(path: string): Promise<Result<Uint8Array, DomainError>> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) return err(domainError("invariant_violation"));
    return ok(await readFile(path));
  } catch {
    return err(domainError("external_failure"));
  }
}

export class LinearVisualPublicationCoordinator {
  constructor(
    private readonly uploader: LinearArtifactUploader,
    private readonly comments: LinearCommentWriter,
    private readonly store: LinearPublicationStorePort,
  ) {}

  async publish(request: LinearPublicationRequest): Promise<LinearPublicationResult> {
    if (!validRequest(request))
      return failure("invalid_request", domainError("invariant_violation"), false);
    if (request.signal?.aborted === true)
      return failure("invalid_request", domainError("interrupted"), false);

    const manifestDigest = sha256OfManifest(request.visualManifest);
    const loaded = await this.store.load(
      request.projectId,
      request.issueId,
      request.visualManifest.commitSha,
    );
    if (!loaded.ok) return failure("receipt_load_failed", loaded.error, false);
    if (loaded.value !== undefined) {
      if (loaded.value.manifestDigest !== manifestDigest) {
        // A prior receipt exists for this exact (issueId, headSha) but its content digest does not
        // match the manifest being published now -- never silently re-publish (that would risk a
        // second, orphaned upload set) and never silently trust the stale receipt either.
        return failure(
          "receipt_conflict",
          domainError("conflict"),
          false,
          "manifest_digest_mismatch",
        );
      }
      return Object.freeze({
        ok: true,
        value: Object.freeze({ receipt: loaded.value, reused: true }),
      });
    }

    const artifactReceipts: LinearPublicationArtifactReceipt[] = [];
    for (const artifact of [...request.visualManifest.artifacts].sort((left, right) =>
      left.path.localeCompare(right.path),
    )) {
      const bytes = await readArtifactBytes(join(request.worktreePath, artifact.path));
      if (!bytes.ok) {
        return failure(
          "artifact_read_failed",
          bytes.error,
          artifactReceipts.length > 0,
          artifact.path,
        );
      }
      if (createHash("sha256").update(bytes.value).digest("hex") !== artifact.sha256) {
        return failure(
          "artifact_changed",
          domainError("conflict"),
          artifactReceipts.length > 0,
          artifact.path,
        );
      }
      const workManagementArtifact: WorkManagementArtifact = {
        filename: basename(artifact.path),
        mediaType: artifact.mediaType,
        sha256: artifact.sha256,
        content: bytes.value,
      };
      const idempotencyKey = artifactIdempotencyKey(
        request.externalIssueId,
        request.visualManifest.commitSha,
        artifact.path,
      );
      const uploaded = await this.uploader.uploadArtifact(
        request.context,
        request.externalIssueId,
        workManagementArtifact,
        idempotencyKey,
        request.signal === undefined ? {} : { signal: request.signal },
      );
      if (!uploaded.ok) {
        return failure("upload_failed", uploaded.error, artifactReceipts.length > 0, artifact.path);
      }
      artifactReceipts.push({
        path: artifact.path,
        sha256: artifact.sha256,
        assetUrl: uploaded.value.url,
        commentId: uploaded.value.commentId,
      });
    }
    // `visualManifestSchema` guarantees `artifacts.min(1)` -- the loop above always ran at least
    // once, so every failure from this point on is always the orphan case (see this file's header).
    const sortedArtifactReceipts = [...artifactReceipts].sort((left, right) =>
      left.path.localeCompare(right.path),
    );

    const manifestCommentBody = renderManifestComment(
      request.visualManifest,
      sortedArtifactReceipts,
    );
    const manifestComment = await this.comments.appendComment(
      request.context,
      request.externalIssueId,
      manifestCommentBody,
      manifestIdempotencyKey(request.externalIssueId, request.visualManifest.commitSha),
    );
    if (!manifestComment.ok) {
      return failure("manifest_comment_failed", manifestComment.error, true);
    }

    const created = await this.store.create({
      projectId: request.projectId,
      issueId: request.issueId,
      externalIssueId: request.externalIssueId,
      headSha: request.visualManifest.commitSha,
      manifestDigest,
      manifestComment: {
        id: manifestComment.value.id,
        sha256: createHash("sha256").update(manifestCommentBody, "utf8").digest("hex"),
      },
      artifacts: sortedArtifactReceipts,
    });
    if (!created.ok) return failure("receipt_persist_failed", created.error, true);
    return Object.freeze({
      ok: true,
      value: Object.freeze({ receipt: created.value, reused: false }),
    });
  }
}
