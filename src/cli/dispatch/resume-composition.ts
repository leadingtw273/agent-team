/**
 * C015c item 2: resume orchestration for a `ci_waiting` (or later-stage) job across a *fresh*
 * `agent-team run` process. This is the piece the item-1 escalation exists to serve: `Job` itself
 * carries no phase, so "where did this job get to" lives entirely in the `FileJobProgressStore`
 * CAS index (job-progress-store.ts), and this module is what actually reads that index and drives
 * the existing engine pipelines (C006/C007/C008/C009) back to completion.
 *
 * Design simplification (disclosed, not hidden): rather than dispatching on the *stored* stage
 * label with a dedicated branch per value, every resumable job except `"merging"` is driven
 * through the identical sequence -- `CiRecoveryPipeline.run()` first (it already re-judges the
 * live CI aggregate itself: pending/success/failure), then `ReviewerPipeline.run()` if and only if
 * CI comes back green. This is deliberately *more* correct than a strict per-stage table, not a
 * shortcut: the whole point of "exact-readback" is to trust live GitHub/CI reality over a stale
 * stage label, and re-entering CiRecovery on an already-green CI costs nothing (it only consumes a
 * `ciFixRounds` attempt when the aggregate is actually `"failure"`). `"merging"` is the one
 * genuine exception -- once auto-merge has been enabled, re-running CI/Reviewer would be wrong
 * (wasted `reviewRuns` attempts on an already-approved change), so a `"merging"` job only ever
 * re-checks whether the change request has since become `"merged"`.
 *
 * Two follow-on findings are disclosed here rather than silently worked around:
 * - `ReviewStatusCoordinator.begin()`'s `"already_approved"` outcome (commit-only-change reuse)
 *   is not handled -- this resume path never leaves a job sitting in a state where that could be
 *   reached (it drives straight from `"approved"` to the merge gate in the same cycle), so the
 *   branch below fails closed to `requires_manual` if it is somehow hit, rather than guessing.
 * - A `changes_requested`/`clarification_required` verdict that has *not* yet exhausted
 *   `reviewRuns` is recorded as `"fix_round"` and will simply be reviewed again on the next
 *   resume -- there is genuinely no pipeline anywhere that hands a review verdict back to the
 *   original implementer for a real code fix (the `reviewerFixRounds` gap, confirmed pre-existing
 *   and explicitly not to be fixed by this ticket). Repeated resumes of an unchanged diff will
 *   eventually exhaust the attempt budget and checkpoint, matching this ticket's own required
 *   "review-blocked -> attempt-limit -> checkpoint" scenario, but will not somehow start passing
 *   on their own.
 */
import { join } from "node:path";

import type { JobRepository } from "../../application/dispatch/index.js";
import type { LeaseCoordinator } from "../../application/leases/index.js";
import type {
  CiRecoveryPipeline,
  ReviewerPipeline,
  ReviewerPipelineOutcome,
  ReviewStatusCoordinator,
  AutoMergeGate,
  LifecyclePipeline,
} from "../../application/pipelines/index.js";
import type { TrustedProjectConfig } from "../../application/projects/index.js";
import type { ChangeRequestSnapshot, SourceControlPort } from "../../application/ports/index.js";
import {
  domainError,
  instantFromDate,
  ok,
  type Clock,
  type DomainError,
  type Instant,
  type Result,
} from "../../domain/foundation/index.js";
import {
  createRequirementSnapshot,
  headShaSchema,
  type HeadSha,
} from "../../domain/review/index.js";
import { checkpointIdSchema } from "../../domain/checkpoint/index.js";
import { watchdogHardStopMs } from "../../domain/jobs/index.js";
import type { Project } from "../../domain/project/index.js";
import {
  projectIssueByExternalId,
  type LinearDiscoveryReadModel,
} from "../../adapters/dispatch/linear-discovery.js";
import {
  FileJobProgressStore,
  type JobProgressRecord,
  type JobProgressRecordMutation,
  type MergeReadbackFingerprint,
  type RequiresManualCause,
  type RequiresManualReasonCode,
  type RequiresManualStage,
  type RequiresManualStallTiming,
} from "../../adapters/dispatch/job-progress-store.js";
import type { AuthoritativeBaseFailure, AuthoritativeBaseRevision } from "./authoritative-base.js";
import {
  FileIssueAdmissionStore,
  type IssueAdmissionPort,
} from "../../adapters/dispatch/issue-admission-store.js";
import {
  FileReviewReportDiagnosticsSidecar,
  defaultReviewReportSidecarDirectory,
  type ReviewReportDiagnosticsSidecarPort,
} from "../../adapters/dispatch/review-report-diagnostics-sidecar.js";
import type { ReportContractFailureCategory } from "../../application/pipelines/reviewer-model.js";
import { Redactor } from "../../infrastructure/redaction/index.js";
import type { FileJobRepository } from "../../infrastructure/jobs/index.js";
import { buildDirective } from "./implementer-request.js";

/** The engine's own `JobRepository` interface only declares `create` -- this module also needs
 * `readAll` (find the job by id) and `update` (C015c item 1's addition to `FileJobRepository`,
 * deliberately not added to the engine interface). Kept structural (`Pick`, not the concrete
 * class) so a fake only needs these two extra methods, not to become an actual
 * `FileJobRepository` instance (impossible for an external class -- it has a private field). */
export type ResumeJobRepository = JobRepository & Pick<FileJobRepository, "readAll" | "update">;

/** Stages a fresh `agent-team run` will attempt to drive forward. `"implementing"` is
 * deliberately excluded -- resuming a mid-`ImplementerPipeline` crash is `ReconcileCoordinator`'s
 * job (unbuilt, out of scope), not this one. Terminal stages (`"completed"`/`"failed"`/
 * `"superseded"`/`"cancelled"`) and fail-closed ones (`"paused"`/`"requires_manual"`) are excluded
 * because nothing here auto-resumes a checkpoint or a human-handoff marker.
 *
 * C015o decision 2: `"review_pending_retry"`/`"ci_pending_retry"` *are* resumable -- that is the
 * entire point of the fix. Before this ticket, a retryable provider-start timeout (E101's real
 * incident) was written as `"requires_manual"`, which this set has always excluded, so the very
 * next `agent-team run` fell through to a *fresh dispatch* for the same still-`ready` Linear issue
 * instead of ever retrying the stuck job -- the direct mechanical cause of the duplicate-job bug
 * this ticket closes (see decision 3's admission-claim fix for the other half of that story). */
export const resumableStageKinds: ReadonlySet<string> = new Set([
  "ci_waiting",
  "awaiting_review",
  "fix_round",
  "merging",
  "review_pending_retry",
  "ci_pending_retry",
  // C015r decision 4: symmetric to the two above, for a `report`-stage contract failure that has
  // not yet exhausted its own, separately-capped retry limit.
  "review_report_pending_retry",
]);

/**
 * C015o decision 1: the previous code set `deadlineAt: deps.clock.now()` for both the
 * `CiRecoveryPipeline`/`ReviewerPipeline` provider requests below -- literally "right now", zero
 * budget. `ChildProcessRunner.spawn()` (src/adapters/process/runner.ts) checks
 * `deadlineMs <= Date.now()` *before* ever spawning the child process, so by the time execution
 * reached that check (even microseconds later), the deadline had already always passed --
 * guaranteed, deterministic `timeout`, unrelated to Claude/Codex CLI cold-start latency at all
 * (verified empirically with a real `ChildProcessRunner.spawn()` call: 10/10 reproductions,
 * `deadlineAt: clock.now()` times out before ever spawning; the exact same call with a real future
 * deadline spawns and completes normally -- see C015o's own diagnosis,
 * /home/markchou/.claude/jobs/6152588f/tmp/c015o-diagnose.md).
 *
 * Fixed by importing `watchdogHardStopMs` (src/domain/jobs/watchdog.ts) directly, the same source
 * `implementerProcessDeadlineMs` (src/cli/dispatch/implementer-request.ts) already aligns to --
 * never a second, independently-chosen literal, so the two call sites can never silently drift
 * apart. That file's own comment explains the underlying rationale: no `WatchdogCoordinator` is
 * wired here either, but the bounded child-process deadline this composition sets must still never
 * exceed the hard-stop boundary the watchdog represents.
 */
const resumeProviderDeadlineMs = watchdogHardStopMs;

/** C015o decision 2: `reviewProviderRetries`/`ciProviderRetries`'s shared cap -- deliberately a
 * *new*, dedicated counter (`JobProgressStage`'s own `retries` field on `review_pending_retry`/
 * `ci_pending_retry`, job-progress-store.ts), never one of `Job.attempts`'s four existing counters
 * (`reviewRuns`/`reviewerFixRounds`/`ciFixRounds`/`processRecoveries`, src/domain/jobs/attempts.ts)
 * -- each of those has its own distinct, already-load-bearing semantics that a provider-start
 * retry would corrupt if it borrowed one:
 * - `reviewRuns` only increments once a *complete* reviewer report comes back; a provider that
 *   never started never produced one.
 * - `reviewerFixRounds` is not currently incremented by anything real (a separate, disclosed,
 *   pre-existing gap -- see this file's own header) and means "sent back to the implementer for a
 *   real code fix", an entirely different event.
 * - `ciFixRounds` belongs exclusively to `CiRecoveryPipeline`'s own repair-and-repush attempts.
 * - `processRecoveries` is C013's cap on resuming an exited process from a mid-flight checkpoint,
 *   not a provider that failed before ever producing one.
 * Living in `JobProgressStage` (adapter layer) rather than `Job.attempts` (domain layer) is what
 * keeps this fix entirely inside CLI/adapter authority -- see this file's own module header. */
const providerRetryLimit = 2;

/** C015r decision 4: a `report`-stage contract failure (the provider ran to completion, but its
 * output failed decision 3's tolerant parse/schema/context checks) gets its *own*, separately
 * capped retry -- deliberately never `providerRetryLimit`/`review_pending_retry` above, which is for
 * the provider failing to run *at all*. codex's C015q review named these as distinct failure
 * semantics that must not share a counter or a limit. The cap is 1 (coordinator's explicit "自動重試
 * 上限 1"), not 2 -- a single, prompt-guided retry, not the same budget as an infrastructure hiccup. */
const reportContractRetryLimit = 1;

/** C015x decision 3: an independent, dedicated bound on how many *consecutive* resumes of a
 * `"merging"` job may observe an unchanged authoritative readback fingerprint before this
 * controller gives up waiting for GitHub to actually execute the already-enabled auto-merge and
 * hands off to a human. Deliberately never `providerRetryLimit`/`reportContractRetryLimit` above,
 * nor any of `Job.attempts`'s four counters (see `providerRetryLimit`'s own comment for why none of
 * those apply here either) -- none of those describe "GitHub itself has not moved the PR forward",
 * which involves no provider invocation and no report-contract failure at all. The exact number (5)
 * is this ticket's own judgment call, not a value the coordinator's decision text dictated --
 * flagged as such in the completion report for later adjustment if operational experience says
 * otherwise. */
const mergingNoProgressLimit = 5;

/**
 * C015y decision C: the wall-clock half of the bounded `"merging"` wait -- codex's review
 * confirmed `armedAt` being persisted-but-never-read was always the original requirement's other
 * half, dropped by C015x. `resumeMergingStage` applies these as a two-layer OR:
 *
 * ```
 * stall = (noProgressCount >= mergingNoProgressLimit && now - lastProgressAt >= mergingNoProgressWallClockMs)
 *      || (now - armedAt >= mergingAbsoluteDeadlineMs)
 * ```
 *
 * The second branch is an *unconditional* backstop -- it fires purely on elapsed time since arming,
 * regardless of whether the fingerprint has been changing (i.e. even a `"merging"` job that keeps
 * observing fresh progress every single resume still escalates once 30 minutes have passed since
 * it was armed). This is codex's own explicit formula, not a narrower "only when stalled" reading of
 * it -- an absolute ceiling on how long any job may sit in `"merging"` at all, independent of the
 * per-resume progress signal the first branch tracks.
 *
 * All wall-clock reads go through `deps.clock.now()`, never `Date.now()` directly -- this file's
 * own established discipline (`computeProviderDeadline` above is the pre-existing precedent).
 */
const mergingNoProgressWallClockMs = 10 * 60_000;
const mergingAbsoluteDeadlineMs = 30 * 60_000;

/** C015y decision C: `mergeStateStatus === "unknown"` must not count toward
 * `mergingNoProgressLimit`/`mergingNoProgressWallClockMs` above (GitHub still computing is neither
 * progress nor no-progress on the underlying merge) -- but it also cannot be allowed to flap
 * forever without ever being noticed, so it gets its own independent bound: at least this many
 * consecutive *fresh* `"unknown"` readbacks, spanning at least this much wall-clock, escalates to
 * `merge_state_unknown_timeout`. `mergingAbsoluteDeadlineMs` above still applies unconditionally
 * even while this is flapping (checked first, in `resumeMergingStage`). */
const mergeStateUnknownMinReadbacks = 2;
const mergeStateUnknownWallClockMs = 10 * 60_000;

function currentReportContractRetries(record: JobProgressRecord): number {
  return record.stage.kind === "review_report_pending_retry" ? record.stage.retries : 0;
}

/** C015r decision 1: builds the closed-enum `cause` every `requiresManual(...)` call site must now
 * supply -- see `requiresManualCauseSchema`'s own header (job-progress-store.ts) for the full
 * rationale. `count` defaults to 1 (a single-shot failure, no retry loop tracked for that call site);
 * only the `review_report_contract` reasonCode's own call site passes a real, larger count (the
 * report-contract retry counter's value at exhaustion) and a `lastCategory`. C015x decision 3 adds
 * `mergeEvidence` -- the coordinator's explicit "保留當時 head/base SHA 與狀態證據於 cause"
 * requirement -- originally passed only by `resumeMergingStage`'s call sites; C015z decision Q3
 * also passes it from `resolveLegacyBaseRevision` (a `setup`-stage reasonCode reusing the same
 * evidence slot). C015y decision C adds
 * `stallTiming` -- the wall-clock evidence codex's review named as missing -- passed only by the
 * two `resumeMergingStage` call sites that actually escalate on a timing condition
 * (`auto_merge_stalled`/`merge_state_unknown_timeout`), never `change_request_behind_base` (that
 * one escalates unconditionally, with no timing judgment involved at all). */
function requiresManualCause(
  stage: RequiresManualStage,
  reasonCode: RequiresManualReasonCode,
  count = 1,
  lastCategory?: ReportContractFailureCategory,
  mergeEvidence?: MergeReadbackFingerprint,
  stallTiming?: RequiresManualStallTiming,
): RequiresManualCause {
  return Object.freeze({
    stage,
    reasonCode,
    attempts: Object.freeze({ count, ...(lastCategory === undefined ? {} : { lastCategory }) }),
    ...(mergeEvidence === undefined ? {} : { mergeEvidence }),
    ...(stallTiming === undefined ? {} : { stallTiming }),
  });
}

/** C015y decision C: milliseconds elapsed between two `Instant`s -- the one primitive every
 * wall-clock comparison in `resumeMergingStage` reduces to. Both arguments always come from
 * `deps.clock.now()` (directly, or persisted from a prior call to it) -- never `Date.now()`. */
function elapsedMs(from: Instant, to: Instant): number {
  return Date.parse(to) - Date.parse(from);
}

/** C015y decision C: assembles the `cause.stallTiming` evidence every timing-based
 * `"merging"`-stage escalation attaches -- `elapsedMs` is always measured from `armedAt` (the
 * unambiguous, never-reset baseline), regardless of which of the two OR-branches actually fired. */
function stallTimingOf(
  armedAt: Instant,
  lastProgressAt: Instant | undefined,
  observedAt: Instant,
): RequiresManualStallTiming {
  return Object.freeze({
    armedAt,
    ...(lastProgressAt === undefined ? {} : { lastProgressAt }),
    observedAt,
    elapsedMs: elapsedMs(armedAt, observedAt),
  });
}

/** C015x decision 3, revised by C015z decision (Q4): derives the persisted readback fingerprint
 * from a fresh, authoritative `ChangeRequestSnapshot`. Originally the four observables codex's own
 * review named ("PR head SHA、base SHA、mergeable state、merge commit／merged 狀態") -- C015z drops
 * `baseSha` from this fingerprint entirely: GitHub's `.base.sha` is frozen at PR-creation time (see
 * `ChangeRequestSnapshot.baseSha`'s corrected header, source-control.ts), so it carried zero actual
 * discriminating power for "did the merge make progress" while still being able to falsely *look*
 * like progress the one time it happened to differ from a prior observation. `headSha`/
 * `mergeStateStatus`/`merged` remain the live signal; `mergeStateStatus` is optional on
 * `ChangeRequestSnapshot` only for pre-existing test-fixture back-compat (see that type's own
 * header) -- the real `GitHubAdapter` always populates it, so the `"unknown"` fallback below is
 * only ever reached by a fake that does not care about this path. */
function mergeFingerprintOf(snapshot: ChangeRequestSnapshot): MergeReadbackFingerprint {
  return Object.freeze({
    headSha: snapshot.headSha,
    mergeStateStatus: snapshot.mergeStateStatus ?? "unknown",
    merged: snapshot.state === "merged",
  });
}

/** C015z decision (Q4): deliberately never compares `baseSha` -- see `mergeFingerprintOf`'s own
 * header. A record persisted by C015x/C015y still carries a `baseSha` value (schema back-compat,
 * job-progress-store.ts), but this equality check ignores it unconditionally, on both sides,
 * regardless of whether either fingerprint happens to have it. */
function mergeFingerprintsEqual(
  left: MergeReadbackFingerprint,
  right: MergeReadbackFingerprint,
): boolean {
  return (
    left.headSha === right.headSha &&
    left.mergeStateStatus === right.mergeStateStatus &&
    left.merged === right.merged
  );
}

function computeProviderDeadline(clock: Clock): Instant | undefined {
  const computed = instantFromDate(new Date(Date.parse(clock.now()) + resumeProviderDeadlineMs));
  return computed.ok ? computed.value : undefined;
}

/** `DomainError.retryable` (src/domain/foundation/error.ts) is `true` only for
 * `timeout`/`unavailable`/`rate_limited`/`quota_unknown`/`interrupted` -- never for
 * `conflict`/`invariant_violation`/`permission_denied`/`not_found`/`external_failure`, which stay
 * `requires_manual` exactly as before. This is the one predicate every retryable-vs-terminal
 * decision in this file defers to -- never re-implemented ad hoc per call site. */
function isRetryableError(error: DomainError): boolean {
  return error.retryable;
}

function currentRetries(
  record: JobProgressRecord,
  kind: "review_pending_retry" | "ci_pending_retry",
): number {
  return record.stage.kind === kind ? record.stage.retries : 0;
}

export function defaultJobProgressDirectory(agentTeamHome: string): string {
  return join(agentTeamHome, "state", "dispatch", "progress");
}

export interface ResumeCycleDependencies {
  readonly progress: FileJobProgressStore;
  readonly jobRepository: ResumeJobRepository;
  readonly leases: LeaseCoordinator;
  readonly sourceControl: Pick<SourceControlPort, "getChangeRequest">;
  readonly readModel: LinearDiscoveryReadModel;
  readonly teamId: string;
  readonly linearProjectId: string;
  readonly project: Project;
  readonly trustedConfig: TrustedProjectConfig;
  readonly ciRecovery: Pick<CiRecoveryPipeline, "run">;
  readonly reviewer: Pick<ReviewerPipeline, "run">;
  readonly reviewStatus: Pick<ReviewStatusCoordinator, "begin" | "record">;
  readonly autoMerge: Pick<AutoMergeGate, "enable">;
  readonly lifecycle: Pick<LifecyclePipeline, "run">;
  readonly clock: Clock;
  readonly holderId: string;
  /** C015y decision A: originally used by `resolveLegacyBaseRevision` to re-resolve the
   * authoritative base when repairing a *legacy* (pre-C015y) job-progress record. C015z decision
   * Q3 removed that repair path outright (a legacy record now always fails closed to
   * `requires_manual` without ever calling this) -- kept on this interface, currently unused by
   * this module, rather than removing it and rippling through every composition/test call site
   * that wires it (handlers.ts, resume-full-composition.ts, and this file's own test suite); a
   * dedicated cleanup ticket may retire it later if nothing else ever needs it. Still a thin,
   * already-ports-bound wrapper around the *same* `resolveAuthoritativeBaseRevision`
   * (authoritative-base.ts) a fresh dispatch uses (handlers.ts) -- never a second,
   * independently-drifting implementation of "what counts as authoritative" -- keeping this module
   * itself free of any direct `GitHubAdapter`/`LocalGitAdapter` construction. */
  readonly resolveAuthoritativeBase: (
    project: Project,
    options: Readonly<{ idempotencyKey: string; signal?: AbortSignal }>,
  ) => Promise<Result<AuthoritativeBaseRevision, AuthoritativeBaseFailure>>;
  /** C015r decision 5: the observability sidecar -- see its own file header
   * (review-report-diagnostics-sidecar.ts) for the full rule set. Only ever called from within this
   * module's own `report`-stage failure handling; never anywhere else. */
  readonly reviewReportSidecar: ReviewReportDiagnosticsSidecarPort;
  /** C015t decision 3: needed *only* by `reconcileMergeStateUnderLease`'s final step (release the
   * claim, and only after Lifecycle and the progress CAS have both durably confirmed) -- the
   * ordinary resumable-stage path (`resumeUnderLease`/`resumeReview`) never touches admission at
   * all, exactly as before this ticket. */
  readonly admission: IssueAdmissionPort;
}

export type ResumeJobOutcome =
  | Readonly<{ jobId: string; outcome: "lease_conflict" }>
  | Readonly<{ jobId: string; outcome: "requires_manual"; reason: string }>
  | Readonly<{ jobId: string; outcome: "still_ci_waiting" }>
  | Readonly<{ jobId: string; outcome: "still_merging" }>
  // C015t decision 1: `AutoMergeGate.enable()`'s `"re_review_required"`/`not_ready:
  // "review_status_missing"` outcomes -- genuinely needs a fresh review, not a human, and not the
  // same thing as "still waiting on CI" (`still_ci_waiting`). Functionally identical re-entry to
  // `still_ci_waiting` today (see `resumableStageKinds`'s own comment: `"awaiting_review"` and
  // `"ci_waiting"` both fall through the same generic CiRecovery-then-Reviewer sequence), but a
  // distinct, more accurate label for anyone reading `agent-team run`'s own output.
  | Readonly<{ jobId: string; outcome: "awaiting_review" }>
  | Readonly<{ jobId: string; outcome: "repair_pushed" }>
  | Readonly<{
      jobId: string;
      outcome: "fix_round";
      verdict: "changes_requested" | "clarification_required";
    }>
  | Readonly<{ jobId: string; outcome: "checkpointed"; checkpointId: string }>
  | Readonly<{ jobId: string; outcome: "merging" }>
  | Readonly<{ jobId: string; outcome: "completed" }>
  | Readonly<{ jobId: string; outcome: "failed"; stage: string; error: DomainError }>
  // C015o decision 2: a retryable provider-start/provider-run failure that has *not* exhausted
  // `providerRetryLimit` -- the job stays in `review_pending_retry`/`ci_pending_retry` (resumable)
  // rather than being forced to `requires_manual`.
  | Readonly<{
      jobId: string;
      outcome: "pending_retry";
      stage: string;
      error: DomainError;
      retries: number;
    }>
  // C015o decision 5: `transition(...)`'s CAS write itself failed -- a *different* process's
  // concurrent write to the same job-progress record, or a genuine storage fault. The in-memory
  // decision this attempt made (e.g. "this should become requires_manual") was never durably
  // recorded; the caller must not report the intended outcome as if it had been, and must not
  // silently retry writing over whatever the record actually now says.
  | Readonly<{ jobId: string; outcome: "progress_write_failed"; error: DomainError }>
  // C015o decision 5 (the 5-real-external-call risk class from the diagnosis): a retryable
  // failure at a call site with no dedicated attempt-counter stage of its own (change request/
  // job/issue/base-revision reads, review begin/record, auto-merge, lifecycle) -- deliberately
  // leaves `record.stage` completely untouched (no write at all) so the next `agent-team run`
  // simply retries the same resume step from scratch. See `requiresManualUnlessRetryable`'s own
  // comment for the disclosed trade-off (no bounded attempt cap on this path, unlike
  // `pending_retry`).
  | Readonly<{ jobId: string; outcome: "transient_failure"; reason: string; error: DomainError }>
  // C015t decision 3: the narrow, read-only re-entry check for `requires_manual` records whose
  // `cause.reasonCode` is in the "external might already have succeeded" set
  // (`isMergeReconcilable`'s own comment). None of these ever change `record.stage` except
  // `"merge_reconciled"` (the one full-success case, itself only reached after Lifecycle, the
  // progress CAS, *and* admission release all durably confirmed, in that order).
  | Readonly<{ jobId: string; outcome: "merge_reconciled" }>
  | Readonly<{
      jobId: string;
      outcome: "merge_reconcile_unchanged";
      readback: "open" | "closed_not_merged";
    }>
  | Readonly<{ jobId: string; outcome: "merge_reconcile_readback_failed"; error: DomainError }>
  | Readonly<{ jobId: string; outcome: "merge_reconcile_lifecycle_failed"; error: DomainError }>
  // C015t decision 1 (acceptance criterion ②'s own explicit requirement): a genuine, ordinary
  // completion -- whether reached through the normal `resumeReview`/`resumeUnderLease` flow
  // (`finishMerged`) or through decision 3's narrow reconcile pass -- must also release the job's
  // admission claim, not just write `completed`. This was a pre-existing C015o gap (nothing ever
  // called `admission.release(..., "completed")` on a normal success path before this ticket,
  // disclosed in the completion report) that this ticket closes as part of making the whole
  // merge-to-completion chain honest end to end. Shared by both call sites via
  // `releaseCompletedAdmission`; the job is already durably `completed` by the time this can ever
  // be reported, so a failure here is always safe to retry independently (never redoes Lifecycle).
  | Readonly<{ jobId: string; outcome: "admission_release_failed"; error: DomainError }>;

/**
 * C015t decision 3: the narrow, read-only re-entry set for `requires_manual` records -- deliberately
 * *not* a blanket reopening of `requires_manual` (codex's own review explicitly warned against a
 * general reconciliation classifier scanning every stuck job; the coordinator's decision 3 draws the
 * line at exactly the two reasonCodes where the underlying failure was itself about whether an
 * *external* system (GitHub's merge, then Lifecycle's Linear transition) had already succeeded --
 * `auto_merge_not_enabled` (this ticket's own root-cause incident) and `lifecycle_not_completed`
 * (the same class of drift one stage later: Lifecycle itself failed to complete, but the merge that
 * triggered it may have still gone through). Every other `requires_manual` reasonCode
 * (`change_request_unavailable`, `job_unavailable`, `review_not_approved`, ...) describes a genuine
 * state mismatch or a review-side rejection that no readback can safely second-guess, and stays
 * exactly as fail-closed as C015o's admission design always intended.
 */
export function isMergeReconcilable(record: JobProgressRecord): record is JobProgressRecord & {
  stage: Extract<JobProgressRecord["stage"], { kind: "requires_manual" }>;
} {
  return (
    record.stage.kind === "requires_manual" &&
    record.stage.cause !== undefined &&
    (record.stage.cause.reasonCode === "auto_merge_not_enabled" ||
      record.stage.cause.reasonCode === "lifecycle_not_completed")
  );
}

/**
 * C015u decision 1: the *complete* predicate for "this record needs `runResumeCycle` to look at it
 * at all" -- `resumableStageKinds.has(...)` alone (the pre-C015t predicate) went stale the moment
 * C015t added the second, narrower candidate class (`isMergeReconcilable`). This is the exact bug a
 * real E101 run just hit: `handlers.ts`'s own pre-flight gate only checked
 * `resumableStageKinds`, so a `requires_manual` record with `cause.reasonCode:
 * "auto_merge_not_enabled"` (genuinely reconcilable) never even reached `runResumeCycle` -- the CLI
 * fell straight through to fresh dispatch, which then correctly got blocked by the still-active
 * admission claim, producing the exact silent-no-op the coordinator observed
 * (`state:"waiting","reason":"no_eligible_candidates"`).
 *
 * `runResumeCycle` itself is *not* changed by this predicate -- it still separately filters into
 * `resumable`/`mergeReconcilable` and drives each through its own distinct code path (a normal
 * resume attempt vs. the narrow, read-only readback). This function exists *only* so every outer
 * gate that has to decide "is there anything for `runResumeCycle` to do" (today: `handlers.ts`'s
 * own pre-flight check before building the GitHub-auth-gated resume composition and ensuring the
 * worktree directory exists) can ask one question and get the right answer, rather than
 * re-deriving (and inevitably drifting from) `runResumeCycle`'s own eligibility logic a second time.
 *
 * Deliberately not "call `runResumeCycle` unconditionally, let it no-op if there's nothing to do":
 * codex's review named the concrete cost of that alternative -- a project with *zero* existing
 * progress records (the common case: no prior job at all, or every prior job already terminal) would
 * still pay for building the full GitHub-auth-gated resume composition and an `ensureDispatchWorktreesDirectory`
 * call on every single `agent-team run`, and -- worse -- would turn an otherwise-dispatchable run
 * into `github_authentication_unavailable`-blocked the moment GitHub auth is not configured, even
 * though this run had no resume work to do at all and a fresh dispatch never needed GitHub auth in
 * the first place.
 */
export function isResumeCandidate(record: JobProgressRecord): boolean {
  return resumableStageKinds.has(record.stage.kind) || isMergeReconcilable(record);
}

/** Runs one resume attempt for every resumable job-progress record belonging to `dependencies.project`,
 * plus (C015t decision 3) a narrow, read-only merge-state reconciliation pass over `requires_manual`
 * records whose cause matches `isMergeReconcilable`. */
export async function runResumeCycle(
  dependencies: ResumeCycleDependencies,
): Promise<Result<readonly ResumeJobOutcome[], DomainError>> {
  const records = await dependencies.progress.listForProject(dependencies.project.id);
  if (!records.ok) return records;
  const resumable = records.value.filter((record) => resumableStageKinds.has(record.stage.kind));
  const mergeReconcilable = records.value.filter((record) => isMergeReconcilable(record));

  const outcomes: ResumeJobOutcome[] = [];
  for (const record of resumable) {
    outcomes.push(await resumeOneJob(record, dependencies));
  }
  for (const record of mergeReconcilable) {
    outcomes.push(await reconcileMergeStateOneJob(record, dependencies));
  }
  return ok(Object.freeze(outcomes));
}

function parsedHeadSha(value: string): ReturnType<typeof headShaSchema.parse> | undefined {
  const parsed = headShaSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parsedCheckpointId(
  value: string,
): ReturnType<typeof checkpointIdSchema.parse> | undefined {
  const parsed = checkpointIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function mutationFrom(record: JobProgressRecord): JobProgressRecordMutation {
  const {
    schemaVersion: _schemaVersion,
    revision: _revision,
    updatedAt: _updatedAt,
    ...rest
  } = record;
  void _schemaVersion;
  void _revision;
  void _updatedAt;
  return rest;
}

async function transition(
  progress: FileJobProgressStore,
  record: JobProgressRecord,
  next: Partial<JobProgressRecordMutation>,
): Promise<Result<JobProgressRecord, DomainError>> {
  return progress.compareAndSwap(record.jobId, record.revision, {
    ...mutationFrom(record),
    ...next,
  });
}

async function resumeOneJob(
  record: JobProgressRecord,
  deps: ResumeCycleDependencies,
): Promise<ResumeJobOutcome> {
  const lease = await deps.leases.acquire({
    jobId: record.jobId,
    issueId: record.issueId,
    holderId: deps.holderId,
  });
  if (!lease.ok) return { jobId: record.jobId, outcome: "lease_conflict" };

  try {
    return await resumeUnderLease(record, deps);
  } finally {
    await deps.leases.release({ leaseId: lease.value.value.id, holderId: deps.holderId });
  }
}

/** C015t decision 3: same lease discipline as `resumeOneJob` -- guards against a concurrent
 * `agent-team run`/reconcile pass racing on the same job while this narrow readback is in flight. */
async function reconcileMergeStateOneJob(
  record: JobProgressRecord,
  deps: ResumeCycleDependencies,
): Promise<ResumeJobOutcome> {
  const lease = await deps.leases.acquire({
    jobId: record.jobId,
    issueId: record.issueId,
    holderId: deps.holderId,
  });
  if (!lease.ok) return { jobId: record.jobId, outcome: "lease_conflict" };

  try {
    return await reconcileMergeStateUnderLease(record, deps);
  } finally {
    await deps.leases.release({ leaseId: lease.value.value.id, holderId: deps.holderId });
  }
}

/**
 * C015t decision 3: reads back the authoritative PR state for a `requires_manual` job whose cause
 * matches `isMergeReconcilable`, and converges *only* the unambiguous case (`state:"merged"`) --
 * `"open"` and `"closed"`-not-merged both leave the record completely untouched, exactly per the
 * coordinator's explicit rule ("不擅自解除"/"不得完成也不得釋放 admission").
 *
 * Ordering is load-bearing: Lifecycle runs first; only once it durably reports `"completed"` does
 * this function CAS the progress record to `completed`; only once *that* durably confirms does it
 * release the admission claim. Any step failing leaves everything durable exactly as it was before
 * this call (no partial writes), so the next reconcile pass safely retries the *entire* sequence
 * from scratch with the same `record.revision` -- and therefore the same Lifecycle
 * `idempotencyKeyPrefix` -- rather than a differently-keyed, potentially-duplicating retry.
 *
 * Provenance from this path is always treated as unknown/external (never self-authorized) -- see
 * `finishMerged`'s own header and decision 1's explicit requirement. This function intentionally
 * does *not* call `finishMerged` (which, on Lifecycle failure, itself writes a fresh
 * `requires_manual` via `transitionOrReport` -- correct for the normal resume path, but it would
 * bump `record.revision` here and break the same-idempotencyKey retry guarantee this function
 * needs); it drives `deps.lifecycle.run(...)` directly instead.
 */
/**
 * C015t decision 1 (acceptance criterion ②): shared by `finishMerged` (the normal resume path) and
 * `reconcileMergeStateUnderLease` (decision 3's backstop) -- both must release the job's admission
 * claim once, and only once, the job is durably `completed`. Never an error if the claim is already
 * released or was never active (a concurrent process may have already done this, or the claim may
 * legitimately not exist any more for another honest reason) -- only a genuine store failure
 * propagates.
 */
async function releaseCompletedAdmission(
  record: JobProgressRecord,
  deps: ResumeCycleDependencies,
): Promise<Result<void, DomainError>> {
  const claim = await deps.admission.load(deps.project.id, record.issueId);
  if (!claim.ok) return claim;
  if (claim.value?.state !== "active") return ok(undefined);
  const released = await deps.admission.release(
    deps.project.id,
    record.issueId,
    claim.value.revision,
    "completed",
  );
  if (!released.ok) return released;
  return ok(undefined);
}

async function reconcileMergeStateUnderLease(
  record: JobProgressRecord,
  deps: ResumeCycleDependencies,
): Promise<ResumeJobOutcome> {
  const changeRequestId = record.changeRequestId;
  if (changeRequestId === undefined) {
    return {
      jobId: record.jobId,
      outcome: "merge_reconcile_readback_failed",
      error: domainError("invariant_violation"),
    };
  }
  const current = await deps.sourceControl.getChangeRequest({
    project: deps.project,
    changeRequestId,
  });
  if (!current.ok) {
    return {
      jobId: record.jobId,
      outcome: "merge_reconcile_readback_failed",
      error: current.error,
    };
  }
  if (current.value.state === "open") {
    return { jobId: record.jobId, outcome: "merge_reconcile_unchanged", readback: "open" };
  }
  if (current.value.state !== "merged") {
    // "closed", not merged -- the coordinator's explicit human-handling branch.
    return {
      jobId: record.jobId,
      outcome: "merge_reconcile_unchanged",
      readback: "closed_not_merged",
    };
  }

  const lifecycleOutcome = await deps.lifecycle.run({
    project: deps.project,
    externalIssueId: record.externalIssueId,
    changeRequestId,
    idempotencyKeyPrefix: `cli-dispatch-reconcile:${record.jobId}:${String(record.revision)}:lifecycle`,
  });
  if (lifecycleOutcome.state !== "completed") {
    return {
      jobId: record.jobId,
      outcome: "merge_reconcile_lifecycle_failed",
      error:
        lifecycleOutcome.state === "failed"
          ? lifecycleOutcome.error
          : domainError("external_failure"),
    };
  }

  const completed = await transition(deps.progress, record, { stage: { kind: "completed" } });
  if (!completed.ok) {
    return { jobId: record.jobId, outcome: "progress_write_failed", error: completed.error };
  }

  const released = await releaseCompletedAdmission(record, deps);
  if (!released.ok) {
    return { jobId: record.jobId, outcome: "admission_release_failed", error: released.error };
  }
  return { jobId: record.jobId, outcome: "merge_reconciled" };
}

/**
 * C015o decision 5: every call site that used to do `await transition(...); return {...}` --
 * ignoring `transition`'s own `Result` -- claimed the intended state change had happened even when
 * the underlying CAS write failed (a concurrent writer, or a genuine storage fault). This is the
 * one place that pattern is now centralized: the caller supplies what it *wants* to become true;
 * this helper only ever reports that as having happened if the durable write actually confirmed it.
 */
async function transitionOrReport(
  deps: ResumeCycleDependencies,
  record: JobProgressRecord,
  next: Partial<JobProgressRecordMutation>,
  onWritten: () => ResumeJobOutcome,
): Promise<ResumeJobOutcome> {
  const written = await transition(deps.progress, record, next);
  if (!written.ok) {
    return { jobId: record.jobId, outcome: "progress_write_failed", error: written.error };
  }
  return onWritten();
}

async function requiresManual(
  record: JobProgressRecord,
  deps: ResumeCycleDependencies,
  reason: string,
  cause: RequiresManualCause,
): Promise<ResumeJobOutcome> {
  return transitionOrReport(deps, record, { stage: { kind: "requires_manual", cause } }, () => ({
    jobId: record.jobId,
    outcome: "requires_manual",
    reason,
  }));
}

/**
 * C015o decision 5 (the "5 real external call" risk class the diagnosis named): for a call site
 * with no dedicated attempt-counter stage of its own, a retryable failure leaves `record.stage`
 * completely untouched -- no `transition(...)` call at all -- so the next `agent-team run` simply
 * re-attempts the same resume step from whatever stage the record was already durably in. This is a
 * disclosed, intentionally minimal-scope choice: unlike `review_pending_retry`/`ci_pending_retry`
 * (decision 2's dedicated counters), this path has no bounded attempt cap -- a condition that never
 * resolves retries indefinitely rather than ever reaching `requires_manual` on its own. Decision 2's
 * own text only asked for a counter at the provider-invocation call sites; adding five more
 * dedicated counter stages for every other retryable-external-call site was judged out of this
 * ticket's scope (each would need its own `JobProgressStage` variant), not silently dropped -- see
 * the completion report.
 */
async function requiresManualUnlessRetryable(
  record: JobProgressRecord,
  deps: ResumeCycleDependencies,
  reason: string,
  error: DomainError | undefined,
  cause: RequiresManualCause,
): Promise<ResumeJobOutcome> {
  if (error !== undefined && isRetryableError(error)) {
    return { jobId: record.jobId, outcome: "transient_failure", reason, error };
  }
  return requiresManual(record, deps, reason, cause);
}

/**
 * C015x decision 3 + C015y decision C: the resume-time half of the bounded `"merging"` wait --
 * `resumeUnderLease` calls this once it already knows `record.stage.kind === "merging"` (a fresh,
 * authoritative `current` readback for this exact change request already in hand from that same
 * call's own pre-flight check). Escalation rules, in priority order, all fail-closed to
 * `requires_manual` with the authoritative evidence attached (never a silent, unbounded wait):
 *
 * 1. `mergeStateStatus === "behind"` escalates *immediately*, regardless of history or elapsed
 *    time -- this project's own `strictRequiredStatusChecksPolicy` ruleset (O004) means GitHub can
 *    never execute this merge while behind, no matter how many more times this job is resumed.
 * 2. The 30-minute absolute deadline (`mergingAbsoluteDeadlineMs`, measured from `armedAt`) fires
 *    *unconditionally* -- even if the fingerprint has been changing every single resume. This is
 *    checked before the `"unknown"` case below on purpose: an `"unknown"` `mergeStateStatus`
 *    flapping in and out must never be able to postpone this indefinitely.
 * 3. `mergeStateStatus === "unknown"` is tracked entirely separately from ordinary progress
 *    (`unknownSince`/`unknownCount`, never `fingerprint`/`noProgressCount`/`lastProgressAt`) --
 *    `mergeStateUnknownMinReadbacks` consecutive fresh `"unknown"` reads spanning
 *    `mergeStateUnknownWallClockMs` escalates to `merge_state_unknown_timeout`. Any non-`"unknown"`
 *    reading clears this streak.
 * 4. Otherwise, ordinary progress tracking: if the freshly observed fingerprint is byte-for-byte
 *    identical to the last persisted one, `noProgressCount` increments and `lastProgressAt` stays
 *    put; escalates to `auto_merge_stalled` only once *both* `noProgressCount >=
 *    mergingNoProgressLimit` *and* `now - lastProgressAt >= mergingNoProgressWallClockMs` hold
 *    (an invocation-count alone was never sufficient -- see `mergingNoProgressWallClockMs`'s own
 *    header for why). Any *change* in the fingerprint (progress, or simply the very first
 *    concrete resume since this stage was armed/migrated) resets the counter to 0 and moves
 *    `lastProgressAt` forward, rather than escalating.
 *
 * The `stage.kind !== "merging"` branch below is unreachable through the one real call site (the
 * check happens immediately before calling) -- kept only as this file's own established
 * fail-closed-on-invariant-violation style, never silently assumed away.
 */
async function resumeMergingStage(
  record: JobProgressRecord,
  deps: ResumeCycleDependencies,
  current: ChangeRequestSnapshot,
): Promise<ResumeJobOutcome> {
  if (record.stage.kind !== "merging") {
    return requiresManual(
      record,
      deps,
      "merging_stage_invariant_violation",
      requiresManualCause("merge", "auto_merge_not_enabled"),
    );
  }
  const stage = record.stage;
  const observed = mergeFingerprintOf(current);
  const observedAt = deps.clock.now();
  const armedAt = stage.armedAt ?? observedAt;

  if (observed.mergeStateStatus === "behind") {
    return requiresManual(
      record,
      deps,
      "change_request_behind_base",
      requiresManualCause("merge", "change_request_behind_base", 1, undefined, observed),
    );
  }

  if (elapsedMs(armedAt, observedAt) >= mergingAbsoluteDeadlineMs) {
    return requiresManual(
      record,
      deps,
      "auto_merge_stalled:absolute_deadline",
      requiresManualCause(
        "merge",
        "auto_merge_stalled",
        (stage.noProgressCount ?? 0) + 1,
        undefined,
        observed,
        stallTimingOf(armedAt, stage.lastProgressAt, observedAt),
      ),
    );
  }

  if (observed.mergeStateStatus === "unknown") {
    const unknownSince = stage.unknownSince ?? observedAt;
    const unknownCount = (stage.unknownCount ?? 0) + 1;
    if (
      unknownCount >= mergeStateUnknownMinReadbacks &&
      elapsedMs(unknownSince, observedAt) >= mergeStateUnknownWallClockMs
    ) {
      return requiresManual(
        record,
        deps,
        "merge_state_unknown_timeout",
        requiresManualCause(
          "merge",
          "merge_state_unknown_timeout",
          unknownCount,
          undefined,
          observed,
          stallTimingOf(armedAt, stage.lastProgressAt, observedAt),
        ),
      );
    }
    // Deliberately never touches `fingerprint`/`noProgressCount`/`lastProgressAt` -- an
    // `"unknown"` reading is GitHub still computing, not evidence either way about the underlying
    // merge's own progress (see this stage's own schema header, job-progress-store.ts).
    return transitionOrReport(
      deps,
      record,
      {
        stage: {
          kind: "merging",
          armedAt,
          fingerprint: stage.fingerprint,
          noProgressCount: stage.noProgressCount ?? 0,
          lastProgressAt: stage.lastProgressAt,
          unknownSince,
          unknownCount,
        },
      },
      () => ({ jobId: record.jobId, outcome: "still_merging" }),
    );
  }

  const previous = stage.fingerprint;
  const progressed = previous === undefined || !mergeFingerprintsEqual(previous, observed);
  const lastProgressAt = progressed ? observedAt : (stage.lastProgressAt ?? observedAt);
  const noProgressCount = progressed ? 0 : (stage.noProgressCount ?? 0) + 1;

  if (
    !progressed &&
    noProgressCount >= mergingNoProgressLimit &&
    elapsedMs(lastProgressAt, observedAt) >= mergingNoProgressWallClockMs
  ) {
    return requiresManual(
      record,
      deps,
      "auto_merge_stalled:no_progress_timeout",
      requiresManualCause(
        "merge",
        "auto_merge_stalled",
        noProgressCount,
        undefined,
        observed,
        stallTimingOf(armedAt, lastProgressAt, observedAt),
      ),
    );
  }

  return transitionOrReport(
    deps,
    record,
    {
      stage: {
        kind: "merging",
        armedAt,
        fingerprint: observed,
        noProgressCount,
        lastProgressAt,
        unknownSince: undefined,
        unknownCount: undefined,
      },
    },
    () => ({ jobId: record.jobId, outcome: "still_merging" }),
  );
}

/**
 * C015z decision (Q3, option b -- replacing C015y decision A's repair heuristic outright): a
 * *legacy* (pre-C015y) job-progress record has no persisted `baseRevision`, and there is no safe
 * way to reconstruct what the original dispatch actually used as its base. The prior version of
 * this function re-resolved the authoritative base the same way a fresh dispatch does
 * (`deps.resolveAuthoritativeBase`) and cross-checked that *live* result against the PR's own
 * `.base.sha` -- but `.base.sha` is a value GitHub freezes at PR-creation time, never the base
 * branch's live tip (see `ChangeRequestSnapshot.baseSha`'s corrected header, source-control.ts).
 * The two values are structurally guaranteed to differ the instant the base branch advances past
 * PR-creation time -- exactly the situation this repair path existed to handle -- so the old check
 * could never succeed in the one case it was built for; it only ever coincidentally passed because
 * this project's own serialized workflow rarely lets `main` advance between a legacy PR's creation
 * and its resume.
 *
 * This function therefore never attempts recovery any more: every legacy record fails closed to
 * `requires_manual(legacy_base_revision_unrecoverable)` unconditionally, carrying *this exact
 * resume's own* fresh PR readback (`current`) as evidence for whoever runs
 * `agent-team dispatch resolve` to requeue it. No CAS write of a guessed `baseRevision` ever
 * happens here -- `deps.resolveAuthoritativeBase` is not even called.
 */
async function resolveLegacyBaseRevision(
  record: JobProgressRecord,
  deps: ResumeCycleDependencies,
  current: ChangeRequestSnapshot,
): Promise<ResumeJobOutcome> {
  return requiresManual(
    record,
    deps,
    "legacy_base_revision_unrecoverable",
    requiresManualCause(
      "setup",
      "legacy_base_revision_unrecoverable",
      1,
      undefined,
      legacyBaseRevisionEvidence(current),
    ),
  );
}

/** C015z decision (Q3): the fresh PR readback's own head/base SHA and merge state, captured as
 * evidence on a `legacy_base_revision_unrecoverable` cause -- deliberately *not*
 * `mergeFingerprintOf` (that helper exists for the `"merging"`-stage no-progress comparison, Q4,
 * and no longer carries `baseSha` at all); this evidence is for a human reading the cause, so it
 * keeps `baseSha` when the fresh readback actually has one. */
function legacyBaseRevisionEvidence(snapshot: ChangeRequestSnapshot): MergeReadbackFingerprint {
  return Object.freeze({
    headSha: snapshot.headSha,
    ...(snapshot.baseSha === undefined ? {} : { baseSha: snapshot.baseSha }),
    mergeStateStatus: snapshot.mergeStateStatus ?? "unknown",
    merged: snapshot.state === "merged",
  });
}

async function resumeUnderLease(
  record: JobProgressRecord,
  deps: ResumeCycleDependencies,
): Promise<ResumeJobOutcome> {
  if (record.changeRequestId === undefined) {
    return requiresManual(
      record,
      deps,
      "missing_change_request_id",
      requiresManualCause("setup", "change_request_unavailable"),
    );
  }
  const changeRequestId = record.changeRequestId;
  const changeRequestReference = { project: deps.project, changeRequestId };
  const currentChangeRequest = await deps.sourceControl.getChangeRequest(changeRequestReference);
  if (!currentChangeRequest.ok) {
    return requiresManualUnlessRetryable(
      record,
      deps,
      "change_request_read_failed",
      currentChangeRequest.error,
      requiresManualCause("setup", "change_request_unavailable"),
    );
  }
  // Exact-readback: the recorded branch/headSha must still match live GitHub, unless the PR has
  // since merged out of band (a legitimate, expected race between this resume and a prior run's
  // own auto-merge/manual merge) -- everything else is a genuine mismatch, fail-closed.
  //
  // C015t decision 1: this readback alone cannot tell *who* merged it -- it is a generic
  // pre-flight check that runs for every resumable stage, not a report from the exact call that
  // caused the merge. The one case where controller authorization is still defensible is
  // `record.stage.kind === "merging"`: a *durable*, previously-written record of this same
  // controller having itself successfully enabled auto-merge for this exact job (never inferred
  // from head-SHA equality alone, which codex's review named as the actual bug in the prior
  // version of this line -- head-SHA equality is only ever used here as a *consistency check* on
  // top of that durable record, never as the sole justification). Any other stage kind finding the
  // PR already merged is genuinely unexplained from this job's own history and must not be
  // self-authorized -- Lifecycle's own out-of-process-merge handling (lifecycle.ts's
  // `#handleMerge`) is what correctly takes over in that case.
  if (currentChangeRequest.value.state === "merged") {
    const authorizedHeadSha =
      record.stage.kind === "merging" ? currentChangeRequest.value.headSha : undefined;
    return finishMerged(record, deps, changeRequestId, authorizedHeadSha);
  }
  if (
    currentChangeRequest.value.headBranch !== record.branch ||
    (record.headSha !== undefined && currentChangeRequest.value.headSha !== record.headSha)
  ) {
    return requiresManual(
      record,
      deps,
      "change_request_state_mismatch",
      requiresManualCause("setup", "change_request_unavailable"),
    );
  }
  if (currentChangeRequest.value.state === "closed") {
    return requiresManual(
      record,
      deps,
      "change_request_closed",
      requiresManualCause("setup", "change_request_unavailable"),
    );
  }

  if (record.stage.kind === "merging") {
    return resumeMergingStage(record, deps, currentChangeRequest.value);
  }

  const jobs = await deps.jobRepository.readAll();
  if (!jobs.ok) {
    return requiresManualUnlessRetryable(
      record,
      deps,
      "job_read_failed",
      jobs.error,
      requiresManualCause("setup", "job_unavailable"),
    );
  }
  const job = jobs.value.find((candidate) => candidate.id === record.jobId);
  if (job === undefined) {
    return requiresManual(
      record,
      deps,
      "job_not_found",
      requiresManualCause("setup", "job_unavailable"),
    );
  }

  const issue = await projectIssueByExternalId(
    deps.project,
    deps.readModel,
    deps.teamId,
    deps.linearProjectId,
    record.externalIssueId,
  );
  if (!issue.ok) {
    return requiresManualUnlessRetryable(
      record,
      deps,
      "issue_projection_failed",
      issue.error,
      requiresManualCause("setup", "requirement_snapshot_unavailable"),
    );
  }
  const requirementSnapshot = createRequirementSnapshot(issue.value, deps.clock.now());
  if (!requirementSnapshot.ok) {
    return requiresManualUnlessRetryable(
      record,
      deps,
      "requirement_snapshot_invalid",
      requirementSnapshot.error,
      requiresManualCause("setup", "requirement_snapshot_unavailable"),
    );
  }

  // C015y decision A: the authoritative base is read from the durable record, never re-derived
  // from the local git checkout -- see this file's own module header and job-progress-store.ts's
  // `baseRevision` field header for why. C015z decision Q3: a legacy record (no `baseRevision` at
  // all) is no longer repaired -- `resolveLegacyBaseRevision` always fails closed to
  // `requires_manual`, so this branch always returns from here; `record` is never reassigned.
  if (record.baseRevision === undefined) {
    return resolveLegacyBaseRevision(record, deps, currentChangeRequest.value);
  }
  const baseRevision: HeadSha = record.baseRevision;

  const worktree = {
    repositoryRoot: deps.project.localRepositoryPath,
    path: record.worktreePath,
    branch: record.branch,
    headSha: currentChangeRequest.value.headSha,
  };
  const idempotencyKeyPrefix = `cli-dispatch-resume:${record.jobId}:${String(record.revision)}`;

  const ciDeadline = computeProviderDeadline(deps.clock);
  if (ciDeadline === undefined) {
    return requiresManual(
      record,
      deps,
      "invalid_deadline",
      requiresManualCause("ci_recovery", "invalid_deadline"),
    );
  }

  const ciOutcome = await deps.ciRecovery.run({
    trigger: { kind: "polling" },
    job,
    project: deps.project,
    trustedConfig: deps.trustedConfig,
    requirementSnapshot: requirementSnapshot.value,
    worktree,
    changeRequest: currentChangeRequest.value,
    model: record.model,
    remote: "origin",
    commitMessage: `${issue.value.title} (${issue.value.externalId}) CI 修復`,
    controllerDirective: buildDirective(issue.value),
    externalData: Object.freeze([]),
    deadlineAt: ciDeadline,
    idempotencyKeyPrefix: `${idempotencyKeyPrefix}:ci-recovery`,
  });

  switch (ciOutcome.state) {
    case "ci_waiting": {
      const headSha = parsedHeadSha(ciOutcome.checks.headSha);
      if (headSha === undefined) {
        return requiresManual(
          record,
          deps,
          "invalid_head_sha",
          requiresManualCause("ci_recovery", "invalid_head_sha"),
        );
      }
      return transitionOrReport(deps, record, { stage: { kind: "ci_waiting" }, headSha }, () => ({
        jobId: record.jobId,
        outcome: "still_ci_waiting",
      }));
    }
    case "repair_pushed": {
      const headSha = parsedHeadSha(ciOutcome.commit.sha);
      if (headSha === undefined) {
        return requiresManual(
          record,
          deps,
          "invalid_head_sha",
          requiresManualCause("ci_recovery", "invalid_head_sha"),
        );
      }
      return transitionOrReport(deps, record, { stage: { kind: "ci_waiting" }, headSha }, () => ({
        jobId: record.jobId,
        outcome: "repair_pushed",
      }));
    }
    case "checkpointed": {
      const checkpointId = parsedCheckpointId(ciOutcome.checkpointId);
      if (checkpointId === undefined) {
        return requiresManual(
          record,
          deps,
          "invalid_checkpoint_id",
          requiresManualCause("ci_recovery", "invalid_checkpoint_id"),
        );
      }
      return transitionOrReport(deps, record, { stage: { kind: "paused", checkpointId } }, () => ({
        jobId: record.jobId,
        outcome: "checkpointed",
        checkpointId: ciOutcome.checkpointId,
      }));
    }
    case "paused":
      return requiresManual(
        record,
        deps,
        `ci_recovery_paused:${ciOutcome.reason}`,
        requiresManualCause("ci_recovery", "ci_recovery_paused"),
      );
    case "failed": {
      // C015o decision 2: retryable CI-recovery provider failures get the same treatment as
      // reviewer ones (`ci_pending_retry`, symmetric to `review_pending_retry`) -- see this
      // file's own module header and `providerRetryLimit`'s comment for why this is a *new*,
      // dedicated counter rather than any of `Job.attempts`'s four existing ones.
      if (isRetryableError(ciOutcome.error)) {
        const retries = currentRetries(record, "ci_pending_retry") + 1;
        if (retries <= providerRetryLimit) {
          return transitionOrReport(
            deps,
            record,
            {
              stage: {
                kind: "ci_pending_retry",
                retries,
                lastErrorCode: ciOutcome.error.code,
              },
            },
            () => ({
              jobId: record.jobId,
              outcome: "pending_retry",
              stage: ciOutcome.stage,
              error: ciOutcome.error,
              retries,
            }),
          );
        }
      }
      return requiresManual(
        record,
        deps,
        `ci_recovery_failed:${ciOutcome.stage}:${ciOutcome.error.code}`,
        requiresManualCause("ci_recovery", "ci_recovery_failed"),
      );
    }
    case "ready_for_review":
      break;
  }

  return resumeReview(record, deps, {
    job,
    changeRequestId,
    requirementSnapshot: requirementSnapshot.value,
    worktree,
    changeRequest: currentChangeRequest.value,
    baseRevision,
    idempotencyKeyPrefix,
  });
}

/**
 * C015r decisions 4 + 5: the single place a `report`-stage reviewer failure is ever handled.
 *
 * Decision 5 (observability sidecar) happens first and unconditionally, right here where the raw
 * rejected text still exists: it is written to `deps.reviewReportSidecar`, Redactor-scrubbed and
 * size-capped by that adapter itself, and then this function never touches the raw text again --
 * it never appears in the `ResumeJobOutcome` this function returns, nor in the `cause` a
 * `requires_manual` transition may write. A sidecar write failure is deliberately never surfaced or
 * retried here -- it is a best-effort diagnostic aid (decision 5's own words), not a gate on the
 * resume outcome itself.
 *
 * Decision 4 (bounded, dedicated retry) happens second: `reportContractRetryLimit` (1) is tracked by
 * `review_report_pending_retry`'s own `retries` field -- never `providerRetryLimit`/
 * `review_pending_retry` (that counter is for the provider failing to run at all, a different
 * failure semantics per codex's C015q review). Once exhausted, `requires_manual` is written with
 * `reasonCode: "review_report_contract"` and `attempts: {count, lastCategory}` -- decision 1's
 * closed-enum cause, still never the raw provider text.
 */
async function handleReportContractFailure(
  record: JobProgressRecord,
  deps: ResumeCycleDependencies,
  reviewOutcome: Extract<ReviewerPipelineOutcome, { state: "failed" }>,
): Promise<ResumeJobOutcome> {
  const category: ReportContractFailureCategory =
    reviewOutcome.reportFailureCategory ?? "schema_invalid";
  if (reviewOutcome.rejectedOutput !== undefined) {
    await deps.reviewReportSidecar.record({
      jobId: record.jobId,
      category,
      rejectedOutput: reviewOutcome.rejectedOutput,
    });
  }
  const retries = currentReportContractRetries(record) + 1;
  if (retries <= reportContractRetryLimit) {
    return transitionOrReport(
      deps,
      record,
      { stage: { kind: "review_report_pending_retry", retries, lastCategory: category } },
      () => ({
        jobId: record.jobId,
        outcome: "pending_retry",
        stage: "report",
        error: reviewOutcome.error,
        retries,
      }),
    );
  }
  return requiresManual(
    record,
    deps,
    `review_report_contract:${category}`,
    requiresManualCause("review", "review_report_contract", retries, category),
  );
}

async function resumeReview(
  record: JobProgressRecord,
  deps: ResumeCycleDependencies,
  context: {
    readonly job: Parameters<CiRecoveryPipeline["run"]>[0]["job"];
    readonly changeRequestId: string;
    readonly requirementSnapshot: Parameters<ReviewerPipeline["run"]>[0]["requirementSnapshot"];
    readonly worktree: Parameters<ReviewerPipeline["run"]>[0]["worktree"];
    readonly changeRequest: Parameters<
      ReviewStatusCoordinator["record"]
    >[0]["decision"]["changeRequest"];
    readonly baseRevision: string;
    readonly idempotencyKeyPrefix: string;
  },
): Promise<ResumeJobOutcome> {
  const expectedHeadSha = context.changeRequest.headSha;
  const begin = await deps.reviewStatus.begin({
    project: deps.project,
    changeRequestId: context.changeRequestId,
    expectedHeadSha,
    idempotencyKeyPrefix: `${context.idempotencyKeyPrefix}:review-begin`,
  });
  if (begin.state === "failed") {
    return requiresManualUnlessRetryable(
      record,
      deps,
      "review_begin_failed",
      begin.error,
      requiresManualCause("review", "review_begin_failed"),
    );
  }
  if (begin.state === "not_ready") {
    return transitionOrReport(deps, record, { stage: { kind: "ci_waiting" } }, () => ({
      jobId: record.jobId,
      outcome: "still_ci_waiting",
    }));
  }
  if (begin.state === "already_approved") {
    // Disclosed limitation (see file header): this resume path never leaves a job in a state
    // that should reach commit-only-change reuse -- fail closed rather than guess at an approval
    // this code has no fresh evidence for.
    return requiresManual(
      record,
      deps,
      "already_approved_reuse_unimplemented",
      requiresManualCause("review", "review_reuse_unimplemented"),
    );
  }

  const reviewDeadline = computeProviderDeadline(deps.clock);
  if (reviewDeadline === undefined) {
    return requiresManual(
      record,
      deps,
      "invalid_deadline",
      requiresManualCause("review", "invalid_deadline"),
    );
  }

  // C015r decision 4: only set when this resume attempt is itself the one, bounded report-contract
  // retry -- carries a fixed failure-category enum into the directive, never the previous attempt's
  // raw invalid output (see `ReviewerPipelineRequest.reportRetryFeedback`'s own header).
  const reportRetryFeedback =
    record.stage.kind === "review_report_pending_retry"
      ? Object.freeze({ category: record.stage.lastCategory })
      : undefined;

  const reviewOutcome = await deps.reviewer.run({
    job: context.job,
    project: deps.project,
    trustedConfig: deps.trustedConfig,
    requirementSnapshot: context.requirementSnapshot,
    worktree: context.worktree,
    changeRequestId: context.changeRequestId,
    baseRevision: context.baseRevision,
    expectedHeadSha,
    models: { code: record.model },
    evidence: Object.freeze([]),
    deadlineAt: reviewDeadline,
    idempotencyKeyPrefix: `${context.idempotencyKeyPrefix}:review`,
    ...(reportRetryFeedback === undefined ? {} : { reportRetryFeedback }),
  });

  switch (reviewOutcome.state) {
    case "not_ready": {
      return transitionOrReport(deps, record, { stage: { kind: "ci_waiting" } }, () => ({
        jobId: record.jobId,
        outcome: "still_ci_waiting",
      }));
    }
    case "checkpointed": {
      const checkpointId = parsedCheckpointId(reviewOutcome.checkpointId);
      if (checkpointId === undefined) {
        return requiresManual(
          record,
          deps,
          "invalid_checkpoint_id",
          requiresManualCause("review", "invalid_checkpoint_id"),
        );
      }
      return transitionOrReport(deps, record, { stage: { kind: "paused", checkpointId } }, () => ({
        jobId: record.jobId,
        outcome: "checkpointed",
        checkpointId: reviewOutcome.checkpointId,
      }));
    }
    case "paused":
      return requiresManual(
        record,
        deps,
        `review_paused:${reviewOutcome.reason}`,
        requiresManualCause("review", "review_paused"),
      );
    case "failed": {
      // C015r decision 4: a `report`-stage failure (the provider ran to completion, but its output
      // failed decision 3's tolerant parse/schema/context checks) is handled entirely separately
      // from the retryable-provider-start/run path below -- its own dedicated, 1-capped retry
      // counter, its own sidecar write, its own requires_manual reasonCode. See
      // `handleReportContractFailure`'s own header for the full rationale.
      if (reviewOutcome.stage === "report") {
        return handleReportContractFailure(record, deps, reviewOutcome);
      }
      // C015o decision 2 (D1's confirmed root cause): a retryable reviewer provider-start/
      // provider-run failure gets a bounded, dedicated `review_pending_retry` state instead of
      // being forced straight to `requires_manual` -- see `providerRetryLimit`'s own comment for
      // why this is a *new* counter, never one of `Job.attempts`'s four existing ones.
      if (isRetryableError(reviewOutcome.error)) {
        const retries = currentRetries(record, "review_pending_retry") + 1;
        if (retries <= providerRetryLimit) {
          return transitionOrReport(
            deps,
            record,
            {
              stage: {
                kind: "review_pending_retry",
                retries,
                lastErrorCode: reviewOutcome.error.code,
              },
            },
            () => ({
              jobId: record.jobId,
              outcome: "pending_retry",
              stage: reviewOutcome.stage,
              error: reviewOutcome.error,
              retries,
            }),
          );
        }
      }
      return requiresManual(
        record,
        deps,
        `review_failed:${reviewOutcome.stage}:${reviewOutcome.error.code}`,
        requiresManualCause("review", "review_provider_failed"),
      );
    }
    case "changes_requested":
    case "clarification_required": {
      const record$ = await deps.reviewStatus.record({
        project: deps.project,
        changeRequestId: context.changeRequestId,
        expectedHeadSha,
        idempotencyKeyPrefix: `${context.idempotencyKeyPrefix}:review-record`,
        decision: reviewOutcome,
      });
      if (record$.state === "failed") {
        return requiresManualUnlessRetryable(
          record,
          deps,
          "review_record_failed",
          record$.error,
          requiresManualCause("review", "review_record_failed"),
        );
      }
      return transitionOrReport(deps, record, { stage: { kind: "fix_round" } }, () => ({
        jobId: record.jobId,
        outcome: "fix_round",
        verdict: reviewOutcome.state,
      }));
    }
    case "approved":
      break;
  }

  const recorded = await deps.reviewStatus.record({
    project: deps.project,
    changeRequestId: context.changeRequestId,
    expectedHeadSha,
    idempotencyKeyPrefix: `${context.idempotencyKeyPrefix}:review-record`,
    decision: reviewOutcome,
  });
  if (recorded.state !== "approved") {
    return recorded.state === "failed"
      ? requiresManualUnlessRetryable(
          record,
          deps,
          "review_record_did_not_approve",
          recorded.error,
          requiresManualCause("review", "review_not_approved"),
        )
      : requiresManual(
          record,
          deps,
          "review_record_did_not_approve",
          requiresManualCause("review", "review_not_approved"),
        );
  }

  const enabled = await deps.autoMerge.enable({
    project: deps.project,
    changeRequestId: context.changeRequestId,
    expectedHeadSha,
    idempotencyKeyPrefix: `${context.idempotencyKeyPrefix}:auto-merge`,
    requirementSnapshot: context.requirementSnapshot,
    baseRevision: context.baseRevision,
    approval: recorded.approval,
  });
  // C015t decision 1: `AutoMergeGate.enable()`'s outcome union now distinguishes exactly why/how a
  // merge did or didn't happen -- this switch is the CLI-side mapping table the coordinator
  // specified, and it is exhaustive over every state the engine can return (see
  // `EnableAutoMergeOutcome`'s own header, merge-gate-model.ts).
  switch (enabled.state) {
    case "auto_merge_enabled": {
      if (enabled.changeRequest.state === "merged") {
        // Same synchronous call chain that just enabled auto-merge found it already merged by the
        // time this check ran -- a pre-existing, disclosed race this ticket does not regress
        // (unlike the C015q/C015s incident, which is `directly_merged`/`already_merged_external`
        // below). Controller-authorized: this exact call armed it.
        return finishMerged(record, deps, context.changeRequestId, enabled.changeRequest.headSha);
      }
      // C015x decision 3: arms the persisted readback fingerprint/bound at the exact moment
      // auto-merge is enabled -- never left bare -- so `resumeMergingStage` has a real baseline to
      // compare every subsequent resume's fresh readback against, from the very first resume.
      // C015y decision C: `lastProgressAt` is seeded to this same arm-time instant -- the natural
      // baseline "progress" is measured against until the fingerprint next actually changes.
      const armedAt = deps.clock.now();
      return transitionOrReport(
        deps,
        record,
        {
          stage: {
            kind: "merging",
            armedAt,
            fingerprint: mergeFingerprintOf(enabled.changeRequest),
            noProgressCount: 0,
            lastProgressAt: armedAt,
          },
        },
        () => ({ jobId: record.jobId, outcome: "merging" }),
      );
    }
    case "directly_merged":
      // This exact call performed the squash fallback and confirmed it landed -- controller-
      // authorized (see `finishMerged`'s own header for why this is never re-derived elsewhere).
      return finishMerged(record, deps, context.changeRequestId, enabled.changeRequest.headSha);
    case "already_merged_external":
      // Found already merged before this call could have caused it -- explicitly NOT controller-
      // authorized. Lifecycle still runs (Linear still needs its Done transition and audit
      // comment; see coordinator's decision 1: honest marking is required, the *policy* of
      // pausing auto-merge/warning on out-of-process merges is Lifecycle's own existing job and
      // is out of this ticket's scope either way).
      return finishMerged(record, deps, context.changeRequestId, undefined);
    case "re_review_required":
      // The diff/requirements genuinely changed since the approval this job recorded -- needs a
      // fresh review, not a human. `AutoMergeGate.enable()` has already posted its own
      // invalidation comment/status before returning this (merge-gate.ts, unchanged by this
      // ticket); this is purely the CLI-side resume label.
      return transitionOrReport(deps, record, { stage: { kind: "awaiting_review" } }, () => ({
        jobId: record.jobId,
        outcome: "awaiting_review",
      }));
    case "not_ready":
      switch (enabled.reason) {
        case "ci_pending":
        case "ci_failed":
          return transitionOrReport(deps, record, { stage: { kind: "ci_waiting" } }, () => ({
            jobId: record.jobId,
            outcome: "still_ci_waiting",
          }));
        case "review_status_missing":
          return transitionOrReport(deps, record, { stage: { kind: "awaiting_review" } }, () => ({
            jobId: record.jobId,
            outcome: "awaiting_review",
          }));
        case "draft":
        case "merge_conflict":
        case "mergeability_unknown":
          // Not explicitly named in the coordinator's decision 1 list -- left exactly as the
          // pre-existing (pre-C015t) behavior, requires_manual, since none of these three are
          // "external already succeeded" cases and touching them is not authorized by this
          // ticket's boundary. Disclosed in the completion report.
          return requiresManual(
            record,
            deps,
            `auto_merge_not_enabled:not_ready:${enabled.reason}`,
            requiresManualCause("merge", "auto_merge_not_enabled"),
          );
        case "behind":
          // C015y decision D: `AutoMergeGate.enable()` caught this BEHIND before ever calling
          // `enableAutoMerge` (point 1 or 2 of the three arm-time interceptions -- see that
          // outcome's own header, merge-gate-model.ts). Same immediate, unconditional escalation
          // as `resumeMergingStage`'s own BEHIND check -- GitHub's `strictRequiredStatusChecksPolicy`
          // ruleset (O004) can never execute this merge while behind, so there is nothing to gain
          // by waiting for a future resume.
          return requiresManual(
            record,
            deps,
            "change_request_behind_base",
            requiresManualCause("merge", "change_request_behind_base"),
          );
      }
    case "failed":
      return requiresManualUnlessRetryable(
        record,
        deps,
        `auto_merge_not_enabled:failed:${enabled.stage}:${enabled.error.code}`,
        enabled.error,
        requiresManualCause("merge", "auto_merge_not_enabled"),
      );
  }
}

/**
 * C015t decision 1: `authorizedHeadSha` is the one and only channel through which "this merge is
 * controller-authorized" reaches Lifecycle -- every caller must decide it *before* calling this
 * function, from a real provenance signal (a union state this exact call chain produced, or a
 * durable prior-stage record), never by re-deriving it from `mergedHeadSha` itself. Passing
 * `mergedHeadSha` and `authorizedHeadSha` as the *same* value is what the prior version of this
 * function always did (the bug codex's review named, resume-composition.ts:426 -> lifecycle.ts:147)
 * -- passing `undefined` here is what makes an honest "not authorized" report to Lifecycle
 * possible at all; `LifecyclePipeline.#handleMerge` already has the correct downstream handling
 * for that (out-of-process-merge pause + audit comment), so nothing in lifecycle.ts/
 * lifecycle-model.ts needed to change for this ticket.
 */
async function finishMerged(
  record: JobProgressRecord,
  deps: ResumeCycleDependencies,
  changeRequestId: string,
  authorizedHeadSha: string | undefined,
): Promise<ResumeJobOutcome> {
  const outcome = await deps.lifecycle.run({
    project: deps.project,
    externalIssueId: record.externalIssueId,
    changeRequestId,
    ...(authorizedHeadSha === undefined ? {} : { mergeAuthorizationHeadSha: authorizedHeadSha }),
    idempotencyKeyPrefix: `cli-dispatch-resume:${record.jobId}:${String(record.revision)}:lifecycle`,
  });
  if (outcome.state !== "completed") {
    return outcome.state === "failed"
      ? requiresManualUnlessRetryable(
          record,
          deps,
          `lifecycle_not_completed:${outcome.state}`,
          outcome.error,
          requiresManualCause("merge", "lifecycle_not_completed"),
        )
      : requiresManual(
          record,
          deps,
          `lifecycle_not_completed:${outcome.state}`,
          requiresManualCause("merge", "lifecycle_not_completed"),
        );
  }
  const completedOutcome = await transitionOrReport(
    deps,
    record,
    { stage: { kind: "completed" } },
    () => ({ jobId: record.jobId, outcome: "completed" as const }),
  );
  if (completedOutcome.outcome !== "completed") return completedOutcome;
  const released = await releaseCompletedAdmission(record, deps);
  if (!released.ok) {
    return { jobId: record.jobId, outcome: "admission_release_failed", error: released.error };
  }
  return completedOutcome;
}

export function buildJobProgressStore(agentTeamHome: string): FileJobProgressStore {
  return new FileJobProgressStore(defaultJobProgressDirectory(agentTeamHome));
}

/** C015o decision 3: sibling directory to job-progress's own (`state/dispatch/admission`, not
 * nested inside `state/dispatch/progress` -- a different composite key space, `projectId`+
 * `issueId` rather than `jobId`, so keeping them visually distinct on disk avoids ever conflating
 * "job progress record" with "issue admission claim" while reading `${AGENT_TEAM_HOME}/state`
 * directly). */
export function defaultIssueAdmissionDirectory(agentTeamHome: string): string {
  return join(agentTeamHome, "state", "dispatch", "admission");
}

export function buildIssueAdmissionStore(agentTeamHome: string): FileIssueAdmissionStore {
  return new FileIssueAdmissionStore(defaultIssueAdmissionDirectory(agentTeamHome));
}

/** C015r decision 5: production default -- a fresh `Redactor()` with no seeded secrets, exactly the
 * same construction `buildClaudeRunner` (claude-factory.ts) already uses for the real provider
 * transcript path, so the sidecar's own scrubbing has the same coverage as everything else a
 * provider's raw text already flows through. */
export function buildReviewReportDiagnosticsSidecar(
  agentTeamHome: string,
): FileReviewReportDiagnosticsSidecar {
  return new FileReviewReportDiagnosticsSidecar(
    defaultReviewReportSidecarDirectory(agentTeamHome),
    new Redactor(),
  );
}
