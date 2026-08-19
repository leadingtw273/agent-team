import type {
  ReviewerPipelineOutcome,
  ReviewerPipelineRequest,
  VisualEvidenceBuildSuccess,
} from "../../application/pipelines/index.js";
import {
  computeReviewerReportContractDigest,
  currentReviewerReportContractBinding,
  requiredReviewerRoles,
} from "../../application/pipelines/reviewer-policy.js";
import { defaultLeaseDurationMs } from "../../application/leases/index.js";
import { attemptLimits, leaseState, watchdogHardStopMs } from "../../domain/jobs/index.js";
import {
  createRequirementSnapshot,
  sha256Digest,
  type ReviewIdentity,
} from "../../domain/review/index.js";
import { instantFromDate } from "../../domain/foundation/index.js";
import type { WorkStatus } from "../../domain/workflow/index.js";
import type {
  CheckpointReadReceipt,
  LocalYamlCheckpointReader,
} from "../../adapters/checkpoint/index.js";
import { aggregateLinearPublicationDigest } from "../../adapters/dispatch/linear-publication-store.js";
import { projectIssueByExternalId } from "../../adapters/dispatch/linear-discovery.js";
import type {
  FileFinalReviewRecoveryStore,
  FinalReviewRecoveryIdentity,
  FinalReviewRecoveryRecord,
  FinalReviewRecoveryRecordMutation,
} from "../../adapters/dispatch/final-review-recovery-store.js";
import type {
  JobProgressRecord,
  JobProgressRecordMutation,
  ReviewerReplayCheckpoint,
  ReviewerReplayIdentity,
} from "../../adapters/dispatch/job-progress-store.js";
import type { FileReviewerReplayDiagnosticStore } from "../../adapters/dispatch/reviewer-replay-diagnostic-store.js";
import type {
  ChangeRequestSnapshot,
  CommitChecksSnapshot,
  SourceControlPort,
  WorkManagementPort,
} from "../../application/ports/index.js";
import {
  createReviewerReplayIdentity,
  createReviewerReplayIdentityForCheckpoint,
  createReviewerReplaySuccessCheckpoint,
  replayIdentityMatches,
  reviewerReportMatchesIdentity,
} from "./reviewer-replay-identity.js";
import {
  isReviewerReplayCheckpointReconcilable,
  resumeUnderLease,
  type ResumeCycleDependencies,
  type ResumeJobOutcome,
} from "./resume-composition.js";

const maximumReplayAttempts = 2;
const transportRetryBackoffMs = 1_000;

export type ReviewerReplayBlockedReason =
  | "job_not_found"
  | "job_not_eligible"
  | "policy_disabled"
  | "policy_read_failed"
  | "claim_mismatch"
  | "claim_read_failed"
  | "lease_conflict"
  | "candidate_changed"
  | "runtime_unavailable"
  | "work_item_canceled"
  | "authoritative_read_failed"
  | "identity_mismatch"
  | "provider_budget_insufficient"
  | "contract_epoch_not_allowed"
  | "contract_version_mismatch"
  | "contract_digest_mismatch"
  | "attempts_exhausted"
  | "review_not_approved"
  | "checkpoint_write_failed"
  | "diagnostic_write_failed"
  | "public_summary_failed"
  | "lease_lost"
  | "final_checkpoint_mismatch"
  | "final_recovery_state_conflict"
  | "final_review_not_supported"
  | "final_review_status_mismatch"
  | "final_pre_provider_failure"
  | "final_provider_outcome_unknown";

export type ReviewerReplayOutcome =
  | Readonly<{
      state: "ready";
      jobId: string;
      identityDigest: string;
      providerAttemptsUsed: number;
      providerAttemptsRemaining: number;
      plannedMutations: readonly string[];
    }>
  | Readonly<{
      state: "continued";
      jobId: string;
      identityDigest: string;
      checkpointDigest: string;
      providerAttempts: number;
      outcome: ResumeJobOutcome;
    }>
  | Readonly<{
      state: "blocked";
      jobId: string;
      reason: ReviewerReplayBlockedReason;
      errorCode?: string;
      providerAttempts?: number;
      formatFailures?: number;
      transportFailures?: number;
    }>;

export interface ReviewerReplayPublicationPorts {
  readonly sourceControl: Pick<SourceControlPort, "appendChangeRequestComment">;
  readonly workManagement: Pick<WorkManagementPort, "appendComment">;
}

export interface ReviewerReplayCoordinatorDependencies {
  readonly resume: ResumeCycleDependencies;
  readonly diagnostics: Pick<FileReviewerReplayDiagnosticStore, "append">;
  readonly publication: ReviewerReplayPublicationPorts;
  readonly delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly leaseHeartbeatIntervalMs?: number;
  readonly finalReviewRecovery?: Readonly<{
    store: Pick<FileFinalReviewRecoveryStore, "load" | "compareAndSwap">;
    checkpoints: Pick<LocalYamlCheckpointReader, "load">;
  }>;
}

export interface ReviewerReplayRunOptions {
  readonly newContractEpoch?: boolean;
  readonly expectContractVersion?: number;
  readonly finalReviewEpoch?: boolean;
  readonly expectCheckpoint?: string;
}

interface ReplayInspection {
  readonly record: JobProgressRecord;
  readonly request: ReviewerPipelineRequest;
  readonly identity: ReviewIdentity;
  readonly replayIdentity: Readonly<{
    identity: ReviewerReplayIdentity;
    identityDigest: string;
  }>;
  readonly changeRequest: ChangeRequestSnapshot;
  readonly checks: CommitChecksSnapshot;
  readonly workStatus: WorkStatus;
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

function exactReplayCause(record: JobProgressRecord): boolean {
  return (
    record.stage.kind === "requires_manual" &&
    record.stage.cause?.stage === "review" &&
    record.stage.cause.reasonCode === "review_report_contract"
  );
}

async function admissionCheck(
  record: JobProgressRecord,
  deps: ResumeCycleDependencies,
): Promise<ReviewerReplayBlockedReason | undefined> {
  const claim = await deps.admission.load(record.projectId, record.issueId);
  if (!claim.ok) return "claim_read_failed";
  return claim.value?.state === "active" && claim.value.jobId === record.jobId
    ? undefined
    : "claim_mismatch";
}

async function inspectReplay(
  record: JobProgressRecord,
  deps: ResumeCycleDependencies,
  signal?: AbortSignal,
): Promise<ReplayInspection | ReviewerReplayOutcome> {
  if (
    record.changeRequestId === undefined ||
    record.headSha === undefined ||
    record.baseRevision === undefined ||
    record.providerAssignments === undefined
  ) {
    return { state: "blocked", jobId: record.jobId, reason: "job_not_eligible" };
  }
  const readOptions = signal === undefined ? {} : { signal };
  const workItem = await deps.workManagement.getIssue(
    { project: deps.project, externalIssueId: record.externalIssueId },
    readOptions,
  );
  if (!workItem.ok) {
    return {
      state: "blocked",
      jobId: record.jobId,
      reason: "authoritative_read_failed",
      errorCode: workItem.error.code,
    };
  }
  if (
    workItem.value.issue.projectId !== record.projectId ||
    workItem.value.issue.externalId !== record.externalIssueId
  ) {
    return { state: "blocked", jobId: record.jobId, reason: "identity_mismatch" };
  }
  if (workItem.value.workStatus === "canceled") {
    return { state: "blocked", jobId: record.jobId, reason: "work_item_canceled" };
  }
  const jobs = await deps.jobRepository.readAll();
  if (!jobs.ok) {
    return {
      state: "blocked",
      jobId: record.jobId,
      reason: "authoritative_read_failed",
      errorCode: jobs.error.code,
    };
  }
  const job = jobs.value.find((candidate) => candidate.id === record.jobId);
  if (job === undefined) {
    return { state: "blocked", jobId: record.jobId, reason: "job_not_found" };
  }
  const issue = await projectIssueByExternalId(
    deps.project,
    deps.readModel,
    deps.teamId,
    deps.linearProjectId,
    record.externalIssueId,
    readOptions,
  );
  if (!issue.ok) {
    return {
      state: "blocked",
      jobId: record.jobId,
      reason: "authoritative_read_failed",
      errorCode: issue.error.code,
    };
  }
  const snapshot = createRequirementSnapshot(issue.value, deps.clock.now());
  if (!snapshot.ok) {
    return {
      state: "blocked",
      jobId: record.jobId,
      reason: "authoritative_read_failed",
      errorCode: snapshot.error.code,
    };
  }
  const reviewRequirement = snapshot.value.issue.reviewRequirement;
  const needsCode = reviewRequirement === "code_review" || reviewRequirement === "dual_review";
  const needsVisual = reviewRequirement === "visual_review" || reviewRequirement === "dual_review";
  let visualEvidence: VisualEvidenceBuildSuccess | undefined;
  let publicationDigest: string | undefined;
  if (needsVisual) {
    if (
      deps.visualEvidence === undefined ||
      deps.linearPublicationStore === undefined ||
      deps.visualReviewModel === undefined
    ) {
      return { state: "blocked", jobId: record.jobId, reason: "runtime_unavailable" };
    }
    const verified = await deps.visualEvidence.verifyExisting({
      worktreePath: record.worktreePath,
      issueId: snapshot.value.issue.id,
      headSha: record.headSha,
      allowedAcceptanceCriteria: snapshot.value.issue.acceptanceCriteria ?? [],
    });
    if (!verified.ok) {
      return {
        state: "blocked",
        jobId: record.jobId,
        reason: "identity_mismatch",
        errorCode: verified.failure.error.code,
      };
    }
    visualEvidence = verified.value;
    const receipt = await deps.linearPublicationStore.load(
      record.projectId,
      record.issueId,
      record.headSha,
    );
    if (!receipt.ok || receipt.value === undefined) {
      return {
        state: "blocked",
        jobId: record.jobId,
        reason: "identity_mismatch",
        ...(!receipt.ok ? { errorCode: receipt.error.code } : {}),
      };
    }
    publicationDigest = aggregateLinearPublicationDigest([receipt.value]);
  }
  const deadline = instantFromDate(new Date(Date.parse(deps.clock.now()) + watchdogHardStopMs));
  if (!deadline.ok || (!needsCode && !needsVisual)) {
    return { state: "blocked", jobId: record.jobId, reason: "job_not_eligible" };
  }
  const request: ReviewerPipelineRequest = {
    job,
    project: deps.project,
    trustedConfig: deps.trustedConfig,
    requirementSnapshot: snapshot.value,
    worktree: {
      repositoryRoot: deps.project.localRepositoryPath,
      path: record.worktreePath,
      branch: record.branch,
      headSha: record.headSha,
    },
    changeRequestId: record.changeRequestId,
    baseRevision: record.baseRevision,
    expectedHeadSha: record.headSha,
    models: {
      ...(needsCode ? { code: record.providerAssignments.codeReview.model } : {}),
      ...(needsVisual ? { visual: deps.visualReviewModel } : {}),
    },
    evidence: visualEvidence?.evidence ?? Object.freeze([]),
    ...(visualEvidence === undefined ? {} : { visualManifest: visualEvidence.visualManifest }),
    ...(publicationDigest === undefined ? {} : { publicationDigest }),
    deadlineAt: deadline.value,
    idempotencyKeyPrefix: `reviewer-replay:${record.jobId}:inspection`,
    attemptAccounting: "reviewer_replay",
    ...(signal === undefined ? {} : { signal }),
  };
  const inspect = deps.reviewer.inspect;
  if (inspect === undefined) {
    return { state: "blocked", jobId: record.jobId, reason: "runtime_unavailable" };
  }
  const inspected = await inspect(request);
  if (inspected.state !== "ready") {
    return {
      state: "blocked",
      jobId: record.jobId,
      reason: inspected.state === "not_ready" ? "authoritative_read_failed" : "identity_mismatch",
      ...(inspected.state === "failed" ? { errorCode: inspected.error.code } : {}),
    };
  }
  const replayIdentity =
    record.reviewerReplay === undefined
      ? createReviewerReplayIdentity(record, inspected.identity, {
          schemaVersion: 2,
          epochOrdinal: 1,
        })
      : createReviewerReplayIdentityForCheckpoint(
          record,
          inspected.identity,
          record.reviewerReplay,
        );
  if (!replayIdentity.ok) {
    return { state: "blocked", jobId: record.jobId, reason: "identity_mismatch" };
  }
  return Object.freeze({
    record,
    request,
    identity: inspected.identity,
    replayIdentity: replayIdentity.value,
    changeRequest: inspected.changeRequest,
    checks: inspected.checks,
    workStatus: workItem.value.workStatus,
  });
}

function replayBlocked(
  value: ReplayInspection | ReviewerReplayOutcome,
): value is ReviewerReplayOutcome {
  return "state" in value;
}

function finalAdmissionBlocked(
  value: FinalReviewAdmission | ReviewerReplayOutcome,
): value is ReviewerReplayOutcome {
  return "state" in value;
}

function withPrefix(
  request: ReviewerPipelineRequest,
  identityDigest: string,
  attempt: number,
  category?: ReviewerPipelineRequest["reportRetryFeedback"],
): ReviewerPipelineRequest {
  return Object.freeze({
    ...request,
    idempotencyKeyPrefix: `reviewer-replay:${request.job.id}:${identityDigest}:attempt-${String(attempt)}`,
    ...(category === undefined ? {} : { reportRetryFeedback: category }),
  });
}

function initialCheckpoint(
  inspection: ReplayInspection,
): Extract<ReviewerReplayCheckpoint, { state: "attempting" }> {
  return {
    state: "attempting",
    identity: inspection.replayIdentity.identity,
    identityDigest: inspection.replayIdentity.identityDigest,
    counters: { providerAttempts: 0, formatFailures: 0, transportFailures: 0 },
    ...(inspection.replayIdentity.identity.schemaVersion === 1
      ? {}
      : { reviewContractBinding: currentReviewerReportContractBinding }),
  };
}

function currentContractGoldenIsValid(): boolean {
  return computeReviewerReportContractDigest() === currentReviewerReportContractBinding.digest;
}

function canCreateContractEpoch(checkpoint: ReviewerReplayCheckpoint): boolean {
  return (
    checkpoint.state === "attempting" &&
    checkpoint.counters.providerAttempts === maximumReplayAttempts &&
    checkpoint.counters.formatFailures === checkpoint.counters.providerAttempts &&
    checkpoint.counters.transportFailures === 0
  );
}

type ContractEpochCheckpointResult =
  | Readonly<{
      ok: true;
      checkpoint: Extract<ReviewerReplayCheckpoint, { state: "attempting" }>;
    }>
  | Readonly<{
      ok: false;
      reason: Extract<
        ReviewerReplayBlockedReason,
        "contract_epoch_not_allowed" | "provider_budget_insufficient"
      >;
    }>;

function contractEpochCheckpoint(
  record: JobProgressRecord,
  inspection: ReplayInspection,
): ContractEpochCheckpointResult {
  const requiredProviderInvocations = requiredReviewerRoles(inspection.request).length;
  if (requiredProviderInvocations === 0 || requiredProviderInvocations > maximumReplayAttempts) {
    return { ok: false, reason: "provider_budget_insufficient" };
  }
  const current = record.reviewerReplay;
  if (
    current === undefined ||
    record.previousReviewerReplay !== undefined ||
    !canCreateContractEpoch(current)
  ) {
    return { ok: false, reason: "contract_epoch_not_allowed" };
  }
  const currentOrdinal = current.identity.schemaVersion === 1 ? 1 : current.identity.epochOrdinal;
  const currentContractVersion = current.reviewContractBinding?.version ?? 1;
  if (currentReviewerReportContractBinding.version !== currentContractVersion + 1) {
    return { ok: false, reason: "contract_epoch_not_allowed" };
  }
  const created = createReviewerReplayIdentity(record, inspection.identity, {
    schemaVersion: 2,
    epochOrdinal: currentOrdinal + 1,
  });
  if (
    !created.ok ||
    created.value.identity.schemaVersion !== 2 ||
    created.value.identity.epochOrdinal > 2
  ) {
    return { ok: false, reason: "contract_epoch_not_allowed" };
  }
  return {
    ok: true,
    checkpoint: {
      state: "attempting",
      identity: created.value.identity,
      identityDigest: created.value.identityDigest,
      reviewContractBinding: currentReviewerReportContractBinding,
      counters: { providerAttempts: 0, formatFailures: 0, transportFailures: 0 },
    },
  };
}

async function defaultDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function heartbeat(
  deps: ResumeCycleDependencies,
  leaseId: Parameters<ResumeCycleDependencies["leases"]["renew"]>[0]["leaseId"],
  intervalOverride?: number,
): Readonly<{ signal: AbortSignal; stop: () => Promise<void> }> {
  const controller = new AbortController();
  const interval = intervalOverride ?? Math.floor(defaultLeaseDurationMs / 3);
  let pending: Promise<void> | undefined;
  const renew = () => {
    if (controller.signal.aborted || pending !== undefined) return;
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
  if (!Number.isSafeInteger(interval) || interval <= 0) controller.abort();
  const timer = setInterval(renew, interval);
  timer.unref();
  return Object.freeze({
    signal: controller.signal,
    async stop() {
      clearInterval(timer);
      await pending;
    },
  });
}

function leaseWasLost(signal: AbortSignal): boolean {
  return signal.aborted;
}

const finalReviewNextStep =
  "審查回合已達上限，請人工檢視 Reviewer 意見與變更請求 diff 後決定下一步。";

interface FinalReviewAdmission {
  readonly inspection: ReplayInspection;
  readonly checkpoint: CheckpointReadReceipt;
  readonly identity: FinalReviewRecoveryIdentity;
  readonly identityDigest: string;
}

function finalBaseFrom(
  record: FinalReviewRecoveryRecord,
): Pick<
  FinalReviewRecoveryRecord,
  "jobId" | "identity" | "identityDigest" | "preProviderFailures"
> {
  return {
    jobId: record.jobId,
    identity: record.identity,
    identityDigest: record.identityDigest,
    preProviderFailures: record.preProviderFailures,
  };
}

function finalBlocked(
  jobId: string,
  reason: ReviewerReplayBlockedReason,
  errorCode?: string,
): ReviewerReplayOutcome {
  return {
    state: "blocked",
    jobId,
    reason,
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function finalLifecycleFingerprintMatches(
  record: JobProgressRecord,
  checkpoint: CheckpointReadReceipt["checkpoint"],
): boolean {
  const lifecycle = record.workStatusLifecycle;
  if (lifecycle?.phase !== "reviewing") return false;
  const lastReview = [...lifecycle.transitions]
    .reverse()
    .find((transition) => transition.step === "review_start");
  const agentTarget = lastReview?.agentTarget;
  if (
    lastReview?.mainTarget !== "in_review" ||
    agentTarget?.kind !== "set" ||
    agentTarget.status !== "waiting" ||
    lastReview.main.state !== "confirmed" ||
    lastReview.agent.state !== "confirmed"
  ) {
    return false;
  }
  return (
    checkpoint.createdAt >= lastReview.main.confirmedAt &&
    checkpoint.createdAt >= lastReview.agent.confirmedAt
  );
}

function finalCheckpointFingerprintMatches(
  record: JobProgressRecord,
  receipt: CheckpointReadReceipt,
  inspection: ReplayInspection,
): boolean {
  if (record.stage.kind !== "paused") return false;
  const checkpoint = receipt.checkpoint;
  const expectedChecks = inspection.checks.checks
    .map((check) => ({
      commandSummary: check.name,
      passed: check.status === "completed" && check.conclusion === "success",
    }))
    .sort((left, right) => left.commandSummary.localeCompare(right.commandSummary));
  const actualChecks = checkpoint.tests
    .map((test) => ({ commandSummary: test.commandSummary, passed: test.status === "passed" }))
    .sort((left, right) => left.commandSummary.localeCompare(right.commandSummary));
  return (
    checkpoint.id === record.stage.checkpointId &&
    checkpoint.jobId === record.jobId &&
    checkpoint.projectId === record.projectId &&
    checkpoint.issueId === record.issueId &&
    checkpoint.reason === "retry_exhausted" &&
    checkpoint.completedItems.length === 0 &&
    checkpoint.remainingItems.length === 0 &&
    checkpoint.blockers.length === 0 &&
    checkpoint.nextSteps.length === 1 &&
    checkpoint.nextSteps[0] === finalReviewNextStep &&
    checkpoint.model.provider === "dispatch-cli" &&
    checkpoint.model.model === "unassigned" &&
    checkpoint.worktree.path === record.worktreePath &&
    checkpoint.worktree.branch === record.branch &&
    checkpoint.worktree.commitSha === record.headSha &&
    checkpoint.worktree.pushed &&
    checkpoint.worktree.draftPullRequestUrl === undefined &&
    checkpoint.requirementSnapshot.requirementsDigest ===
      inspection.request.requirementSnapshot.requirementsDigest &&
    checkpoint.requirementSnapshot.issue.reviewRequirement === "code_review" &&
    inspection.checks.aggregate === "success" &&
    expectedChecks.length > 0 &&
    expectedChecks.every((check) => check.passed) &&
    JSON.stringify(actualChecks) === JSON.stringify(expectedChecks) &&
    finalLifecycleFingerprintMatches(record, checkpoint)
  );
}

async function hasActiveTargetLease(
  record: JobProgressRecord,
  deps: ResumeCycleDependencies,
): Promise<boolean | undefined> {
  const leases = await deps.leases.repository.readAll();
  if (!leases.ok) return undefined;
  const now = deps.clock.now();
  return leases.value.some(
    (lease) =>
      (lease.jobId === record.jobId || lease.issueId === record.issueId) &&
      leaseState(lease, now) === "active",
  );
}

async function inspectFinalReviewAdmission(
  record: JobProgressRecord,
  expectedCheckpoint: string,
  deps: ResumeCycleDependencies,
  checkpoints: Pick<LocalYamlCheckpointReader, "load">,
  options: Readonly<{ checkLease: boolean; allowSuccessReplay?: boolean }>,
): Promise<FinalReviewAdmission | ReviewerReplayOutcome> {
  if (
    record.stage.kind !== "paused" ||
    record.stage.checkpointId !== expectedCheckpoint ||
    record.changeRequestId === undefined ||
    record.headSha === undefined ||
    record.baseRevision === undefined ||
    (!options.allowSuccessReplay &&
      (record.reviewerReplay !== undefined || record.previousReviewerReplay !== undefined))
  ) {
    return finalBlocked(record.jobId, "job_not_eligible");
  }
  const checkpoint = await checkpoints.load(expectedCheckpoint);
  if (!checkpoint.ok) {
    return finalBlocked(record.jobId, "final_checkpoint_mismatch", checkpoint.error.code);
  }
  const inspected = await inspectReplay(record, deps);
  if (replayBlocked(inspected)) return inspected;
  if (
    inspected.request.requirementSnapshot.issue.reviewRequirement !== "code_review" ||
    requiredReviewerRoles(inspected.request).length !== 1 ||
    requiredReviewerRoles(inspected.request)[0] !== "code_reviewer" ||
    inspected.workStatus !== "in_review" ||
    inspected.changeRequest.draft ||
    inspected.changeRequest.mergeability === "conflicting" ||
    inspected.changeRequest.mergeStateStatus === "behind" ||
    inspected.request.job.attempts.reviewerFixRounds !== attemptLimits.reviewerFixRounds ||
    inspected.request.job.attempts.reviewRuns >= attemptLimits.reviewRuns
  ) {
    return finalBlocked(record.jobId, "final_review_not_supported");
  }
  if (!finalCheckpointFingerprintMatches(record, checkpoint.value, inspected)) {
    return finalBlocked(record.jobId, "final_checkpoint_mismatch");
  }
  const getCommitStatuses = deps.sourceControl.getCommitStatuses;
  if (getCommitStatuses === undefined) {
    return finalBlocked(record.jobId, "runtime_unavailable");
  }
  const statuses = await getCommitStatuses(
    { project: deps.project },
    record.headSha,
    deps.signal === undefined ? {} : { signal: deps.signal },
  );
  if (!statuses.ok || statuses.value.headSha.toLowerCase() !== record.headSha.toLowerCase()) {
    return finalBlocked(
      record.jobId,
      "authoritative_read_failed",
      statuses.ok ? undefined : statuses.error.code,
    );
  }
  const reviewStatuses = statuses.value.statuses.filter(
    (status) => status.context === "agent-team/review",
  );
  if (reviewStatuses.length !== 1 || reviewStatuses[0]?.state !== "pending") {
    return finalBlocked(record.jobId, "final_review_status_mismatch");
  }
  if (options.checkLease) {
    const active = await hasActiveTargetLease(record, deps);
    if (active === undefined) return finalBlocked(record.jobId, "authoritative_read_failed");
    if (active) return finalBlocked(record.jobId, "lease_conflict");
  }
  const identity: FinalReviewRecoveryIdentity = {
    schemaVersion: 1,
    operation: "reviewer-final-replay",
    jobId: record.jobId,
    projectId: record.projectId,
    issueId: record.issueId,
    externalIssueId: record.externalIssueId,
    changeRequestId: record.changeRequestId,
    sourceCheckpointId: expectedCheckpoint,
    sourceCheckpointDigest: checkpoint.value.sha256,
    baseRevision: record.baseRevision,
    requirementsDigest: inspected.identity.requirementsDigest,
    headSha: inspected.identity.headSha,
    diffDigest: inspected.identity.diffDigest,
    ...(inspected.identity.evidenceDigest === undefined
      ? {}
      : { evidenceDigest: inspected.identity.evidenceDigest }),
    ...(inspected.identity.publicationDigest === undefined
      ? {}
      : { publicationDigest: inspected.identity.publicationDigest }),
    reviewContractBinding: currentReviewerReportContractBinding,
  };
  const identityDigest = sha256Digest(identity);
  return identityDigest.ok
    ? {
        inspection: inspected,
        checkpoint: checkpoint.value,
        identity,
        identityDigest: identityDigest.value,
      }
    : finalBlocked(record.jobId, "identity_mismatch");
}

async function publishFormatExhaustion(
  record: JobProgressRecord,
  checkpoint: Extract<ReviewerReplayCheckpoint, { state: "attempting" }>,
  deps: ReviewerReplayCoordinatorDependencies,
  signal: AbortSignal,
): Promise<boolean> {
  if (record.changeRequestId === undefined || record.headSha === undefined) return false;
  const body = [
    "Agent Team reviewer-replay 已停止：review report 格式不符。",
    `錯誤類型數量：format=${String(checkpoint.counters.formatFailures)}，transport=${String(checkpoint.counters.transportFailures)}。`,
    "未寫入 review success，亦未觸發合併。",
  ].join("\n");
  const prefix = `reviewer-replay:${record.jobId}:${checkpoint.identityDigest}:format-exhausted`;
  const pr = await deps.publication.sourceControl.appendChangeRequestComment(
    {
      changeRequest: { project: deps.resume.project, changeRequestId: record.changeRequestId },
      expectedHeadSha: record.headSha,
      kind: "automation",
      body,
    },
    { idempotencyKey: `${prefix}:pr`, signal },
  );
  if (!pr.ok) return false;
  const linear = await deps.publication.workManagement.appendComment(
    { project: deps.resume.project, externalIssueId: record.externalIssueId },
    body,
    { idempotencyKey: `${prefix}:linear`, signal },
  );
  return linear.ok;
}

export class ReviewerReplayCoordinator {
  constructor(readonly dependencies: ReviewerReplayCoordinatorDependencies) {}

  async #runFinalReview(
    jobId: string,
    dryRun: boolean,
    expectedCheckpoint: string | undefined,
  ): Promise<ReviewerReplayOutcome> {
    const final = this.dependencies.finalReviewRecovery;
    const deps = this.dependencies.resume;
    if (final === undefined || expectedCheckpoint === undefined) {
      return finalBlocked(jobId, "runtime_unavailable");
    }
    const loaded = await deps.progress.load(jobId);
    if (!loaded.ok || loaded.value === undefined) {
      return finalBlocked(
        jobId,
        loaded.ok ? "job_not_found" : "authoritative_read_failed",
        loaded.ok ? undefined : loaded.error.code,
      );
    }
    let record = loaded.value;
    const policy = await deps.reviewerReplayPolicy?.load(record.projectId);
    if (policy === undefined || !policy.ok || policy.value?.enabled !== true) {
      return finalBlocked(
        jobId,
        policy !== undefined && !policy.ok ? "policy_read_failed" : "policy_disabled",
        policy !== undefined && !policy.ok ? policy.error.code : undefined,
      );
    }
    const claimFailure = await admissionCheck(record, deps);
    if (claimFailure !== undefined) return finalBlocked(jobId, claimFailure);
    if (deps.prepare !== undefined) {
      try {
        await deps.prepare();
      } catch {
        return finalBlocked(jobId, "runtime_unavailable");
      }
    }
    const recovery = await final.store.load(jobId);
    if (!recovery.ok) {
      return finalBlocked(jobId, "authoritative_read_failed", recovery.error.code);
    }
    if (recovery.value?.state === "provider_reserved") {
      if (dryRun) return finalBlocked(jobId, "final_provider_outcome_unknown");
    } else if (
      recovery.value !== undefined &&
      recovery.value.state !== "ready" &&
      recovery.value.state !== "review_succeeded"
    ) {
      return finalBlocked(jobId, "final_recovery_state_conflict");
    }
    const admission = await inspectFinalReviewAdmission(
      record,
      expectedCheckpoint,
      deps,
      final.checkpoints,
      { checkLease: dryRun, allowSuccessReplay: recovery.value?.state === "review_succeeded" },
    );
    if (finalAdmissionBlocked(admission)) return admission;
    if (
      recovery.value !== undefined &&
      (recovery.value.identityDigest !== admission.identityDigest ||
        JSON.stringify(recovery.value.identity) !== JSON.stringify(admission.identity))
    ) {
      return finalBlocked(jobId, "identity_mismatch");
    }
    if (dryRun) {
      return {
        state: "ready",
        jobId,
        identityDigest: admission.identityDigest,
        providerAttemptsUsed: recovery.value?.state === "review_succeeded" ? 1 : 0,
        providerAttemptsRemaining: recovery.value?.state === "review_succeeded" ? 0 : 1,
        plannedMutations: Object.freeze([
          ...(recovery.value?.state === "review_succeeded"
            ? []
            : ["final-review-reservation", "provider-attempt", "final-review-success"]),
          "review-success-checkpoint",
          "review-status",
          "auto-merge-gate",
          "lifecycle",
          "job-completion",
          "claim-release",
        ]),
      };
    }

    const lease = await deps.leases.acquire({
      jobId: record.jobId,
      issueId: record.issueId,
      holderId: deps.holderId,
    });
    if (!lease.ok) return finalBlocked(jobId, "lease_conflict");
    const beat = heartbeat(deps, lease.value.value.id, this.dependencies.leaseHeartbeatIntervalMs);
    const guardedDeps: ResumeCycleDependencies = { ...deps, signal: beat.signal };
    try {
      const current = await guardedDeps.progress.load(jobId, { signal: beat.signal });
      if (!current.ok || current.value?.revision !== record.revision) {
        return finalBlocked(jobId, "candidate_changed");
      }
      record = current.value;
      const claimUnderLease = await admissionCheck(record, guardedDeps);
      if (claimUnderLease !== undefined) return finalBlocked(jobId, claimUnderLease);
      let currentRecovery = await final.store.load(jobId, { signal: beat.signal });
      if (!currentRecovery.ok) {
        return finalBlocked(jobId, "authoritative_read_failed", currentRecovery.error.code);
      }
      if (currentRecovery.value?.state === "provider_reserved") {
        const unknown = await final.store.compareAndSwap(
          jobId,
          currentRecovery.value.revision,
          {
            ...finalBaseFrom(currentRecovery.value),
            state: "provider_outcome_unknown",
            providerRuns: 1,
            completedAt: guardedDeps.clock.now(),
          },
          { signal: beat.signal },
        );
        return finalBlocked(
          jobId,
          unknown.ok ? "final_provider_outcome_unknown" : "checkpoint_write_failed",
          unknown.ok ? undefined : unknown.error.code,
        );
      }
      if (
        currentRecovery.value !== undefined &&
        currentRecovery.value.state !== "ready" &&
        currentRecovery.value.state !== "review_succeeded"
      ) {
        return finalBlocked(jobId, "final_recovery_state_conflict");
      }
      const underLeaseAdmission = await inspectFinalReviewAdmission(
        record,
        expectedCheckpoint,
        guardedDeps,
        final.checkpoints,
        {
          checkLease: false,
          allowSuccessReplay: currentRecovery.value?.state === "review_succeeded",
        },
      );
      if (finalAdmissionBlocked(underLeaseAdmission)) return underLeaseAdmission;
      if (
        currentRecovery.value !== undefined &&
        (currentRecovery.value.identityDigest !== underLeaseAdmission.identityDigest ||
          JSON.stringify(currentRecovery.value.identity) !==
            JSON.stringify(underLeaseAdmission.identity))
      ) {
        return finalBlocked(jobId, "identity_mismatch");
      }

      if (currentRecovery.value?.state === "review_succeeded") {
        const continued = await this.#continueFinalSuccess(
          record,
          currentRecovery.value,
          underLeaseAdmission,
          guardedDeps,
        );
        return continued;
      }
      if (currentRecovery.value === undefined) {
        const initialized = await final.store.compareAndSwap(
          jobId,
          null,
          {
            state: "ready",
            jobId: record.jobId,
            identity: underLeaseAdmission.identity,
            identityDigest: underLeaseAdmission.identityDigest,
            preProviderFailures: 0,
          },
          { signal: beat.signal },
        );
        if (!initialized.ok) {
          return finalBlocked(jobId, "checkpoint_write_failed", initialized.error.code);
        }
        currentRecovery = { ok: true, value: initialized.value };
      }
      if (currentRecovery.value?.state !== "ready") {
        return finalBlocked(jobId, "final_recovery_state_conflict");
      }
      const reserved = await final.store.compareAndSwap(
        jobId,
        currentRecovery.value.revision,
        {
          ...finalBaseFrom(currentRecovery.value),
          state: "provider_reserved",
          reservedAt: guardedDeps.clock.now(),
        },
        { signal: beat.signal },
      );
      if (!reserved.ok) {
        return finalBlocked(jobId, "checkpoint_write_failed", reserved.error.code);
      }
      if (reserved.value.state !== "provider_reserved") {
        return finalBlocked(jobId, "checkpoint_write_failed");
      }
      const reviewOutcome = await guardedDeps.reviewer.run(
        withPrefix(underLeaseAdmission.inspection.request, underLeaseAdmission.identityDigest, 1),
      );
      if (leaseWasLost(beat.signal)) return finalBlocked(jobId, "lease_lost");
      if (reviewOutcome.state === "approved") {
        const replayIdentity = createReviewerReplayIdentity(record, reviewOutcome.identity, {
          schemaVersion: 2,
          epochOrdinal: 1,
        });
        if (
          !replayIdentity.ok ||
          reviewOutcome.reports.length !== 1 ||
          reviewOutcome.reports.some(
            (report) => !reviewerReportMatchesIdentity(report, reviewOutcome.identity),
          ) ||
          replayIdentity.value.identity.requirementsDigest !==
            underLeaseAdmission.identity.requirementsDigest ||
          replayIdentity.value.identity.headSha !== underLeaseAdmission.identity.headSha ||
          replayIdentity.value.identity.diffDigest !== underLeaseAdmission.identity.diffDigest ||
          replayIdentity.value.identity.evidenceDigest !==
            underLeaseAdmission.identity.evidenceDigest ||
          replayIdentity.value.identity.publicationDigest !==
            underLeaseAdmission.identity.publicationDigest
        ) {
          return finalBlocked(jobId, "identity_mismatch");
        }
        const replayAttempt: Extract<ReviewerReplayCheckpoint, { state: "attempting" }> = {
          state: "attempting",
          identity: replayIdentity.value.identity,
          identityDigest: replayIdentity.value.identityDigest,
          reviewContractBinding: currentReviewerReportContractBinding,
          counters: { providerAttempts: 1, formatFailures: 0, transportFailures: 0 },
        };
        const checkpoint = createReviewerReplaySuccessCheckpoint(
          replayAttempt,
          reviewOutcome.reports,
          guardedDeps.clock.now(),
        );
        if (!checkpoint.ok) return finalBlocked(jobId, "checkpoint_write_failed");
        const success = await final.store.compareAndSwap(
          jobId,
          reserved.value.revision,
          {
            ...finalBaseFrom(reserved.value),
            state: "review_succeeded",
            providerRuns: 1,
            completedAt: guardedDeps.clock.now(),
            reports: [...reviewOutcome.reports],
            reportDigests: [...checkpoint.value.reportDigests],
            reviewerReplayCheckpointDigest: checkpoint.value.checkpointDigest,
          },
          { signal: beat.signal },
        );
        if (!success.ok) {
          return finalBlocked(jobId, "checkpoint_write_failed", success.error.code);
        }
        if (success.value.state !== "review_succeeded") {
          return finalBlocked(jobId, "checkpoint_write_failed");
        }
        return await this.#continueFinalSuccess(
          record,
          success.value,
          underLeaseAdmission,
          guardedDeps,
        );
      }
      return await this.#finishFinalFailure(
        record,
        reserved.value,
        reviewOutcome,
        underLeaseAdmission,
        guardedDeps,
      );
    } finally {
      await beat.stop();
      await deps.leases.release({ leaseId: lease.value.value.id, holderId: deps.holderId });
    }
  }

  async #continueFinalSuccess(
    record: JobProgressRecord,
    recovery: Extract<FinalReviewRecoveryRecord, { state: "review_succeeded" }>,
    admission: FinalReviewAdmission,
    deps: ResumeCycleDependencies,
  ): Promise<ReviewerReplayOutcome> {
    let current = record;
    if (current.reviewerReplay === undefined) {
      const replayIdentity = createReviewerReplayIdentity(current, admission.inspection.identity, {
        schemaVersion: 2,
        epochOrdinal: 1,
      });
      if (!replayIdentity.ok) return finalBlocked(record.jobId, "identity_mismatch");
      const replayAttempt: Extract<ReviewerReplayCheckpoint, { state: "attempting" }> = {
        state: "attempting",
        identity: replayIdentity.value.identity,
        identityDigest: replayIdentity.value.identityDigest,
        reviewContractBinding: currentReviewerReportContractBinding,
        counters: { providerAttempts: 1, formatFailures: 0, transportFailures: 0 },
      };
      const checkpoint = createReviewerReplaySuccessCheckpoint(
        replayAttempt,
        recovery.reports,
        recovery.completedAt,
      );
      if (
        !checkpoint.ok ||
        checkpoint.value.checkpointDigest !== recovery.reviewerReplayCheckpointDigest ||
        JSON.stringify(checkpoint.value.reportDigests) !== JSON.stringify(recovery.reportDigests)
      ) {
        return finalBlocked(record.jobId, "identity_mismatch");
      }
      const written = await deps.progress.compareAndSwap(
        record.jobId,
        record.revision,
        { ...mutationFrom(record), reviewerReplay: checkpoint.value },
        deps.signal === undefined ? {} : { signal: deps.signal },
      );
      if (!written.ok) {
        return finalBlocked(record.jobId, "checkpoint_write_failed", written.error.code);
      }
      current = written.value;
    } else if (
      current.reviewerReplay.state !== "review_succeeded" ||
      current.reviewerReplay.checkpointDigest !== recovery.reviewerReplayCheckpointDigest ||
      current.previousReviewerReplay !== undefined
    ) {
      return finalBlocked(record.jobId, "identity_mismatch");
    }
    const replay = current.reviewerReplay;
    if (replay?.state !== "review_succeeded") {
      return finalBlocked(record.jobId, "checkpoint_write_failed");
    }
    const continued = await resumeUnderLease(current, deps);
    return {
      state: "continued",
      jobId: record.jobId,
      identityDigest: recovery.identityDigest,
      checkpointDigest: replay.checkpointDigest,
      providerAttempts: 1,
      outcome: continued,
    };
  }

  async #finishFinalFailure(
    record: JobProgressRecord,
    reserved: Extract<FinalReviewRecoveryRecord, { state: "provider_reserved" }>,
    reviewOutcome: ReviewerPipelineOutcome,
    admission: FinalReviewAdmission,
    deps: ResumeCycleDependencies,
  ): Promise<ReviewerReplayOutcome> {
    const store = this.dependencies.finalReviewRecovery?.store;
    if (store === undefined) return finalBlocked(record.jobId, "runtime_unavailable");
    let next: FinalReviewRecoveryRecordMutation;
    if (reviewOutcome.state === "not_ready") {
      next = {
        ...finalBaseFrom(reserved),
        state: "ready",
        preProviderFailures: reserved.preProviderFailures + 1,
        lastPreProviderFailure: { kind: "not_ready", stage: "checks" },
      };
    } else if (
      reviewOutcome.state === "failed" &&
      ["request", "change_request", "checks", "worktree", "diff", "ready"].includes(
        reviewOutcome.stage,
      )
    ) {
      next = {
        ...finalBaseFrom(reserved),
        state: "ready",
        preProviderFailures: reserved.preProviderFailures + 1,
        lastPreProviderFailure: {
          kind: "failed",
          stage: reviewOutcome.stage as
            "request" | "change_request" | "checks" | "worktree" | "diff" | "ready",
          errorCode: reviewOutcome.error.code,
        },
      };
    } else if (
      reviewOutcome.state === "changes_requested" ||
      reviewOutcome.state === "clarification_required"
    ) {
      next = {
        ...finalBaseFrom(reserved),
        state: "review_not_approved",
        providerRuns: 1,
        completedAt: deps.clock.now(),
        verdict: reviewOutcome.state,
      };
    } else if (reviewOutcome.state === "paused") {
      next = {
        ...finalBaseFrom(reserved),
        state: "provider_paused",
        providerRuns: 1,
        completedAt: deps.clock.now(),
        reason: reviewOutcome.reason,
      };
    } else if (reviewOutcome.state === "failed" && reviewOutcome.stage === "report") {
      next = {
        ...finalBaseFrom(reserved),
        state: "report_failed",
        providerRuns: 1,
        completedAt: deps.clock.now(),
        category: reviewOutcome.reportFailureCategory ?? "schema_invalid",
        diagnosticCount: reviewOutcome.diagnostics?.length ?? 0,
      };
    } else {
      next = {
        ...finalBaseFrom(reserved),
        state: "provider_failed",
        providerRuns: 1,
        completedAt: deps.clock.now(),
        stage:
          reviewOutcome.state === "failed"
            ? (reviewOutcome.stage as
                | "evidence"
                | "checkpoint"
                | "provider_start"
                | "provider_run"
                | "tool_decision"
                | "post_review_worktree"
                | "attempt_persistence")
            : "unknown",
        errorCode:
          reviewOutcome.state === "failed" ? reviewOutcome.error.code : "invariant_violation",
      };
    }
    const written = await store.compareAndSwap(
      record.jobId,
      reserved.revision,
      next,
      deps.signal === undefined ? {} : { signal: deps.signal },
    );
    if (!written.ok) {
      return finalBlocked(record.jobId, "checkpoint_write_failed", written.error.code);
    }
    if (reviewOutcome.state === "failed" && reviewOutcome.stage === "report") {
      const diagnostic = await this.dependencies.diagnostics.append(
        record.jobId,
        admission.identityDigest,
        {
          attempt: 1,
          kind: "format",
          category: reviewOutcome.reportFailureCategory ?? "schema_invalid",
          diagnostics: [...(reviewOutcome.diagnostics ?? [])],
        },
        { epochScoped: true },
      );
      if (!diagnostic.ok) {
        return finalBlocked(record.jobId, "diagnostic_write_failed", diagnostic.error.code);
      }
    }
    return finalBlocked(
      record.jobId,
      next.state === "ready" ? "final_pre_provider_failure" : "review_not_approved",
      reviewOutcome.state === "failed" ? reviewOutcome.error.code : undefined,
    );
  }

  async run(
    jobId: string,
    dryRun: boolean,
    options: ReviewerReplayRunOptions = {},
  ): Promise<ReviewerReplayOutcome> {
    if (options.finalReviewEpoch === true) {
      return this.#runFinalReview(jobId, dryRun, options.expectCheckpoint);
    }
    const deps = this.dependencies.resume;
    const newContractEpoch = options.newContractEpoch === true;
    if (
      newContractEpoch &&
      options.expectContractVersion !== currentReviewerReportContractBinding.version
    ) {
      return { state: "blocked", jobId, reason: "contract_version_mismatch" };
    }
    if (newContractEpoch && !currentContractGoldenIsValid()) {
      return { state: "blocked", jobId, reason: "contract_digest_mismatch" };
    }
    const loaded = await deps.progress.load(jobId);
    if (!loaded.ok || loaded.value === undefined) {
      return {
        state: "blocked",
        jobId,
        reason: loaded.ok ? "job_not_found" : "authoritative_read_failed",
        ...(!loaded.ok ? { errorCode: loaded.error.code } : {}),
      };
    }
    let record = loaded.value;
    if (!exactReplayCause(record)) {
      return { state: "blocked", jobId, reason: "job_not_eligible" };
    }
    const policy = await deps.reviewerReplayPolicy?.load(record.projectId);
    if (policy === undefined || !policy.ok || policy.value?.enabled !== true) {
      return {
        state: "blocked",
        jobId,
        reason: policy !== undefined && !policy.ok ? "policy_read_failed" : "policy_disabled",
        ...(policy !== undefined && !policy.ok ? { errorCode: policy.error.code } : {}),
      };
    }
    const claimFailure = await admissionCheck(record, deps);
    if (claimFailure !== undefined) return { state: "blocked", jobId, reason: claimFailure };
    if (deps.prepare !== undefined) {
      try {
        await deps.prepare();
      } catch {
        return { state: "blocked", jobId, reason: "runtime_unavailable" };
      }
    }
    if (dryRun) {
      const inspected = await inspectReplay(record, deps);
      if (replayBlocked(inspected)) return inspected;
      if (
        record.reviewerReplay !== undefined &&
        !replayIdentityMatches(record.reviewerReplay, inspected.replayIdentity)
      ) {
        return { state: "blocked", jobId, reason: "identity_mismatch" };
      }
      if (newContractEpoch) {
        const candidate = contractEpochCheckpoint(record, inspected);
        if (!candidate.ok) {
          return { state: "blocked", jobId, reason: candidate.reason };
        }
        return {
          state: "ready",
          jobId,
          identityDigest: candidate.checkpoint.identityDigest,
          providerAttemptsUsed: 0,
          providerAttemptsRemaining: maximumReplayAttempts,
          plannedMutations: Object.freeze([
            "archive-reviewer-replay-epoch",
            "create-reviewer-contract-epoch",
            "provider-attempt",
            "review-success-checkpoint",
            "review-status",
            "auto-merge-gate",
            "lifecycle",
            "job-completion",
            "claim-release",
          ]),
        };
      }
      const used = record.reviewerReplay?.counters.providerAttempts ?? 0;
      const requiredProviderInvocations = requiredReviewerRoles(inspected.request).length;
      if (record.reviewerReplay?.state === "attempting" && used >= maximumReplayAttempts) {
        return {
          state: "blocked",
          jobId,
          reason: "attempts_exhausted",
          providerAttempts: used,
          formatFailures: record.reviewerReplay.counters.formatFailures,
          transportFailures: record.reviewerReplay.counters.transportFailures,
        };
      }
      if (
        record.reviewerReplay?.state !== "review_succeeded" &&
        (requiredProviderInvocations === 0 ||
          used + requiredProviderInvocations > maximumReplayAttempts)
      ) {
        return {
          state: "blocked",
          jobId,
          reason: "provider_budget_insufficient",
          providerAttempts: used,
        };
      }
      return {
        state: "ready",
        jobId,
        identityDigest: inspected.replayIdentity.identityDigest,
        providerAttemptsUsed: used,
        providerAttemptsRemaining:
          record.reviewerReplay?.state === "review_succeeded"
            ? 0
            : Math.max(0, maximumReplayAttempts - used),
        plannedMutations: Object.freeze([
          ...(record.reviewerReplay?.state === "review_succeeded"
            ? []
            : ["provider-attempt", "review-success-checkpoint"]),
          "review-status",
          "auto-merge-gate",
          "lifecycle",
          "job-completion",
          "claim-release",
        ]),
      };
    }

    const lease = await deps.leases.acquire({
      jobId: record.jobId,
      issueId: record.issueId,
      holderId: deps.holderId,
    });
    if (!lease.ok) return { state: "blocked", jobId, reason: "lease_conflict" };
    const beat = heartbeat(deps, lease.value.value.id, this.dependencies.leaseHeartbeatIntervalMs);
    const guardedDeps: ResumeCycleDependencies = { ...deps, signal: beat.signal };
    try {
      const current = await guardedDeps.progress.load(jobId, { signal: beat.signal });
      if (!current.ok || current.value?.revision !== record.revision) {
        return { state: "blocked", jobId, reason: "candidate_changed" };
      }
      record = current.value;
      const claimUnderLease = await admissionCheck(record, guardedDeps);
      if (claimUnderLease !== undefined) {
        return { state: "blocked", jobId, reason: claimUnderLease };
      }
      const existingCheckpoint = record.reviewerReplay;
      if (newContractEpoch && existingCheckpoint?.state === "review_succeeded") {
        return { state: "blocked", jobId, reason: "contract_epoch_not_allowed" };
      }
      if (
        isReviewerReplayCheckpointReconcilable(record) &&
        existingCheckpoint?.state === "review_succeeded"
      ) {
        const continued = await resumeUnderLease(record, guardedDeps);
        return {
          state: "continued",
          jobId,
          identityDigest: existingCheckpoint.identityDigest,
          checkpointDigest: existingCheckpoint.checkpointDigest,
          providerAttempts: existingCheckpoint.counters.providerAttempts,
          outcome: continued,
        };
      }

      let createContractEpoch = newContractEpoch;
      while (!beat.signal.aborted) {
        let inspected = await inspectReplay(record, guardedDeps, beat.signal);
        if (replayBlocked(inspected)) return inspected;
        if (
          record.reviewerReplay !== undefined &&
          !replayIdentityMatches(record.reviewerReplay, inspected.replayIdentity)
        ) {
          return { state: "blocked", jobId, reason: "identity_mismatch" };
        }
        if (createContractEpoch) {
          const candidate = contractEpochCheckpoint(record, inspected);
          if (!candidate.ok || record.reviewerReplay === undefined) {
            return {
              state: "blocked",
              jobId,
              reason: candidate.ok ? "contract_epoch_not_allowed" : candidate.reason,
            };
          }
          const archived = await guardedDeps.progress.compareAndSwap(
            jobId,
            record.revision,
            {
              ...mutationFrom(record),
              previousReviewerReplay: record.reviewerReplay,
              reviewerReplay: candidate.checkpoint,
            },
            { signal: beat.signal },
          );
          if (!archived.ok) {
            return {
              state: "blocked",
              jobId,
              reason: "checkpoint_write_failed",
              errorCode: archived.error.code,
            };
          }
          record = archived.value;
          createContractEpoch = false;
          inspected = await inspectReplay(record, guardedDeps, beat.signal);
          if (replayBlocked(inspected)) return inspected;
        }
        let replay = record.reviewerReplay;
        if (replay === undefined) {
          const initialized = await guardedDeps.progress.compareAndSwap(
            jobId,
            record.revision,
            { ...mutationFrom(record), reviewerReplay: initialCheckpoint(inspected) },
            { signal: beat.signal },
          );
          if (!initialized.ok) {
            return {
              state: "blocked",
              jobId,
              reason: "checkpoint_write_failed",
              errorCode: initialized.error.code,
            };
          }
          record = initialized.value;
          replay = record.reviewerReplay;
        }
        if (replay === undefined || !replayIdentityMatches(replay, inspected.replayIdentity)) {
          return { state: "blocked", jobId, reason: "identity_mismatch" };
        }
        if (replay.state === "review_succeeded") {
          const continued = await resumeUnderLease(record, guardedDeps);
          return {
            state: "continued",
            jobId,
            identityDigest: replay.identityDigest,
            checkpointDigest: replay.checkpointDigest,
            providerAttempts: replay.counters.providerAttempts,
            outcome: continued,
          };
        }
        if (replay.counters.providerAttempts >= maximumReplayAttempts) {
          if (replay.counters.formatFailures > 0) {
            const published = await publishFormatExhaustion(
              record,
              replay,
              this.dependencies,
              beat.signal,
            );
            if (!published) {
              return { state: "blocked", jobId, reason: "public_summary_failed" };
            }
          }
          return {
            state: "blocked",
            jobId,
            reason: "attempts_exhausted",
            providerAttempts: replay.counters.providerAttempts,
            formatFailures: replay.counters.formatFailures,
            transportFailures: replay.counters.transportFailures,
          };
        }
        const requiredProviderInvocations = requiredReviewerRoles(inspected.request).length;
        if (
          requiredProviderInvocations === 0 ||
          replay.counters.providerAttempts + requiredProviderInvocations > maximumReplayAttempts
        ) {
          return {
            state: "blocked",
            jobId,
            reason: "provider_budget_insufficient",
            providerAttempts: replay.counters.providerAttempts,
          };
        }
        const attempt = replay.counters.providerAttempts + 1;
        const attempting: Extract<ReviewerReplayCheckpoint, { state: "attempting" }> = {
          ...replay,
          counters: {
            ...replay.counters,
            providerAttempts: replay.counters.providerAttempts + requiredProviderInvocations,
          },
        };
        const reserved = await guardedDeps.progress.compareAndSwap(
          jobId,
          record.revision,
          { ...mutationFrom(record), reviewerReplay: attempting },
          { signal: beat.signal },
        );
        if (!reserved.ok) {
          return {
            state: "blocked",
            jobId,
            reason: "checkpoint_write_failed",
            errorCode: reserved.error.code,
          };
        }
        record = reserved.value;
        const category = replay.lastFormatCategory;
        const reviewOutcome: ReviewerPipelineOutcome = await guardedDeps.reviewer.run(
          withPrefix(
            inspected.request,
            replay.identityDigest,
            attempt,
            category === undefined ? undefined : { category },
          ),
        );
        if (leaseWasLost(beat.signal)) {
          return { state: "blocked", jobId, reason: "lease_lost" };
        }
        if (reviewOutcome.state === "approved") {
          const currentReplay = record.reviewerReplay;
          if (currentReplay?.state !== "attempting") {
            return { state: "blocked", jobId, reason: "checkpoint_write_failed" };
          }
          const approvedIdentity = createReviewerReplayIdentityForCheckpoint(
            record,
            reviewOutcome.identity,
            currentReplay,
          );
          if (
            !approvedIdentity.ok ||
            !replayIdentityMatches(currentReplay, approvedIdentity.value) ||
            reviewOutcome.reports.some(
              (report) => !reviewerReportMatchesIdentity(report, reviewOutcome.identity),
            )
          ) {
            return { state: "blocked", jobId, reason: "identity_mismatch" };
          }
          const checkpoint = createReviewerReplaySuccessCheckpoint(
            currentReplay,
            reviewOutcome.reports,
            guardedDeps.clock.now(),
          );
          if (!checkpoint.ok) {
            return { state: "blocked", jobId, reason: "checkpoint_write_failed" };
          }
          const written = await guardedDeps.progress.compareAndSwap(
            jobId,
            record.revision,
            { ...mutationFrom(record), reviewerReplay: checkpoint.value },
            { signal: beat.signal },
          );
          if (!written.ok) {
            return {
              state: "blocked",
              jobId,
              reason: "checkpoint_write_failed",
              errorCode: written.error.code,
            };
          }
          record = written.value;
          const continued = await resumeUnderLease(record, guardedDeps);
          return {
            state: "continued",
            jobId,
            identityDigest: checkpoint.value.identityDigest,
            checkpointDigest: checkpoint.value.checkpointDigest,
            providerAttempts: checkpoint.value.counters.providerAttempts,
            outcome: continued,
          };
        }

        const currentReplay = record.reviewerReplay;
        if (currentReplay?.state !== "attempting") {
          return { state: "blocked", jobId, reason: "checkpoint_write_failed" };
        }
        let next: Extract<ReviewerReplayCheckpoint, { state: "attempting" }>;
        if (reviewOutcome.state === "failed" && reviewOutcome.stage === "report") {
          const category = reviewOutcome.reportFailureCategory ?? "schema_invalid";
          next = {
            ...currentReplay,
            counters: {
              ...currentReplay.counters,
              formatFailures: currentReplay.counters.formatFailures + 1,
            },
            lastFormatCategory: category,
            diagnosticCount: reviewOutcome.diagnostics?.length ?? 0,
          };
          const diagnostic = await this.dependencies.diagnostics.append(
            jobId,
            currentReplay.identityDigest,
            {
              attempt,
              kind: "format",
              category,
              diagnostics: [...(reviewOutcome.diagnostics ?? [])],
            },
            { epochScoped: currentReplay.identity.schemaVersion === 2 },
          );
          if (!diagnostic.ok) {
            return {
              state: "blocked",
              jobId,
              reason: "diagnostic_write_failed",
              errorCode: diagnostic.error.code,
            };
          }
        } else if (
          reviewOutcome.state === "failed" &&
          reviewOutcome.error.retryable &&
          (reviewOutcome.stage === "provider_start" || reviewOutcome.stage === "provider_run")
        ) {
          next = {
            ...currentReplay,
            counters: {
              ...currentReplay.counters,
              transportFailures: currentReplay.counters.transportFailures + 1,
            },
            lastTransportErrorCode: reviewOutcome.error.code,
          };
          const diagnostic = await this.dependencies.diagnostics.append(
            jobId,
            currentReplay.identityDigest,
            {
              attempt,
              kind: "transport",
              errorCode: reviewOutcome.error.code,
              diagnostics: [],
            },
            { epochScoped: currentReplay.identity.schemaVersion === 2 },
          );
          if (!diagnostic.ok) {
            return {
              state: "blocked",
              jobId,
              reason: "diagnostic_write_failed",
              errorCode: diagnostic.error.code,
            };
          }
        } else {
          return {
            state: "blocked",
            jobId,
            reason: "review_not_approved",
            providerAttempts: currentReplay.counters.providerAttempts,
          };
        }
        const failedPersisted = await guardedDeps.progress.compareAndSwap(
          jobId,
          record.revision,
          { ...mutationFrom(record), reviewerReplay: next },
          { signal: beat.signal },
        );
        if (!failedPersisted.ok) {
          return {
            state: "blocked",
            jobId,
            reason: "checkpoint_write_failed",
            errorCode: failedPersisted.error.code,
          };
        }
        record = failedPersisted.value;
        if (next.counters.providerAttempts >= maximumReplayAttempts) {
          if (next.counters.formatFailures > 0) {
            const published = await publishFormatExhaustion(
              record,
              next,
              this.dependencies,
              beat.signal,
            );
            if (!published) {
              return { state: "blocked", jobId, reason: "public_summary_failed" };
            }
          }
          return {
            state: "blocked",
            jobId,
            reason: "attempts_exhausted",
            providerAttempts: next.counters.providerAttempts,
            formatFailures: next.counters.formatFailures,
            transportFailures: next.counters.transportFailures,
          };
        }
        if (next.lastTransportErrorCode !== undefined) {
          await (this.dependencies.delay ?? defaultDelay)(transportRetryBackoffMs, beat.signal);
        }
      }
      return { state: "blocked", jobId, reason: "lease_lost" };
    } finally {
      await beat.stop();
      await deps.leases.release({ leaseId: lease.value.value.id, holderId: deps.holderId });
    }
  }
}
