import { randomUUID } from "node:crypto";

import type {
  FileJobProgressStore,
  IssueAdmissionPort,
  JobProgressRecord,
} from "../../adapters/dispatch/index.js";
import { LeaseCoordinator } from "../../application/leases/index.js";
import type {
  ChangeRequestSnapshot,
  SourceControlPort,
  WorkManagementIssueSnapshot,
} from "../../application/ports/index.js";
import {
  JobPrLifecyclePublisher,
  createJobPrLifecycleEvent,
  parseJobPrLifecycleComment,
  type LifecyclePipeline,
  type LifecyclePipelinePorts,
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
import { sha256Digest } from "../../domain/review/index.js";
import type {
  ExternalMergeRecoveryInspection,
  ExternalMergeRecoveryPort,
  ExternalMergeRecoveryReceipt,
  ValidatedExternalMergeInput,
} from "./external-merge-recovery-handlers.js";
import {
  FileManagedMutationAuthority,
  fenceWorkManagementLifecyclePort,
  rotateJobControlFence,
  type ManagedMutationRequest,
  type WorkManagementLifecyclePort,
} from "./managed-mutation-authority.js";

export interface ExternalMergeRecoveryAuthorityOptions {
  readonly project: Project;
  readonly progress: FileJobProgressStore;
  readonly admission: IssueAdmissionPort;
  readonly leases: LeaseCoordinator;
  readonly workManagement: WorkManagementLifecyclePort;
  readonly sourceControl: Pick<SourceControlPort, "getChangeRequest">;
  readonly buildLifecycle: (
    ports: Readonly<{
      sourceControl: LifecyclePipelinePorts["sourceControl"];
      workManagement: LifecyclePipelinePorts["workManagement"];
    }>,
  ) => Pick<LifecyclePipeline, "run">;
  readonly clock: Clock;
  readonly generateHolderId?: () => string;
}

type InspectionEvidence = Readonly<{
  inspection: ExternalMergeRecoveryInspection;
  issue: WorkManagementIssueSnapshot;
  changeRequest: ChangeRequestSnapshot;
  hasExternalMergeEvent: boolean;
  hasJobCompletedEvent: boolean;
  hasRecoveryMarker: boolean;
}>;

const terminalStages = new Set(["completed", "cancelled", "superseded"]);

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

function sameSha(left: string | undefined, right: string): boolean {
  return left?.toLowerCase() === right.toLowerCase();
}

function requestedLifecycleEvent(request: ManagedMutationRequest) {
  if (
    request.intent !== "linear_lifecycle" ||
    typeof request.identity !== "object" ||
    request.identity === null
  ) {
    return undefined;
  }
  const body = (request.identity as Readonly<Record<string, unknown>>)["body"];
  return typeof body === "string" ? parseJobPrLifecycleComment(body) : undefined;
}

export class ExternalMergeRecoveryAuthority implements ExternalMergeRecoveryPort {
  constructor(readonly options: ExternalMergeRecoveryAuthorityOptions) {}

  async inspect(
    record: JobProgressRecord,
    input: ValidatedExternalMergeInput,
  ): Promise<Result<ExternalMergeRecoveryInspection, DomainError>> {
    const evidence = await this.#inspect(record, input);
    return evidence.ok ? ok(evidence.value.inspection) : evidence;
  }

  async recover(
    initialRecord: JobProgressRecord,
    input: ValidatedExternalMergeInput,
  ): Promise<Result<ExternalMergeRecoveryReceipt, DomainError>> {
    const initial = await this.#inspect(initialRecord, input);
    if (!initial.ok) return initial;
    if (initial.value.inspection.mode === "finalizable") {
      return this.#finalizeTerminal(initialRecord, input, initial.value);
    }

    const holderId = this.options.generateHolderId?.() ?? `external-merge-recovery:${randomUUID()}`;
    const acquired = await this.options.leases.acquire({
      jobId: initialRecord.jobId,
      issueId: initialRecord.issueId,
      holderId,
    });
    if (!acquired.ok) return acquired;
    const lease = acquired.value.value;
    let leaseReleased = false;
    const releaseLease = async (): Promise<Result<void, DomainError>> => {
      if (leaseReleased) return ok(undefined);
      const released = await this.options.leases.release({ leaseId: lease.id, holderId });
      if (released.ok) leaseReleased = true;
      return released.ok ? ok(undefined) : released;
    };

    const fenced = await rotateJobControlFence(this.options.progress, initialRecord, lease);
    if (!fenced.ok) {
      await releaseLease();
      return fenced;
    }
    const refreshedEvidence = await this.#inspect(fenced.value, input);
    if (!refreshedEvidence.ok) {
      await releaseLease();
      return refreshedEvidence;
    }

    const authority = this.#mutationAuthority(fenced.value, input);
    if (!authority.ok) {
      await releaseLease();
      return authority;
    }
    const fencedWorkManagement = fenceWorkManagementLifecyclePort(
      this.options.workManagement,
      authority.value,
    );
    const lifecycleWorkManagement = this.#idempotentLifecycleCommentPort(
      fencedWorkManagement,
      input,
      fenced.value,
    );
    if (!lifecycleWorkManagement.ok) {
      await releaseLease();
      return lifecycleWorkManagement;
    }
    const readOnlySourceControl: LifecyclePipelinePorts["sourceControl"] = {
      getChangeRequest: (reference, options) =>
        this.options.sourceControl.getChangeRequest(reference, options),
      closeChangeRequest: () => Promise.resolve(err(domainError("permission_denied"))),
    };
    const lifecycle = this.options.buildLifecycle({
      sourceControl: readOnlySourceControl,
      workManagement: lifecycleWorkManagement.value,
    });
    const identity = this.#identityDigest(input, fenced.value);
    if (!identity.ok) {
      await releaseLease();
      return identity;
    }
    const lifecycleOutcome = await lifecycle.run({
      project: this.options.project,
      externalIssueId: fenced.value.externalIssueId,
      changeRequestId: String(input.prNumber),
      idempotencyKeyPrefix: `acknowledge-external-merge:${identity.value}:lifecycle`,
    });
    if (lifecycleOutcome.state !== "completed" || lifecycleOutcome.merge !== "out_of_process") {
      await releaseLease();
      return lifecycleOutcome.state === "failed"
        ? err(lifecycleOutcome.error)
        : err(domainError("conflict"));
    }

    const publisher = new JobPrLifecyclePublisher(fencedWorkManagement);
    const externalEvent = createJobPrLifecycleEvent({
      schemaVersion: 1,
      kind: "external_merge_observed",
      projectId: fenced.value.projectId,
      issueId: fenced.value.issueId,
      prNumber: input.prNumber,
      mergeCommitSha: input.mergeCommitSha,
    });
    const completedEvent = createJobPrLifecycleEvent({
      schemaVersion: 1,
      kind: "job_completed",
      projectId: fenced.value.projectId,
      issueId: fenced.value.issueId,
      jobId: fenced.value.jobId,
      prNumber: input.prNumber,
      mergeCommitSha: input.mergeCommitSha,
    });
    if (!externalEvent.ok || !completedEvent.ok) {
      await releaseLease();
      return err(domainError("invariant_violation"));
    }
    const oldHead = fenced.value.headSha ?? "unavailable";
    const externalPublished = await publisher.publish({
      issue: { project: this.options.project, externalIssueId: fenced.value.externalIssueId },
      humanSummary:
        `Agent Team 已以 legacy recovery 確認 PR #${String(input.prNumber)} 是流程外合併；` +
        `舊 Job Head=${oldHead}，GitHub merged Head=${input.headSha}，未宣稱由 Controller 授權。` +
        (fenced.value.humanDelivery?.acceptanceRequirement === "required"
          ? " 此 Job 的人工驗收收據未經本命令驗證；操作者已明確啟用 recovery exception，未宣稱人工驗收通過。"
          : ""),
      event: externalEvent.value,
    });
    if (!externalPublished.ok) {
      await releaseLease();
      return externalPublished;
    }
    const completedPublished = await publisher.publish({
      issue: { project: this.options.project, externalIssueId: fenced.value.externalIssueId },
      humanSummary:
        `Agent Team 已由 legacy external-merge recovery 收斂 Job ${fenced.value.jobId}；` +
        `PR #${String(input.prNumber)} 已在流程外合併。`,
      event: completedEvent.value,
    });
    if (!completedPublished.ok) {
      await releaseLease();
      return completedPublished;
    }

    const beforeTerminal = await this.options.progress.load(fenced.value.jobId);
    if (!beforeTerminal.ok || beforeTerminal.value === undefined) {
      await releaseLease();
      return beforeTerminal.ok ? err(domainError("not_found")) : beforeTerminal;
    }
    const activeFence = beforeTerminal.value.controlFence;
    if (
      activeFence?.state !== "active" ||
      activeFence.leaseId !== lease.id ||
      activeFence.holderId !== holderId
    ) {
      await releaseLease();
      return err(domainError("conflict"));
    }
    const terminal = await this.options.progress.compareAndSwap(
      beforeTerminal.value.jobId,
      beforeTerminal.value.revision,
      {
        ...mutationFrom(beforeTerminal.value),
        stage: { kind: "completed" },
        controlFence: { ...activeFence, state: "revoked" },
      },
    );
    if (!terminal.ok) {
      await releaseLease();
      return terminal;
    }
    const admission = await this.#releaseAdmission(terminal.value);
    if (!admission.ok) {
      await releaseLease();
      return admission;
    }
    const released = await releaseLease();
    if (!released.ok) return released;
    return ok({
      mode: "recovered",
      jobId: terminal.value.jobId,
      prNumber: input.prNumber,
      headSha: input.headSha,
      mergeCommitSha: input.mergeCommitSha,
      headDrift:
        terminal.value.headSha !== undefined && !sameSha(terminal.value.headSha, input.headSha),
      humanAcceptanceException:
        terminal.value.humanDelivery?.acceptanceRequirement === "required" &&
        input.allowMissingHumanAcceptance,
      admissionReleased: admission.value,
      leaseReleased: true,
    });
  }

  async #inspect(
    record: JobProgressRecord,
    input: ValidatedExternalMergeInput,
  ): Promise<Result<InspectionEvidence, DomainError>> {
    if (
      record.projectId !== this.options.project.id ||
      record.jobId !== input.jobId ||
      record.changeRequestId !== String(input.prNumber)
    ) {
      return err(domainError("conflict"));
    }
    if (record.controlFence?.state === "revoked" && !terminalStages.has(record.stage.kind)) {
      return err(domainError("conflict"));
    }
    if (
      record.humanDelivery?.acceptanceRequirement === "required" &&
      !input.allowMissingHumanAcceptance
    ) {
      return err(domainError("conflict"));
    }
    const issueReference = {
      project: this.options.project,
      externalIssueId: record.externalIssueId,
    };
    const [issue, comments, changeRequest, claim] = await Promise.all([
      this.options.workManagement.getIssue(issueReference),
      this.options.workManagement.listComments(issueReference),
      this.options.sourceControl.getChangeRequest({
        project: this.options.project,
        changeRequestId: String(input.prNumber),
      }),
      this.options.admission.load(record.projectId, record.issueId),
    ]);
    if (!issue.ok) return issue;
    if (!comments.ok) return comments;
    if (!changeRequest.ok) return changeRequest;
    if (!claim.ok) return claim;
    if (
      issue.value.issue.id !== record.issueId ||
      issue.value.issue.projectId !== record.projectId ||
      issue.value.issue.externalId !== record.externalIssueId ||
      issue.value.archivedAt !== undefined ||
      issue.value.trashed === true ||
      issue.value.workStatus === "canceled"
    ) {
      return err(domainError("conflict"));
    }
    const pr = changeRequest.value;
    if (
      pr.number !== input.prNumber ||
      pr.state !== "merged" ||
      pr.baseBranch !== this.options.project.defaultBranch ||
      pr.headBranch !== record.branch ||
      !sameSha(pr.headSha, input.headSha) ||
      !sameSha(pr.mergeCommitSha, input.mergeCommitSha) ||
      pr.mergedAt === undefined
    ) {
      return err(domainError("conflict"));
    }
    if (
      claim.value !== undefined &&
      !(
        (claim.value.state === "active" && claim.value.jobId === record.jobId) ||
        (claim.value.state === "released" &&
          claim.value.jobId === record.jobId &&
          claim.value.releaseReason === "completed")
      )
    ) {
      return err(domainError("conflict"));
    }
    const events = comments.value.flatMap((comment) => {
      const event = parseJobPrLifecycleComment(comment.body);
      return event === undefined ? [] : [event];
    });
    const hasExternalMergeEvent = events.some(
      (event) =>
        event.kind === "external_merge_observed" &&
        event.projectId === record.projectId &&
        event.issueId === record.issueId &&
        event.prNumber === input.prNumber &&
        sameSha(event.mergeCommitSha, input.mergeCommitSha),
    );
    const hasJobCompletedEvent = events.some(
      (event) =>
        event.kind === "job_completed" &&
        event.projectId === record.projectId &&
        event.issueId === record.issueId &&
        event.jobId === record.jobId &&
        event.prNumber === input.prNumber &&
        sameSha(event.mergeCommitSha, input.mergeCommitSha),
    );
    const identityDigest = this.#identityDigest(input, record);
    if (!identityDigest.ok) return identityDigest;
    const recoveryMarker = `agent-team-external-merge-recovery:v1 ${identityDigest.value}`;
    const hasRecoveryMarker = comments.value.some((comment) =>
      comment.body.includes(recoveryMarker),
    );
    const finalizable =
      record.stage.kind === "completed" &&
      record.controlFence?.state === "revoked" &&
      hasExternalMergeEvent &&
      hasJobCompletedEvent &&
      hasRecoveryMarker;
    if (terminalStages.has(record.stage.kind) && !finalizable) {
      return err(domainError("conflict"));
    }
    return ok({
      inspection: {
        mode: finalizable ? "finalizable" : "recoverable",
        jobId: record.jobId,
        prNumber: input.prNumber,
        headSha: input.headSha,
        mergeCommitSha: input.mergeCommitSha,
        headDrift: record.headSha !== undefined && !sameSha(record.headSha, input.headSha),
        humanAcceptanceException:
          record.humanDelivery?.acceptanceRequirement === "required" &&
          input.allowMissingHumanAcceptance,
      },
      issue: issue.value,
      changeRequest: pr,
      hasExternalMergeEvent,
      hasJobCompletedEvent,
      hasRecoveryMarker,
    });
  }

  #mutationAuthority(
    record: JobProgressRecord,
    input: ValidatedExternalMergeInput,
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
        validateAuthority: async (current, request) => {
          if (!["linear_lifecycle", "linear_work_status"].includes(request.intent)) {
            return err(domainError("permission_denied"));
          }
          const evidence = await this.#inspect(current, input);
          if (!evidence.ok || evidence.value.inspection.mode !== "recoverable") {
            return evidence.ok ? err(domainError("conflict")) : evidence;
          }
          const event = requestedLifecycleEvent(request);
          if (event === undefined) return ok(undefined);
          if (
            event.kind === "external_merge_observed" &&
            event.projectId === current.projectId &&
            event.issueId === current.issueId &&
            event.prNumber === input.prNumber &&
            sameSha(event.mergeCommitSha, input.mergeCommitSha)
          ) {
            return ok(undefined);
          }
          return event.kind === "job_completed" &&
            event.projectId === current.projectId &&
            event.issueId === current.issueId &&
            event.jobId === current.jobId &&
            event.prNumber === input.prNumber &&
            sameSha(event.mergeCommitSha, input.mergeCommitSha)
            ? ok(undefined)
            : err(domainError("conflict"));
        },
      }),
    );
  }

  #idempotentLifecycleCommentPort(
    fenced: WorkManagementLifecyclePort,
    input: ValidatedExternalMergeInput,
    record: JobProgressRecord,
  ): Result<LifecyclePipelinePorts["workManagement"], DomainError> {
    const digest = this.#identityDigest(input, record);
    if (!digest.ok) return digest;
    const marker = `<!-- agent-team-external-merge-recovery:v1 ${digest.value} -->`;
    const acceptanceDisclosure =
      record.humanDelivery?.acceptanceRequirement === "required" &&
      input.allowMissingHumanAcceptance
        ? "\n\n此 Job 的人工驗收收據未經本命令驗證；操作者已明確啟用 recovery exception，未宣稱人工驗收通過。"
        : "";
    return ok({
      getIssue: fenced.getIssue,
      setWorkStatus: fenced.setWorkStatus,
      setAgentCondition: fenced.setAgentCondition,
      appendComment: async (reference, body, options) => {
        const comments = await fenced.listComments(reference);
        if (!comments.ok) return comments;
        const existing = comments.value.find((comment) => comment.body.includes(marker));
        return existing === undefined
          ? fenced.appendComment(reference, `${body}${acceptanceDisclosure}\n\n${marker}`, options)
          : ok(existing);
      },
    });
  }

  #identityDigest(
    input: ValidatedExternalMergeInput,
    record: JobProgressRecord,
  ): Result<string, DomainError> {
    return sha256Digest({
      operation: "acknowledge-external-merge",
      projectId: record.projectId,
      issueId: record.issueId,
      jobId: record.jobId,
      prNumber: input.prNumber,
      branch: record.branch,
      headSha: input.headSha,
      mergeCommitSha: input.mergeCommitSha,
      allowMissingHumanAcceptance: input.allowMissingHumanAcceptance,
    });
  }

  async #releaseAdmission(
    record: JobProgressRecord,
  ): Promise<Result<"released" | "already_released" | "not_found", DomainError>> {
    const claim = await this.options.admission.load(record.projectId, record.issueId);
    if (!claim.ok) return claim;
    if (claim.value === undefined) return ok("not_found");
    if (
      claim.value.state === "released" &&
      claim.value.jobId === record.jobId &&
      claim.value.releaseReason === "completed"
    ) {
      return ok("already_released");
    }
    if (claim.value.state !== "active" || claim.value.jobId !== record.jobId) {
      return err(domainError("conflict"));
    }
    const released = await this.options.admission.release(
      record.projectId,
      record.issueId,
      claim.value.revision,
      "completed",
    );
    return released.ok ? ok("released") : released;
  }

  async #finalizeTerminal(
    record: JobProgressRecord,
    input: ValidatedExternalMergeInput,
    evidence: InspectionEvidence,
  ): Promise<Result<ExternalMergeRecoveryReceipt, DomainError>> {
    if (
      !evidence.hasExternalMergeEvent ||
      !evidence.hasJobCompletedEvent ||
      !evidence.hasRecoveryMarker
    ) {
      return err(domainError("conflict"));
    }
    const admission = await this.#releaseAdmission(record);
    if (!admission.ok) return admission;
    const fence = record.controlFence;
    if (fence?.state !== "revoked") return err(domainError("conflict"));
    const released = await this.options.leases.release({
      leaseId: fence.leaseId,
      holderId: fence.holderId,
    });
    if (!released.ok) return released;
    return ok({
      mode: admission.value === "already_released" ? "already_finalized" : "finalized",
      jobId: record.jobId,
      prNumber: input.prNumber,
      headSha: input.headSha,
      mergeCommitSha: input.mergeCommitSha,
      headDrift: record.headSha !== undefined && !sameSha(record.headSha, input.headSha),
      humanAcceptanceException:
        record.humanDelivery?.acceptanceRequirement === "required" &&
        input.allowMissingHumanAcceptance,
      admissionReleased: admission.value,
      leaseReleased: true,
    });
  }
}
