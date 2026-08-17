import type { ReviewerReport } from "../../application/pipelines/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Instant,
  type Result,
} from "../../domain/foundation/index.js";
import {
  canonicalSerialize,
  sha256Digest,
  type ReviewIdentity,
} from "../../domain/review/index.js";
import type {
  JobProgressRecord,
  ReviewerReplayCheckpoint,
  ReviewerReplayIdentity,
} from "../../adapters/dispatch/job-progress-store.js";
import { reviewerReplayCheckpointSchema } from "../../adapters/dispatch/job-progress-store.js";

export function createReviewerReplayIdentity(
  record: JobProgressRecord,
  review: ReviewIdentity,
): Result<
  Readonly<{ identity: ReviewerReplayIdentity; identityDigest: string }>,
  DomainError<"invariant_violation">
> {
  if (record.changeRequestId === undefined || record.baseRevision === undefined) {
    return err(domainError("invariant_violation"));
  }
  const identity: ReviewerReplayIdentity = Object.freeze({
    schemaVersion: 1,
    jobId: record.jobId,
    projectId: record.projectId,
    issueId: record.issueId,
    externalIssueId: record.externalIssueId,
    changeRequestId: record.changeRequestId,
    baseRevision: record.baseRevision,
    requirementsDigest: review.requirementsDigest,
    headSha: review.headSha,
    diffDigest: review.diffDigest,
    ...(review.evidenceDigest === undefined ? {} : { evidenceDigest: review.evidenceDigest }),
    ...(review.publicationDigest === undefined
      ? {}
      : { publicationDigest: review.publicationDigest }),
  });
  const digest = sha256Digest(identity);
  return digest.ok ? ok(Object.freeze({ identity, identityDigest: digest.value })) : digest;
}

export function replayIdentityMatches(
  checkpoint: ReviewerReplayCheckpoint,
  identity: Readonly<{ identity: ReviewerReplayIdentity; identityDigest: string }>,
): boolean {
  if (checkpoint.identityDigest !== identity.identityDigest) return false;
  const left = canonicalSerialize(checkpoint.identity);
  const right = canonicalSerialize(identity.identity);
  return left.ok && right.ok && left.value === right.value;
}

export function reviewerReportMatchesIdentity(
  report: ReviewerReport,
  identity: ReviewIdentity,
): boolean {
  return (
    report.requirementsDigest === identity.requirementsDigest &&
    report.headSha === identity.headSha &&
    report.diffDigest === identity.diffDigest &&
    report.evidenceDigest === identity.evidenceDigest &&
    report.publicationDigest === identity.publicationDigest
  );
}

export function createReviewerReplaySuccessCheckpoint(
  current: Extract<ReviewerReplayCheckpoint, { state: "attempting" }>,
  reports: readonly ReviewerReport[],
  completedAt: Instant,
): Result<
  Extract<ReviewerReplayCheckpoint, { state: "review_succeeded" }>,
  DomainError<"invariant_violation">
> {
  const orderedReports = [...reports].sort((left, right) => left.role.localeCompare(right.role));
  const reportDigests: string[] = [];
  for (const report of orderedReports) {
    const digest = sha256Digest(report);
    if (!digest.ok) return digest;
    reportDigests.push(digest.value);
  }
  const checkpointDigest = sha256Digest({
    schemaVersion: 1,
    operation: "reviewer-replay",
    identityDigest: current.identityDigest,
    counters: current.counters,
    reportDigests,
    outcome: "review_succeeded",
  });
  if (!checkpointDigest.ok) return checkpointDigest;
  const parsed = reviewerReplayCheckpointSchema.safeParse({
    state: "review_succeeded",
    identity: current.identity,
    identityDigest: current.identityDigest,
    counters: current.counters,
    reports: orderedReports,
    reportDigests,
    checkpointDigest: checkpointDigest.value,
    completedAt,
  });
  return parsed.success
    ? ok(parsed.data as Extract<ReviewerReplayCheckpoint, { state: "review_succeeded" }>)
    : err(domainError("invariant_violation"));
}
