import type { VisualManifest } from "../../domain/checkpoint/index.js";
import type { DomainError, Instant, Result } from "../../domain/foundation/index.js";
import type { Project } from "../../domain/project/index.js";
import type { ReviewIdentity, RequirementSnapshot } from "../../domain/review/index.js";
import type {
  AutoMergePauseQueryPort,
  ChangeRequestCommentReceipt,
  ChangeRequestSnapshot,
  CommitChecksSnapshot,
  GitPort,
  SourceControlPort,
  WorkManagementPort,
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
export interface MergeMutationReceipt {
  readonly kind: "enable_auto_merge" | "direct_squash";
  readonly idempotencyKey: string;
  readonly attemptedAt: Instant;
  readonly outcome:
    | "confirmed_enabled"
    | "request_accepted_readback_unknown"
    | "merged_directly"
    | "rejected"
    | "outcome_unknown";
}

export type MergeGateAutoMergeAttempt =
  | Readonly<{
      outcome: "enabled";
      changeRequest: ChangeRequestSnapshot;
      mutations: readonly MergeMutationReceipt[];
    }>
  | Readonly<{
      outcome: "merged_directly";
      headSha: string;
      mutations: readonly [MergeMutationReceipt, ...MergeMutationReceipt[]];
    }>
  | Readonly<{ outcome: "merged_externally"; changeRequest: ChangeRequestSnapshot }>
  | Readonly<{
      outcome: "authorization_revoked";
      changeRequest: ChangeRequestSnapshot;
      mutations: readonly MergeMutationReceipt[];
    }>
  | Readonly<{
      outcome: "mutation_failed";
      stage: "authorization" | "auto_merge";
      error: DomainError;
      mutations: readonly [MergeMutationReceipt, ...MergeMutationReceipt[]];
    }>;

export interface MergeGatePorts {
  readonly git: Pick<GitPort, "getEffectiveTreeDiff">;
  /**
   * E116cap: checked at the very top of `AutoMergeGate.enable()`, before any GitHub read at all --
   * a project this port reports as paused must never even attempt to arm auto-merge, regardless of
   * how clean the change request otherwise looks. This is the structural enforcement point; the
   * CLI-side call site (`resumeUnderLease`, resume-composition.ts) only maps the resulting
   * `not_ready:"auto_merge_paused"` outcome to a dedicated, human-readable `requires_manual`
   * reasonCode -- it never re-derives or re-checks the pause decision itself. See
   * `auto-merge-pause.ts`'s own header for why this is its own narrow port rather than folded into
   * `SourceControlPort`/`LifecyclePolicyPort`.
   */
  readonly autoMergePause: AutoMergePauseQueryPort;
  /** C035: authoritative Linear read used at the final merge authorization boundary. */
  readonly workManagement: Pick<WorkManagementPort, "getIssue">;
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
      externalIssueId: string,
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
  readonly currentVisualManifest?: VisualManifest;
  readonly currentPublicationDigest?: string;
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
  | "request"
  | "authorization"
  // E116cap: the one failure stage `autoMergePause.isPaused()` itself can produce (the port call
  // returning `!ok`) -- distinct from `"request"` (a shape/invariant problem with the request
  // itself) and from every other stage below, none of which are reachable until *after* this port
  // has already reported `paused: false`.
  | "policy"
  | "change_request"
  | "checks"
  | "diff"
  | "comment"
  | "status"
  | "auto_merge";

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
      mutations: readonly MergeMutationReceipt[];
    }>
  | Readonly<{
      state: "directly_merged";
      headSha: string;
      mutations: readonly [MergeMutationReceipt, ...MergeMutationReceipt[]];
    }>
  | Readonly<{ state: "already_merged_external"; changeRequest: ChangeRequestSnapshot }>
  | Readonly<{ state: "work_canceled"; mutations: readonly MergeMutationReceipt[] }>
  | Readonly<{
      state: "re_review_required";
      reason: "requirements_changed" | "effective_diff_changed";
      identity: ReviewIdentity;
    }>
  // E102-4b: the approval's `requirementsDigest`/`diffDigest` are both still identical to the
  // freshly recomputed `current` identity -- this is *not* a genuine requirements/diff change, so
  // it must never be folded into `re_review_required`/`effective_diff_changed` (that reasonCode is
  // reserved for "the code actually changed, send it back through the normal implementer/reviewer
  // loop," which is exactly wrong here). At the *identical* commit, the evidence this gate just
  // re-verified from disk (`VisualEvidenceBuilder.verifyExisting`, resume-composition.ts's own
  // pre-arm recheck) hashes to a different `evidenceDigest` than the one the recorded approval was
  // actually reviewed against. `LinearPublicationReceiptRecord`s are write-once (see
  // linear-publication-store.ts's own header) precisely so this should be structurally impossible
  // in the ordinary flow -- reaching this state means either on-disk evidence was replaced without
  // a new commit, or a bug, either of which is a safety event for a human, never something this
  // gate silently re-review-loops on (a fresh review could not safely publish a second receipt for
  // the same (issueId, headSha) either -- see that file's own "write-once" contract). See
  // `merge-gate.ts`'s own `enable()` for exactly which comment/status this posts.
  | Readonly<{ state: "evidence_drift_detected"; identity: ReviewIdentity }>
  // E102-4b: symmetric to `evidence_drift_detected` above, but the drift is in the *publication*
  // record (`FileLinearPublicationStore.load()`'s returned receipt digests differently from the one
  // the recorded approval was reviewed against) rather than the visual manifest/artifacts
  // themselves -- kept as its own distinct outcome (not merged into `evidence_drift_detected`) so an
  // operator reading `dispatch resolve`'s output can tell which durable record actually diverged.
  | Readonly<{ state: "publication_drift_detected"; identity: ReviewIdentity }>
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
        | "behind"
        // E116cap: `MergeGatePorts.autoMergePause.isPaused()` reported `paused: true` -- checked
        // first, before any other readback in `enable()` (see `MergeGatePorts.autoMergePause`'s own
        // header). Never reachable together with any other `not_ready` reason on the same call:
        // this is an unconditional short-circuit, not one more condition ANDed with the rest.
        | "auto_merge_paused";
    }>
  | Readonly<{
      state: "failed";
      stage: MergeGateFailureStage;
      error: DomainError;
      mutations?: readonly MergeMutationReceipt[];
    }>;
