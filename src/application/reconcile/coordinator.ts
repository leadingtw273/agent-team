import { domainError, type DomainError } from "../../domain/foundation/index.js";
import {
  consumeAttempt,
  jobSchema,
  type Job,
  type JobAttemptCounters,
} from "../../domain/jobs/index.js";
import { projectSchema } from "../../domain/project/index.js";
import type { MutationOptions, ReadOptions } from "../ports/index.js";
import {
  reconcileProviderFindingKinds,
  type ReconcileAllOutcome,
  type ReconcileAllRequest,
  type ReconcileBlockReason,
  type ReconcilePorts,
  type ReconcileProviderFinding,
  type ReconcileTarget,
  type ReconcileTargetFailureStage,
  type ReconcileTargetOutcome,
} from "./model.js";

const mutationPrefixPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@+-]{0,127}$/u;
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@+-]{0,511}$/u;
const providerFindingKindSet: ReadonlySet<string> = new Set(reconcileProviderFindingKinds);
const linearFindingKinds: ReadonlySet<string> = new Set([
  "work_status_changed",
  "agent_condition_changed",
  "issue_revision_changed",
]);

function mutation(request: ReconcileAllRequest, step: string): MutationOptions {
  return {
    idempotencyKey: `${request.idempotencyKeyPrefix}:${step}`,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  };
}

function readOptions(request: ReconcileAllRequest): ReadOptions {
  return request.signal === undefined ? {} : { signal: request.signal };
}

function failedTarget(
  target: ReconcileTarget,
  stage: ReconcileTargetFailureStage,
  error: DomainError,
): ReconcileTargetOutcome {
  return Object.freeze({ state: "failed", jobId: target.job.id, stage, error });
}

function validTarget(target: ReconcileTarget): boolean {
  return (
    projectSchema.safeParse(target.project).success &&
    jobSchema.safeParse(target.job).success &&
    target.job.projectId === target.project.id &&
    target.job.startedAt !== undefined &&
    target.externalIssueId.trim().length > 0 &&
    target.externalIssueId.length <= 255 &&
    (target.checkpointId === undefined || identifierPattern.test(target.checkpointId))
  );
}

function validFindings(findings: readonly ReconcileProviderFinding[]): boolean {
  const identities = new Set<string>();
  for (const finding of findings) {
    if (
      !["linear", "github"].includes(finding.source) ||
      !providerFindingKindSet.has(finding.kind) ||
      (finding.source === "linear") !== linearFindingKinds.has(finding.kind) ||
      !identifierPattern.test(finding.fingerprint)
    ) {
      return false;
    }
    const identity = `${finding.source}:${finding.kind}:${finding.fingerprint}`;
    if (identities.has(identity)) return false;
    identities.add(identity);
  }
  return true;
}

function sameJobWithAttempts(
  source: Job,
  readBack: Job,
  expectedAttempts: JobAttemptCounters,
): boolean {
  return (
    jobSchema.safeParse(readBack).success &&
    source.id === readBack.id &&
    source.projectId === readBack.projectId &&
    source.issueId === readBack.issueId &&
    source.createdAt === readBack.createdAt &&
    source.startedAt === readBack.startedAt &&
    source.watchdogExtensionGranted === readBack.watchdogExtensionGranted &&
    JSON.stringify(readBack.attempts) === JSON.stringify(expectedAttempts)
  );
}

export class ReconcileCoordinator {
  constructor(readonly ports: ReconcilePorts) {}

  async reconcileAll(request: ReconcileAllRequest): Promise<ReconcileAllOutcome> {
    if (
      !mutationPrefixPattern.test(request.controllerId) ||
      !mutationPrefixPattern.test(request.idempotencyKeyPrefix)
    ) {
      return Object.freeze({
        state: "failed",
        stage: "request",
        error: domainError("invariant_violation"),
      });
    }
    const active = await this.ports.jobs.listActive(readOptions(request));
    if (!active.ok) return Object.freeze({ state: "failed", stage: "jobs", error: active.error });
    if (
      active.value.some((target) => !validTarget(target)) ||
      new Set(active.value.map((target) => target.job.id)).size !== active.value.length
    ) {
      return Object.freeze({
        state: "failed",
        stage: "jobs",
        error: domainError("conflict"),
      });
    }

    const reclaimed = await this.ports.leases.reclaimExpired(
      request.controllerId,
      mutation(request, "reclaim-expired-leases"),
    );
    if (!reclaimed.ok) {
      return Object.freeze({ state: "failed", stage: "leases", error: reclaimed.error });
    }
    if (
      reclaimed.value.persistence === "unknown" ||
      reclaimed.value.lockRelease !== "confirmed" ||
      (reclaimed.value.reclaimedLeaseIds.length > 0 &&
        reclaimed.value.persistence !== "confirmed") ||
      new Set(reclaimed.value.reclaimedLeaseIds).size !==
        reclaimed.value.reclaimedLeaseIds.length ||
      reclaimed.value.reclaimedLeaseIds.some((id) => !identifierPattern.test(id))
    ) {
      return Object.freeze({
        state: "failed",
        stage: "leases",
        error: domainError("conflict"),
      });
    }

    const targets: ReconcileTargetOutcome[] = [];
    let modelResumeAttempts = 0;
    for (const target of active.value) {
      const reconciled = await this.#reconcileTarget(target, request, () => {
        modelResumeAttempts += 1;
      });
      targets.push(reconciled);
    }
    const degraded = targets.some(
      (target) => target.state === "blocked" || target.state === "failed",
    );
    return Object.freeze({
      state: degraded ? "degraded" : "completed",
      reclaimedLeaseIds: Object.freeze([...reclaimed.value.reclaimedLeaseIds]),
      targets: Object.freeze(targets),
      modelResumeAttempts,
    });
  }

  async #reconcileTarget(
    target: ReconcileTarget,
    request: ReconcileAllRequest,
    onResumeAttempt: () => void,
  ): Promise<ReconcileTargetOutcome> {
    const provider = await this.ports.providers.readBack(target, readOptions(request));
    if (!provider.ok) {
      return this.#block(target, request, "source_unavailable", [], [], "provider", provider.error);
    }
    if (!validFindings(provider.value.findings)) {
      return failedTarget(target, "provider", domainError("conflict"));
    }
    const providerFindings = Object.freeze([...provider.value.findings]);
    const events = await this.ports.events.repairMissing(
      { target, providerFindings },
      mutation(request, `repair-events:${target.job.id}`),
    );
    if (!events.ok) {
      return this.#block(
        target,
        request,
        "event_repair_unconfirmed",
        providerFindings,
        [],
        "events",
        events.error,
      );
    }
    if (
      events.value.durability === "unknown" ||
      (events.value.repairedEventIds.length > 0 && events.value.durability !== "confirmed") ||
      new Set(events.value.repairedEventIds).size !== events.value.repairedEventIds.length ||
      events.value.repairedEventIds.some((id) => !identifierPattern.test(id))
    ) {
      return this.#block(target, request, "event_repair_unconfirmed", providerFindings, []);
    }
    const repairedEventIds = Object.freeze([...events.value.repairedEventIds]);
    const process = await this.ports.processes.inspect(target.job, readOptions(request));
    if (!process.ok) return failedTarget(target, "process", process.error);
    if (!["running", "exited", "missing"].includes(process.value.state)) {
      return failedTarget(target, "process", domainError("conflict"));
    }
    if (process.value.state === "running") {
      return Object.freeze({
        state: "healthy",
        jobId: target.job.id,
        providerFindings,
        repairedEventIds,
      });
    }
    if (target.checkpointId === undefined) {
      return this.#block(target, request, "checkpoint_missing", providerFindings, repairedEventIds);
    }
    const attempts = consumeAttempt(target.job.attempts, "processRecoveries");
    if (!attempts.ok) {
      return this.#block(
        target,
        request,
        "recovery_limit_reached",
        providerFindings,
        repairedEventIds,
      );
    }
    const recoveryLease = await this.ports.leases.prepareRecovery(
      target,
      request.controllerId,
      mutation(request, `prepare-recovery-lease:${target.job.id}`),
    );
    if (!recoveryLease.ok) return failedTarget(target, "lease", recoveryLease.error);
    if (
      !recoveryLease.value.ready ||
      recoveryLease.value.durability !== "confirmed" ||
      recoveryLease.value.leaseId === undefined ||
      !identifierPattern.test(recoveryLease.value.leaseId)
    ) {
      return this.#block(target, request, "lease_unavailable", providerFindings, repairedEventIds);
    }
    const nextJob = Object.freeze({ ...target.job, attempts: attempts.value });
    const persisted = await this.ports.jobs.update(
      nextJob,
      mutation(request, `consume-recovery:${target.job.id}`),
    );
    if (!persisted.ok) {
      return this.#releaseRecoveryAfterJobFailure(
        target,
        request,
        recoveryLease.value.leaseId,
        persisted.error,
      );
    }
    if (
      persisted.value.durability !== "confirmed" ||
      !sameJobWithAttempts(target.job, persisted.value.job, attempts.value)
    ) {
      return this.#releaseRecoveryAfterJobFailure(
        target,
        request,
        recoveryLease.value.leaseId,
        domainError("conflict"),
      );
    }
    onResumeAttempt();
    const resumed = await this.ports.processes.resumeFromCheckpoint(
      {
        job: persisted.value.job,
        checkpointId: target.checkpointId,
        reason: "unexpected_process_exit",
      },
      mutation(request, `resume:${target.job.id}`),
    );
    if (!resumed.ok) return failedTarget(target, "recovery", resumed.error);
    if (!resumed.value.started || resumed.value.durability !== "confirmed") {
      return failedTarget(target, "recovery", domainError("external_failure"));
    }
    return Object.freeze({
      state: "resumed",
      jobId: target.job.id,
      checkpointId: target.checkpointId,
      processRecoveries: attempts.value.processRecoveries,
      providerFindings,
      repairedEventIds,
    });
  }

  async #releaseRecoveryAfterJobFailure(
    target: ReconcileTarget,
    request: ReconcileAllRequest,
    leaseId: string,
    jobError: DomainError,
  ): Promise<ReconcileTargetOutcome> {
    const released = await this.ports.leases.releaseRecovery(
      leaseId,
      request.controllerId,
      mutation(request, `release-recovery-lease:${target.job.id}`),
    );
    if (!released.ok) return failedTarget(target, "lease", released.error);
    if (released.value.durability !== "confirmed") {
      return failedTarget(target, "lease", domainError("external_failure"));
    }
    return failedTarget(target, "job", jobError);
  }

  async #block(
    target: ReconcileTarget,
    request: ReconcileAllRequest,
    reason: ReconcileBlockReason,
    providerFindings: readonly ReconcileProviderFinding[],
    repairedEventIds: readonly string[],
    failureStage?: "provider" | "events",
    failure?: DomainError,
  ): Promise<ReconcileTargetOutcome> {
    const blocked = await this.ports.blocks.record(
      { target, reason },
      mutation(request, `block:${target.job.id}:${reason}`),
    );
    if (!blocked.ok) return failedTarget(target, "block", blocked.error);
    if (blocked.value.durability !== "confirmed") {
      return failedTarget(target, "block", domainError("external_failure"));
    }
    if (failureStage !== undefined && failure !== undefined) {
      return failedTarget(target, failureStage, failure);
    }
    return Object.freeze({
      state: "blocked",
      jobId: target.job.id,
      reason,
      providerFindings,
      repairedEventIds,
    });
  }
}
