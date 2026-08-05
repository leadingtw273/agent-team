import type { DomainError } from "../../domain/foundation/index.js";
import type { Project } from "../../domain/project/index.js";
import type { ReviewIdentity, RequirementSnapshot } from "../../domain/review/index.js";
import type {
  ChangeRequestCommentReceipt,
  ChangeRequestSnapshot,
  CommitChecksSnapshot,
  GitPort,
  SourceControlPort,
} from "../ports/index.js";
import type { ReviewerPipelineOutcome, ReviewerReport } from "./reviewer-model.js";

export const REVIEW_STATUS_CONTEXT = "agent-team/review";

export type ReviewDecision = Extract<
  ReviewerPipelineOutcome,
  { state: "approved" | "changes_requested" | "clarification_required" }
>;

export interface ReviewStatusPorts {
  readonly sourceControl: Pick<
    SourceControlPort,
    | "getChangeRequest"
    | "getCommitChecks"
    | "getCommitStatuses"
    | "setCommitStatus"
    | "appendChangeRequestComment"
  >;
}

export interface MergeGatePorts {
  readonly git: Pick<GitPort, "getEffectiveTreeDiff">;
  readonly sourceControl: Pick<
    SourceControlPort,
    | "getChangeRequest"
    | "getCommitChecks"
    | "getCommitStatuses"
    | "setCommitStatus"
    | "appendChangeRequestComment"
    | "enableAutoMerge"
  >;
}

interface ReviewRequestBase {
  readonly project: Project;
  readonly changeRequestId: string;
  readonly expectedHeadSha: string;
  readonly idempotencyKeyPrefix: string;
  readonly signal?: AbortSignal;
}

export type BeginReviewRequest = ReviewRequestBase;

export interface RecordReviewRequest extends ReviewRequestBase {
  readonly decision: ReviewDecision;
}

export interface RecordedReviewApproval {
  readonly changeRequestId: string;
  readonly identity: ReviewIdentity;
  readonly reports: readonly ReviewerReport[];
  readonly evidenceComment: ChangeRequestCommentReceipt;
}

export interface EnableAutoMergeRequest extends ReviewRequestBase {
  readonly requirementSnapshot: RequirementSnapshot;
  readonly baseRevision: string;
  readonly approval: RecordedReviewApproval;
}

export type ReviewStatusFailureStage =
  "request" | "change_request" | "checks" | "comment" | "status";

export type BeginReviewOutcome =
  | Readonly<{
      state: "pending";
      changeRequest: ChangeRequestSnapshot;
      checks: CommitChecksSnapshot;
    }>
  | Readonly<{
      state: "already_approved";
      changeRequest: ChangeRequestSnapshot;
      checks: CommitChecksSnapshot;
    }>
  | Readonly<{
      state: "not_ready";
      reason: "ci_pending" | "ci_failed";
      changeRequest: ChangeRequestSnapshot;
      checks: CommitChecksSnapshot;
    }>
  | Readonly<{ state: "failed"; stage: ReviewStatusFailureStage; error: DomainError }>;

export type RecordReviewOutcome =
  | Readonly<{ state: "approved"; approval: RecordedReviewApproval }>
  | Readonly<{
      state: "rejected";
      reason: "changes_requested" | "clarification_required";
      evidenceComment: ChangeRequestCommentReceipt;
    }>
  | Readonly<{ state: "failed"; stage: ReviewStatusFailureStage; error: DomainError }>;

export type MergeGateFailureStage =
  "request" | "change_request" | "checks" | "diff" | "comment" | "status" | "auto_merge";

export type EnableAutoMergeOutcome =
  | Readonly<{
      state: "enabled";
      reuse: "unchanged" | "ci_revalidation";
      identity: ReviewIdentity;
      changeRequest: ChangeRequestSnapshot;
    }>
  | Readonly<{
      state: "re_review_required";
      reason: "requirements_changed" | "effective_diff_changed";
      identity: ReviewIdentity;
    }>
  | Readonly<{
      state: "not_ready";
      reason:
        | "ci_pending"
        | "ci_failed"
        | "draft"
        | "merge_conflict"
        | "mergeability_unknown"
        | "review_status_missing";
    }>
  | Readonly<{ state: "failed"; stage: MergeGateFailureStage; error: DomainError }>;
