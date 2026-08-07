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
  ReviewStatusCoordinator,
  AutoMergeGate,
  LifecyclePipeline,
} from "../../application/pipelines/index.js";
import type { TrustedProjectConfig } from "../../application/projects/index.js";
import type { SourceControlPort } from "../../application/ports/index.js";
import { ok, type Clock, type DomainError, type Result } from "../../domain/foundation/index.js";
import { createRequirementSnapshot, headShaSchema } from "../../domain/review/index.js";
import { checkpointIdSchema } from "../../domain/checkpoint/index.js";
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
} from "../../adapters/dispatch/job-progress-store.js";
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
 * job (unbuilt, out of scope), not this one. Terminal stages (`"completed"`/`"failed"`) and
 * fail-closed ones (`"paused"`/`"requires_manual"`) are excluded because nothing here auto-resumes
 * a checkpoint or a human-handoff marker. */
export const resumableStageKinds: ReadonlySet<string> = new Set([
  "ci_waiting",
  "awaiting_review",
  "fix_round",
  "merging",
]);

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
  | Readonly<{ jobId: string; outcome: "failed"; stage: string; error: DomainError }>;

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

async function requiresManual(
  record: JobProgressRecord,
  deps: ResumeCycleDependencies,
  reason: string,
): Promise<ResumeJobOutcome> {
  await transition(deps.progress, record, { stage: { kind: "requires_manual" } });
  return { jobId: record.jobId, outcome: "requires_manual", reason };
}

async function resumeUnderLease(
  record: JobProgressRecord,
  deps: ResumeCycleDependencies,
): Promise<ResumeJobOutcome> {
  if (record.changeRequestId === undefined) {
    return requiresManual(record, deps, "missing_change_request_id");
  }
  const changeRequestId = record.changeRequestId;
  const changeRequestReference = { project: deps.project, changeRequestId };
  const currentChangeRequest = await deps.sourceControl.getChangeRequest(changeRequestReference);
  if (!currentChangeRequest.ok) {
    return requiresManual(record, deps, "change_request_read_failed");
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
    return requiresManual(record, deps, "change_request_state_mismatch");
  }
  if (currentChangeRequest.value.state === "closed") {
    return requiresManual(record, deps, "change_request_closed");
  }

  if (record.stage.kind === "merging") {
    await transition(deps.progress, record, { stage: { kind: "merging" } });
    return { jobId: record.jobId, outcome: "still_merging" };
  }

  const jobs = await deps.jobRepository.readAll();
  if (!jobs.ok) return requiresManual(record, deps, "job_read_failed");
  const job = jobs.value.find((candidate) => candidate.id === record.jobId);
  if (job === undefined) return requiresManual(record, deps, "job_not_found");

  const issue = await projectIssueByExternalId(
    deps.project,
    deps.readModel,
    deps.teamId,
    deps.linearProjectId,
    record.externalIssueId,
  );
  if (!issue.ok) return requiresManual(record, deps, "issue_projection_failed");
  const requirementSnapshot = createRequirementSnapshot(issue.value, deps.clock.now());
  if (!requirementSnapshot.ok) return requiresManual(record, deps, "requirement_snapshot_invalid");

  const git = deps.gitForBaseRevision ?? new LocalGitAdapter();
  const repository = await git.inspectRepository({ rootPath: deps.project.localRepositoryPath });
  if (!repository.ok) return requiresManual(record, deps, "base_revision_unavailable");

  const worktree = {
    repositoryRoot: deps.project.localRepositoryPath,
    path: record.worktreePath,
    branch: record.branch,
    headSha: currentChangeRequest.value.headSha,
  };
  const idempotencyKeyPrefix = `cli-dispatch-resume:${record.jobId}:${String(record.revision)}`;

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
    deadlineAt: deps.clock.now(),
    idempotencyKeyPrefix: `${idempotencyKeyPrefix}:ci-recovery`,
  });

  switch (ciOutcome.state) {
    case "ci_waiting": {
      const headSha = parsedHeadSha(ciOutcome.checks.headSha);
      if (headSha === undefined) return requiresManual(record, deps, "invalid_head_sha");
      await transition(deps.progress, record, { stage: { kind: "ci_waiting" }, headSha });
      return { jobId: record.jobId, outcome: "still_ci_waiting" };
    }
    case "repair_pushed": {
      const headSha = parsedHeadSha(ciOutcome.commit.sha);
      if (headSha === undefined) return requiresManual(record, deps, "invalid_head_sha");
      await transition(deps.progress, record, { stage: { kind: "ci_waiting" }, headSha });
      return { jobId: record.jobId, outcome: "repair_pushed" };
    }
    case "checkpointed": {
      const checkpointId = parsedCheckpointId(ciOutcome.checkpointId);
      if (checkpointId === undefined) return requiresManual(record, deps, "invalid_checkpoint_id");
      await transition(deps.progress, record, { stage: { kind: "paused", checkpointId } });
      return { jobId: record.jobId, outcome: "checkpointed", checkpointId: ciOutcome.checkpointId };
    }
    case "paused":
      return requiresManual(record, deps, `ci_recovery_paused:${ciOutcome.reason}`);
    case "failed":
      await transition(deps.progress, record, { stage: { kind: "requires_manual" } });
      return {
        jobId: record.jobId,
        outcome: "failed",
        stage: ciOutcome.stage,
        error: ciOutcome.error,
      };
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
  if (begin.state === "failed") return requiresManual(record, deps, "review_begin_failed");
  if (begin.state === "not_ready") {
    await transition(deps.progress, record, { stage: { kind: "ci_waiting" } });
    return { jobId: record.jobId, outcome: "still_ci_waiting" };
  }
  if (begin.state === "already_approved") {
    // Disclosed limitation (see file header): this resume path never leaves a job in a state
    // that should reach commit-only-change reuse -- fail closed rather than guess at an approval
    // this code has no fresh evidence for.
    return requiresManual(record, deps, "already_approved_reuse_unimplemented");
  }

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
    deadlineAt: deps.clock.now(),
    idempotencyKeyPrefix: `${context.idempotencyKeyPrefix}:review`,
  });

  switch (reviewOutcome.state) {
    case "not_ready": {
      await transition(deps.progress, record, { stage: { kind: "ci_waiting" } });
      return { jobId: record.jobId, outcome: "still_ci_waiting" };
    }
    case "checkpointed": {
      const checkpointId = parsedCheckpointId(reviewOutcome.checkpointId);
      if (checkpointId === undefined) return requiresManual(record, deps, "invalid_checkpoint_id");
      await transition(deps.progress, record, { stage: { kind: "paused", checkpointId } });
      return {
        jobId: record.jobId,
        outcome: "checkpointed",
        checkpointId: reviewOutcome.checkpointId,
      };
    }
    case "paused":
      return requiresManual(record, deps, `review_paused:${reviewOutcome.reason}`);
    case "failed":
      await transition(deps.progress, record, { stage: { kind: "requires_manual" } });
      return {
        jobId: record.jobId,
        outcome: "failed",
        stage: reviewOutcome.stage,
        error: reviewOutcome.error,
      };
    case "changes_requested":
    case "clarification_required": {
      const record$ = await deps.reviewStatus.record({
        project: deps.project,
        changeRequestId: context.changeRequestId,
        expectedHeadSha,
        idempotencyKeyPrefix: `${context.idempotencyKeyPrefix}:review-record`,
        decision: reviewOutcome,
      });
      if (record$.state === "failed") return requiresManual(record, deps, "review_record_failed");
      await transition(deps.progress, record, { stage: { kind: "fix_round" } });
      return { jobId: record.jobId, outcome: "fix_round", verdict: reviewOutcome.state };
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
    return requiresManual(record, deps, "review_record_did_not_approve");
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
    return requiresManual(record, deps, `auto_merge_not_enabled:${enabled.state}`);
  }
  if (enabled.changeRequest.state === "merged") {
    return finishMerged(record, deps, context.changeRequestId, enabled.changeRequest.headSha);
  }
  await transition(deps.progress, record, { stage: { kind: "merging" } });
  return { jobId: record.jobId, outcome: "merging" };
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
    return requiresManual(record, deps, `lifecycle_not_completed:${outcome.state}`);
  }
  await transition(deps.progress, record, { stage: { kind: "completed" } });
  return { jobId: record.jobId, outcome: "completed" };
}

export function buildJobProgressStore(agentTeamHome: string): FileJobProgressStore {
  return new FileJobProgressStore(defaultJobProgressDirectory(agentTeamHome));
}
