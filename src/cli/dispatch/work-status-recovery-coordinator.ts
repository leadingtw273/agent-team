import type {
  FileJobProgressStore,
  JobProgressRecord,
} from "../../adapters/dispatch/job-progress-store.js";
import type { IssueAdmissionPort } from "../../adapters/dispatch/issue-admission-store.js";
import type { JobRepository } from "../../application/dispatch/index.js";
import type { LeaseCoordinator } from "../../application/leases/index.js";
import {
  createWorkStatusLifecycleTransitionInstance,
  type IssueScopeLockPort,
  type IssueScopeLockHandle,
  type WorkStatusHistoryPort,
  type WorkStatusHistorySnapshot,
  type WorkStatusLifecycleCoordinator,
  type WorkStatusLifecycleTransition,
} from "../../application/pipelines/index.js";
import type { WorkManagementPort } from "../../application/ports/index.js";
import type { WorkManagementIssueSnapshot } from "../../application/ports/index.js";
import { createClock, ok, type Clock } from "../../domain/foundation/index.js";
import { sha256Digest } from "../../domain/review/index.js";
import type { Project } from "../../domain/project/index.js";
import type { FileJobRepository } from "../../infrastructure/jobs/index.js";

type RecoveryWorkManagement = Pick<WorkManagementPort, "getIssue"> & WorkStatusHistoryPort;
type RecoveryJobRepository = JobRepository & Pick<FileJobRepository, "readAll">;

export type WorkStatusRecoveryOutcome =
  | Readonly<{
      state: "ready";
      dryRun: true;
      jobId: string;
      transitionInstance: string;
      disposition: "target_observed" | "pre_state_reissued" | "pre_state_retained";
      plannedMutation: "operator_receipt_only" | "new_bounded_transition";
    }>
  | Readonly<{
      state: "recovered";
      dryRun: false;
      jobId: string;
      transitionInstance: string;
      disposition: "target_observed" | "pre_state_reissued" | "pre_state_retained";
    }>
  | Readonly<{
      state: "blocked";
      reason:
        | "job_not_found"
        | "job_not_eligible"
        | "job_identity_mismatch"
        | "claim_mismatch"
        | "lease_conflict"
        | "lock_conflict"
        | "transition_not_found"
        | "transition_not_recoverable"
        | "history_unavailable"
        | "history_identity_mismatch"
        | "issue_identity_mismatch"
        | "issue_archived_or_trashed"
        | "work_status_not_recoverable"
        | "checkpoint_conflict"
        | "transition_failed";
    }>
  | Readonly<{ state: "failed"; reason: "read_failed" | "lease_release_failed" }>;

export interface WorkStatusRecoveryDependencies {
  readonly progress: Pick<FileJobProgressStore, "load" | "compareAndSwap">;
  readonly jobs: RecoveryJobRepository;
  readonly admission: Pick<IssueAdmissionPort, "load">;
  readonly leases: Pick<LeaseCoordinator, "acquire" | "release">;
  readonly locks: IssueScopeLockPort;
  readonly workManagement: RecoveryWorkManagement;
  readonly lifecycle: Pick<
    WorkStatusLifecycleCoordinator,
    "transition" | "transitionWhileLockHeld"
  >;
  readonly project: Project;
  readonly clock?: Clock;
}

function phaseFor(transition: WorkStatusLifecycleTransition) {
  switch (transition.step) {
    case "work_start":
      return "work_start" as const;
    case "review_start":
      return "reviewing" as const;
    case "fix_start":
      return "fixing" as const;
    case "merge_start":
      return "merging" as const;
    case "complete":
    case "requires_manual":
    case "clear_condition":
      return "terminal" as const;
  }
}

function restoredStage(transition: WorkStatusLifecycleTransition): JobProgressRecord["stage"] {
  switch (transition.step) {
    case "work_start":
      return { kind: "work_start_pending" };
    case "complete":
      return { kind: "merging" };
    case "review_start":
    case "fix_start":
    case "merge_start":
    case "requires_manual":
    case "clear_condition":
      return { kind: "awaiting_review" };
  }
}

function mutation(record: JobProgressRecord, stage: JobProgressRecord["stage"] = record.stage) {
  const {
    schemaVersion: _schemaVersion,
    revision: _revision,
    updatedAt: _updatedAt,
    ...rest
  } = record;
  void _schemaVersion;
  void _revision;
  void _updatedAt;
  return { ...rest, stage };
}

function historyPrefixMatches(
  transition: WorkStatusLifecycleTransition,
  history: Awaited<ReturnType<WorkStatusHistoryPort["getIssueHistory"]>>,
): boolean {
  const evidence = transition.historyEvidence;
  if (!history.ok || evidence === undefined) return false;
  if (history.value.entries.length < evidence.historyEntryCount) return false;
  const prefix = history.value.entries.slice(0, evidence.historyEntryCount);
  const digest = sha256Digest({ schemaVersion: 1, entries: prefix });
  if (!digest.ok || digest.value !== evidence.historyPrefixDigest) return false;
  if (evidence.historyTailId !== undefined && prefix.at(-1)?.id !== evidence.historyTailId) {
    return false;
  }
  return history.value.stateSpans.some(
    (span) => span.id === evidence.preStateSpanId && span.stateId === evidence.preStateId,
  );
}

type RecoverySourceShape = "sent_unknown" | "fix_start_intent" | "confirmed_manual_handoff";

function recoverySourceShape(
  record: JobProgressRecord,
  transition: WorkStatusLifecycleTransition,
): RecoverySourceShape | undefined {
  if (transition.main.state === "sent_unknown") return "sent_unknown";
  if (
    transition.step === "fix_start" &&
    transition.main.state === "intent" &&
    transition.mainFailures.count > 0 &&
    transition.mainFailures.count < 6 &&
    transition.mainFailures.lastErrorCode === "conflict"
  ) {
    return "fix_start_intent";
  }
  if (
    record.stage.kind === "requires_manual" &&
    record.stage.cause?.stage === "review" &&
    record.workStatusLifecycle?.transitions.at(-1)?.instance === transition.instance &&
    transition.step === "requires_manual" &&
    transition.mainTarget === "requires_manual" &&
    transition.allowedMainSources?.length === 1 &&
    transition.allowedMainSources[0] === "in_review" &&
    transition.main.state === "confirmed" &&
    transition.agent.state === "confirmed"
  ) {
    return "confirmed_manual_handoff";
  }
  return undefined;
}

function preStateSpanIsOpen(
  transition: WorkStatusLifecycleTransition,
  history: WorkStatusHistorySnapshot,
): boolean {
  const evidence = transition.historyEvidence;
  return (
    evidence !== undefined &&
    history.stateSpans.some(
      (span) =>
        span.id === evidence.preStateSpanId &&
        span.stateId === evidence.preStateId &&
        span.endedAt === null,
    )
  );
}

function classifyRecoveryState(
  record: JobProgressRecord,
  transition: WorkStatusLifecycleTransition,
  sourceShape: RecoverySourceShape,
  issue: WorkManagementIssueSnapshot,
  history: WorkStatusHistorySnapshot,
):
  | Readonly<{
      ok: true;
      disposition: "target_observed" | "pre_state_reissued" | "pre_state_retained";
    }>
  | Readonly<{
      ok: false;
      reason:
        | "history_identity_mismatch"
        | "issue_identity_mismatch"
        | "issue_archived_or_trashed"
        | "work_status_not_recoverable";
    }> {
  if (
    issue.issue.projectId !== record.projectId ||
    issue.issue.externalId !== record.externalIssueId ||
    history.currentStateId !== issue.workStatusStateId
  ) {
    return { ok: false, reason: "issue_identity_mismatch" };
  }
  if (issue.archivedAt !== undefined || issue.trashed === true) {
    return { ok: false, reason: "issue_archived_or_trashed" };
  }
  if (!historyPrefixMatches(transition, ok(history))) {
    return { ok: false, reason: "history_identity_mismatch" };
  }
  const atTarget = issue.workStatus === transition.mainTarget;
  const atPreState =
    issue.workStatusStateId === transition.historyEvidence?.preStateId &&
    transition.allowedMainSources?.includes(issue.workStatus) === true;
  if (sourceShape === "confirmed_manual_handoff") {
    return atPreState
      ? { ok: true, disposition: "pre_state_retained" }
      : { ok: false, reason: "work_status_not_recoverable" };
  }
  if (sourceShape === "fix_start_intent") {
    return atPreState && preStateSpanIsOpen(transition, history)
      ? { ok: true, disposition: "pre_state_retained" }
      : { ok: false, reason: "work_status_not_recoverable" };
  }
  return atTarget
    ? { ok: true, disposition: "target_observed" }
    : atPreState
      ? { ok: true, disposition: "pre_state_reissued" }
      : { ok: false, reason: "work_status_not_recoverable" };
}

export class WorkStatusRecoveryCoordinator {
  readonly #clock: Clock;

  constructor(readonly dependencies: WorkStatusRecoveryDependencies) {
    this.#clock = dependencies.clock ?? createClock();
  }

  async run(
    input: Readonly<{
      jobId: string;
      transitionInstance: string;
      holderId: string;
      dryRun: boolean;
    }>,
  ): Promise<WorkStatusRecoveryOutcome> {
    const loaded = await this.dependencies.progress.load(input.jobId);
    if (!loaded.ok) return { state: "failed", reason: "read_failed" };
    const record = loaded.value;
    if (record === undefined) return { state: "blocked", reason: "job_not_found" };
    if (
      record.stage.kind !== "requires_manual" ||
      record.stage.cause?.reasonCode !== "work_status_lifecycle_failed" ||
      record.workStatusLifecycle?.admissionMode !== "enforce"
    ) {
      return { state: "blocked", reason: "job_not_eligible" };
    }
    const jobs = await this.dependencies.jobs.readAll();
    if (!jobs.ok) return { state: "failed", reason: "read_failed" };
    const job = jobs.value.find((candidate) => candidate.id === input.jobId);
    if (
      job === undefined ||
      this.dependencies.project.id !== record.projectId ||
      job.projectId !== record.projectId ||
      job.issueId !== record.issueId
    ) {
      return { state: "blocked", reason: "job_identity_mismatch" };
    }
    const claim = await this.dependencies.admission.load(record.projectId, record.issueId);
    if (
      !claim.ok ||
      claim.value?.state !== "active" ||
      claim.value.jobId !== record.jobId ||
      claim.value.externalIssueId !== record.externalIssueId
    ) {
      return { state: "blocked", reason: "claim_mismatch" };
    }
    const transition = record.workStatusLifecycle.transitions.find(
      (candidate) => candidate.instance === input.transitionInstance,
    );
    if (transition === undefined) return { state: "blocked", reason: "transition_not_found" };
    const sourceShape = recoverySourceShape(record, transition);
    if (
      sourceShape === undefined ||
      transition.mainTarget === undefined ||
      transition.historyEvidence === undefined ||
      transition.allowedMainSources === undefined
    ) {
      return { state: "blocked", reason: "transition_not_recoverable" };
    }
    const reference = {
      project: this.dependencies.project,
      externalIssueId: record.externalIssueId,
    };
    const issue = await this.dependencies.workManagement.getIssue(reference);
    const history = await this.dependencies.workManagement.getIssueHistory(reference);
    if (!issue.ok || !history.ok) return { state: "blocked", reason: "history_unavailable" };
    const classified = classifyRecoveryState(
      record,
      transition,
      sourceShape,
      issue.value,
      history.value,
    );
    if (!classified.ok) return { state: "blocked", reason: classified.reason };
    const disposition = classified.disposition;
    if (input.dryRun) {
      return {
        state: "ready",
        dryRun: true,
        jobId: record.jobId,
        transitionInstance: transition.instance,
        disposition,
        plannedMutation:
          disposition === "pre_state_reissued" ? "new_bounded_transition" : "operator_receipt_only",
      };
    }

    const lease = await this.dependencies.leases.acquire({
      jobId: job.id,
      issueId: job.issueId,
      holderId: input.holderId,
    });
    if (!lease.ok) return { state: "blocked", reason: "lease_conflict" };
    let outcome: WorkStatusRecoveryOutcome;
    const lock = await this.dependencies.locks.acquire(
      { projectId: record.projectId, externalIssueId: record.externalIssueId },
      input.holderId,
    );
    if (!lock.ok) {
      outcome = { state: "blocked", reason: "lock_conflict" };
    } else {
      const current = await this.dependencies.progress.load(record.jobId);
      const currentClaim = await this.dependencies.admission.load(record.projectId, record.issueId);
      if (
        !current.ok ||
        current.value?.revision !== record.revision ||
        !currentClaim.ok ||
        currentClaim.value?.revision !== claim.value.revision
      ) {
        outcome = { state: "blocked", reason: "checkpoint_conflict" };
      } else {
        const lockedIssue = await this.dependencies.workManagement.getIssue(reference);
        const lockedHistory = await this.dependencies.workManagement.getIssueHistory(reference);
        if (!lockedIssue.ok || !lockedHistory.ok) {
          outcome = { state: "blocked", reason: "history_unavailable" };
        } else {
          const lockedState = classifyRecoveryState(
            current.value,
            transition,
            sourceShape,
            lockedIssue.value,
            lockedHistory.value,
          );
          if (!lockedState.ok || lockedState.disposition !== disposition) {
            outcome = {
              state: "blocked",
              reason: lockedState.ok ? "history_identity_mismatch" : lockedState.reason,
            };
          } else {
            const existingRecovery = [...(current.value.workStatusLifecycle?.recoveries ?? [])]
              .reverse()
              .find((receipt) => receipt.sourceTransitionInstance === transition.instance);
            if (existingRecovery !== undefined) {
              const continuationInstance =
                existingRecovery.continuationTransitionInstance ?? transition.instance;
              outcome = await this.#continue(
                current.value,
                transition,
                continuationInstance,
                existingRecovery.disposition,
                input.holderId,
                reference,
                lock.value,
              );
            } else {
              const epoch = (record.workStatusLifecycle.recoveries?.length ?? 0) + 1;
              const historyDigest = sha256Digest({
                schemaVersion: 1,
                entries: lockedHistory.value.entries,
              });
              const authorityDigest = sha256Digest({
                schemaVersion: 1,
                operation: "work-status-recover",
                jobId: record.jobId,
                sourceTransitionInstance: transition.instance,
                epoch,
                disposition,
                claimRevision: claim.value.revision,
                historyDigest: historyDigest.ok ? historyDigest.value : "invalid",
              });
              const continuation =
                authorityDigest.ok && disposition === "pre_state_reissued"
                  ? createWorkStatusLifecycleTransitionInstance({
                      jobId: record.jobId,
                      step: transition.step,
                      mainTarget: transition.mainTarget,
                      allowedMainSources: transition.allowedMainSources,
                      ...(transition.agentTarget === undefined
                        ? {}
                        : { agentTarget: transition.agentTarget }),
                      authorityDigest: authorityDigest.value,
                    })
                  : undefined;
              if (
                !historyDigest.ok ||
                !authorityDigest.ok ||
                (continuation !== undefined && !continuation.ok)
              ) {
                outcome = { state: "blocked", reason: "history_identity_mismatch" };
              } else {
                const receipt = Object.freeze({
                  epoch,
                  sourceTransitionInstance: transition.instance,
                  disposition,
                  operatorReceiptDigest: authorityDigest.value,
                  authorizedAt: this.#clock.now(),
                  historyDigest: historyDigest.value,
                  ...(disposition === "pre_state_reissued" && continuation?.ok === true
                    ? { continuationTransitionInstance: continuation.value }
                    : {}),
                });
                const checkpointed = await this.dependencies.progress.compareAndSwap(
                  record.jobId,
                  record.revision,
                  {
                    ...mutation(record),
                    workStatusLifecycle: {
                      ...record.workStatusLifecycle,
                      recoveries: [...(record.workStatusLifecycle.recoveries ?? []), receipt],
                    },
                  },
                );
                if (!checkpointed.ok) {
                  outcome = { state: "blocked", reason: "checkpoint_conflict" };
                } else {
                  outcome = await this.#continue(
                    checkpointed.value,
                    transition,
                    continuation?.ok === true ? continuation.value : transition.instance,
                    disposition,
                    input.holderId,
                    reference,
                    lock.value,
                  );
                }
              }
            }
          }
        }
      }
      const releasedLock = await lock.value.release();
      if (!releasedLock.ok && outcome.state === "recovered") {
        outcome = { state: "failed", reason: "read_failed" };
      }
    }
    const released = await this.dependencies.leases.release({
      leaseId: lease.value.value.id,
      holderId: input.holderId,
    });
    return !released.ok && outcome.state === "recovered"
      ? { state: "failed", reason: "lease_release_failed" }
      : outcome;
  }

  async #continue(
    record: JobProgressRecord,
    transition: WorkStatusLifecycleTransition,
    continuationInstance: string,
    disposition: "target_observed" | "pre_state_reissued" | "pre_state_retained",
    holderId: string,
    reference: Parameters<WorkManagementPort["getIssue"]>[0],
    lock: IssueScopeLockHandle,
  ): Promise<WorkStatusRecoveryOutcome> {
    if (transition.mainTarget === undefined || transition.allowedMainSources === undefined) {
      return { state: "blocked", reason: "transition_not_recoverable" };
    }
    let current = record;
    if (disposition === "pre_state_reissued") {
      const invocation = sha256Digest({
        schemaVersion: 1,
        operation: "work-status-recover-transition",
        jobId: record.jobId,
        continuationInstance,
      });
      if (!invocation.ok) return { state: "blocked", reason: "transition_failed" };
      const result = await this.dependencies.lifecycle.transitionWhileLockHeld(
        {
          jobId: record.jobId,
          reference,
          holderId,
          mode: "enforce",
          ...(record.workStatusLifecycle?.capabilityDigest === undefined
            ? {}
            : { capabilityDigest: record.workStatusLifecycle.capabilityDigest }),
          phase: phaseFor(transition),
          step: transition.step,
          transitionInstance: continuationInstance,
          invocationDigest: invocation.value,
          mainTarget: transition.mainTarget,
          allowedMainSources: transition.allowedMainSources,
          ...(transition.agentTarget === undefined ? {} : { agentTarget: transition.agentTarget }),
        },
        lock,
      );
      if (result.state !== "permitted") {
        return { state: "blocked", reason: "transition_failed" };
      }
      const reloaded = await this.dependencies.progress.load(record.jobId);
      if (!reloaded.ok || reloaded.value === undefined)
        return { state: "failed", reason: "read_failed" };
      current = reloaded.value;
    }
    const restored = await this.dependencies.progress.compareAndSwap(
      current.jobId,
      current.revision,
      mutation(current, restoredStage(transition)),
    );
    return restored.ok
      ? {
          state: "recovered",
          dryRun: false,
          jobId: current.jobId,
          transitionInstance: transition.instance,
          disposition,
        }
      : { state: "blocked", reason: "checkpoint_conflict" };
  }
}
