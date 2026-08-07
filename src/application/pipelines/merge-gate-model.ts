import type { DomainError, Result } from "../../domain/foundation/index.js";
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

/**
 * C015t decision 1: `SourceControlPort.enableAutoMerge` (application/ports/source-control.ts, NOT
 * authorized for this ticket to touch) returns a bare `ChangeRequestSnapshot` -- it has no
 * side-channel for "I, this exact call, just performed a direct squash-merge as a fallback action"
 * versus "I observed the change request was already merged by someone/something else." That
 * distinction can only be known at the CLI/adapter composition boundary that actually *decides*
 * whether to attempt the fallback squash (`buildMergeGateSourceControl`,
 * src/cli/dispatch/status-merge-composition.ts) -- so `MergeGatePorts.sourceControl.enableAutoMerge`
 * is intentionally *not* `Pick<SourceControlPort, ... | "enableAutoMerge">` like the rest of this
 * port slice; it has its own richer return shape the CLI-layer composition root is responsible for
 * producing. This is the one piece of "union 定義" that reaches slightly outside
 * `merge-gate-model.ts`'s own file, into how `MergeGatePorts` is assembled -- the coordinator's
 * decision 1 explicitly requires provenance to travel *with* the union, never be reverse-inferred
 * from head-SHA equality alone, and this is the only structural way to make that true without
 * touching the shared `SourceControlPort` interface.
 */
export type MergeGateAutoMergeAttempt =
  | Readonly<{ outcome: "enabled"; changeRequest: ChangeRequestSnapshot }>
  | Readonly<{ outcome: "merged_directly"; changeRequest: ChangeRequestSnapshot }>
  | Readonly<{ outcome: "merged_externally"; changeRequest: ChangeRequestSnapshot }>;

export interface MergeGatePorts {
  readonly git: Pick<GitPort, "getEffectiveTreeDiff">;
  readonly sourceControl: Pick<
    SourceControlPort,
    | "getChangeRequest"
    | "getCommitChecks"
    | "getCommitStatuses"
    | "setCommitStatus"
    | "appendChangeRequestComment"
  > & {
    // Property syntax (an arrow-function-shaped type), not TypeScript method-shorthand syntax --
    // shorthand methods are treated as potentially `this`-sensitive, which trips
    // `@typescript-eslint/unbound-method` at every call site that reads this property off an
    // object without immediately invoking it (e.g. `expect(ports.sourceControl.enableAutoMerge)
    // .toHaveBeenCalled()` in tests). This member never uses `this`; the property form says so
    // structurally instead of requiring every caller to work around a lint rule.
    readonly enableAutoMerge: (
      reference: Parameters<SourceControlPort["enableAutoMerge"]>[0],
      expectedHeadSha: string,
      options: Parameters<SourceControlPort["enableAutoMerge"]>[2],
    ) => Promise<Result<MergeGateAutoMergeAttempt, DomainError>>;
  };
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

/**
 * C015t decision 1: this union used to have a single `"enabled"` state whose own `changeRequest`
 * field could -- silently, ambiguously -- already be `state:"merged"` (GitHub's
 * `enablePullRequestAutoMerge` structurally rejects an already-clean PR, so
 * `buildMergeGateSourceControl`'s fallback, src/cli/dispatch/status-merge-composition.ts, squash-
 * merges it directly instead; that success used to come back through this exact same `"enabled"`
 * shape). `AutoMergeGate.enable()`'s own post-condition check then required the *literal* string
 * `"open"`, so a `"merged"` snapshot always fell through to `mergeFailure("auto_merge", conflict)`
 * -- C015q/C015s's real-world false-red (a Draft PR that genuinely, successfully merged, reported as
 * `requires_manual`). Renamed to `"auto_merge_enabled"` and split into three explicit, mutually
 * exclusive states so a merge is never representable as anything other than a real terminal value a
 * caller must positively handle:
 * - `"directly_merged"`: *this exact call* (this session, this controller) performed the squash
 *   fallback and confirmed it landed -- safe to authorize Lifecycle's merge with this head SHA.
 * - `"already_merged_external"`: the change request was found already `merged` *before* this call
 *   could have caused it (either at the very first readback, the pre-merge readback, or GitHub's own
 *   `enableAutoMerge` mutation reporting an already-merged snapshot) -- this call did not cause it,
 *   and must never be reported to Lifecycle as controller-authorized (see resume-composition.ts's own
 *   comment on why provenance cannot be reverse-inferred from head-SHA equality alone).
 * - `"auto_merge_enabled"`: the ordinary case -- auto-merge is now armed on GitHub's side, still
 *   `open`, not yet actually merged; the caller must still expect it to land asynchronously.
 */
export type EnableAutoMergeOutcome =
  | Readonly<{
      state: "auto_merge_enabled";
      reuse: "unchanged" | "ci_revalidation";
      identity: ReviewIdentity;
      changeRequest: ChangeRequestSnapshot;
    }>
  | Readonly<{ state: "directly_merged"; changeRequest: ChangeRequestSnapshot }>
  | Readonly<{ state: "already_merged_external"; changeRequest: ChangeRequestSnapshot }>
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
        | "review_status_missing"
        // C015y decision D: GitHub's own `mergeable_state` reads `"behind"` -- this project's own
        // `strictRequiredStatusChecksPolicy` ruleset (O004) means GitHub can never execute this
        // merge while behind, no matter how "mergeable" the boolean-derived `mergeability` field
        // above independently claims. Checked at *both* readback points inside `enable()` (the
        // very first readback and the immediately-pre-merge readback) -- never just one -- so a PR
        // that only becomes behind in the narrow window between them is still caught before this
        // gate ever calls `enableAutoMerge`.
        | "behind";
    }>
  | Readonly<{ state: "failed"; stage: MergeGateFailureStage; error: DomainError }>;
