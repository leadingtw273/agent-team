import type {
  FileJobProgressStore,
  JobProgressRecord,
  JobProgressRecordMutation,
} from "../../adapters/dispatch/job-progress-store.js";
import type { IssueAdmissionPort } from "../../adapters/dispatch/issue-admission-store.js";
import type { JobRepository } from "../../application/dispatch/index.js";
import type { LeaseCoordinator } from "../../application/leases/index.js";
import {
  createWorkStatusLifecycleTransitionInstance,
  type IssueScopeLockHandle,
  type IssueScopeLockPort,
  type WorkStatusLifecycleCoordinator,
  type WorkStatusLifecycleOutcome,
} from "../../application/pipelines/index.js";
import type { SourceControlPort, WorkManagementPort } from "../../application/ports/index.js";
import type { DomainError } from "../../domain/foundation/index.js";
import type { Project } from "../../domain/project/index.js";
import { sha256Digest } from "../../domain/review/index.js";
import type { FileJobRepository } from "../../infrastructure/jobs/index.js";

type CiResumeJobRepository = JobRepository & Pick<FileJobRepository, "readAll">;
type CiResumeWorkManagement = Pick<WorkManagementPort, "getIssue">;

export type CiResumeBlockedReason =
  | "job_not_found"
  | "job_not_eligible"
  | "job_identity_mismatch"
  | "claim_mismatch"
  | "change_request_mismatch"
  | "ci_not_successful"
  | "linear_identity_mismatch"
  | "linear_state_mismatch"
  | "lease_conflict"
  | "lock_conflict"
  | "candidate_changed"
  | "lifecycle_transition_failed"
  | "checkpoint_write_failed";

export type CiResumeOutcome =
  | Readonly<{
      state: "ready";
      dryRun: true;
      projectId: string;
      jobId: string;
      headSha: string;
      plannedMutations: readonly [
        "linear-ready",
        "linear-in-progress",
        "ci-waiting-checkpoint",
        "existing-job-resume",
      ];
    }>
  | Readonly<{
      state: "checkpointed";
      dryRun: false;
      projectId: string;
      jobId: string;
      headSha: string;
      revision: number;
    }>
  | Readonly<{ state: "blocked"; jobId: string; reason: CiResumeBlockedReason }>
  | Readonly<{
      state: "failed";
      jobId: string;
      reason: "authoritative_read_failed" | "lock_release_failed" | "lease_release_failed";
      errorCode?: DomainError["code"];
    }>;

export interface CiResumeCoordinatorDependencies {
  readonly project: Project;
  readonly progress: Pick<FileJobProgressStore, "load" | "compareAndSwap">;
  readonly jobs: CiResumeJobRepository;
  readonly admission: Pick<IssueAdmissionPort, "load">;
  readonly leases: Pick<LeaseCoordinator, "acquire" | "release">;
  readonly locks: IssueScopeLockPort;
  readonly workManagement: CiResumeWorkManagement;
  readonly lifecycle: Pick<WorkStatusLifecycleCoordinator, "transitionWhileLockHeld">;
  readonly sourceControl: Pick<SourceControlPort, "getChangeRequest" | "getCommitChecks">;
}

interface RecoveryIdentity {
  readonly clearInstance: string;
  readonly workStartInstance: string;
}

interface Admission {
  readonly record: JobProgressRecord;
  readonly claimRevision: number;
  readonly identity: RecoveryIdentity;
}

function mutationFrom(record: JobProgressRecord): JobProgressRecordMutation {
  const {
    schemaVersion: _schemaVersion,
    revision: _revision,
    updatedAt: _updatedAt,
    ...mutation
  } = record;
  void _schemaVersion;
  void _revision;
  void _updatedAt;
  return mutation;
}

function blocked(jobId: string, reason: CiResumeBlockedReason): CiResumeOutcome {
  return Object.freeze({ state: "blocked", jobId, reason });
}

function failed(
  jobId: string,
  reason: Extract<CiResumeOutcome, { state: "failed" }>["reason"],
  errorCode?: DomainError["code"],
): CiResumeOutcome {
  return Object.freeze({
    state: "failed",
    jobId,
    reason,
    ...(errorCode === undefined ? {} : { errorCode }),
  });
}

function recoveryIdentity(record: JobProgressRecord): RecoveryIdentity | undefined {
  const checkpoint = record.workStatusLifecycle;
  const manualTransition = [...(checkpoint?.transitions ?? [])]
    .reverse()
    .find(
      (transition) =>
        transition.step === "requires_manual" &&
        transition.mainTarget === "requires_manual" &&
        transition.main.state === "confirmed",
    );
  if (
    checkpoint?.admissionMode !== "enforce" ||
    checkpoint.capabilityDigest === undefined ||
    manualTransition === undefined ||
    record.changeRequestId === undefined ||
    record.headSha === undefined
  ) {
    return undefined;
  }
  const authority = sha256Digest({
    schemaVersion: 1,
    operation: "exact-job-ci-resume",
    jobId: record.jobId,
    projectId: record.projectId,
    issueId: record.issueId,
    externalIssueId: record.externalIssueId,
    changeRequestId: record.changeRequestId,
    branch: record.branch,
    headSha: record.headSha,
    manualTransitionInstance: manualTransition.instance,
  });
  if (!authority.ok) return undefined;
  const clear = createWorkStatusLifecycleTransitionInstance({
    jobId: record.jobId,
    step: "clear_condition",
    mainTarget: "ready",
    allowedMainSources: ["requires_manual"],
    agentTarget: { kind: "clear" },
    authorityDigest: authority.value,
  });
  const workStart = createWorkStatusLifecycleTransitionInstance({
    jobId: record.jobId,
    step: "work_start",
    mainTarget: "in_progress",
    allowedMainSources: ["ready"],
    agentTarget: { kind: "set", status: "executing" },
    authorityDigest: authority.value,
  });
  if (!clear.ok || !workStart.ok) return undefined;
  return Object.freeze({ clearInstance: clear.value, workStartInstance: workStart.value });
}

function hasTransition(record: JobProgressRecord, instance: string): boolean {
  return (
    record.workStatusLifecycle?.transitions.some(
      (transition) => transition.instance === instance,
    ) === true
  );
}

function lifecycleConfirmed(outcome: WorkStatusLifecycleOutcome): boolean {
  return (
    outcome.state === "permitted" &&
    (outcome.main === "confirmed" || outcome.main === "operator_authorized") &&
    outcome.agent === "confirmed"
  );
}

function hasRecoverableCiManualCause(record: JobProgressRecord): boolean {
  if (record.stage.kind !== "requires_manual") return false;
  const cause = record.stage.cause;
  return (
    (cause?.stage === "ci_recovery" && cause.reasonCode === "ci_recovery_paused") ||
    (cause?.stage === "review" && cause.reasonCode === "ci_failed_after_ready")
  );
}

function isReviewRepairCiManualCause(record: JobProgressRecord): boolean {
  return (
    record.stage.kind === "requires_manual" &&
    record.stage.cause?.stage === "review" &&
    record.stage.cause.reasonCode === "ci_failed_after_ready"
  );
}

export class CiResumeCoordinator {
  constructor(readonly dependencies: CiResumeCoordinatorDependencies) {}

  async #inspect(jobId: string, expectedRevision?: number): Promise<Admission | CiResumeOutcome> {
    const recordRead = await this.dependencies.progress.load(jobId);
    if (!recordRead.ok) {
      return failed(jobId, "authoritative_read_failed", recordRead.error.code);
    }
    const record = recordRead.value;
    if (record === undefined) return blocked(jobId, "job_not_found");
    if (expectedRevision !== undefined && record.revision !== expectedRevision) {
      return blocked(jobId, "candidate_changed");
    }
    if (
      record.projectId !== this.dependencies.project.id ||
      !hasRecoverableCiManualCause(record) ||
      record.changeRequestId === undefined ||
      record.headSha === undefined
    ) {
      return blocked(jobId, "job_not_eligible");
    }
    const identity = recoveryIdentity(record);
    if (identity === undefined) return blocked(jobId, "job_not_eligible");
    const [jobs, claim, changeRequest, checks, issue] = await Promise.all([
      this.dependencies.jobs.readAll(),
      this.dependencies.admission.load(record.projectId, record.issueId),
      this.dependencies.sourceControl.getChangeRequest({
        project: this.dependencies.project,
        changeRequestId: record.changeRequestId,
      }),
      this.dependencies.sourceControl.getCommitChecks(
        { project: this.dependencies.project },
        record.headSha,
      ),
      this.dependencies.workManagement.getIssue({
        project: this.dependencies.project,
        externalIssueId: record.externalIssueId,
      }),
    ]);
    if (!jobs.ok || !claim.ok || !changeRequest.ok || !checks.ok || !issue.ok) {
      const errorCode = !jobs.ok
        ? jobs.error.code
        : !claim.ok
          ? claim.error.code
          : !changeRequest.ok
            ? changeRequest.error.code
            : !checks.ok
              ? checks.error.code
              : !issue.ok
                ? issue.error.code
                : "external_failure";
      return failed(jobId, "authoritative_read_failed", errorCode);
    }
    const matchingJobs = jobs.value.filter(
      (job) =>
        job.id === record.jobId &&
        job.projectId === record.projectId &&
        job.issueId === record.issueId,
    );
    if (matchingJobs.length !== 1) return blocked(jobId, "job_identity_mismatch");
    if (
      claim.value?.state !== "active" ||
      claim.value.jobId !== record.jobId ||
      claim.value.projectId !== record.projectId ||
      claim.value.issueId !== record.issueId ||
      claim.value.externalIssueId !== record.externalIssueId
    ) {
      return blocked(jobId, "claim_mismatch");
    }
    if (
      changeRequest.value.state !== "open" ||
      (!changeRequest.value.draft && !isReviewRepairCiManualCause(record)) ||
      changeRequest.value.headBranch !== record.branch ||
      changeRequest.value.headSha.toLowerCase() !== record.headSha.toLowerCase() ||
      changeRequest.value.mergeability === "conflicting" ||
      changeRequest.value.mergeStateStatus === "behind" ||
      changeRequest.value.mergeStateStatus === "dirty"
    ) {
      return blocked(jobId, "change_request_mismatch");
    }
    if (
      checks.value.headSha.toLowerCase() !== record.headSha.toLowerCase() ||
      checks.value.aggregate !== "success" ||
      checks.value.checks.length === 0
    ) {
      return blocked(jobId, "ci_not_successful");
    }
    if (
      issue.value.issue.id !== record.issueId ||
      issue.value.issue.projectId !== record.projectId ||
      issue.value.issue.externalId !== record.externalIssueId ||
      issue.value.issue.agentRole === undefined ||
      issue.value.archivedAt !== undefined ||
      issue.value.trashed === true
    ) {
      return blocked(jobId, "linear_identity_mismatch");
    }
    const clearExists = hasTransition(record, identity.clearInstance);
    const workStartExists = hasTransition(record, identity.workStartInstance);
    const expectedStatuses = workStartExists
      ? (["ready", "in_progress"] as const)
      : clearExists
        ? (["requires_manual", "ready"] as const)
        : (["requires_manual"] as const);
    if (!expectedStatuses.includes(issue.value.workStatus as never)) {
      return blocked(jobId, "linear_state_mismatch");
    }
    return Object.freeze({ record, claimRevision: claim.value.revision, identity });
  }

  async #transition(
    record: JobProgressRecord,
    lock: IssueScopeLockHandle,
    input: Readonly<{
      step: "clear_condition" | "work_start";
      phase: "work_start" | "implementing";
      transitionInstance: string;
      mainTarget: "ready" | "in_progress";
      allowedMainSources: readonly ["requires_manual"] | readonly ["ready"];
      agentTarget:
        { readonly kind: "clear" } | { readonly kind: "set"; readonly status: "executing" };
    }>,
  ): Promise<WorkStatusLifecycleOutcome | undefined> {
    const capabilityDigest = record.workStatusLifecycle?.capabilityDigest;
    if (capabilityDigest === undefined) return undefined;
    const invocation = sha256Digest({
      schemaVersion: 1,
      operation: "exact-job-ci-resume-lifecycle",
      jobId: record.jobId,
      transitionInstance: input.transitionInstance,
      progressRevision: record.revision,
    });
    if (!invocation.ok) return undefined;
    return this.dependencies.lifecycle.transitionWhileLockHeld(
      {
        jobId: record.jobId,
        reference: {
          project: this.dependencies.project,
          externalIssueId: record.externalIssueId,
        },
        holderId: lock.holderId,
        mode: "enforce",
        capabilityDigest,
        phase: input.phase,
        step: input.step,
        transitionInstance: input.transitionInstance,
        invocationDigest: invocation.value,
        mainTarget: input.mainTarget,
        allowedMainSources: input.allowedMainSources,
        agentTarget: input.agentTarget,
      },
      lock,
    );
  }

  async run(
    input: Readonly<{ jobId: string; holderId: string; dryRun: boolean }>,
  ): Promise<CiResumeOutcome> {
    const admitted = await this.#inspect(input.jobId);
    if ("state" in admitted) return admitted;
    if (input.dryRun) {
      return Object.freeze({
        state: "ready",
        dryRun: true,
        projectId: admitted.record.projectId,
        jobId: admitted.record.jobId,
        headSha: admitted.record.headSha ?? "",
        plannedMutations: [
          "linear-ready",
          "linear-in-progress",
          "ci-waiting-checkpoint",
          "existing-job-resume",
        ] as const,
      });
    }

    const lease = await this.dependencies.leases.acquire({
      jobId: admitted.record.jobId,
      issueId: admitted.record.issueId,
      holderId: input.holderId,
    });
    if (!lease.ok) return blocked(input.jobId, "lease_conflict");
    const lock = await this.dependencies.locks.acquire(
      {
        projectId: admitted.record.projectId,
        externalIssueId: admitted.record.externalIssueId,
      },
      input.holderId,
    );
    if (!lock.ok) {
      const released = await this.dependencies.leases.release({
        leaseId: lease.value.value.id,
        holderId: input.holderId,
      });
      return released.ok
        ? blocked(input.jobId, "lock_conflict")
        : failed(input.jobId, "lease_release_failed", released.error.code);
    }

    let result: CiResumeOutcome;
    const currentAdmission = await this.#inspect(input.jobId, admitted.record.revision);
    if ("state" in currentAdmission || currentAdmission.claimRevision !== admitted.claimRevision) {
      result =
        "state" in currentAdmission ? currentAdmission : blocked(input.jobId, "candidate_changed");
    } else {
      let current = currentAdmission.record;
      let mayStart = hasTransition(current, currentAdmission.identity.workStartInstance);
      result = blocked(input.jobId, "candidate_changed");
      if (!mayStart) {
        const cleared = await this.#transition(current, lock.value, {
          step: "clear_condition",
          phase: "work_start",
          transitionInstance: currentAdmission.identity.clearInstance,
          mainTarget: "ready",
          allowedMainSources: ["requires_manual"],
          agentTarget: { kind: "clear" },
        });
        if (cleared === undefined || !lifecycleConfirmed(cleared)) {
          result = blocked(input.jobId, "lifecycle_transition_failed");
        } else {
          const afterClear = await this.dependencies.progress.load(input.jobId);
          if (!afterClear.ok) {
            result = failed(input.jobId, "authoritative_read_failed", afterClear.error.code);
          } else if (afterClear.value === undefined) {
            result = blocked(input.jobId, "candidate_changed");
          } else {
            current = afterClear.value;
            mayStart = true;
          }
        }
      }

      if (mayStart && hasRecoverableCiManualCause(current)) {
        const started = await this.#transition(current, lock.value, {
          step: "work_start",
          phase: "implementing",
          transitionInstance: currentAdmission.identity.workStartInstance,
          mainTarget: "in_progress",
          allowedMainSources: ["ready"],
          agentTarget: { kind: "set", status: "executing" },
        });
        if (started === undefined || !lifecycleConfirmed(started)) {
          result = blocked(input.jobId, "lifecycle_transition_failed");
        } else {
          const afterStart = await this.dependencies.progress.load(input.jobId);
          const claim = await this.dependencies.admission.load(current.projectId, current.issueId);
          if (!afterStart.ok || !claim.ok) {
            const error = !afterStart.ok ? afterStart.error : !claim.ok ? claim.error : undefined;
            result = failed(input.jobId, "authoritative_read_failed", error?.code);
          } else if (
            afterStart.value === undefined ||
            !hasRecoverableCiManualCause(afterStart.value) ||
            claim.value?.state !== "active" ||
            claim.value.jobId !== input.jobId ||
            claim.value.revision !== admitted.claimRevision
          ) {
            result = blocked(input.jobId, "candidate_changed");
          } else {
            const written = await this.dependencies.progress.compareAndSwap(
              input.jobId,
              afterStart.value.revision,
              {
                ...mutationFrom(afterStart.value),
                stage: { kind: "ci_waiting" },
              },
            );
            result = written.ok
              ? Object.freeze({
                  state: "checkpointed" as const,
                  dryRun: false as const,
                  projectId: written.value.projectId,
                  jobId: written.value.jobId,
                  headSha: written.value.headSha ?? "",
                  revision: written.value.revision,
                })
              : blocked(input.jobId, "checkpoint_write_failed");
          }
        }
      }
    }

    const lockReleased = await lock.value.release();
    const leaseReleased = await this.dependencies.leases.release({
      leaseId: lease.value.value.id,
      holderId: input.holderId,
    });
    if (!lockReleased.ok) {
      return failed(input.jobId, "lock_release_failed", lockReleased.error.code);
    }
    if (!leaseReleased.ok) {
      return failed(input.jobId, "lease_release_failed", leaseReleased.error.code);
    }
    return result;
  }
}
