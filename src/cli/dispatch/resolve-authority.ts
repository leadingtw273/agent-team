import { randomUUID } from "node:crypto";

import type { FileJobProgressStore, JobProgressRecord } from "../../adapters/dispatch/index.js";
import type { ChangeRequestSnapshot, SourceControlPort } from "../../application/ports/index.js";
import { LeaseCoordinator } from "../../application/leases/index.js";
import {
  createJobPrLifecycleEvent,
  type LifecyclePipeline,
  parseJobPrLifecycleComment,
  parsePullRequestBackPointer,
  projectPullRequestAuthority,
} from "../../application/pipelines/index.js";
import {
  domainError,
  err,
  ok,
  type Clock,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import type { Project } from "../../domain/project/index.js";
import { jobIdSchema } from "../../domain/jobs/index.js";
import { headShaSchema } from "../../domain/review/index.js";
import type { ResumeJobRepository } from "./resume-composition.js";
import type {
  DispatchResolveAuthorityPort,
  DispatchResolveAuthorityReceipt,
  DispatchResolveInput,
} from "./resolve-handlers.js";
import type { LinearWorkManagementAdapter } from "./work-management-adapter.js";
import { createJobPrAuthorityValidator } from "./job-pr-authority-validator.js";
import {
  FileManagedMutationAuthority,
  fenceSourceControlPort,
  fenceWorkManagementLifecyclePort,
  publishAuthorityConflict,
  rotateJobControlFence,
  type WorkManagementLifecyclePort,
} from "./managed-mutation-authority.js";
import { fencedLifecyclePublisher } from "./job-mutation-runtime.js";

export interface DispatchResolveAuthorityOptions {
  readonly project: Project;
  readonly progress: FileJobProgressStore;
  readonly jobs: ResumeJobRepository;
  readonly leases: LeaseCoordinator;
  readonly workManagement: Pick<
    LinearWorkManagementAdapter,
    "getIssue" | "listComments" | "appendComment"
  >;
  readonly lifecycleWorkManagement?: WorkManagementLifecyclePort;
  readonly sourceControl: SourceControlPort;
  readonly buildLifecycle?: (
    ports: Readonly<{
      sourceControl: SourceControlPort;
      workManagement: WorkManagementLifecyclePort;
    }>,
  ) => Pick<LifecyclePipeline, "run">;
  readonly clock: Clock;
  readonly generateHolderId?: () => string;
}

type ResolveAuthorityMode = "cancellation" | "completion" | "supersede";

function mutationFrom(record: JobProgressRecord) {
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

export class DispatchResolveAuthority implements DispatchResolveAuthorityPort {
  constructor(readonly options: DispatchResolveAuthorityOptions) {}

  async converge(
    record: JobProgressRecord,
    input: DispatchResolveInput,
  ): Promise<Result<DispatchResolveAuthorityReceipt, DomainError>> {
    if (record.projectId !== this.options.project.id) return err(domainError("conflict"));
    const holderId = this.options.generateHolderId?.() ?? `dispatch-resolve:${randomUUID()}`;
    const acquired = await this.options.leases.acquire({
      jobId: record.jobId,
      issueId: record.issueId,
      holderId,
    });
    if (!acquired.ok) return acquired;
    const lease = acquired.value.value;
    let released = false;
    const release = async (): Promise<Result<void, DomainError>> => {
      if (released) return ok(undefined);
      const result = await this.options.leases.release({ leaseId: lease.id, holderId });
      if (result.ok) released = true;
      return result.ok ? ok(undefined) : result;
    };
    const fenced = await rotateJobControlFence(this.options.progress, record, lease);
    if (!fenced.ok) {
      await release();
      return fenced;
    }
    const converged = await this.#convergeUnderLease(fenced.value, input);
    if (!converged.ok) {
      await release();
      return converged;
    }
    return ok(
      "blockedReason" in converged.value
        ? { record: converged.value.record, release, blockedReason: converged.value.blockedReason }
        : { record: converged.value, release },
    );
  }

  async #convergeUnderLease(
    initialRecord: JobProgressRecord,
    input: DispatchResolveInput,
  ): Promise<
    Result<
      | JobProgressRecord
      | Readonly<{
          record: JobProgressRecord;
          blockedReason: "cancellation_after_merge";
        }>,
      DomainError
    >
  > {
    let record = initialRecord;
    const issueRef = { project: this.options.project, externalIssueId: record.externalIssueId };
    const [issue, comments] = await Promise.all([
      this.options.workManagement.getIssue(issueRef),
      this.options.workManagement.listComments(issueRef),
    ]);
    if (!issue.ok) return issue;
    if (!comments.ok) return comments;
    if (
      issue.value.issue.id !== record.issueId ||
      issue.value.issue.projectId !== record.projectId ||
      issue.value.issue.externalId !== record.externalIssueId
    ) {
      return err(domainError("conflict"));
    }
    const completedTakeoverStage =
      (record.stage.kind === "paused" && record.stage.pauseReason === "no_changes") ||
      (record.stage.kind === "requires_manual" &&
        record.stage.cause?.stage === "dispatch" &&
        record.stage.cause.reasonCode === "protected_region_requires_human");
    const completedObsoleteTakeover =
      input.as === "cancelled" &&
      issue.value.workStatus === "completed" &&
      completedTakeoverStage &&
      record.changeRequestId === undefined;
    const authorityMode: ResolveAuthorityMode = completedObsoleteTakeover
      ? "completion"
      : input.as === "cancelled"
        ? "cancellation"
        : "supersede";
    if (
      input.as === "cancelled" &&
      issue.value.workStatus !== "canceled" &&
      !completedObsoleteTakeover
    ) {
      return err(domainError("permission_denied"));
    }
    if (input.as === "superseded" && ["canceled", "completed"].includes(issue.value.workStatus)) {
      return err(domainError("permission_denied"));
    }
    if (completedObsoleteTakeover) {
      const existing = await this.options.sourceControl.findOpenChangeRequestsByHead(
        { project: this.options.project },
        record.branch,
      );
      if (!existing.ok) return existing;
      if (existing.value.length > 0) return err(domainError("permission_denied"));
    }

    let events = comments.value.flatMap((comment) => {
      const event = parseJobPrLifecycleComment(comment.body);
      return event === undefined ? [] : [event];
    });
    if (!events.some((event) => event.kind === "job_started" && event.jobId === record.jobId)) {
      const repaired = await this.#publishJobStarted(record, issueRef, authorityMode);
      if (!repaired.ok) return repaired;
      record = repaired.value;
      const refreshedComments = await this.options.workManagement.listComments(issueRef);
      if (!refreshedComments.ok) return refreshedComments;
      events = refreshedComments.value.flatMap((comment) => {
        const event = parseJobPrLifecycleComment(comment.body);
        return event === undefined ? [] : [event];
      });
    }

    if (record.changeRequestId === undefined) {
      const candidates = await this.options.sourceControl.findOpenChangeRequestsByHead(
        { project: this.options.project },
        record.branch,
      );
      if (!candidates.ok) return candidates;
      // A completed issue and an obsolete pre-implementation Job have separate lifecycles: the
      // issue may stay completed after a Team Lead takeover while the original Job is cancelled.
      // This exception is restricted to no-changes and protected-region dispatch exits, and is
      // safe only while the original Job still has no PR of its own.
      if (completedObsoleteTakeover && candidates.value.length > 0) {
        return err(domainError("permission_denied"));
      }
      if (candidates.value.length > 1) {
        return this.#conflict(record, input, "multiple_pr_candidates", {
          branch: record.branch,
          candidateNumbers: candidates.value.map((candidate) => candidate.number),
        });
      }
      if (candidates.value.length === 0) {
        if (input.as === "superseded") return err(domainError("conflict"));
        return this.#publishTerminal(record, input, authorityMode);
      }
      const candidate = candidates.value[0];
      const candidateHead = headShaSchema.safeParse(candidate?.headSha);
      if (
        candidate === undefined ||
        !candidateHead.success ||
        !this.#matchesOriginalJob(candidate, record)
      ) {
        return this.#conflict(
          record,
          input,
          "pr_identity_mismatch",
          candidate === undefined
            ? { branch: record.branch, candidate: "missing" }
            : {
                branch: record.branch,
                prNumber: candidate.number,
                headBranch: candidate.headBranch,
                headSha: candidate.headSha,
              },
          candidate?.number,
        );
      }
      const attached = await this.options.progress.compareAndSwap(record.jobId, record.revision, {
        ...mutationFrom(record),
        changeRequestId: String(candidate.number),
        headSha: candidateHead.data,
      });
      if (!attached.ok) return attached;
      record = attached.value;
    }

    const changeRequestId = record.changeRequestId;
    if (changeRequestId === undefined) return err(domainError("conflict"));
    const changeRequest = await this.options.sourceControl.getChangeRequest({
      project: this.options.project,
      changeRequestId,
    });
    if (!changeRequest.ok) return changeRequest;
    if (!this.#matchesOriginalJob(changeRequest.value, record)) {
      return this.#conflict(
        record,
        input,
        "pr_identity_mismatch",
        {
          branch: record.branch,
          prNumber: changeRequest.value.number,
          headBranch: changeRequest.value.headBranch,
          headSha: changeRequest.value.headSha,
        },
        changeRequest.value.number,
      );
    }
    let projection = projectPullRequestAuthority(events, changeRequest.value.number);
    if (projection.state === "none" && record.controlFence?.ownershipEpoch === 0) {
      const bound = await this.#publishPrBound(
        record,
        changeRequest.value,
        issueRef,
        input.as === "cancelled" ? "cancellation" : "supersede",
      );
      if (!bound.ok) return bound;
      record = bound.value;
      const refreshedComments = await this.options.workManagement.listComments(issueRef);
      if (!refreshedComments.ok) return refreshedComments;
      events = refreshedComments.value.flatMap((comment) => {
        const event = parseJobPrLifecycleComment(comment.body);
        return event === undefined ? [] : [event];
      });
      projection = projectPullRequestAuthority(events, changeRequest.value.number);
    }
    const ownershipEpoch = record.controlFence?.ownershipEpoch;
    if (
      ownershipEpoch === undefined ||
      projection.state !== "owned" ||
      projection.ownerJobId !== record.jobId ||
      projection.ownershipEpoch !== ownershipEpoch
    ) {
      return this.#conflict(
        record,
        input,
        projection.state === "unsettled" ? "unsettled_pr" : "owner_conflict",
        {
          prNumber: changeRequest.value.number,
          projection,
          localOwnershipEpoch: ownershipEpoch ?? null,
        },
        changeRequest.value.number,
      );
    }
    if (changeRequest.value.state === "merged") {
      return this.#convergeExternalMerge(record, input, changeRequest.value);
    }

    if (input.as === "cancelled") {
      const authority = this.#authority(record, "cancellation");
      if (!authority.ok) return authority;
      const sourceControl = fenceSourceControlPort(this.options.sourceControl, authority.value);
      if (changeRequest.value.state === "open") {
        const closed = await sourceControl.closeChangeRequest(
          { project: this.options.project, changeRequestId },
          { idempotencyKey: `dispatch-resolve:${record.jobId}:close-pr` },
        );
        if (!closed.ok || closed.value.state !== "closed") {
          return closed.ok ? err(domainError("conflict")) : closed;
        }
      }
      const refreshed = await this.options.progress.load(record.jobId);
      if (!refreshed.ok || refreshed.value === undefined) {
        return refreshed.ok ? err(domainError("not_found")) : refreshed;
      }
      return this.#publishTerminal(refreshed.value, input);
    }

    // A safe same-PR handoff needs authority over both Jobs and an atomic successor checkpoint.
    // This MVP has only the old Job's Lease, so fail closed before publishing a false owner.
    return this.#conflict(
      record,
      input,
      "owner_conflict",
      {
        reason: "safe_successor_handoff_unavailable",
        prNumber: changeRequest.value.number,
        successorJobId: input.supersededByJobId ?? null,
      },
      changeRequest.value.number,
    );
  }

  async #conflict(
    record: JobProgressRecord,
    input: DispatchResolveInput,
    conflictClass:
      | "multiple_pr_candidates"
      | "pr_identity_mismatch"
      | "owner_conflict"
      | "unsettled_pr"
      | "linear_github_mismatch",
    observedIdentity: unknown,
    prNumber?: number,
  ): Promise<Result<never, DomainError>> {
    if (this.options.lifecycleWorkManagement === undefined) {
      return err(domainError("conflict"));
    }
    const authority = this.#authority(
      record,
      input.as === "cancelled" ? "cancellation" : "supersede",
      input.supersededByJobId,
    );
    if (!authority.ok) return authority;
    const published = await publishAuthorityConflict({
      authority: authority.value,
      project: this.options.project,
      workManagement: this.options.lifecycleWorkManagement,
      record,
      conflictClass,
      observedIdentity,
      ...(prNumber === undefined ? {} : { prNumber }),
    });
    return published.ok ? err(domainError("conflict")) : published;
  }

  #matchesOriginalJob(changeRequest: ChangeRequestSnapshot, record: JobProgressRecord): boolean {
    const pointer = parsePullRequestBackPointer(changeRequest.body ?? "");
    const pointerValue = pointer.ok ? pointer.value : undefined;
    return (
      pointer.ok &&
      pointerValue?.projectId === record.projectId &&
      pointerValue.issueId === record.issueId &&
      pointerValue.jobId === record.jobId &&
      pointerValue.branch === record.branch &&
      changeRequest.headBranch === record.branch &&
      (record.headSha === undefined || changeRequest.headSha === record.headSha)
    );
  }

  async #publishJobStarted(
    record: JobProgressRecord,
    issue: Readonly<{ project: Project; externalIssueId: string }>,
    mode: ResolveAuthorityMode,
  ): Promise<Result<JobProgressRecord, DomainError>> {
    const authority = this.#authority(record, mode);
    if (!authority.ok) return authority;
    const event = createJobPrLifecycleEvent({
      schemaVersion: 1,
      kind: "job_started",
      projectId: record.projectId,
      issueId: record.issueId,
      jobId: record.jobId,
    });
    if (!event.ok) return event;
    const published = await fencedLifecyclePublisher(
      this.options.workManagement,
      authority.value,
    ).publish({
      issue,
      humanSummary: `Agent Team 已補登既有 Job ${record.jobId} 的開始紀錄。`,
      event: event.value,
    });
    if (!published.ok) return published;
    const refreshed = await this.options.progress.load(record.jobId);
    return !refreshed.ok
      ? refreshed
      : refreshed.value === undefined
        ? err(domainError("not_found"))
        : ok(refreshed.value);
  }

  async #publishPrBound(
    record: JobProgressRecord,
    changeRequest: ChangeRequestSnapshot,
    issue: Readonly<{ project: Project; externalIssueId: string }>,
    mode: "cancellation" | "supersede",
  ): Promise<Result<JobProgressRecord, DomainError>> {
    const authority = this.#authority(record, mode);
    if (!authority.ok) return authority;
    const headSha = headShaSchema.safeParse(changeRequest.headSha);
    if (!headSha.success) return err(domainError("conflict"));
    const event = createJobPrLifecycleEvent({
      schemaVersion: 1,
      kind: "pr_bound",
      projectId: record.projectId,
      issueId: record.issueId,
      jobId: record.jobId,
      prNumber: changeRequest.number,
      branch: record.branch,
      initialHeadSha: headSha.data,
      ownershipEpoch: 1,
    });
    if (!event.ok) return event;
    const published = await fencedLifecyclePublisher(
      this.options.workManagement,
      authority.value,
    ).publish({
      issue,
      humanSummary: `Agent Team 已補登 PR #${String(changeRequest.number)} 與 Job ${record.jobId} 的綁定。`,
      event: event.value,
    });
    if (!published.ok) return published;
    const refreshed = await this.options.progress.load(record.jobId);
    if (!refreshed.ok || refreshed.value === undefined) {
      return refreshed.ok ? err(domainError("not_found")) : refreshed;
    }
    const fence = refreshed.value.controlFence;
    if (fence?.state !== "active" || fence.ownershipEpoch !== 0) {
      return err(domainError("conflict"));
    }
    return this.options.progress.compareAndSwap(record.jobId, refreshed.value.revision, {
      ...mutationFrom(refreshed.value),
      controlFence: { ...fence, ownershipEpoch: 1 },
    });
  }

  async #convergeExternalMerge(
    record: JobProgressRecord,
    input: DispatchResolveInput,
    changeRequest: ChangeRequestSnapshot,
  ): Promise<
    Result<
      Readonly<{ record: JobProgressRecord; blockedReason: "cancellation_after_merge" }>,
      DomainError
    >
  > {
    if (
      input.as !== "cancelled" ||
      changeRequest.mergeCommitSha === undefined ||
      this.options.buildLifecycle === undefined ||
      this.options.lifecycleWorkManagement === undefined
    ) {
      return err(domainError("conflict"));
    }
    const authority = this.#authority(record, "cancellation");
    if (!authority.ok) return authority;
    const sourceControl = fenceSourceControlPort(this.options.sourceControl, authority.value);
    const workManagement = fenceWorkManagementLifecyclePort(
      this.options.lifecycleWorkManagement,
      authority.value,
    );
    const lifecycle = this.options.buildLifecycle({ sourceControl, workManagement });
    const outcome = await lifecycle.run({
      project: this.options.project,
      externalIssueId: record.externalIssueId,
      changeRequestId: String(changeRequest.number),
      idempotencyKeyPrefix: `dispatch-resolve:${record.jobId}:external-merge`,
      cancellationRaceAudit: { observedAt: this.options.clock.now() },
    });
    if (outcome.state === "failed") return err(outcome.error);
    if (outcome.state !== "blocked" || outcome.reason !== "cancellation_after_merge") {
      return err(domainError("conflict"));
    }

    const event = createJobPrLifecycleEvent({
      schemaVersion: 1,
      kind: "external_merge_observed",
      projectId: record.projectId,
      issueId: record.issueId,
      prNumber: changeRequest.number,
      mergeCommitSha: changeRequest.mergeCommitSha,
    });
    if (!event.ok) return event;
    const publisher = fencedLifecyclePublisher(this.options.workManagement, authority.value);
    const published = await publisher.publish({
      issue: { project: this.options.project, externalIssueId: record.externalIssueId },
      humanSummary: `Agent Team 觀察到 PR #${String(changeRequest.number)} 已由流程外合併；保留合併事實並停止取消流程。`,
      event: event.value,
    });
    if (!published.ok) return published;
    const refreshed = await this.options.progress.load(record.jobId);
    if (!refreshed.ok) return refreshed;
    return refreshed.value === undefined
      ? err(domainError("not_found"))
      : ok({ record: refreshed.value, blockedReason: "cancellation_after_merge" });
  }

  #authority(
    record: JobProgressRecord,
    mode: ResolveAuthorityMode,
    supersededByJobId?: string,
  ): Result<FileManagedMutationAuthority, DomainError> {
    const fence = record.controlFence;
    if (fence?.state !== "active") return err(domainError("permission_denied"));
    return ok(
      new FileManagedMutationAuthority({
        progress: this.options.progress,
        jobId: record.jobId,
        expectedFence: {
          leaseId: fence.leaseId,
          holderId: fence.holderId,
          leaseEpoch: fence.leaseEpoch,
          ownershipEpoch: fence.ownershipEpoch,
        },
        clock: this.options.clock,
        validateAuthority: createJobPrAuthorityValidator({
          project: this.options.project,
          workManagement: this.options.workManagement,
          sourceControl: this.options.sourceControl,
          mode,
          ...(supersededByJobId === undefined ? {} : { supersededByJobId }),
        }),
        ...(this.options.lifecycleWorkManagement === undefined
          ? {}
          : {
              escalation: {
                project: this.options.project,
                workManagement: this.options.lifecycleWorkManagement,
                sourceControl: this.options.sourceControl,
                mode,
                ...(supersededByJobId === undefined ? {} : { supersededByJobId }),
              },
            }),
      }),
    );
  }

  async #publishTerminal(
    record: JobProgressRecord,
    input: DispatchResolveInput,
    mode: ResolveAuthorityMode = input.as === "cancelled" ? "cancellation" : "supersede",
  ): Promise<Result<JobProgressRecord, DomainError>> {
    const successorId =
      input.as === "superseded" ? jobIdSchema.safeParse(input.supersededByJobId) : undefined;
    if (successorId !== undefined && !successorId.success) {
      return err(domainError("invariant_violation"));
    }
    const successorJobId = successorId?.success === true ? successorId.data : undefined;
    if (input.as === "superseded" && successorJobId === undefined) {
      return err(domainError("invariant_violation"));
    }
    const authority = this.#authority(record, mode, input.supersededByJobId);
    if (!authority.ok) return authority;
    let event: ReturnType<typeof createJobPrLifecycleEvent>;
    if (input.as === "cancelled") {
      event = createJobPrLifecycleEvent({
        schemaVersion: 1,
        kind: "job_cancelled",
        projectId: record.projectId,
        issueId: record.issueId,
        jobId: record.jobId,
      });
    } else {
      if (successorJobId === undefined) return err(domainError("invariant_violation"));
      event = createJobPrLifecycleEvent({
        schemaVersion: 1,
        kind: "job_superseded",
        projectId: record.projectId,
        issueId: record.issueId,
        oldJobId: record.jobId,
        newJobId: successorJobId,
      });
    }
    if (!event.ok) return event;
    const publisher = fencedLifecyclePublisher(this.options.workManagement, authority.value);
    const published = await publisher.publish({
      issue: { project: this.options.project, externalIssueId: record.externalIssueId },
      humanSummary:
        input.as === "cancelled"
          ? `Agent Team 已取消 Job ${record.jobId}。`
          : `Agent Team 已由 Job ${String(successorJobId)} 取代 ${record.jobId}。`,
      event: event.value,
    });
    if (!published.ok) return published;
    const refreshed = await this.options.progress.load(record.jobId);
    return !refreshed.ok
      ? refreshed
      : refreshed.value === undefined
        ? err(domainError("not_found"))
        : ok(refreshed.value);
  }
}
