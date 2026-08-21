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
 * A pre-existing success review status never supplies the in-memory `RecordedReviewApproval`
 * required by `AutoMergeGate.enable()`. Rather than parse an external comment or guess that the
 * current Linear requirements still match it, `"already_approved"` deliberately continues into a
 * fresh Reviewer run. The fresh decision is recorded and becomes the sole approval used by this
 * merge attempt. A blocking `changes_requested` verdict is first recorded for traceability, then
 * passed to the original implementer through `ReviewerRecoveryPipeline`; only
 * `clarification_required` keeps
 *   the pre-existing `fix_round` transition because it does not carry a blocking repair request.
 */
import { join } from "node:path";

import type { JobRepository } from "../../application/dispatch/index.js";
import { defaultLeaseDurationMs, type LeaseCoordinator } from "../../application/leases/index.js";
import type {
  CiRecoveryPipeline,
  ReviewerRecoveryPipeline,
  ReviewerPipeline,
  ReviewerPipelineOutcome,
  ReviewStatusCoordinator,
  AutoMergeGate,
  LifecyclePipeline,
  LifecyclePipelineRequest,
  VisualEvidenceBuilder,
  VisualEvidenceBuildSuccess,
} from "../../application/pipelines/index.js";
import {
  createWorkStatusLifecycleTransitionInstance,
  type WorkStatusLifecycleCoordinator,
} from "../../application/pipelines/index.js";
import type { TrustedProjectConfig } from "../../application/projects/index.js";
import type {
  ChangeRequestSnapshot,
  SourceControlPort,
  WorkManagementPort,
} from "../../application/ports/index.js";
import {
  domainError,
  err,
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
  sha256Digest,
  type HeadSha,
} from "../../domain/review/index.js";
import { checkpointIdSchema, type VisualManifest } from "../../domain/checkpoint/index.js";
import { watchdogHardStopMs } from "../../domain/jobs/index.js";
import type { Project } from "../../domain/project/index.js";
import {
  projectIssueByExternalId,
  type LinearDiscoveryReadModel,
} from "../../adapters/dispatch/linear-discovery.js";
import type { LinearVisualPublicationCoordinator } from "../../adapters/dispatch/linear-publication.js";
import {
  aggregateLinearPublicationDigest,
  type LinearPublicationStorePort,
} from "../../adapters/dispatch/linear-publication-store.js";
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
import { FileAutoMergePauseStore } from "../../adapters/dispatch/auto-merge-pause-store.js";
import type { FileReviewerReplayPolicyStore } from "../../adapters/dispatch/reviewer-replay-policy-store.js";
import type { AuthoritativeBaseFailure, AuthoritativeBaseRevision } from "./authoritative-base.js";
import {
  FileIssueAdmissionStore,
  type IssueAdmissionPort,
} from "../../adapters/dispatch/issue-admission-store.js";
import type { HumanAcceptanceStorePort } from "../../adapters/dispatch/human-acceptance-store.js";
import {
  FileReviewReportDiagnosticsSidecar,
  defaultReviewReportSidecarDirectory,
  type ReviewReportDiagnosticsSidecarPort,
} from "../../adapters/dispatch/review-report-diagnostics-sidecar.js";
import type { ReportContractFailureCategory } from "../../application/pipelines/reviewer-model.js";
import { Redactor } from "../../infrastructure/redaction/index.js";
import type { FileJobRepository } from "../../infrastructure/jobs/index.js";
import { buildDirective } from "./implementer-request.js";
import type { ReviewerWaitPublicationPort } from "./reviewer-wait-publication.js";
import {
  hasConfirmedWorkStart,
  latestConfirmedActiveWorkStatus,
  mayProjectRequiresManual,
  requiresManualBlockingReason,
} from "./requires-manual-projection.js";
import {
  createReviewerReplayIdentityForCheckpoint,
  createReviewerReplaySuccessCheckpointDigest,
  replayIdentityMatches,
  reviewerReportMatchesIdentity,
} from "./reviewer-replay-identity.js";

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
  "work_start_pending",
  "ci_waiting",
  "awaiting_review",
  "fix_round",
  "merging",
  "review_pending_retry",
  "reviewer_waiting",
  "ci_pending_retry",
  // C015r decision 4: symmetric to the two above, for a `report`-stage contract failure that has
  // not yet exhausted its own, separately-capped retry limit.
  "review_report_pending_retry",
]);

function isRecoverableImplementing(record: JobProgressRecord): boolean {
  return (
    record.stage.kind === "implementing" &&
    record.stage.executionEpoch?.ordinal === 1 &&
    record.stage.executionEpoch.providerOutput === "none" &&
    record.workStatusLifecycle !== undefined &&
    record.baseRevision !== undefined
  );
}

function isPrePrResumeCandidate(record: JobProgressRecord): boolean {
  return record.stage.kind === "work_start_pending" || isRecoverableImplementing(record);
}

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
 * - `reviewerFixRounds` is incremented only after `ReviewerRecoveryPipeline` has staged,
 *   committed, and pushed a reviewer-requested repair; it means "sent back to the implementer
 *   for a real code fix", an entirely different event.
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

/** E116cap: sibling directory to job-progress's own -- see `FileAutoMergePauseStore`'s own header
 * (src/adapters/dispatch/auto-merge-pause-store.ts) for the composite key shape (one file per
 * `projectId`, not per `jobId`). */
export function defaultAutoMergePauseDirectory(agentTeamHome: string): string {
  return join(agentTeamHome, "state", "dispatch", "auto-merge-pause");
}

export interface ResumeCycleDependencies {
  readonly progress: FileJobProgressStore;
  readonly jobRepository: ResumeJobRepository;
  readonly leases: LeaseCoordinator;
  readonly sourceControl: Pick<SourceControlPort, "getChangeRequest"> &
    Partial<Pick<SourceControlPort, "getCommitStatuses">>;
  /** C035: authoritative Linear state read, separate from the requirement projection. */
  readonly workManagement: Pick<WorkManagementPort, "getIssue">;
  readonly reviewWaitPublication?: ReviewerWaitPublicationPort;
  readonly readModel: LinearDiscoveryReadModel;
  readonly teamId: string;
  readonly linearProjectId: string;
  readonly project: Project;
  readonly trustedConfig: TrustedProjectConfig;
  readonly ciRecovery: Pick<CiRecoveryPipeline, "run">;
  readonly reviewerRecovery: Pick<ReviewerRecoveryPipeline, "run">;
  readonly reviewer: Pick<ReviewerPipeline, "run"> & Partial<Pick<ReviewerPipeline, "inspect">>;
  /** Required only for a reviewer-replay success checkpoint. Missing/disabled fails that exact
   * checkpoint closed without making any external mutation. */
  readonly reviewerReplayPolicy?: Pick<FileReviewerReplayPolicyStore, "load">;
  /** E102-3: builds the `VisualManifest` + `visual_artifact` evidence a `visual_review`/
   * `dual_review` job's `reviewer.run()` call requires (see `resumeReview`'s own use, below) --
   * see visual-evidence-builder.ts's own header for the full data flow. Optional (unlike every
   * other pipeline dependency on this interface) so every pre-existing test/composition call site
   * that only ever exercises `code_review` jobs keeps compiling unchanged; `resumeReview` fails
   * closed to `requires_manual` (reasonCode `visual_evidence_unavailable`) if a job that actually
   * needs a visual reviewer is resumed while this is undefined, rather than silently skipping
   * visual evidence or crashing. */
  /** E102-4b: `verifyExisting` is a purely read-only re-hash/re-validate of whatever evidence is
   * already on disk for the exact (issueId, headSha) under review -- see its own header
   * (visual-evidence-builder.ts) for why `resumeReview`'s pre-arm merge recheck must call *only*
   * this method, never `build()` again, before ever passing `currentVisualManifest` to
   * `AutoMergeGate.enable()`. */
  readonly visualEvidence?: Pick<VisualEvidenceBuilder, "build" | "verifyExisting">;
  /** E102-2/E102-3: the real Gemini model `models.visual` should request, sourced from the host's
   * optional `providers.json` `gemini.models` (provider-config-store.ts) -- E102-2 wired
   * `visualReviewer` itself (`GeminiRunner`) but deliberately left this per-request model value to
   * this ticket (see reviewer-composition.ts's own header and E102-2's PR description). Optional
   * for the identical reason `visualEvidence` above is; `resumeReview` requires both together
   * before ever attempting a `visual_review`/`dual_review` job -- a `GeminiRunner` wired without a
   * model this host actually allowlists would fail the *provider's own* validation instead of
   * this composition's, which is a worse failure to reach. */
  readonly visualReviewModel?: string;
  /** E102-5: publishes a `visual_review`/`dual_review` job's `VisualEvidenceBuilder` output
   * (manifest + PNG artifacts) to Linear via the existing `LinearUploadClient` (A004,
   * adapters/linear/upload.ts) -- see `resumeReview`'s own call site, immediately after the
   * `visualEvidence.build()` call above succeeds. Optional for the identical reason
   * `visualEvidence`/`visualReviewModel` are: every pre-existing `code_review`-only composition/
   * test call site keeps compiling unchanged. `resumeReview` fails closed to `requires_manual`
   * (reasonCode `visual_publication_failed`) if a job that actually needs a visual reviewer is
   * resumed while this is undefined, exactly mirroring `visualEvidence`'s own guard. */
  readonly linearPublication?: Pick<LinearVisualPublicationCoordinator, "publish">;
  /** E102-4b: read-only access to the same durable, write-once receipt store `linearPublication`
   * above publishes through (`FileLinearPublicationStore`, linear-publication-store.ts) -- used
   * *only* by `resumeReview`'s pre-arm merge recheck to load the exact receipt for this
   * (projectId, issueId, headSha) and recompute `aggregateLinearPublicationDigest` from it, never to
   * publish or create anything. Optional for the same composition-root-gap reason
   * `visualEvidence`/`linearPublication` are: every pre-existing `code_review`-only call site keeps
   * compiling unchanged. `resumeReview` fails closed to `requires_manual` (reasonCode
   * `visual_publication_missing_at_merge`) if a `dual_review`/`visual_review` job reaches this
   * point while it is undefined. */
  readonly linearPublicationStore?: Pick<LinearPublicationStorePort, "load">;
  readonly reviewStatus: Pick<ReviewStatusCoordinator, "begin" | "record">;
  readonly autoMerge: Pick<AutoMergeGate, "enable">;
  readonly lifecycle: Pick<LifecyclePipeline, "run">;
  /** Required only for new Jobs whose approved policy says human acceptance is required. */
  readonly humanAcceptance?: Pick<HumanAcceptanceStorePort, "createPending">;
  readonly clock: Clock;
  readonly holderId: string;
  /** Optional project-scoped lazy initialization, invoked only after this job is leased and
   * revalidated. The caller may memoize it so multiple jobs share one prepared runtime. */
  readonly prepare?: () => Promise<void>;
  /** Per-job lease heartbeat cancellation. Long provider calls receive this signal. */
  readonly signal?: AbortSignal;
  /** Test seam; production renews at one third of the five-minute lease TTL. */
  readonly leaseHeartbeatIntervalMs?: number;
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
  readonly workStatusLifecycle?: Pick<WorkStatusLifecycleCoordinator, "transition">;
  /** LWS03: the only path allowed to resume a Job before a PR identity exists. It runs under the
   * same per-Job lease/heartbeat as every other resume path and must never create a Job or claim. */
  readonly prePrImplementation?: Readonly<{
    run(
      record: JobProgressRecord,
      options: Readonly<{ signal?: AbortSignal }>,
    ): Promise<ResumeJobOutcome>;
  }>;
}

async function gateWorkStatusLifecycle(
  record: JobProgressRecord,
  deps: ResumeCycleDependencies,
  input: Readonly<{
    step: "review_start" | "fix_start" | "merge_start" | "complete";
    phase: "reviewing" | "fixing" | "merging" | "terminal";
    mainTarget: "in_review" | "in_progress" | "completed";
    allowedMainSources: readonly ("in_progress" | "in_review" | "completed")[];
    agentTarget:
      | { readonly kind: "clear" }
      | { readonly kind: "set"; readonly status: "waiting" | "executing" };
    causeStage: "review" | "merge";
    authority: Readonly<Record<string, unknown>>;
  }>,
): Promise<ResumeJobOutcome | JobProgressRecord> {
  const checkpoint = record.workStatusLifecycle;
  if (checkpoint === undefined || checkpoint.admissionMode === "off") return record;
  const coordinator = deps.workStatusLifecycle;
  if (coordinator === undefined) {
    return requiresManual(
      record,
      deps,
      "work_status_lifecycle_unavailable",
      requiresManualCause(input.causeStage, "work_status_lifecycle_failed"),
    );
  }
  const authorityDigest = sha256Digest({
    schemaVersion: 1,
    jobId: record.jobId,
    step: input.step,
    ...input.authority,
  });
  const transitionInstance = authorityDigest.ok
    ? createWorkStatusLifecycleTransitionInstance({
        jobId: record.jobId,
        step: input.step,
        mainTarget: input.mainTarget,
        allowedMainSources: input.allowedMainSources,
        agentTarget: input.agentTarget,
        authorityDigest: authorityDigest.value,
      })
    : authorityDigest;
  const invocationDigest = sha256Digest({
    schemaVersion: 1,
    operation: `resume-${input.step}`,
    jobId: record.jobId,
    checkpointRevision: record.revision,
    ...(authorityDigest.ok ? { authorityDigest: authorityDigest.value } : {}),
  });
  if (!transitionInstance.ok || !invocationDigest.ok) {
    return requiresManual(
      record,
      deps,
      "work_status_identity_invalid",
      requiresManualCause(input.causeStage, "work_status_lifecycle_failed"),
    );
  }
  const transitioned = await whileResumeLeaseHeld(deps, () =>
    coordinator.transition({
      jobId: record.jobId,
      reference: { project: deps.project, externalIssueId: record.externalIssueId },
      holderId: `work-status:${deps.holderId}`,
      mode: checkpoint.admissionMode,
      ...(checkpoint.capabilityDigest === undefined
        ? {}
        : { capabilityDigest: checkpoint.capabilityDigest }),
      phase: input.phase,
      step: input.step,
      transitionInstance: transitionInstance.value,
      invocationDigest: invocationDigest.value,
      mainTarget: input.mainTarget,
      allowedMainSources: input.allowedMainSources,
      agentTarget: input.agentTarget,
    }),
  );
  if (transitioned.state === "permitted") {
    const current = await whileResumeLeaseHeld(deps, () => deps.progress.load(record.jobId));
    if (current.ok && current.value !== undefined) return current.value;
    return {
      jobId: record.jobId,
      outcome: "transient_failure",
      reason: "work_status_progress_read_failed",
      error: current.ok ? domainError("not_found") : current.error,
    };
  }
  const current = await whileResumeLeaseHeld(deps, () => deps.progress.load(record.jobId));
  if (!current.ok || current.value === undefined) {
    return {
      jobId: record.jobId,
      outcome: "transient_failure",
      reason: "work_status_progress_read_failed",
      error: current.ok ? domainError("not_found") : current.error,
    };
  }
  const incident = current.value.workStatusLifecycle?.incident?.reasonCode;
  const retryable =
    (transitioned.reason === "provider_outage" || transitioned.reason === "main_unconfirmed") &&
    transitioned.error?.retryable === true &&
    incident !== "mutation_unconfirmed" &&
    incident !== "retry_exhausted";
  if (retryable) {
    return {
      jobId: record.jobId,
      outcome: "transient_failure",
      reason: `work_status_${input.step}_${transitioned.reason}`,
      error: transitioned.error ?? domainError("unavailable"),
    };
  }
  return requiresManual(
    current.value,
    deps,
    `work_status_${input.step}_${transitioned.reason}`,
    requiresManualCause(input.causeStage, "work_status_lifecycle_failed"),
  );
}

/** Final, read-only authority fence immediately before a Reviewer or reviewer-fix Provider call.
 * Earlier admission/CI/lifecycle checks remain necessary, but are not durable authority across
 * visual evidence generation, publication, or review-status mutations. This fence deliberately
 * re-reads every identity that can revoke execution and makes a drift a zero-Provider outcome. */
async function verifyProviderAuthority(
  record: JobProgressRecord,
  deps: ResumeCycleDependencies,
  input: Readonly<{
    expectedWorkStatus: "in_review" | "in_progress";
    expectedHeadSha: string;
    changeRequestId: string;
    requirementsDigest: string;
  }>,
): Promise<ResumeJobOutcome | undefined> {
  const readOptions = deps.signal === undefined ? undefined : { signal: deps.signal };
  const [progress, workItem, claim, jobs, changeRequest, projectedIssue] =
    await whileResumeLeaseHeld(deps, () =>
      Promise.all([
        deps.progress.load(record.jobId),
        deps.workManagement.getIssue(
          { project: deps.project, externalIssueId: record.externalIssueId },
          readOptions,
        ),
        deps.admission.load(record.projectId, record.issueId),
        deps.jobRepository.readAll(),
        deps.sourceControl.getChangeRequest(
          { project: deps.project, changeRequestId: input.changeRequestId },
          readOptions,
        ),
        projectIssueByExternalId(
          deps.project,
          deps.readModel,
          deps.teamId,
          deps.linearProjectId,
          record.externalIssueId,
          readOptions,
        ),
      ]),
    );
  const readError = !progress.ok
    ? progress.error
    : !workItem.ok
      ? workItem.error
      : !claim.ok
        ? claim.error
        : !jobs.ok
          ? jobs.error
          : !changeRequest.ok
            ? changeRequest.error
            : !projectedIssue.ok
              ? projectedIssue.error
              : undefined;
  if (readError !== undefined) {
    return {
      jobId: record.jobId,
      outcome: "transient_failure",
      reason: "provider_authority_read_failed",
      error: readError,
    };
  }
  if (
    !progress.ok ||
    progress.value === undefined ||
    !workItem.ok ||
    !claim.ok ||
    claim.value === undefined ||
    !jobs.ok ||
    !changeRequest.ok ||
    !projectedIssue.ok
  ) {
    return {
      jobId: record.jobId,
      outcome: "transient_failure",
      reason: "provider_authority_read_failed",
      error: domainError("not_found"),
    };
  }
  if (progress.value.revision !== record.revision) {
    return {
      jobId: record.jobId,
      outcome: "transient_failure",
      reason: "provider_authority_checkpoint_changed",
      error: domainError("conflict"),
    };
  }
  const matchingJobs = jobs.value.filter(
    (job) =>
      job.id === record.jobId &&
      job.projectId === record.projectId &&
      job.issueId === record.issueId,
  );
  const requirementSnapshot = createRequirementSnapshot(projectedIssue.value, deps.clock.now());
  const lifecycleEnforced = record.workStatusLifecycle?.admissionMode === "enforce";
  const invalidAuthority =
    progress.value.projectId !== record.projectId ||
    progress.value.issueId !== record.issueId ||
    progress.value.externalIssueId !== record.externalIssueId ||
    workItem.value.issue.id !== record.issueId ||
    workItem.value.issue.projectId !== record.projectId ||
    workItem.value.issue.externalId !== record.externalIssueId ||
    workItem.value.archivedAt !== undefined ||
    workItem.value.trashed === true ||
    workItem.value.workStatus === "canceled" ||
    (lifecycleEnforced && workItem.value.workStatus !== input.expectedWorkStatus) ||
    claim.value.state !== "active" ||
    claim.value.projectId !== record.projectId ||
    claim.value.issueId !== record.issueId ||
    claim.value.externalIssueId !== record.externalIssueId ||
    claim.value.jobId !== record.jobId ||
    matchingJobs.length !== 1 ||
    changeRequest.value.state !== "open" ||
    changeRequest.value.headBranch !== record.branch ||
    changeRequest.value.headSha !== input.expectedHeadSha ||
    !requirementSnapshot.ok ||
    requirementSnapshot.value.requirementsDigest !== input.requirementsDigest;
  return invalidAuthority
    ? requiresManual(
        progress.value,
        deps,
        "provider_authority_mismatch",
        requiresManualCause("review", "work_status_lifecycle_failed"),
      )
    : undefined;
}

export type ResumeJobOutcome =
  | Readonly<{ jobId: string; outcome: "lease_conflict" }>
  | Readonly<{
      jobId: string;
      outcome: "candidate_changed";
      reason: "missing" | "revision_changed" | "no_longer_resumable";
    }>
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
  | Readonly<{
      jobId: string;
      outcome: "reviewer_waiting";
      reason: "confirmed_quota_wall" | "unconfirmed_throttling";
      retryNotBefore?: Instant;
    }>
  | Readonly<{ jobId: string; outcome: "repair_pushed" }>
  | Readonly<{ jobId: string; outcome: "reviewer_fix_pushed" }>
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

type CancellationRaceMergeMutations = NonNullable<
  NonNullable<LifecyclePipelineRequest["cancellationRaceAudit"]>["mergeMutations"]
>;

function lifecycleAudit(
  record: JobProgressRecord,
  operation: "dispatch-resume" | "reconcile" | "reviewer-replay",
): NonNullable<LifecyclePipelineRequest["workStatusLifecycleAudit"]> {
  const transitionDigest = (step: "work_start" | "review_start"): string | undefined => {
    const transition = [...(record.workStatusLifecycle?.transitions ?? [])]
      .reverse()
      .find((candidate) => candidate.step === step);
    if (transition === undefined) return undefined;
    const digest = sha256Digest({ schemaVersion: 1, jobId: record.jobId, transition });
    return digest.ok ? digest.value : undefined;
  };
  const workReceiptDigest = transitionDigest("work_start");
  const reviewReceiptDigest = transitionDigest("review_start");
  return Object.freeze({
    operation,
    jobId: record.jobId,
    ...(workReceiptDigest === undefined ? {} : { workReceiptDigest }),
    ...(reviewReceiptDigest === undefined ? {} : { reviewReceiptDigest }),
    outcome: "completed" as const,
  });
}

function persistedMergeMutations(
  record: JobProgressRecord,
): CancellationRaceMergeMutations | undefined {
  return record.mergeMutations;
}

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

/** The exact legacy state written before fresh review of an existing approval was implemented.
 * It is safe to re-enter the normal pipeline because `resumeUnderLease` revalidates the durable
 * revision, PR/head, Linear work item and current review inputs before any merge mutation. */
function isReviewReuseReconcilable(record: JobProgressRecord): boolean {
  return (
    record.stage.kind === "requires_manual" &&
    record.stage.cause?.stage === "review" &&
    record.stage.cause.reasonCode === "review_reuse_unimplemented"
  );
}

/** Scheduler/reconcile bridge for one exact recovery class. The successful checkpoint is the
 * sole authority to skip provider execution; a bare historical requires_manual record remains
 * ineligible and can only be started by the dedicated CLI. */
export function isReviewerReplayCheckpointReconcilable(record: JobProgressRecord): boolean {
  return (
    record.stage.kind === "requires_manual" &&
    record.stage.cause?.stage === "review" &&
    record.stage.cause.reasonCode === "review_report_contract" &&
    hasReviewerReplaySuccessCheckpoint(record)
  );
}

/** Any persisted replay approval remains governed by the project kill switch, even after the
 * ordinary merge pipeline advances the stage away from the original requires-manual cause. */
export function hasReviewerReplaySuccessCheckpoint(record: JobProgressRecord): boolean {
  return record.reviewerReplay?.state === "review_succeeded";
}

async function reviewerReplayPolicyBlock(
  record: JobProgressRecord,
  deps: ResumeCycleDependencies,
): Promise<ResumeJobOutcome | undefined> {
  if (!hasReviewerReplaySuccessCheckpoint(record)) return undefined;
  const reviewerReplayPolicy = deps.reviewerReplayPolicy;
  if (reviewerReplayPolicy === undefined) {
    return {
      jobId: record.jobId,
      outcome: "requires_manual",
      reason: "reviewer_replay_disabled",
    };
  }
  const policy = await whileResumeLeaseHeld(deps, () =>
    reviewerReplayPolicy.load(record.projectId),
  );
  if (!policy.ok || policy.value?.enabled !== true) {
    return {
      jobId: record.jobId,
      outcome: "requires_manual",
      reason: !policy.ok ? "reviewer_replay_policy_unavailable" : "reviewer_replay_disabled",
    };
  }
  return undefined;
}

function isPipelineResumable(record: JobProgressRecord): boolean {
  return (
    resumableStageKinds.has(record.stage.kind) ||
    isRecoverableImplementing(record) ||
    isReviewReuseReconcilable(record) ||
    isReviewerReplayCheckpointReconcilable(record)
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
  return isPipelineResumable(record) || isMergeReconcilable(record);
}

export interface ResumeCycleSelection {
  /** Snapshot-bound CAS identities. Records created or changed after inventory cannot join. */
  readonly selections: readonly Readonly<{
    jobId: JobProgressRecord["jobId"];
    expectedRevision: number;
  }>[];
}

class ResumeLeaseLostError extends Error {
  constructor() {
    super("Resume lease was lost.");
    this.name = "ResumeLeaseLostError";
  }
}

function assertResumeLeaseHeld(deps: ResumeCycleDependencies): void {
  if (deps.signal?.aborted === true) throw new ResumeLeaseLostError();
}

async function whileResumeLeaseHeld<T>(
  deps: ResumeCycleDependencies,
  operation: () => Promise<T>,
): Promise<T> {
  assertResumeLeaseHeld(deps);
  let value: T;
  try {
    value = await operation();
  } catch (error) {
    assertResumeLeaseHeld(deps);
    throw error;
  }
  assertResumeLeaseHeld(deps);
  return value;
}

/** Runs one resume attempt for every resumable job-progress record belonging to `dependencies.project`,
 * plus (C015t decision 3) a narrow, read-only merge-state reconciliation pass over `requires_manual`
 * records whose cause matches `isMergeReconcilable`. */
export async function runResumeCycle(
  dependencies: ResumeCycleDependencies,
  selection?: ResumeCycleSelection,
): Promise<Result<readonly ResumeJobOutcome[], DomainError>> {
  const records = await dependencies.progress.listForProject(dependencies.project.id);
  if (!records.ok) return records;
  const outcomes: ResumeJobOutcome[] = [];
  let selected: readonly JobProgressRecord[] = records.value;
  if (selection !== undefined) {
    const identities = new Set(selection.selections.map((candidate) => candidate.jobId));
    if (identities.size !== selection.selections.length) return err(domainError("conflict"));
    const byJobId = new Map(records.value.map((record) => [record.jobId, record]));
    const accepted: JobProgressRecord[] = [];
    for (const candidate of selection.selections) {
      const record = byJobId.get(candidate.jobId);
      if (record === undefined) {
        outcomes.push({ jobId: candidate.jobId, outcome: "candidate_changed", reason: "missing" });
      } else if (record.revision !== candidate.expectedRevision) {
        outcomes.push({
          jobId: candidate.jobId,
          outcome: "candidate_changed",
          reason: "revision_changed",
        });
      } else if (!isResumeCandidate(record)) {
        outcomes.push({
          jobId: candidate.jobId,
          outcome: "candidate_changed",
          reason: "no_longer_resumable",
        });
      } else {
        accepted.push(record);
      }
    }
    selected = accepted;
  }
  const resumable = selected.filter(isPipelineResumable);
  const mergeReconcilable = selected.filter((record) => isMergeReconcilable(record));

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
  deps: ResumeCycleDependencies,
  record: JobProgressRecord,
  next: Partial<JobProgressRecordMutation>,
): Promise<Result<JobProgressRecord, DomainError>> {
  return whileResumeLeaseHeld(deps, () =>
    deps.progress.compareAndSwap(record.jobId, record.revision, {
      ...mutationFrom(record),
      ...next,
    }),
  );
}

type PersistedMergeMutation = NonNullable<JobProgressRecord["mergeMutations"]>[number];

function mergedMutationHistory(
  existing: readonly PersistedMergeMutation[] | undefined,
  incoming: CancellationRaceMergeMutations,
): JobProgressRecordMutation["mergeMutations"] | undefined {
  const combined = [...(existing ?? [])];
  for (const receipt of incoming) {
    const index = combined.findIndex(
      (candidate) =>
        candidate.kind === receipt.kind &&
        candidate.idempotencyKey === receipt.idempotencyKey &&
        candidate.attemptedAt === receipt.attemptedAt,
    );
    if (index < 0) combined.push({ ...receipt });
    else combined[index] = { ...receipt };
  }
  return combined.length <= 32 ? combined : undefined;
}

async function persistMergeMutations(
  deps: ResumeCycleDependencies,
  initialRecord: JobProgressRecord,
  incoming: CancellationRaceMergeMutations,
): Promise<Result<JobProgressRecord, DomainError>> {
  if (incoming.length === 0) return ok(initialRecord);
  let current = initialRecord;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const mergeMutations = mergedMutationHistory(current.mergeMutations, incoming);
    if (mergeMutations === undefined) return err(domainError("invariant_violation"));
    const written = await transition(deps, current, { mergeMutations });
    if (written.ok || written.error.code !== "conflict") return written;
    const loaded = await whileResumeLeaseHeld(deps, () => deps.progress.load(current.jobId));
    if (!loaded.ok) return loaded;
    if (loaded.value === undefined) return err(domainError("conflict"));
    current = loaded.value;
  }
  return err(domainError("conflict"));
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

  const heartbeat = startResumeLeaseHeartbeat(deps, lease.value.value.id);
  const guardedDeps = { ...deps, signal: heartbeat.signal };
  try {
    const current = await revalidateRecordUnderLease(record, guardedDeps, isPipelineResumable);
    if ("outcome" in current) return current;
    if (current.record.providerAssignments === undefined) {
      return await requiresManual(
        current.record,
        guardedDeps,
        "legacy_provider_assignment_unavailable",
        requiresManualCause("setup", "legacy_provider_assignment_unavailable"),
      );
    }
    if (isPrePrResumeCandidate(current.record)) {
      if (guardedDeps.prePrImplementation === undefined) {
        return await requiresManual(
          current.record,
          guardedDeps,
          "pre_pr_resume_unavailable",
          requiresManualCause("setup", "bootstrap_incomplete"),
        );
      }
      const resumed = await guardedDeps.prePrImplementation.run(current.record, {
        signal: heartbeat.signal,
      });
      await heartbeat.stop();
      return heartbeat.signal.aborted
        ? { jobId: record.jobId, outcome: "lease_conflict" }
        : resumed;
    }
    if (guardedDeps.prepare !== undefined) {
      await whileResumeLeaseHeld(guardedDeps, guardedDeps.prepare);
    }
    const resumed = await resumeUnderLease(current.record, guardedDeps);
    await heartbeat.stop();
    return heartbeat.signal.aborted ? { jobId: record.jobId, outcome: "lease_conflict" } : resumed;
  } catch (error) {
    if (error instanceof ResumeLeaseLostError) {
      return { jobId: record.jobId, outcome: "lease_conflict" };
    }
    throw error;
  } finally {
    await heartbeat.stop();
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

  const heartbeat = startResumeLeaseHeartbeat(deps, lease.value.value.id);
  const guardedDeps = { ...deps, signal: heartbeat.signal };
  try {
    const current = await revalidateRecordUnderLease(record, guardedDeps, isMergeReconcilable);
    if ("outcome" in current) return current;
    if (guardedDeps.prepare !== undefined) {
      await whileResumeLeaseHeld(guardedDeps, guardedDeps.prepare);
    }
    const reconciled = await reconcileMergeStateUnderLease(current.record, guardedDeps);
    await heartbeat.stop();
    return heartbeat.signal.aborted
      ? { jobId: record.jobId, outcome: "lease_conflict" }
      : reconciled;
  } catch (error) {
    if (error instanceof ResumeLeaseLostError) {
      return { jobId: record.jobId, outcome: "lease_conflict" };
    }
    throw error;
  } finally {
    await heartbeat.stop();
    await deps.leases.release({ leaseId: lease.value.value.id, holderId: deps.holderId });
  }
}

async function revalidateRecordUnderLease(
  expected: JobProgressRecord,
  deps: ResumeCycleDependencies,
  eligible: (record: JobProgressRecord) => boolean,
): Promise<
  | Readonly<{ record: JobProgressRecord }>
  | Extract<ResumeJobOutcome, { outcome: "candidate_changed" | "failed" }>
> {
  const loaded = await whileResumeLeaseHeld(deps, () => deps.progress.load(expected.jobId));
  if (!loaded.ok) {
    return {
      jobId: expected.jobId,
      outcome: "failed",
      stage: "progress_read",
      error: loaded.error,
    };
  }
  const current = loaded.value;
  if (current === undefined) {
    return { jobId: expected.jobId, outcome: "candidate_changed", reason: "missing" };
  }
  if (
    current.revision !== expected.revision ||
    current.projectId !== expected.projectId ||
    current.issueId !== expected.issueId ||
    current.externalIssueId !== expected.externalIssueId
  ) {
    return { jobId: expected.jobId, outcome: "candidate_changed", reason: "revision_changed" };
  }
  if (!eligible(current)) {
    return { jobId: expected.jobId, outcome: "candidate_changed", reason: "no_longer_resumable" };
  }
  return { record: current };
}

interface ResumeLeaseHeartbeat {
  readonly signal: AbortSignal;
  readonly stop: () => Promise<void>;
}

/** Keeps the existing five-minute crash-recovery lease alive without weakening its TTL. */
function startResumeLeaseHeartbeat(
  deps: ResumeCycleDependencies,
  leaseId: Parameters<LeaseCoordinator["renew"]>[0]["leaseId"],
): ResumeLeaseHeartbeat {
  const controller = new AbortController();
  const intervalMs = deps.leaseHeartbeatIntervalMs ?? Math.floor(defaultLeaseDurationMs / 3);
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    controller.abort();
    return Object.freeze({ signal: controller.signal, stop: () => Promise.resolve() });
  }
  let pending: Promise<void> | undefined;
  const renew = () => {
    if (pending !== undefined || controller.signal.aborted) return;
    pending = deps.leases
      .renew({ leaseId, holderId: deps.holderId })
      .then((result) => {
        if (!result.ok) controller.abort();
      })
      .catch(() => {
        controller.abort();
      })
      .finally(() => {
        pending = undefined;
      });
  };
  const timer = setInterval(renew, intervalMs);
  timer.unref();
  return Object.freeze({
    signal: controller.signal,
    async stop() {
      clearInterval(timer);
      await pending;
    },
  });
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
  const claim = await whileResumeLeaseHeld(deps, () =>
    deps.admission.load(deps.project.id, record.issueId),
  );
  if (!claim.ok) return claim;
  if (claim.value?.state !== "active") return ok(undefined);
  const activeClaim = claim.value;
  const released = await whileResumeLeaseHeld(deps, () =>
    deps.admission.release(deps.project.id, record.issueId, activeClaim.revision, "completed"),
  );
  if (!released.ok) return released;
  return ok(undefined);
}

interface PreparedHumanAcceptance {
  readonly record: JobProgressRecord;
  readonly lifecycle?: NonNullable<LifecyclePipelineRequest["humanAcceptance"]>;
}

async function prepareHumanAcceptance(
  record: JobProgressRecord,
  deps: ResumeCycleDependencies,
  changeRequestId: string,
  mergedReadback?: ChangeRequestSnapshot,
): Promise<Result<PreparedHumanAcceptance, DomainError>> {
  const policy = record.humanDelivery;
  if (policy?.acceptanceRequirement !== "required") return ok({ record });
  const humanAcceptance = deps.humanAcceptance;
  if (humanAcceptance === undefined) return err(domainError("invariant_violation"));

  const readbackResult =
    mergedReadback === undefined
      ? await whileResumeLeaseHeld(deps, () =>
          deps.sourceControl.getChangeRequest(
            { project: deps.project, changeRequestId },
            deps.signal === undefined ? undefined : { signal: deps.signal },
          ),
        )
      : ok(mergedReadback);
  if (!readbackResult.ok) return readbackResult;
  const readback = readbackResult.value;
  const mergeCommit = readback.mergeCommitSha;
  const mergedAt = readback.mergedAt;
  if (readback.state !== "merged") return err(domainError("unavailable"));
  if (
    readback.baseBranch !== deps.project.defaultBranch ||
    String(readback.number) !== changeRequestId ||
    mergeCommit === undefined ||
    mergedAt === undefined ||
    (record.headSha !== undefined && readback.headSha !== record.headSha)
  ) {
    return err(domainError("conflict"));
  }

  const workItem = await whileResumeLeaseHeld(deps, () =>
    deps.workManagement.getIssue(
      { project: deps.project, externalIssueId: record.externalIssueId },
      deps.signal === undefined ? undefined : { signal: deps.signal },
    ),
  );
  if (!workItem.ok) return workItem;
  const currentRequirement = createRequirementSnapshot(workItem.value.issue, deps.clock.now());
  const currentHumanSummaryDigest =
    workItem.value.issue.humanSummary === undefined
      ? undefined
      : sha256Digest(workItem.value.issue.humanSummary);
  const workStatusEligible =
    workItem.value.workStatus === "in_progress" ||
    workItem.value.workStatus === "in_review" ||
    (record.workStatusLifecycle?.admissionMode === "observe" &&
      workItem.value.workStatus === "ready");
  if (
    workItem.value.issue.projectId !== record.projectId ||
    workItem.value.issue.externalId !== record.externalIssueId ||
    !workStatusEligible ||
    !currentRequirement.ok ||
    currentRequirement.value.requirementsDigest !== policy.requirementDigest ||
    workItem.value.issue.humanAcceptanceRequirement !== policy.acceptanceRequirement ||
    workItem.value.issue.verificationLevel !== policy.verificationLevel ||
    currentHumanSummaryDigest === undefined ||
    !currentHumanSummaryDigest.ok ||
    currentHumanSummaryDigest.value !== policy.humanSummaryDigest
  ) {
    return err(domainError("conflict"));
  }

  const created = await whileResumeLeaseHeld(deps, () =>
    humanAcceptance.createPending({
      identity: {
        projectId: record.projectId,
        issueId: record.issueId,
        jobId: record.jobId,
        requirementDigest: policy.requirementDigest,
        mergeCommit,
      },
      externalIssueId: record.externalIssueId,
      changeRequest: {
        url: readback.url,
        number: readback.number,
        headSha: readback.headSha,
      },
      humanSummaryDigest: policy.humanSummaryDigest,
      mergedAt,
    }),
  );
  if (!created.ok) return created;
  if (
    policy.acceptanceIdentityDigest !== undefined &&
    policy.acceptanceIdentityDigest !== created.value.identityDigest
  ) {
    return err(domainError("conflict"));
  }

  let current = record;
  if (policy.acceptanceIdentityDigest === undefined) {
    const persisted = await transition(deps, record, {
      humanDelivery: {
        ...policy,
        acceptanceIdentityDigest: created.value.identityDigest,
      },
    });
    if (!persisted.ok) return persisted;
    current = persisted.value;
  }
  return ok({
    record: current,
    lifecycle: {
      state: "pending",
      identityDigest: created.value.identityDigest,
      requirementDigest: policy.requirementDigest,
      humanSummaryDigest: policy.humanSummaryDigest,
      mergeCommit,
      mergedAt,
      headSha: readback.headSha,
    },
  });
}

async function reconcileMergeStateUnderLease(
  record: JobProgressRecord,
  deps: ResumeCycleDependencies,
): Promise<ResumeJobOutcome> {
  const policyBlock = await reviewerReplayPolicyBlock(record, deps);
  if (policyBlock !== undefined) return policyBlock;
  const changeRequestId = record.changeRequestId;
  if (changeRequestId === undefined) {
    return {
      jobId: record.jobId,
      outcome: "merge_reconcile_readback_failed",
      error: domainError("invariant_violation"),
    };
  }
  const current = await whileResumeLeaseHeld(deps, () =>
    deps.sourceControl.getChangeRequest(
      { project: deps.project, changeRequestId },
      deps.signal === undefined ? undefined : { signal: deps.signal },
    ),
  );
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

  const acceptance = await prepareHumanAcceptance(record, deps, changeRequestId, current.value);
  if (!acceptance.ok) {
    return {
      jobId: record.jobId,
      outcome: "merge_reconcile_lifecycle_failed",
      error: acceptance.error,
    };
  }
  record = acceptance.value.record;
  const awaitingHumanAcceptance = acceptance.value.lifecycle !== undefined;

  const terminalLifecycle = await gateWorkStatusLifecycle(record, deps, {
    step: "complete",
    phase: "terminal",
    mainTarget: awaitingHumanAcceptance ? "in_review" : "completed",
    allowedMainSources: awaitingHumanAcceptance
      ? ["in_progress", "in_review"]
      : ["in_progress", "in_review", "completed"],
    agentTarget: { kind: "clear" },
    causeStage: "merge",
    authority: {
      changeRequestId,
      authorizedHeadSha: "external",
      lifecycleHeadSha: current.value.headSha,
      ...(acceptance.value.lifecycle === undefined
        ? {}
        : { humanAcceptanceIdentityDigest: acceptance.value.lifecycle.identityDigest }),
    },
  });
  if ("outcome" in terminalLifecycle) return terminalLifecycle;
  record = terminalLifecycle;

  const lifecyclePrefix =
    record.reviewerReplay?.state === "review_succeeded"
      ? `reviewer-replay:${record.jobId}:${record.reviewerReplay.identityDigest}:lifecycle`
      : `cli-dispatch-lifecycle:${record.jobId}:${changeRequestId}`;
  const lifecycleOutcome = await whileResumeLeaseHeld(deps, () =>
    deps.lifecycle.run({
      project: deps.project,
      externalIssueId: record.externalIssueId,
      changeRequestId,
      idempotencyKeyPrefix: lifecyclePrefix,
      ...(acceptance.value.lifecycle === undefined
        ? {}
        : { humanAcceptance: acceptance.value.lifecycle }),
      workStatusLifecycleAudit: lifecycleAudit(
        record,
        record.reviewerReplay?.state === "review_succeeded" ? "reviewer-replay" : "reconcile",
      ),
      ...(record.reviewerReplay?.state !== "review_succeeded"
        ? {}
        : {
            reviewerReplayAudit: {
              operation: "reviewer-replay" as const,
              checkpointDigest: record.reviewerReplay.checkpointDigest,
              attemptTotal: record.reviewerReplay.counters.providerAttempts,
              outcome: "review_succeeded" as const,
            },
          }),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      cancellationRaceAudit: {
        observedAt: deps.clock.now(),
        ...(record.mergeMutations === undefined ? {} : { mergeMutations: record.mergeMutations }),
      },
    }),
  );
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

  const completed = await transition(deps, record, { stage: { kind: "completed" } });
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
  const written = await transition(deps, record, next);
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
  const written = await transition(deps, record, { stage: { kind: "requires_manual", cause } });
  if (!written.ok) {
    return { jobId: record.jobId, outcome: "progress_write_failed", error: written.error };
  }

  // Work-status lifecycle failures are themselves evidence that authority is ambiguous. Never
  // recurse through the same failed transition, and never overwrite a human-owned main state.
  if (
    cause.reasonCode !== "work_status_lifecycle_failed" &&
    mayProjectRequiresManual(written.value) &&
    hasConfirmedWorkStart(written.value)
  ) {
    const coordinator = deps.workStatusLifecycle;
    const capabilityDigest = written.value.workStatusLifecycle?.capabilityDigest;
    const allowedMainSource = latestConfirmedActiveWorkStatus(written.value);
    if (
      coordinator !== undefined &&
      capabilityDigest !== undefined &&
      allowedMainSource !== undefined
    ) {
      const authorityDigest = sha256Digest({
        schemaVersion: 1,
        operation: "requires-manual-projection",
        jobId: written.value.jobId,
        externalIssueId: written.value.externalIssueId,
        cause,
      });
      if (authorityDigest.ok) {
        const agentTarget = {
          kind: "set" as const,
          status: "blocked" as const,
          blockingReason: requiresManualBlockingReason(cause),
        };
        const transitionInstance = createWorkStatusLifecycleTransitionInstance({
          jobId: written.value.jobId,
          step: "requires_manual",
          mainTarget: "requires_manual",
          allowedMainSources: [allowedMainSource],
          agentTarget,
          authorityDigest: authorityDigest.value,
        });
        const invocationDigest = sha256Digest({
          schemaVersion: 1,
          operation: "requires-manual-projection-invocation",
          jobId: written.value.jobId,
          progressRevision: written.value.revision,
          ...(transitionInstance.ok ? { transitionInstance: transitionInstance.value } : {}),
        });
        if (transitionInstance.ok && invocationDigest.ok) {
          // The Job is already durably fail-closed. A projection outage must never reopen it or
          // change the terminal outcome; reconcile will retry the receipted projection later.
          await whileResumeLeaseHeld(deps, () =>
            coordinator.transition({
              jobId: written.value.jobId,
              reference: {
                project: deps.project,
                externalIssueId: written.value.externalIssueId,
              },
              holderId: `work-status:${deps.holderId}`,
              mode: "enforce",
              capabilityDigest,
              phase: "terminal",
              step: "requires_manual",
              transitionInstance: transitionInstance.value,
              invocationDigest: invocationDigest.value,
              mainTarget: "requires_manual",
              allowedMainSources: [allowedMainSource],
              agentTarget,
            }),
          );
          // The periodic reconcile path publishes the human-readable handoff with the same
          // deterministic transition instance. Keeping publication there avoids widening this
          // composition's work-management authority; LinearMutationClient marker-dedupes retries.
        }
      }
    }
  }

  return { jobId: record.jobId, outcome: "requires_manual", reason };
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

export async function resumeUnderLease(
  record: JobProgressRecord,
  deps: ResumeCycleDependencies,
): Promise<ResumeJobOutcome> {
  const policyBlock = await reviewerReplayPolicyBlock(record, deps);
  if (policyBlock !== undefined) return policyBlock;
  const assignments = record.providerAssignments;
  if (assignments === undefined) {
    return requiresManual(
      record,
      deps,
      "legacy_provider_assignment_unavailable",
      requiresManualCause("setup", "legacy_provider_assignment_unavailable"),
    );
  }
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
  const readOptions = deps.signal === undefined ? undefined : { signal: deps.signal };
  const currentChangeRequest = await whileResumeLeaseHeld(deps, () =>
    deps.sourceControl.getChangeRequest(changeRequestReference, readOptions),
  );
  if (!currentChangeRequest.ok) {
    return requiresManualUnlessRetryable(
      record,
      deps,
      "change_request_read_failed",
      currentChangeRequest.error,
      requiresManualCause("setup", "change_request_unavailable"),
    );
  }
  const workItem = await whileResumeLeaseHeld(deps, () =>
    deps.workManagement.getIssue(
      { project: deps.project, externalIssueId: record.externalIssueId },
      readOptions,
    ),
  );
  if (!workItem.ok) {
    return requiresManualUnlessRetryable(
      record,
      deps,
      "work_item_status_unavailable",
      workItem.error,
      requiresManualCause("merge", "work_item_status_unavailable"),
    );
  }
  if (
    workItem.value.issue.projectId !== deps.project.id ||
    workItem.value.issue.externalId !== record.externalIssueId
  ) {
    return requiresManual(
      record,
      deps,
      "work_item_status_mismatch",
      requiresManualCause("merge", "work_item_status_unavailable"),
    );
  }
  // C035: this check deliberately precedes both the already-merged and `merging` branches. Once
  // Linear says canceled, no stale local stage is allowed to keep driving GitHub mutations.
  if (workItem.value.workStatus === "canceled") {
    return stopCanceledWork(record, deps, changeRequestId);
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
    return finishMerged(
      record,
      deps,
      changeRequestId,
      authorizedHeadSha,
      persistedMergeMutations(record),
    );
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

  if (record.stage.kind === "reviewer_waiting") {
    const waiting = record as ReviewerWaitingRecord;
    if (currentChangeRequest.value.headSha !== waiting.stage.binding.headSha) {
      return requiresManual(
        record,
        deps,
        "reviewer_wait_head_changed",
        requiresManualCause("setup", "change_request_unavailable"),
      );
    }
    if (waiting.stage.publication === "pending") {
      return publishReviewerWaiting(waiting, deps);
    }
    if (
      waiting.stage.retryNotBefore === undefined ||
      Date.parse(deps.clock.now()) < Date.parse(waiting.stage.retryNotBefore)
    ) {
      return reviewerWaitingOutcome(waiting);
    }
    // The next cycle performs the ordinary full PR/CI/requirements/effective-diff validation and
    // starts a brand-new Claude process. This transition never resumes a partial provider session.
    return transitionOrReport(deps, record, { stage: { kind: "awaiting_review" } }, () => ({
      jobId: record.jobId,
      outcome: "awaiting_review",
    }));
  }

  if (record.stage.kind === "merging") {
    return resumeMergingStage(record, deps, currentChangeRequest.value);
  }

  const jobs = await whileResumeLeaseHeld(deps, () => deps.jobRepository.readAll());
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

  const issue = await whileResumeLeaseHeld(deps, () =>
    projectIssueByExternalId(
      deps.project,
      deps.readModel,
      deps.teamId,
      deps.linearProjectId,
      record.externalIssueId,
      readOptions,
    ),
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
  const idempotencyKeyPrefix =
    record.reviewerReplay?.state === "review_succeeded"
      ? `reviewer-replay:${record.jobId}:${record.reviewerReplay.identityDigest}`
      : `cli-dispatch-resume:${record.jobId}:${String(record.revision)}`;

  // C031: a non-draft PR has already had `ReviewerPipeline.run()` call
  // `markChangeRequestReady()` (reviewer.ts) at least once. `CiRecoveryPipeline.run()`'s own
  // `validRequest()` (ci-recovery.ts) hard-requires `request.changeRequest.draft` -- a non-draft
  // PR can never satisfy that invariant, by design (ci-recovery's safety semantics: only ever
  // auto-push a repair commit to a PR that has never yet been shown to a reviewer). Routing such
  // a job through `deps.ciRecovery.run()` anyway does not mean "CI recovery is inapplicable, try
  // something else" -- it means a guaranteed, non-retryable `failed("request",
  // invariant_violation)`, which used to surface as a misleading `ci_recovery_failed`
  // requires_manual, silently discarding whatever retry budget this job's *actual* current stage
  // still had (e.g. `review_report_pending_retry`'s own report-contract retry). `resumeReview()`
  // itself re-reads the live PR/CI state independently, and `markChangeRequestReady()` is a no-op
  // against an already-ready PR, so skipping straight to it here loses nothing this PR's own
  // history still needed. Deliberately never relaxes ci-recovery's own draft invariant -- that
  // stays exactly as strict as before this ticket; this is purely a routing decision made from
  // the live readback already in hand.
  if (!currentChangeRequest.value.draft) {
    return resumeReview(record, deps, {
      job,
      issue: issue.value,
      changeRequestId,
      requirementSnapshot: requirementSnapshot.value,
      worktree,
      changeRequest: currentChangeRequest.value,
      baseRevision,
      idempotencyKeyPrefix,
    });
  }

  const ciDeadline = computeProviderDeadline(deps.clock);
  if (ciDeadline === undefined) {
    return requiresManual(
      record,
      deps,
      "invalid_deadline",
      requiresManualCause("ci_recovery", "invalid_deadline"),
    );
  }

  const ciOutcome = await whileResumeLeaseHeld(deps, () =>
    deps.ciRecovery.run({
      trigger: { kind: "polling" },
      job,
      project: deps.project,
      trustedConfig: deps.trustedConfig,
      requirementSnapshot: requirementSnapshot.value,
      worktree,
      changeRequest: currentChangeRequest.value,
      model: assignments.execution.model,
      remote: "origin",
      commitMessage: `${issue.value.title} (${issue.value.externalId}) CI 修復`,
      controllerDirective: buildDirective(issue.value),
      externalData: Object.freeze([]),
      deadlineAt: ciDeadline,
      idempotencyKeyPrefix: `${idempotencyKeyPrefix}:ci-recovery`,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    }),
  );

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
    issue: issue.value,
    changeRequestId,
    requirementSnapshot: requirementSnapshot.value,
    worktree,
    changeRequest: currentChangeRequest.value,
    baseRevision,
    idempotencyKeyPrefix,
  });
}

/**
 * Runs the existing cancellation lifecycle. For an unmerged PR that lifecycle already performs
 * the progress CAS, checkpoint, close, lease release and Linear comment, so this helper must not
 * attempt a second CAS with the stale `record.revision`. For a merged race the lifecycle only
 * writes the audit/pause side effects and this helper persists the requires-manual cause.
 */
async function stopCanceledWork(
  record: JobProgressRecord,
  deps: ResumeCycleDependencies,
  changeRequestId: string,
  observedMergeMutations?: CancellationRaceMergeMutations,
): Promise<ResumeJobOutcome> {
  const mergeMutations = observedMergeMutations ?? persistedMergeMutations(record);
  const outcome = await whileResumeLeaseHeld(deps, () =>
    deps.lifecycle.run({
      project: deps.project,
      externalIssueId: record.externalIssueId,
      changeRequestId,
      idempotencyKeyPrefix: `cli-dispatch-resume:${record.jobId}:${String(record.revision)}:cancellation`,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      cancellationRaceAudit: {
        observedAt: deps.clock.now(),
        ...(mergeMutations === undefined ? {} : { mergeMutations }),
      },
    }),
  );
  if (outcome.state === "canceled") {
    return { jobId: record.jobId, outcome: "requires_manual", reason: "work_item_canceled" };
  }
  if (outcome.state === "blocked" && outcome.reason === "cancellation_after_merge") {
    return { jobId: record.jobId, outcome: "requires_manual", reason: "cancellation_after_merge" };
  }
  if (outcome.state === "failed") {
    return requiresManualUnlessRetryable(
      record,
      deps,
      `cancellation_lifecycle_failed:${outcome.stage}:${outcome.error.code}`,
      outcome.error,
      requiresManualCause("merge", "work_item_canceled"),
    );
  }
  return requiresManual(
    record,
    deps,
    `cancellation_lifecycle_unexpected:${outcome.state}`,
    requiresManualCause("merge", "work_item_canceled"),
  );
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
    await whileResumeLeaseHeld(deps, () =>
      deps.reviewReportSidecar.record({
        jobId: record.jobId,
        category,
        rejectedOutput: reviewOutcome.rejectedOutput ?? "",
      }),
    );
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

type ReviewerWaitingRecord = JobProgressRecord & {
  stage: Extract<JobProgressRecord["stage"], { kind: "reviewer_waiting" }>;
};

function reviewerWaitingOutcome(record: ReviewerWaitingRecord): ResumeJobOutcome {
  return Object.freeze({
    jobId: record.jobId,
    outcome: "reviewer_waiting" as const,
    reason: record.stage.reason,
    ...(record.stage.retryNotBefore === undefined
      ? {}
      : { retryNotBefore: record.stage.retryNotBefore }),
  });
}

async function publishReviewerWaiting(
  record: ReviewerWaitingRecord,
  deps: ResumeCycleDependencies,
): Promise<ResumeJobOutcome> {
  if (record.stage.publication === "confirmed") return reviewerWaitingOutcome(record);
  if (deps.reviewWaitPublication === undefined || record.changeRequestId === undefined) {
    return reviewerWaitingOutcome(record);
  }
  const published = await whileResumeLeaseHeld(
    deps,
    () =>
      deps.reviewWaitPublication?.publish({
        project: deps.project,
        externalIssueId: record.externalIssueId,
        changeRequestId: record.changeRequestId ?? "",
        headSha: record.stage.binding.headSha,
        confidence: record.stage.confidence,
        ...(record.stage.bucket === undefined ? {} : { bucket: record.stage.bucket }),
        ...(record.stage.resetAt === undefined ? {} : { resetAt: record.stage.resetAt }),
        idempotencyKeyPrefix: `reviewer-wait:${record.jobId}:${record.stage.binding.headSha}:${record.stage.reason}`,
        lifecycleMode: record.workStatusLifecycle?.admissionMode ?? "off",
      }) ?? Promise.resolve(err(domainError("invariant_violation"))),
  );
  if (!published.ok) {
    return Object.freeze({
      jobId: record.jobId,
      outcome: "transient_failure" as const,
      reason: `reviewer_wait_publication_failed:${published.error.code}`,
      error: published.error,
    });
  }
  const confirmed = await transition(deps, record, {
    stage: { ...record.stage, publication: "confirmed" },
  });
  return confirmed.ok
    ? reviewerWaitingOutcome(confirmed.value as ReviewerWaitingRecord)
    : { jobId: record.jobId, outcome: "progress_write_failed", error: confirmed.error };
}

async function enterReviewerWaiting(
  record: JobProgressRecord,
  deps: ResumeCycleDependencies,
  wait: NonNullable<Extract<ReviewerPipelineOutcome, { state: "failed" }>["reviewWait"]>,
): Promise<ResumeJobOutcome> {
  const retryNotBefore =
    wait.confidence === "confirmed" &&
    wait.resetAt !== undefined &&
    Date.parse(wait.resetAt) > Date.parse(deps.clock.now())
      ? wait.resetAt
      : undefined;
  const written = await transition(deps, record, {
    stage: {
      kind: "reviewer_waiting",
      reason: wait.confidence === "confirmed" ? "confirmed_quota_wall" : "unconfirmed_throttling",
      confidence: wait.confidence,
      ...(wait.bucket === undefined ? {} : { bucket: wait.bucket }),
      ...(wait.resetAt === undefined ? {} : { resetAt: wait.resetAt }),
      ...(retryNotBefore === undefined ? {} : { retryNotBefore }),
      binding: {
        requirementsDigest: wait.requirementsDigest,
        headSha: wait.headSha,
        diffDigest: wait.diffDigest,
      },
      publication: "pending",
    },
  });
  if (!written.ok) {
    return { jobId: record.jobId, outcome: "progress_write_failed", error: written.error };
  }
  return publishReviewerWaiting(written.value as ReviewerWaitingRecord, deps);
}

async function resumeReview(
  record: JobProgressRecord,
  deps: ResumeCycleDependencies,
  context: {
    readonly job: Parameters<CiRecoveryPipeline["run"]>[0]["job"];
    readonly issue: Parameters<typeof buildDirective>[0];
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
  const assignments = record.providerAssignments;
  if (assignments === undefined) {
    return requiresManual(
      record,
      deps,
      "legacy_provider_assignment_unavailable",
      requiresManualCause("setup", "legacy_provider_assignment_unavailable"),
    );
  }
  const expectedHeadSha = context.changeRequest.headSha;
  const reviewerReplayCheckpoint =
    record.reviewerReplay?.state === "review_succeeded" ? record.reviewerReplay : undefined;
  const beginReview = async (): Promise<ResumeJobOutcome | undefined> => {
    const begin = await whileResumeLeaseHeld(deps, () =>
      deps.reviewStatus.begin({
        project: deps.project,
        changeRequestId: context.changeRequestId,
        expectedHeadSha,
        idempotencyKeyPrefix: `${context.idempotencyKeyPrefix}:review-begin`,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      }),
    );
    if (begin.state === "failed") {
      if (reviewerReplayCheckpoint !== undefined) {
        return {
          jobId: record.jobId,
          outcome: "requires_manual",
          reason: `reviewer_replay_review_begin_failed:${begin.error.code}`,
        };
      }
      return requiresManualUnlessRetryable(
        record,
        deps,
        "review_begin_failed",
        begin.error,
        requiresManualCause("review", "review_begin_failed"),
      );
    }
    if (begin.state !== "not_ready") return undefined;
    if (reviewerReplayCheckpoint !== undefined) {
      return {
        jobId: record.jobId,
        outcome: "requires_manual",
        reason: `reviewer_replay_${begin.reason}`,
      };
    }
    // C031: `begin.reason` is `"ci_pending" | "ci_failed"` (BeginReviewOutcome, merge-gate-model.ts)
    // -- a draft PR's CI failure still retreats to `ci_waiting` (a fresh `agent-team run` resume
    // will drive it back through `CiRecoveryPipeline`, exactly as before this ticket). A *non-draft*
    // PR's `ci_failed`, though, has no automatic repair path left at all -- ci-recovery's own draft
    // invariant (ci-recovery.ts's `validRequest()`) means it can never run against this PR again --
    // so retreating to `ci_waiting` here would just have the next resume observe the identical
    // `ci_failed` forever, an unbounded retry loop rather than a bounded one. Fail closed instead.
    if (begin.reason === "ci_failed" && !begin.changeRequest.draft) {
      return requiresManual(
        record,
        deps,
        "ci_failed_after_ready",
        requiresManualCause("review", "ci_failed_after_ready"),
      );
    }
    return transitionOrReport(deps, record, { stage: { kind: "ci_waiting" } }, () => ({
      jobId: record.jobId,
      outcome: "still_ci_waiting",
    }));
  };
  if (reviewerReplayCheckpoint === undefined) {
    const halted = await beginReview();
    if (halted !== undefined) return halted;
    const lifecycleGate = await gateWorkStatusLifecycle(record, deps, {
      step: "review_start",
      phase: "reviewing",
      mainTarget: "in_review",
      allowedMainSources: ["in_progress", "in_review"],
      agentTarget: { kind: "set", status: "waiting" },
      causeStage: "review",
      authority: {
        requirementsDigest: context.requirementSnapshot.requirementsDigest,
        headSha: expectedHeadSha,
        baseRevision: context.baseRevision,
      },
    });
    if ("outcome" in lifecycleGate) return lifecycleGate;
    record = lifecycleGate;
  }
  // `already_approved` intentionally falls through to the same fresh Reviewer path as `pending`.
  // Its successful status proves only that this head was reviewed before; it is not a
  // `RecordedReviewApproval` and cannot authorize this merge without re-evaluating current
  // requirements and recording a fresh, transport-bound decision.

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

  // E102-3: `Issue.reviewRequirement` (optional on the domain schema) decides which reviewer
  // role(s) `reviewer.run()`'s own `validReviewerRequest` (reviewer-policy.ts) will require --
  // mirrored here so `models`/`evidence`/`visualManifest` are assembled to match exactly, rather
  // than this call always forcing `models.code` the way it did before this ticket (which is why a
  // `visual_review`/`dual_review` job could never pass `validReviewerRequest` at all: it always
  // set `models.code` even when only a visual reviewer was required, and never set `models.visual`/
  // `evidence`/`visualManifest` for any requirement). An `undefined` `reviewRequirement` still
  // resolves to "no role required" here, exactly as it always has -- `validReviewerRequest`'s own
  // `roles.length > 0` check fails that case closed, unchanged from before this ticket.
  const reviewRequirement = context.requirementSnapshot.issue.reviewRequirement;
  const needsCodeReview =
    reviewRequirement === "code_review" || reviewRequirement === "dual_review";
  const needsVisualReview =
    reviewRequirement === "visual_review" || reviewRequirement === "dual_review";

  let visualEvidence: VisualEvidenceBuildSuccess | undefined;
  // E102-4b: the review-time counterpart of `identity.ts`'s own `publicationDigest` field --
  // `aggregateLinearPublicationDigest` over the *single* receipt `published` below just durably
  // recorded (or reused) for this exact (issueId, headSha). Deliberately never scans the receipt
  // store's directory or aggregates any other head/issue's receipts: the coordinator's own spec for
  // this ticket is explicit that today's data model has exactly one receipt per (project, issue,
  // head) key, so "the one receipt this call just produced" already *is* the complete input set --
  // seeing more than one receipt here would itself be a bug this aggregation is not asked to guard
  // against.
  let publicationDigest: string | undefined;
  if (needsVisualReview) {
    if (
      deps.visualEvidence === undefined ||
      (reviewerReplayCheckpoint === undefined &&
        (deps.visualReviewModel === undefined ||
          deps.trustedConfig.commands.visualReview.length === 0))
    ) {
      return requiresManual(
        record,
        deps,
        "visual_evidence_builder_unavailable",
        requiresManualCause("review", "visual_evidence_unavailable"),
      );
    }
    const visualEvidencePort = deps.visualEvidence;
    const built = await whileResumeLeaseHeld(deps, () =>
      reviewerReplayCheckpoint === undefined
        ? visualEvidencePort.build({
            worktreePath: context.worktree.path,
            issueId: context.requirementSnapshot.issue.id,
            headSha: expectedHeadSha,
            commands: deps.trustedConfig.commands.visualReview,
            allowedAcceptanceCriteria: context.requirementSnapshot.issue.acceptanceCriteria ?? [],
            deadlineAt: reviewDeadline,
            ...(deps.signal === undefined ? {} : { signal: deps.signal }),
          })
        : visualEvidencePort.verifyExisting({
            worktreePath: context.worktree.path,
            issueId: context.requirementSnapshot.issue.id,
            headSha: expectedHeadSha,
            allowedAcceptanceCriteria: context.requirementSnapshot.issue.acceptanceCriteria ?? [],
          }),
    );
    if (!built.ok) {
      return requiresManual(
        record,
        deps,
        `visual_evidence_build_failed:${built.failure.reason}`,
        requiresManualCause("review", "visual_evidence_unavailable"),
      );
    }
    visualEvidence = built.value;

    if (reviewerReplayCheckpoint !== undefined) {
      const linearPublicationStore = deps.linearPublicationStore;
      if (linearPublicationStore === undefined) {
        return {
          jobId: record.jobId,
          outcome: "requires_manual",
          reason: "reviewer_replay_publication_unavailable",
        };
      }
      const receipt = await whileResumeLeaseHeld(deps, () =>
        linearPublicationStore.load(
          deps.project.id,
          context.requirementSnapshot.issue.id,
          expectedHeadSha,
        ),
      );
      if (!receipt.ok || receipt.value === undefined) {
        return {
          jobId: record.jobId,
          outcome: "requires_manual",
          reason: "reviewer_replay_publication_unavailable",
        };
      }
      publicationDigest = aggregateLinearPublicationDigest([receipt.value]);
    } else {
      // E102-5: the manifest + PNG evidence `built` just produced must reach Linear -- with a
      // durable, reusable receipt -- before the reviewer is ever allowed to start. Any failure here
      // (composition-root gap, a stale/mismatched receipt, or the upload/comment call itself failing)
      // fails this job closed to `requires_manual`, never letting `reviewer.run()` proceed on
      // evidence nobody outside this process can see. See linear-publication.ts's own header for why
      // an "orphan" (a Linear-side asset/comment already created, but no durable receipt for it)
      // gets a distinct reasonCode from every other publication failure.
      if (deps.linearPublication === undefined) {
        return requiresManual(
          record,
          deps,
          "linear_publication_unavailable",
          requiresManualCause("review", "visual_publication_failed"),
        );
      }
      const linearPublication = deps.linearPublication;
      const publishedVisualEvidence = visualEvidence;
      const publicationContext = await whileResumeLeaseHeld(deps, () =>
        deps.readModel.readContext(
          deps.teamId,
          deps.linearProjectId,
          deps.signal === undefined ? {} : { signal: deps.signal },
        ),
      );
      if (!publicationContext.ok) {
        return requiresManualUnlessRetryable(
          record,
          deps,
          "linear_publication_context_unavailable",
          publicationContext.error,
          requiresManualCause("review", "visual_publication_failed"),
        );
      }
      const published = await whileResumeLeaseHeld(deps, () =>
        linearPublication.publish({
          context: publicationContext.value,
          projectId: deps.project.id,
          issueId: context.requirementSnapshot.issue.id,
          externalIssueId: record.externalIssueId,
          worktreePath: context.worktree.path,
          visualManifest: publishedVisualEvidence.visualManifest,
          ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        }),
      );
      if (!published.ok) {
        return requiresManual(
          record,
          deps,
          `linear_publication_failed:${published.failure.reason}`,
          requiresManualCause(
            "review",
            published.failure.orphan ? "visual_publication_orphan" : "visual_publication_failed",
          ),
        );
      }
      publicationDigest = aggregateLinearPublicationDigest([published.value.receipt]);
    }
  }

  const reviewerRequest: Parameters<ReviewerPipeline["run"]>[0] = {
    job: context.job,
    project: deps.project,
    trustedConfig: deps.trustedConfig,
    requirementSnapshot: context.requirementSnapshot,
    worktree: context.worktree,
    changeRequestId: context.changeRequestId,
    baseRevision: context.baseRevision,
    expectedHeadSha,
    models: {
      ...(needsCodeReview ? { code: assignments.codeReview.model } : {}),
      ...(needsVisualReview && deps.visualReviewModel !== undefined
        ? { visual: deps.visualReviewModel }
        : {}),
    },
    evidence: visualEvidence?.evidence ?? Object.freeze([]),
    ...(visualEvidence === undefined ? {} : { visualManifest: visualEvidence.visualManifest }),
    ...(publicationDigest === undefined ? {} : { publicationDigest }),
    deadlineAt: reviewDeadline,
    idempotencyKeyPrefix: `${context.idempotencyKeyPrefix}:review`,
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    ...(reportRetryFeedback === undefined ? {} : { reportRetryFeedback }),
  };

  let reviewOutcome: ReviewerPipelineOutcome;
  if (reviewerReplayCheckpoint === undefined) {
    const authority = await verifyProviderAuthority(record, deps, {
      expectedWorkStatus: "in_review",
      expectedHeadSha,
      changeRequestId: context.changeRequestId,
      requirementsDigest: context.requirementSnapshot.requirementsDigest,
    });
    if (authority !== undefined) return authority;
    reviewOutcome = await whileResumeLeaseHeld(deps, () => deps.reviewer.run(reviewerRequest));
  } else {
    const inspect = deps.reviewer.inspect;
    if (inspect === undefined) {
      return {
        jobId: record.jobId,
        outcome: "requires_manual",
        reason: "reviewer_replay_inspect_unavailable",
      };
    }
    const inspected = await whileResumeLeaseHeld(deps, () => inspect(reviewerRequest));
    if (inspected.state !== "ready") {
      return {
        jobId: record.jobId,
        outcome: "requires_manual",
        reason:
          inspected.state === "not_ready"
            ? `reviewer_replay_${inspected.reason}`
            : `reviewer_replay_identity_read_failed:${inspected.stage}:${inspected.error.code}`,
      };
    }
    const replayIdentity = createReviewerReplayIdentityForCheckpoint(
      record,
      inspected.identity,
      reviewerReplayCheckpoint,
    );
    const reportDigests = reviewerReplayCheckpoint.reports.map((report) => sha256Digest(report));
    const expectedCheckpointDigest = createReviewerReplaySuccessCheckpointDigest({
      identity: reviewerReplayCheckpoint.identity,
      identityDigest: reviewerReplayCheckpoint.identityDigest,
      counters: reviewerReplayCheckpoint.counters,
      ...(reviewerReplayCheckpoint.reviewContractBinding === undefined
        ? {}
        : { reviewContractBinding: reviewerReplayCheckpoint.reviewContractBinding }),
      reportDigests: reviewerReplayCheckpoint.reportDigests,
    });
    if (
      !replayIdentity.ok ||
      !replayIdentityMatches(reviewerReplayCheckpoint, replayIdentity.value) ||
      reportDigests.some((digest) => !digest.ok) ||
      reportDigests.some(
        (digest, index) =>
          digest.ok && digest.value !== reviewerReplayCheckpoint.reportDigests[index],
      ) ||
      !expectedCheckpointDigest.ok ||
      expectedCheckpointDigest.value !== reviewerReplayCheckpoint.checkpointDigest ||
      reviewerReplayCheckpoint.reports.some(
        (report) =>
          report.verdict !== "passed" || !reviewerReportMatchesIdentity(report, inspected.identity),
      )
    ) {
      return {
        jobId: record.jobId,
        outcome: "requires_manual",
        reason: "reviewer_replay_identity_mismatch",
      };
    }
    const halted = await beginReview();
    if (halted !== undefined) return halted;
    const lifecycleGate = await gateWorkStatusLifecycle(record, deps, {
      step: "review_start",
      phase: "reviewing",
      mainTarget: "in_review",
      allowedMainSources: ["in_progress", "in_review"],
      agentTarget: { kind: "set", status: "waiting" },
      causeStage: "review",
      authority: {
        requirementsDigest: context.requirementSnapshot.requirementsDigest,
        headSha: expectedHeadSha,
        baseRevision: context.baseRevision,
      },
    });
    if ("outcome" in lifecycleGate) return lifecycleGate;
    record = lifecycleGate;
    reviewOutcome = Object.freeze({
      state: "approved" as const,
      job: inspected.job,
      changeRequest: inspected.changeRequest,
      checks: inspected.checks,
      identity: inspected.identity,
      reports: reviewerReplayCheckpoint.reports,
    });
  }

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
      if (reviewOutcome.reviewWait !== undefined) {
        return enterReviewerWaiting(record, deps, reviewOutcome.reviewWait);
      }
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
    case "clarification_required": {
      const record$ = await whileResumeLeaseHeld(deps, () =>
        deps.reviewStatus.record({
          project: deps.project,
          changeRequestId: context.changeRequestId,
          expectedHeadSha,
          idempotencyKeyPrefix: `${context.idempotencyKeyPrefix}:review-record`,
          decision: reviewOutcome,
          ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        }),
      );
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
        verdict: "clarification_required",
      }));
    }
    case "changes_requested": {
      const record$ = await whileResumeLeaseHeld(deps, () =>
        deps.reviewStatus.record({
          project: deps.project,
          changeRequestId: context.changeRequestId,
          expectedHeadSha,
          idempotencyKeyPrefix: `${context.idempotencyKeyPrefix}:review-record`,
          decision: reviewOutcome,
          ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        }),
      );
      if (record$.state === "failed") {
        return requiresManualUnlessRetryable(
          record,
          deps,
          "review_record_failed",
          record$.error,
          requiresManualCause("review", "review_record_failed"),
        );
      }
      const fixLifecycleGate = await gateWorkStatusLifecycle(record, deps, {
        step: "fix_start",
        phase: "fixing",
        mainTarget: "in_progress",
        allowedMainSources: ["in_review", "in_progress"],
        agentTarget: { kind: "set", status: "executing" },
        causeStage: "review",
        authority: {
          requirementsDigest: context.requirementSnapshot.requirementsDigest,
          headSha: expectedHeadSha,
          baseRevision: context.baseRevision,
          fixRound: reviewOutcome.job.attempts.reviewerFixRounds + 1,
        },
      });
      if ("outcome" in fixLifecycleGate) return fixLifecycleGate;
      record = fixLifecycleGate;
      const recoveryDeadline = computeProviderDeadline(deps.clock);
      if (recoveryDeadline === undefined) {
        return requiresManual(
          record,
          deps,
          "invalid_deadline",
          requiresManualCause("review", "review_paused"),
        );
      }
      const fixAuthority = await verifyProviderAuthority(record, deps, {
        expectedWorkStatus: "in_progress",
        expectedHeadSha,
        changeRequestId: context.changeRequestId,
        requirementsDigest: context.requirementSnapshot.requirementsDigest,
      });
      if (fixAuthority !== undefined) return fixAuthority;
      const recoveryOutcome = await whileResumeLeaseHeld(deps, () =>
        deps.reviewerRecovery.run({
          job: reviewOutcome.job,
          project: deps.project,
          trustedConfig: deps.trustedConfig,
          requirementSnapshot: context.requirementSnapshot,
          worktree: context.worktree,
          model: assignments.execution.model,
          remote: "origin",
          commitMessage: `${context.issue.title} (${context.issue.externalId}) Review 修復`,
          controllerDirective: buildDirective(context.issue),
          findings: reviewOutcome.findings.filter((finding) => finding.severity === "blocking"),
          externalData: Object.freeze([]),
          deadlineAt: recoveryDeadline,
          idempotencyKeyPrefix: `${context.idempotencyKeyPrefix}:reviewer-recovery`,
          ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        }),
      );
      switch (recoveryOutcome.state) {
        case "repair_pushed": {
          const headSha = parsedHeadSha(recoveryOutcome.push.sha);
          if (headSha === undefined) {
            return requiresManual(
              record,
              deps,
              "invalid_head_sha",
              requiresManualCause("review", "review_provider_failed"),
            );
          }
          return transitionOrReport(
            deps,
            record,
            { stage: { kind: "ci_waiting" }, headSha },
            () => ({
              jobId: record.jobId,
              outcome: "reviewer_fix_pushed",
            }),
          );
        }
        case "checkpointed": {
          const checkpointId = parsedCheckpointId(recoveryOutcome.checkpointId);
          if (checkpointId === undefined) {
            return requiresManual(
              record,
              deps,
              "invalid_checkpoint_id",
              requiresManualCause("review", "review_provider_failed"),
            );
          }
          return transitionOrReport(
            deps,
            record,
            { stage: { kind: "paused", checkpointId } },
            () => ({
              jobId: record.jobId,
              outcome: "checkpointed",
              checkpointId: recoveryOutcome.checkpointId,
            }),
          );
        }
        case "paused":
          return requiresManual(
            record,
            deps,
            `reviewer_recovery_paused:${recoveryOutcome.reason}`,
            requiresManualCause("review", "review_paused"),
          );
        case "failed":
          return requiresManual(
            record,
            deps,
            `reviewer_recovery_failed:${recoveryOutcome.stage}:${recoveryOutcome.error.code}`,
            requiresManualCause("review", "review_provider_failed"),
          );
      }
    }
    case "approved":
      break;
  }

  const recorded = await whileResumeLeaseHeld(deps, () =>
    deps.reviewStatus.record({
      project: deps.project,
      changeRequestId: context.changeRequestId,
      expectedHeadSha,
      idempotencyKeyPrefix: `${context.idempotencyKeyPrefix}:review-record`,
      decision: reviewOutcome,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    }),
  );
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

  // E102-4b: `AutoMergeGate.enable()`'s own `validApproval` (merge-gate.ts) requires a non-empty
  // `currentVisualManifest`/`currentPublicationDigest` for every `dual_review`/`visual_review` job
  // (see that function's own `requiresEvidence` branch) -- before this ticket, this call site never
  // supplied either, so `enable()` always failed closed with `stage:"request"` for exactly the jobs
  // that most need auto-merge (E102-4's own domain/gate logic was correct; only this production
  // wiring was missing -- see this ticket's own PR description for the full history). Both values
  // come from a fresh, read-only re-verification of the exact commit under review -- never from
  // `recorded.approval.identity` itself (that would be comparing the approval against itself, which
  // can never detect drift) and never from `deps.visualEvidence.build()` (which would silently
  // re-manufacture evidence, and re-publish is impossible anyway -- Linear receipts are write-once,
  // see linear-publication-store.ts's own header) -- only ever this call site, only ever for a job
  // that actually needs visual evidence.
  let currentVisualManifest: VisualManifest | undefined;
  let currentPublicationDigest: string | undefined;
  if (needsVisualReview) {
    if (deps.visualEvidence === undefined) {
      return requiresManual(
        record,
        deps,
        "visual_evidence_builder_unavailable_at_merge",
        requiresManualCause("merge", "visual_evidence_missing_at_merge"),
      );
    }
    const visualEvidencePort = deps.visualEvidence;
    const verified = await whileResumeLeaseHeld(deps, () =>
      visualEvidencePort.verifyExisting({
        worktreePath: context.worktree.path,
        issueId: context.requirementSnapshot.issue.id,
        headSha: expectedHeadSha,
        allowedAcceptanceCriteria: context.requirementSnapshot.issue.acceptanceCriteria ?? [],
      }),
    );
    if (!verified.ok) {
      return requiresManual(
        record,
        deps,
        `visual_evidence_verify_failed:${verified.failure.reason}`,
        requiresManualCause("merge", "visual_evidence_missing_at_merge"),
      );
    }
    currentVisualManifest = verified.value.visualManifest;

    if (deps.linearPublicationStore === undefined) {
      return requiresManual(
        record,
        deps,
        "linear_publication_store_unavailable_at_merge",
        requiresManualCause("merge", "visual_publication_missing_at_merge"),
      );
    }
    const linearPublicationStore = deps.linearPublicationStore;
    const receipt = await whileResumeLeaseHeld(deps, () =>
      linearPublicationStore.load(
        deps.project.id,
        context.requirementSnapshot.issue.id,
        expectedHeadSha,
      ),
    );
    if (!receipt.ok || receipt.value === undefined) {
      return requiresManual(
        record,
        deps,
        "linear_publication_receipt_missing_at_merge",
        requiresManualCause("merge", "visual_publication_missing_at_merge"),
      );
    }
    currentPublicationDigest = aggregateLinearPublicationDigest([receipt.value]);
  }

  const mergeLifecycleGate = await gateWorkStatusLifecycle(record, deps, {
    step: "merge_start",
    phase: "merging",
    mainTarget: "in_review",
    allowedMainSources: ["in_review"],
    agentTarget: { kind: "set", status: "executing" },
    causeStage: "merge",
    authority: {
      requirementsDigest: context.requirementSnapshot.requirementsDigest,
      headSha: expectedHeadSha,
      baseRevision: context.baseRevision,
      approvalIdentity: recorded.approval.identity,
    },
  });
  if ("outcome" in mergeLifecycleGate) return mergeLifecycleGate;
  record = mergeLifecycleGate;

  const enabled = await whileResumeLeaseHeld(deps, () =>
    deps.autoMerge.enable({
      project: deps.project,
      changeRequestId: context.changeRequestId,
      expectedHeadSha,
      idempotencyKeyPrefix: `${context.idempotencyKeyPrefix}:auto-merge`,
      requirementSnapshot: context.requirementSnapshot,
      baseRevision: context.baseRevision,
      approval: recorded.approval,
      ...(record.workStatusLifecycle?.admissionMode === "enforce"
        ? { expectedWorkStatus: "in_review" as const }
        : {}),
      ...(currentVisualManifest === undefined ? {} : { currentVisualManifest }),
      ...(currentPublicationDigest === undefined ? {} : { currentPublicationDigest }),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    }),
  );
  const mutationReceipts = "mutations" in enabled ? (enabled.mutations ?? []) : [];
  if (mutationReceipts.length > 0) {
    // Persist the transport-boundary receipts before Lifecycle, requires-manual handling, or any
    // other side effect. This cannot make GitHub + local disk atomic; it closes the controllable
    // crash window after the GitHub call returned and keeps CAS conflicts fail-closed.
    const persisted = await persistMergeMutations(deps, record, mutationReceipts);
    if (!persisted.ok) {
      return { jobId: record.jobId, outcome: "progress_write_failed", error: persisted.error };
    }
    record = persisted.value;
  }
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
        return finishMerged(
          record,
          deps,
          context.changeRequestId,
          enabled.changeRequest.headSha,
          enabled.mutations,
        );
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
      return finishMerged(
        record,
        deps,
        context.changeRequestId,
        enabled.headSha,
        enabled.mutations,
      );
    case "already_merged_external":
      // Found already merged before this call could have caused it -- explicitly NOT controller-
      // authorized. Lifecycle still runs (Linear still needs its Done transition and audit
      // comment; see coordinator's decision 1: honest marking is required, the *policy* of
      // pausing auto-merge/warning on out-of-process merges is Lifecycle's own existing job and
      // is out of this ticket's scope either way).
      return finishMerged(record, deps, context.changeRequestId, undefined);
    case "work_canceled":
      return stopCanceledWork(record, deps, context.changeRequestId, enabled.mutations);
    case "re_review_required":
      // The diff/requirements genuinely changed since the approval this job recorded -- needs a
      // fresh review, not a human. `AutoMergeGate.enable()` has already posted its own
      // invalidation comment/status before returning this (merge-gate.ts, unchanged by this
      // ticket); this is purely the CLI-side resume label.
      return transitionOrReport(deps, record, { stage: { kind: "awaiting_review" } }, () => ({
        jobId: record.jobId,
        outcome: "awaiting_review",
      }));
    // E102-4b: the freshly re-verified evidence/publication at this *identical* commit hashes
    // differently from what the recorded approval was reviewed against -- `AutoMergeGate.enable()`
    // has already posted its own drift comment/status before returning this (merge-gate.ts). Never
    // routed back through `awaiting_review`/a fresh reviewer run like `re_review_required` above --
    // see `EnableAutoMergeOutcome.evidence_drift_detected`'s own header for why this is always a
    // human-routed safety event instead.
    case "evidence_drift_detected":
      return requiresManual(
        record,
        deps,
        "evidence_drift_detected_at_merge",
        requiresManualCause("merge", "evidence_drift_detected"),
      );
    case "publication_drift_detected":
      return requiresManual(
        record,
        deps,
        "publication_drift_detected_at_merge",
        requiresManualCause("merge", "publication_drift_detected"),
      );
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
        case "auto_merge_paused":
          // E116cap: `AutoMergeGate.enable()` found `MergeGatePorts.autoMergePause` reporting this
          // project paused (checked before any other readiness condition -- see that outcome's own
          // header, merge-gate-model.ts). Never waited on like `ci_pending`/`review_status_missing`
          // above: a paused project stays paused until a human resolves it (see
          // `FileAutoMergePauseStore.resolve`, auto-merge-pause-store.ts), so re-resuming this job
          // on its own would only repeat the exact same `not_ready` outcome forever. Dedicated
          // reasonCode (not folded into the generic `auto_merge_not_enabled` bucket right above) so
          // a human reading `dispatch resolve`'s output can tell "this project is quarantined after
          // an out-of-process merge" apart from every other reason auto-merge failed to arm.
          return requiresManual(
            record,
            deps,
            "auto_merge_paused_out_of_process_merge",
            requiresManualCause("merge", "auto_merge_paused_out_of_process_merge"),
          );
      }
    case "failed":
      if (enabled.stage === "authorization") {
        return requiresManualUnlessRetryable(
          record,
          deps,
          `work_item_status_unavailable:${enabled.error.code}`,
          enabled.error,
          requiresManualCause("merge", "work_item_status_unavailable"),
        );
      }
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
  mergeMutations?: CancellationRaceMergeMutations,
): Promise<ResumeJobOutcome> {
  const acceptance = await prepareHumanAcceptance(record, deps, changeRequestId);
  if (!acceptance.ok) {
    return requiresManualUnlessRetryable(
      record,
      deps,
      `human_acceptance_checkpoint_failed:${acceptance.error.code}`,
      acceptance.error,
      requiresManualCause("merge", "human_acceptance_checkpoint_failed"),
    );
  }
  record = acceptance.value.record;
  const awaitingHumanAcceptance = acceptance.value.lifecycle !== undefined;
  const terminalLifecycle = await gateWorkStatusLifecycle(record, deps, {
    step: "complete",
    phase: "terminal",
    mainTarget: awaitingHumanAcceptance ? "in_review" : "completed",
    allowedMainSources: awaitingHumanAcceptance
      ? ["in_progress", "in_review"]
      : ["in_progress", "in_review", "completed"],
    agentTarget: { kind: "clear" },
    causeStage: "merge",
    authority: {
      changeRequestId,
      authorizedHeadSha: authorizedHeadSha ?? "external",
      lifecycleHeadSha: authorizedHeadSha ?? record.headSha ?? "external",
      ...(acceptance.value.lifecycle === undefined
        ? {}
        : { humanAcceptanceIdentityDigest: acceptance.value.lifecycle.identityDigest }),
    },
  });
  if ("outcome" in terminalLifecycle) return terminalLifecycle;
  record = terminalLifecycle;

  const lifecyclePrefix =
    record.reviewerReplay?.state === "review_succeeded"
      ? `reviewer-replay:${record.jobId}:${record.reviewerReplay.identityDigest}:lifecycle`
      : `cli-dispatch-lifecycle:${record.jobId}:${changeRequestId}`;
  const outcome = await whileResumeLeaseHeld(deps, () =>
    deps.lifecycle.run({
      project: deps.project,
      externalIssueId: record.externalIssueId,
      changeRequestId,
      ...(authorizedHeadSha === undefined ? {} : { mergeAuthorizationHeadSha: authorizedHeadSha }),
      idempotencyKeyPrefix: lifecyclePrefix,
      ...(acceptance.value.lifecycle === undefined
        ? {}
        : { humanAcceptance: acceptance.value.lifecycle }),
      workStatusLifecycleAudit: lifecycleAudit(
        record,
        record.reviewerReplay?.state === "review_succeeded" ? "reviewer-replay" : "dispatch-resume",
      ),
      ...(record.reviewerReplay?.state !== "review_succeeded"
        ? {}
        : {
            reviewerReplayAudit: {
              operation: "reviewer-replay" as const,
              checkpointDigest: record.reviewerReplay.checkpointDigest,
              attemptTotal: record.reviewerReplay.counters.providerAttempts,
              outcome: "review_succeeded" as const,
            },
          }),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      cancellationRaceAudit: {
        observedAt: deps.clock.now(),
        ...(mergeMutations === undefined ? {} : { mergeMutations }),
      },
    }),
  );
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

/** E116cap: production default -- see `defaultAutoMergePauseDirectory`'s own comment. */
export function buildAutoMergePauseStore(agentTeamHome: string): FileAutoMergePauseStore {
  return new FileAutoMergePauseStore(defaultAutoMergePauseDirectory(agentTeamHome));
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
