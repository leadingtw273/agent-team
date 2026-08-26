import type {
  FileJobProgressStore,
  JobProgressRecord,
  JobProgressRecordMutation,
} from "../../adapters/dispatch/job-progress-store.js";
import type { IssueAdmissionPort } from "../../adapters/dispatch/issue-admission-store.js";
import type { WorkManagementPort } from "../../application/ports/index.js";
import {
  WorkStatusLifecycleCoordinator,
  createWorkStatusLifecycleTransitionInstance,
  type ImplementerPipeline,
  type ImplementerPipelineOutcome,
} from "../../application/pipelines/index.js";
import type { TrustedProjectConfig } from "../../application/projects/index.js";
import {
  domainError,
  type Clock,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import { consumeAttempt, type Job } from "../../domain/jobs/index.js";
import type { Project } from "../../domain/project/index.js";
import type { Issue } from "../../domain/project/index.js";
import { checkpointIdSchema } from "../../domain/checkpoint/index.js";
import { headShaSchema, sha256Digest, type HeadSha } from "../../domain/review/index.js";
import type { ResumeJobRepository } from "./resume-composition.js";
import type { ResumeJobOutcome } from "./resume-composition.js";
import {
  buildImplementerPipelineRequest,
  type BuildImplementerPipelineRequestOptions,
} from "./implementer-request.js";
import type { AuthoritativeBaseRevision, AuthoritativeBaseFailure } from "./authoritative-base.js";

type LifecycleWorkManagement = Pick<
  WorkManagementPort,
  "getIssue" | "setWorkStatus" | "setAgentCondition" | "clearAgentCondition"
>;

export interface PrePrImplementationCoordinatorDependencies {
  readonly agentTeamHome: string;
  readonly project: Project;
  readonly trustedConfig: TrustedProjectConfig;
  readonly progress: FileJobProgressStore;
  readonly jobs: ResumeJobRepository;
  readonly admission: Pick<IssueAdmissionPort, "load">;
  readonly workManagement: LifecycleWorkManagement;
  readonly resolveRequirementIssue: (
    externalIssueId: string,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<Result<Issue, DomainError>>;
  readonly workStatus: WorkStatusLifecycleCoordinator;
  /** Publishes and read-backs the public Job seed before any managed provider mutation. */
  readonly ensureJobStarted?: (record: JobProgressRecord) => Promise<Result<void, DomainError>>;
  readonly bindPullRequest?: (
    record: JobProgressRecord,
    prNumber: number,
    headSha: string,
  ) => Promise<Result<JobProgressRecord, DomainError>>;
  readonly clock: Clock;
  readonly ensureWorktreeDirectory: () => Promise<Result<void, DomainError>>;
  readonly buildPipeline: () => Promise<
    | Readonly<{ state: "ready"; value: Pick<ImplementerPipeline, "run"> }>
    | Readonly<{ state: "blocked"; reason: string }>
  >;
  readonly resolveAuthoritativeBase: (
    project: Project,
    options: Readonly<{ idempotencyKey: string; signal?: AbortSignal }>,
  ) => Promise<Result<AuthoritativeBaseRevision, AuthoritativeBaseFailure>>;
}

function mutation(record: JobProgressRecord): JobProgressRecordMutation {
  return {
    jobId: record.jobId,
    projectId: record.projectId,
    issueId: record.issueId,
    externalIssueId: record.externalIssueId,
    model: record.model,
    ...(record.providerAssignments === undefined
      ? {}
      : { providerAssignments: record.providerAssignments }),
    ...(record.skillSnapshots === undefined ? {} : { skillSnapshots: record.skillSnapshots }),
    stage: record.stage,
    branch: record.branch,
    worktreePath: record.worktreePath,
    ...(record.protectedRegionHandoff === undefined
      ? {}
      : { protectedRegionHandoff: record.protectedRegionHandoff }),
    ...(record.changeRequestId === undefined ? {} : { changeRequestId: record.changeRequestId }),
    ...(record.headSha === undefined ? {} : { headSha: record.headSha }),
    ...(record.mergeMutations === undefined ? {} : { mergeMutations: record.mergeMutations }),
    ...(record.baseRevision === undefined ? {} : { baseRevision: record.baseRevision }),
    ...(record.reviewerReplay === undefined ? {} : { reviewerReplay: record.reviewerReplay }),
    ...(record.previousReviewerReplay === undefined
      ? {}
      : { previousReviewerReplay: record.previousReviewerReplay }),
    ...(record.workStatusLifecycle === undefined
      ? {}
      : { workStatusLifecycle: record.workStatusLifecycle }),
    ...(record.humanDelivery === undefined ? {} : { humanDelivery: record.humanDelivery }),
    ...(record.controlFence === undefined ? {} : { controlFence: record.controlFence }),
    ...(record.mutationAttempts === undefined
      ? {}
      : { mutationAttempts: record.mutationAttempts }),
  };
}

async function requiresManual(
  progress: FileJobProgressStore,
  record: JobProgressRecord,
  reasonCode:
    | "bootstrap_incomplete"
    | "pre_pr_identity_unrecoverable"
    | "process_recovery_exhausted"
    | "implementer_composition_blocked"
    | "implementer_pipeline_failed"
    | "authoritative_base_unavailable"
    | "worktree_directory_unavailable"
    | "invalid_base_revision"
    | "invalid_head_sha"
    | "invalid_checkpoint_id",
  evidence: Partial<Pick<JobProgressRecordMutation, "changeRequestId" | "headSha">> = {},
): Promise<ResumeJobOutcome> {
  const written = await progress.compareAndSwap(record.jobId, record.revision, {
    ...mutation(record),
    ...evidence,
    stage: {
      kind: "requires_manual",
      cause: { stage: "dispatch", reasonCode, attempts: { count: 1 } },
    },
  });
  return written.ok
    ? { jobId: record.jobId, outcome: "requires_manual", reason: reasonCode }
    : { jobId: record.jobId, outcome: "progress_write_failed", error: written.error };
}

async function uniqueJob(
  repository: ResumeJobRepository,
  record: JobProgressRecord,
): Promise<Result<Job, DomainError>> {
  const jobs = await repository.readAll();
  if (!jobs.ok) return jobs;
  const matches = jobs.value.filter(
    (job) =>
      job.id === record.jobId &&
      job.projectId === record.projectId &&
      job.issueId === record.issueId,
  );
  return matches.length === 1 && matches[0] !== undefined
    ? { ok: true, value: matches[0] }
    : { ok: false, error: domainError("conflict") };
}

export class PrePrImplementationCoordinator {
  constructor(readonly dependencies: PrePrImplementationCoordinatorDependencies) {}

  async run(
    initialRecord: JobProgressRecord,
    options: Readonly<{
      holderId: string;
      signal?: AbortSignal;
      onPipelineOutcome?: (outcome: ImplementerPipelineOutcome) => void;
    }>,
  ): Promise<ResumeJobOutcome> {
    if (
      initialRecord.workStatusLifecycle === undefined ||
      (initialRecord.stage.kind !== "work_start_pending" &&
        !(
          initialRecord.stage.kind === "implementing" &&
          initialRecord.stage.executionEpoch?.ordinal === 1 &&
          initialRecord.stage.executionEpoch.providerOutput === "none" &&
          initialRecord.baseRevision !== undefined
        ))
    ) {
      return requiresManual(
        this.dependencies.progress,
        initialRecord,
        "pre_pr_identity_unrecoverable",
      );
    }

    if (this.dependencies.ensureJobStarted !== undefined) {
      const started = await this.dependencies.ensureJobStarted(initialRecord);
      if (!started.ok) {
        return requiresManual(
          this.dependencies.progress,
          initialRecord,
          "pre_pr_identity_unrecoverable",
        );
      }
      const refreshed = await this.dependencies.progress.load(initialRecord.jobId);
      if (!refreshed.ok || refreshed.value === undefined) {
        return {
          jobId: initialRecord.jobId,
          outcome: "transient_failure",
          reason: "job_progress_read_failed",
          error: refreshed.ok ? domainError("not_found") : refreshed.error,
        };
      }
      initialRecord = refreshed.value;
    }
    const workStatusLifecycle = initialRecord.workStatusLifecycle;
    if (workStatusLifecycle === undefined) {
      return requiresManual(
        this.dependencies.progress,
        initialRecord,
        "pre_pr_identity_unrecoverable",
      );
    }

    const loadedJob = await uniqueJob(this.dependencies.jobs, initialRecord);
    if (!loadedJob.ok) {
      return requiresManual(
        this.dependencies.progress,
        initialRecord,
        "pre_pr_identity_unrecoverable",
      );
    }
    // The dispatch candidate passed by the caller is useful context, but it is not authority.
    // Always read Linear here so a cancellation or identity drift between admission and execution
    // cannot be hidden by the in-memory candidate.
    const readOptions = options.signal === undefined ? undefined : { signal: options.signal };
    const [issue, requirementIssue] = await Promise.all([
      this.dependencies.workManagement.getIssue(
        { project: this.dependencies.project, externalIssueId: initialRecord.externalIssueId },
        readOptions,
      ),
      this.dependencies.resolveRequirementIssue(initialRecord.externalIssueId, readOptions),
    ]);
    if (
      !issue.ok ||
      !requirementIssue.ok ||
      issue.value.issue.id !== initialRecord.issueId ||
      issue.value.issue.projectId !== initialRecord.projectId ||
      issue.value.issue.externalId !== initialRecord.externalIssueId ||
      requirementIssue.value.id !== initialRecord.issueId ||
      requirementIssue.value.projectId !== initialRecord.projectId ||
      requirementIssue.value.externalId !== initialRecord.externalIssueId
    ) {
      return requiresManual(
        this.dependencies.progress,
        initialRecord,
        "pre_pr_identity_unrecoverable",
      );
    }

    const recovering = initialRecord.stage.kind === "implementing";
    let job = loadedJob.value;

    let baseRevision: HeadSha | undefined = initialRecord.baseRevision;
    if (baseRevision === undefined) {
      const resolved = await this.dependencies.resolveAuthoritativeBase(this.dependencies.project, {
        idempotencyKey: `pre-pr:${job.id}:authoritative-base`,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (!resolved.ok) {
        const persisted = await requiresManual(
          this.dependencies.progress,
          initialRecord,
          "authoritative_base_unavailable",
        );
        return persisted.outcome === "requires_manual"
          ? { ...persisted, reason: resolved.error.reason }
          : persisted;
      }
      const parsed = headShaSchema.safeParse(resolved.value.baseRevision);
      if (!parsed.success) {
        return requiresManual(this.dependencies.progress, initialRecord, "invalid_base_revision");
      }
      baseRevision = parsed.data;
    }

    const authorityDigest = sha256Digest({ schemaVersion: 1, jobId: job.id, executionEpoch: 1 });
    const transitionInstance = authorityDigest.ok
      ? createWorkStatusLifecycleTransitionInstance({
          jobId: job.id,
          step: "work_start",
          mainTarget: "in_progress",
          allowedMainSources: ["ready", "in_progress"],
          agentTarget: { kind: "set", status: "executing" },
          authorityDigest: authorityDigest.value,
        })
      : authorityDigest;
    const invocationDigest = sha256Digest({
      schemaVersion: 1,
      operation: "pre-pr-work-start",
      jobId: job.id,
      executionEpoch: recovering ? 2 : 1,
      checkpointRevision: initialRecord.revision,
    });
    if (!transitionInstance.ok || !invocationDigest.ok) {
      return requiresManual(
        this.dependencies.progress,
        initialRecord,
        "pre_pr_identity_unrecoverable",
      );
    }
    const workStart = await this.dependencies.workStatus.transition({
      jobId: job.id,
      reference: {
        project: this.dependencies.project,
        externalIssueId: initialRecord.externalIssueId,
      },
      holderId: options.holderId,
      mode: workStatusLifecycle.admissionMode,
      ...(workStatusLifecycle.capabilityDigest === undefined
        ? {}
        : { capabilityDigest: workStatusLifecycle.capabilityDigest }),
      phase: "work_start",
      step: "work_start",
      transitionInstance: transitionInstance.value,
      invocationDigest: invocationDigest.value,
      mainTarget: "in_progress",
      allowedMainSources: ["ready", "in_progress"],
      agentTarget: { kind: "set", status: "executing" },
    });
    if (workStart.state !== "permitted") {
      const current = await this.dependencies.progress.load(job.id);
      if (!current.ok || current.value === undefined) {
        return {
          jobId: job.id,
          outcome: "transient_failure",
          reason: "work_status_progress_read_failed",
          error: current.ok ? domainError("not_found") : current.error,
        };
      }
      const incident = current.value.workStatusLifecycle?.incident?.reasonCode;
      const retryable =
        (workStart.reason === "provider_outage" || workStart.reason === "main_unconfirmed") &&
        workStart.error?.retryable === true &&
        incident !== "mutation_unconfirmed" &&
        incident !== "retry_exhausted";
      if (!retryable) {
        return requiresManual(
          this.dependencies.progress,
          current.value,
          "pre_pr_identity_unrecoverable",
        );
      }
      return {
        jobId: job.id,
        outcome: "transient_failure",
        reason: `work_status_${workStart.reason}`,
        error: workStart.error ?? domainError("conflict"),
      };
    }

    if (recovering) {
      const consumed = consumeAttempt(job.attempts, "processRecoveries");
      if (!consumed.ok) {
        return requiresManual(
          this.dependencies.progress,
          initialRecord,
          "process_recovery_exhausted",
        );
      }
      job = Object.freeze({ ...job, attempts: consumed.value });
      const saved = await this.dependencies.jobs.update(job, {
        idempotencyKey: `pre-pr:${job.id}:consume-process-recovery:${String(consumed.value.processRecoveries)}`,
      });
      if (!saved.ok || saved.value.durability !== "confirmed") {
        return {
          jobId: initialRecord.jobId,
          outcome: "transient_failure",
          reason: "process_recovery_persistence_failed",
          error: saved.ok ? domainError("external_failure") : saved.error,
        };
      }
    }

    const beforeProvider = await this.dependencies.progress.load(job.id);
    if (!beforeProvider.ok || beforeProvider.value === undefined) {
      return {
        jobId: job.id,
        outcome: "transient_failure",
        reason: "job_progress_read_failed",
        error: beforeProvider.ok ? domainError("not_found") : beforeProvider.error,
      };
    }
    const epochOrdinal = recovering ? 2 : 1;
    const lifecycleCheckpoint = beforeProvider.value.workStatusLifecycle;
    if (lifecycleCheckpoint === undefined) {
      return requiresManual(
        this.dependencies.progress,
        beforeProvider.value,
        "pre_pr_identity_unrecoverable",
      );
    }
    const armed = await this.dependencies.progress.compareAndSwap(
      job.id,
      beforeProvider.value.revision,
      {
        ...mutation(beforeProvider.value),
        stage: {
          kind: "implementing",
          executionEpoch: {
            ordinal: epochOrdinal,
            providerOutput: "none",
            startedAt: this.dependencies.clock.now(),
          },
        },
        baseRevision,
        workStatusLifecycle: {
          ...lifecycleCheckpoint,
          phase: "implementing",
        },
      },
    );
    if (!armed.ok) {
      return { jobId: job.id, outcome: "progress_write_failed", error: armed.error };
    }

    const worktrees = await this.dependencies.ensureWorktreeDirectory();
    if (!worktrees.ok) {
      return requiresManual(
        this.dependencies.progress,
        armed.value,
        "worktree_directory_unavailable",
      );
    }
    const pipeline = await this.dependencies.buildPipeline();
    if (pipeline.state !== "ready") {
      const persisted = await requiresManual(
        this.dependencies.progress,
        armed.value,
        "implementer_composition_blocked",
      );
      return persisted.outcome === "requires_manual"
        ? { ...persisted, reason: pipeline.reason }
        : persisted;
    }

    // This is the last authority boundary before Provider. Re-read every durable identity after
    // worktree/pipeline composition, because either operation may take long enough for a human,
    // webhook, or another process to cancel the issue or supersede the claim. A mismatch is a
    // permanent hand-off, never a reason to invoke Provider optimistically.
    const [providerProgress, providerIssue, providerClaim, providerJob, providerRequirementIssue] =
      await Promise.all([
        this.dependencies.progress.load(job.id),
        this.dependencies.workManagement.getIssue(
          { project: this.dependencies.project, externalIssueId: initialRecord.externalIssueId },
          readOptions,
        ),
        this.dependencies.admission.load(initialRecord.projectId, initialRecord.issueId),
        uniqueJob(this.dependencies.jobs, armed.value),
        this.dependencies.resolveRequirementIssue(initialRecord.externalIssueId, readOptions),
      ]);
    if (
      !providerProgress.ok ||
      providerProgress.value === undefined ||
      !providerIssue.ok ||
      !providerClaim.ok ||
      providerClaim.value === undefined ||
      !providerJob.ok ||
      !providerRequirementIssue.ok
    ) {
      return {
        jobId: job.id,
        outcome: "transient_failure",
        reason: "pre_pr_authority_read_failed",
        error: !providerProgress.ok
          ? providerProgress.error
          : !providerIssue.ok
            ? providerIssue.error
            : !providerClaim.ok
              ? providerClaim.error
              : !providerJob.ok
                ? providerJob.error
                : !providerRequirementIssue.ok
                  ? providerRequirementIssue.error
                  : domainError("not_found"),
      };
    }
    const current = providerProgress.value;
    const currentIssue = providerIssue.value;
    const claim = providerClaim.value;
    const enforce = workStatusLifecycle.admissionMode === "enforce";
    const invalidAuthority =
      current.revision !== armed.value.revision ||
      current.projectId !== initialRecord.projectId ||
      current.issueId !== initialRecord.issueId ||
      current.externalIssueId !== initialRecord.externalIssueId ||
      current.stage.kind !== "implementing" ||
      current.stage.executionEpoch?.ordinal !== epochOrdinal ||
      current.stage.executionEpoch.providerOutput !== "none" ||
      currentIssue.issue.id !== initialRecord.issueId ||
      currentIssue.issue.projectId !== initialRecord.projectId ||
      currentIssue.issue.externalId !== initialRecord.externalIssueId ||
      providerRequirementIssue.value.id !== initialRecord.issueId ||
      providerRequirementIssue.value.projectId !== initialRecord.projectId ||
      providerRequirementIssue.value.externalId !== initialRecord.externalIssueId ||
      currentIssue.archivedAt !== undefined ||
      currentIssue.trashed === true ||
      currentIssue.workStatus === "canceled" ||
      (enforce && currentIssue.workStatus !== "in_progress") ||
      claim.state !== "active" ||
      claim.projectId !== initialRecord.projectId ||
      claim.issueId !== initialRecord.issueId ||
      claim.externalIssueId !== initialRecord.externalIssueId ||
      claim.jobId !== job.id ||
      providerJob.value.id !== job.id;
    if (invalidAuthority) {
      return requiresManual(this.dependencies.progress, current, "pre_pr_identity_unrecoverable");
    }

    const requestOptions: BuildImplementerPipelineRequestOptions = {
      job: providerJob.value,
      issue: providerRequirementIssue.value,
      project: this.dependencies.project,
      trustedConfig: this.dependencies.trustedConfig,
      model: current.model,
      agentTeamHome: this.dependencies.agentTeamHome,
      clock: this.dependencies.clock,
      baseRevision,
      ...(current.skillSnapshots?.implementer === undefined
        ? {}
        : { skillSnapshot: current.skillSnapshots.implementer }),
    };
    const request = buildImplementerPipelineRequest(requestOptions);
    if (!request.ok) {
      return requiresManual(this.dependencies.progress, current, "pre_pr_identity_unrecoverable");
    }
    const pipelineOutcome = await pipeline.value.run({
      ...request.value,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    options.onPipelineOutcome?.(pipelineOutcome);

    const afterProvider = await this.dependencies.progress.load(job.id);
    if (!afterProvider.ok || afterProvider.value === undefined) {
      return {
        jobId: job.id,
        outcome: "transient_failure",
        reason: "job_progress_read_failed",
        error: afterProvider.ok ? domainError("not_found") : afterProvider.error,
      };
    }
    if (
      afterProvider.value.stage.kind !== "implementing" ||
      afterProvider.value.stage.executionEpoch?.ordinal !== epochOrdinal ||
      afterProvider.value.stage.executionEpoch.providerOutput !== "none"
    ) {
      return {
        jobId: job.id,
        outcome: "progress_write_failed",
        error: domainError("conflict"),
      };
    }
    const outputConfirmed = await this.dependencies.progress.compareAndSwap(
      job.id,
      afterProvider.value.revision,
      {
        ...mutation(afterProvider.value),
        stage: {
          kind: "implementing",
          executionEpoch: {
            ...afterProvider.value.stage.executionEpoch,
            providerOutput: "confirmed",
          },
        },
      },
    );
    if (!outputConfirmed.ok) {
      return { jobId: job.id, outcome: "progress_write_failed", error: outputConfirmed.error };
    }
    return this.#persistOutcome(outputConfirmed.value, pipelineOutcome, baseRevision);
  }

  async #persistOutcome(
    record: JobProgressRecord,
    outcome: ImplementerPipelineOutcome,
    baseRevision: HeadSha,
  ): Promise<ResumeJobOutcome> {
    if (outcome.state === "ci_waiting") {
      const head = headShaSchema.safeParse(outcome.commit.sha);
      if (!head.success) {
        return requiresManual(this.dependencies.progress, record, "invalid_head_sha", {
          changeRequestId: String(outcome.changeRequest.number),
        });
      }
      const written = await this.dependencies.progress.compareAndSwap(
        record.jobId,
        record.revision,
        {
          ...mutation(record),
          stage: { kind: "ci_waiting" },
          changeRequestId: String(outcome.changeRequest.number),
          headSha: head.data,
          baseRevision,
        },
      );
      if (!written.ok) {
        return { jobId: record.jobId, outcome: "progress_write_failed", error: written.error };
      }
      if (this.dependencies.bindPullRequest !== undefined) {
        const bound = await this.dependencies.bindPullRequest(
          written.value,
          outcome.changeRequest.number,
          head.data,
        );
        if (!bound.ok) {
          const current = await this.dependencies.progress.load(record.jobId);
          if (!current.ok || current.value === undefined) {
            return {
              jobId: record.jobId,
              outcome: "transient_failure",
              reason: "job_progress_read_failed",
              error: current.ok ? domainError("not_found") : current.error,
            };
          }
          return requiresManual(
            this.dependencies.progress,
            current.value,
            "pre_pr_identity_unrecoverable",
          );
        }
      }
      return { jobId: record.jobId, outcome: "still_ci_waiting" };
    }
    if (outcome.state === "paused") {
      const checkpoint =
        outcome.checkpointId === undefined
          ? undefined
          : checkpointIdSchema.safeParse(outcome.checkpointId);
      if (checkpoint !== undefined && !checkpoint.success) {
        return requiresManual(this.dependencies.progress, record, "invalid_checkpoint_id");
      }
      const written = await this.dependencies.progress.compareAndSwap(
        record.jobId,
        record.revision,
        {
          ...mutation(record),
          stage: {
            kind: "paused",
            pauseReason: outcome.reason,
            ...(checkpoint === undefined ? {} : { checkpointId: checkpoint.data }),
          },
        },
      );
      if (!written.ok) {
        return { jobId: record.jobId, outcome: "progress_write_failed", error: written.error };
      }
      return checkpoint === undefined
        ? { jobId: record.jobId, outcome: "requires_manual", reason: outcome.reason }
        : { jobId: record.jobId, outcome: "checkpointed", checkpointId: checkpoint.data };
    }
    return requiresManual(this.dependencies.progress, record, "implementer_pipeline_failed");
  }
}
