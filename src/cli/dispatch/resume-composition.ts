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
import type { SourceControlPort } from "../../application/ports/index.js";
import {
  instantFromDate,
  ok,
  type Clock,
  type DomainError,
  type Instant,
  type Result,
} from "../../domain/foundation/index.js";
import { createRequirementSnapshot, headShaSchema } from "../../domain/review/index.js";
import { checkpointIdSchema } from "../../domain/checkpoint/index.js";
import { watchdogHardStopMs } from "../../domain/jobs/index.js";
import type { Project } from "../../domain/project/index.js";
import { LocalGitAdapter } from "../../adapters/git/index.js";
import {
  projectIssueByExternalId,
  type LinearDiscoveryReadModel,
} from "../../adapters/dispatch/linear-discovery.js";
import {
  FileJobProgressStore,
  type JobProgressRecord,
  type JobProgressRecordMutation,
  type RequiresManualCause,
  type RequiresManualReasonCode,
  type RequiresManualStage,
} from "../../adapters/dispatch/job-progress-store.js";
import { FileIssueAdmissionStore } from "../../adapters/dispatch/issue-admission-store.js";
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

function currentReportContractRetries(record: JobProgressRecord): number {
  return record.stage.kind === "review_report_pending_retry" ? record.stage.retries : 0;
}

/** C015r decision 1: builds the closed-enum `cause` every `requiresManual(...)` call site must now
 * supply -- see `requiresManualCauseSchema`'s own header (job-progress-store.ts) for the full
 * rationale. `count` defaults to 1 (a single-shot failure, no retry loop tracked for that call site);
 * only the `review_report_contract` reasonCode's own call site passes a real, larger count (the
 * report-contract retry counter's value at exhaustion) and a `lastCategory`. */
function requiresManualCause(
  stage: RequiresManualStage,
  reasonCode: RequiresManualReasonCode,
  count = 1,
  lastCategory?: ReportContractFailureCategory,
): RequiresManualCause {
  return Object.freeze({
    stage,
    reasonCode,
    attempts: Object.freeze({ count, ...(lastCategory === undefined ? {} : { lastCategory }) }),
  });
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
  /** Injectable for tests; production defaults to a real `LocalGitAdapter`. */
  readonly gitForBaseRevision?: Pick<LocalGitAdapter, "inspectRepository">;
  /** C015r decision 5: the observability sidecar -- see its own file header
   * (review-report-diagnostics-sidecar.ts) for the full rule set. Only ever called from within this
   * module's own `report`-stage failure handling; never anywhere else. */
  readonly reviewReportSidecar: ReviewReportDiagnosticsSidecarPort;
}

export type ResumeJobOutcome =
  | Readonly<{ jobId: string; outcome: "lease_conflict" }>
  | Readonly<{ jobId: string; outcome: "requires_manual"; reason: string }>
  | Readonly<{ jobId: string; outcome: "still_ci_waiting" }>
  | Readonly<{ jobId: string; outcome: "still_merging" }>
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
  | Readonly<{ jobId: string; outcome: "transient_failure"; reason: string; error: DomainError }>;

/** Runs one resume attempt for every resumable job-progress record belonging to `dependencies.project`. */
export async function runResumeCycle(
  dependencies: ResumeCycleDependencies,
): Promise<Result<readonly ResumeJobOutcome[], DomainError>> {
  const records = await dependencies.progress.listForProject(dependencies.project.id);
  if (!records.ok) return records;
  const resumable = records.value.filter((record) => resumableStageKinds.has(record.stage.kind));

  const outcomes: ResumeJobOutcome[] = [];
  for (const record of resumable) {
    outcomes.push(await resumeOneJob(record, dependencies));
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
  if (currentChangeRequest.value.state === "merged") {
    return finishMerged(record, deps, changeRequestId, currentChangeRequest.value.headSha);
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
    return transitionOrReport(deps, record, { stage: { kind: "merging" } }, () => ({
      jobId: record.jobId,
      outcome: "still_merging",
    }));
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

  const git = deps.gitForBaseRevision ?? new LocalGitAdapter();
  const repository = await git.inspectRepository({ rootPath: deps.project.localRepositoryPath });
  if (!repository.ok) {
    return requiresManualUnlessRetryable(
      record,
      deps,
      "base_revision_unavailable",
      repository.error,
      requiresManualCause("setup", "base_revision_unavailable"),
    );
  }

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
    baseRevision: repository.value.headSha,
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
  if (enabled.state !== "enabled") {
    return enabled.state === "failed"
      ? requiresManualUnlessRetryable(
          record,
          deps,
          `auto_merge_not_enabled:${enabled.state}`,
          enabled.error,
          requiresManualCause("review", "auto_merge_not_enabled"),
        )
      : requiresManual(
          record,
          deps,
          `auto_merge_not_enabled:${enabled.state}`,
          requiresManualCause("review", "auto_merge_not_enabled"),
        );
  }
  if (enabled.changeRequest.state === "merged") {
    return finishMerged(record, deps, context.changeRequestId, enabled.changeRequest.headSha);
  }
  return transitionOrReport(deps, record, { stage: { kind: "merging" } }, () => ({
    jobId: record.jobId,
    outcome: "merging",
  }));
}

async function finishMerged(
  record: JobProgressRecord,
  deps: ResumeCycleDependencies,
  changeRequestId: string,
  mergedHeadSha: string,
): Promise<ResumeJobOutcome> {
  const outcome = await deps.lifecycle.run({
    project: deps.project,
    externalIssueId: record.externalIssueId,
    changeRequestId,
    mergeAuthorizationHeadSha: mergedHeadSha,
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
  return transitionOrReport(deps, record, { stage: { kind: "completed" } }, () => ({
    jobId: record.jobId,
    outcome: "completed",
  }));
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
