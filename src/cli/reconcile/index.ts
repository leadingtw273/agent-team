import { randomUUID } from "node:crypto";

import type {
  ReconcileAllOutcome,
  ReconcileAllRequest,
  ReconcileTargetOutcome,
} from "../../application/reconcile/index.js";
import type { DomainError, Result } from "../../domain/foundation/index.js";
import type { JobProgressRecord } from "../../adapters/dispatch/job-progress-store.js";
import type { ResumeJobOutcome } from "../dispatch/resume-composition.js";
import type { WorkStatusOrphanScanOutcome } from "../dispatch/work-status-orphan-coordinator.js";
import type { WorkStatusJobReconcileOutcome } from "../dispatch/work-status-orphan-coordinator.js";
import type { CliCommandOutcome } from "../program.js";
import { countJobProgressInventory, type JobProgressInventory } from "./active-job-inventory.js";

export const manualReconcileEvidenceCodes = [
  "manual_reconcile_completed",
  "manual_reconcile_degraded",
  "manual_reconcile_failed_request",
  "manual_reconcile_failed_jobs",
  "manual_reconcile_failed_leases",
  "manual_reconcile_execution_failed",
  "manual_reconcile_runtime_unavailable",
] as const;

export type ManualReconcileEvidenceCode = (typeof manualReconcileEvidenceCodes)[number];

/**
 * E010c: closed enum of every capability `ReconcilePorts` (src/application/reconcile/model.ts)
 * exposes -- one entry per port method, no aggregation -- plus CLI-owned production capabilities
 * such as T02B's durable progress inventory. A composition root (e.g.
 * `composition.ts`'s `buildManualReconcileUseCase`) reports, per request, which of these it
 * actually backed with production logic ("wired") versus which fail closed with an honest
 * `"unavailable"` error today ("unwired"). This lets the CLI payload disclose scope honestly
 * instead of letting a `completed` verdict be misread as "every reconcile capability ran".
 */
export const reconcileCapabilityIds = [
  "lease_reclaim",
  "job_update",
  "active_job_snapshot",
  "durable_progress_inventory",
  "durable_progress_resume",
  "provider_readback",
  "event_repair",
  "process_inspect",
  "process_resume",
  "block_record",
  "lease_recovery_prepare",
  "lease_recovery_release",
] as const;

export type ReconcileCapabilityId = (typeof reconcileCapabilityIds)[number];

export interface ReconcileDisclosedScope {
  readonly wiredCapabilities: readonly ReconcileCapabilityId[];
  readonly unwiredCapabilities: readonly ReconcileCapabilityId[];
}

export interface ManualReconcileUseCase {
  readonly reconcileAll: (request: ReconcileAllRequest) => Promise<ReconcileAllOutcome>;
  readonly readJobProgressInventory: () => Promise<Result<JobProgressInventory, DomainError>>;
  readonly resumeJobProgress: (
    records: readonly JobProgressRecord[],
  ) => Promise<JobProgressResumeBatch>;
  readonly quarantineWorkStatusOrphans?: () => Promise<readonly WorkStatusOrphanScanOutcome[]>;
  readonly reconcileJob?: (jobId: string) => Promise<WorkStatusJobReconcileOutcome>;
  /** E010c: which `ReconcilePorts` capabilities this use case's composition actually backed. */
  readonly disclosedScope: ReconcileDisclosedScope;
}

export interface JobProgressResumeBatch {
  readonly outcomes: readonly ResumeJobOutcome[];
  readonly blocked: readonly Readonly<{
    projectId: string;
    jobId: string;
    reason: string;
  }>[];
}

export interface CreateManualReconcileHandlerOptions {
  readonly reconcile: ManualReconcileUseCase;
  readonly createRequest?: () => ReconcileAllRequest;
}

export type ManualReconcileInput = Readonly<{ all: true }> | Readonly<{ jobId: string }>;

interface TargetCounts {
  readonly healthy: number;
  readonly resumed: number;
  readonly blocked: number;
  readonly failed: number;
}

function outcome(
  state: CliCommandOutcome["state"],
  payload: Readonly<Record<string, unknown>>,
): CliCommandOutcome {
  return Object.freeze({ state, message: JSON.stringify(payload) });
}

function createDefaultRequest(): ReconcileAllRequest {
  return Object.freeze({
    controllerId: "manual-reconcile",
    idempotencyKeyPrefix: `manual-reconcile:${randomUUID()}`,
  });
}

function countTargets(targets: readonly ReconcileTargetOutcome[]): TargetCounts {
  let healthy = 0;
  let resumed = 0;
  let blocked = 0;
  let failed = 0;
  for (const target of targets) {
    switch (target.state) {
      case "healthy":
        healthy += 1;
        break;
      case "resumed":
        resumed += 1;
        break;
      case "blocked":
        blocked += 1;
        break;
      case "failed":
        failed += 1;
        break;
    }
  }
  return Object.freeze({ healthy, resumed, blocked, failed });
}

function failedEvidence(
  stage: Extract<ReconcileAllOutcome, { state: "failed" }>["stage"],
):
  | "manual_reconcile_failed_request"
  | "manual_reconcile_failed_jobs"
  | "manual_reconcile_failed_leases" {
  switch (stage) {
    case "request":
      return "manual_reconcile_failed_request";
    case "jobs":
      return "manual_reconcile_failed_jobs";
    case "leases":
      return "manual_reconcile_failed_leases";
  }
}

function safeResumeBatch(batch: JobProgressResumeBatch): Readonly<Record<string, unknown>> {
  return Object.freeze({
    outcomes: Object.freeze(
      batch.outcomes.map((candidate) => {
        const withPossibleError = candidate as ResumeJobOutcome & { readonly error?: DomainError };
        const { error, ...safe } = withPossibleError;
        return Object.freeze(error === undefined ? safe : { ...safe, errorCode: error.code });
      }),
    ),
    blocked: batch.blocked,
  });
}

function renderReconcileOutcome(
  result: ReconcileAllOutcome,
  disclosedScope: ReconcileDisclosedScope,
  inventory: JobProgressInventory,
  resumed: JobProgressResumeBatch,
  orphanScans: readonly WorkStatusOrphanScanOutcome[] = [],
): CliCommandOutcome {
  if (result.state === "failed") {
    return outcome("failed", {
      operation: "manual_reconcile",
      state: "failed",
      evidenceCode: failedEvidence(result.stage),
    });
  }

  // T02B: a coordinator pass is not globally complete while durable progress remains unresolved.
  // Keep target counts separate (the generic coordinator still has no safe ReconcileTarget bridge),
  // but downgrade the command instead of preserving the old false-green empty-target result.
  const jobProgressCounts = countJobProgressInventory(inventory);
  const hasUnresolvedProgress = jobProgressCounts.resumable + jobProgressCounts.blocked > 0;
  const unresolvedJobIds = new Set<string>(
    [...inventory.resumable, ...inventory.blocked].map((record) => record.jobId),
  );
  const resumeDidNotConverge =
    resumed.blocked.some((candidate) => unresolvedJobIds.has(candidate.jobId)) ||
    resumed.outcomes.some(
      (candidate) =>
        unresolvedJobIds.has(candidate.jobId) &&
        candidate.outcome !== "completed" &&
        candidate.outcome !== "merge_reconciled",
    );
  const effectiveState =
    result.state === "degraded" ||
    hasUnresolvedProgress ||
    resumeDidNotConverge ||
    orphanScans.some((scan) => scan.blocked > 0)
      ? ("degraded" as const)
      : ("completed" as const);
  const payload = {
    operation: "manual_reconcile",
    state: effectiveState,
    evidenceCode:
      effectiveState === "completed"
        ? ("manual_reconcile_completed" as const)
        : ("manual_reconcile_degraded" as const),
    reclaimedLeaseCount: result.reclaimedLeaseIds.length,
    targetCounts: countTargets(result.targets),
    jobProgressCounts,
    jobProgressResume: safeResumeBatch(resumed),
    workStatusOrphanScans: orphanScans,
    jobProgressBlocked: inventory.blocked.map((record) => ({
      projectId: record.projectId,
      jobId: record.jobId,
      stage: record.stage.kind,
      ...(record.stage.kind === "requires_manual" && record.stage.cause !== undefined
        ? { reasonCode: record.stage.cause.reasonCode }
        : {}),
    })),
    modelResumeAttempts: result.modelResumeAttempts,
    scopeDisclosure: disclosedScope,
  };
  return outcome(effectiveState === "completed" ? "success" : "blocked", payload);
}

/**
 * Uses the same Reconcile application contract as the timer. It never turns a
 * blocked or failed application result into CLI success, and excludes raw
 * adapter diagnostics from the user-facing payload.
 */
export function createManualReconcileHandler(
  options: CreateManualReconcileHandlerOptions,
): (input: ManualReconcileInput) => Promise<CliCommandOutcome> {
  const createRequest = options.createRequest ?? createDefaultRequest;
  return async (input) => {
    try {
      if ("jobId" in input) {
        if (options.reconcile.reconcileJob === undefined) {
          return outcome("blocked", {
            operation: "manual_reconcile_job",
            state: "blocked",
            jobId: input.jobId,
            reason: "runtime_unavailable",
          });
        }
        const exact = await options.reconcile.reconcileJob(input.jobId);
        return outcome(exact.state === "completed" ? "success" : "blocked", {
          operation: "manual_reconcile_job",
          ...exact,
        });
      }
      const inventory = await options.reconcile.readJobProgressInventory();
      if (!inventory.ok) {
        return outcome("failed", {
          operation: "manual_reconcile",
          state: "failed",
          evidenceCode: "manual_reconcile_failed_jobs",
        });
      }
      const reconciled = await options.reconcile.reconcileAll(createRequest());
      if (reconciled.state === "failed") {
        return renderReconcileOutcome(
          reconciled,
          options.reconcile.disclosedScope,
          inventory.value,
          {
            outcomes: [],
            blocked: [],
          },
        );
      }
      const orphanScans =
        reconciled.state === "completed" &&
        options.reconcile.quarantineWorkStatusOrphans !== undefined
          ? await options.reconcile.quarantineWorkStatusOrphans()
          : [];
      const resumed =
        reconciled.state === "completed"
          ? await options.reconcile.resumeJobProgress(inventory.value.resumable)
          : Object.freeze({ outcomes: Object.freeze([]), blocked: Object.freeze([]) });
      const finalInventory = await options.reconcile.readJobProgressInventory();
      if (!finalInventory.ok) {
        return outcome("failed", {
          operation: "manual_reconcile",
          state: "failed",
          evidenceCode: "manual_reconcile_failed_jobs",
        });
      }
      return renderReconcileOutcome(
        reconciled,
        options.reconcile.disclosedScope,
        finalInventory.value,
        resumed,
        orphanScans,
      );
    } catch {
      return outcome("failed", {
        operation: "manual_reconcile",
        state: "failed",
        evidenceCode: "manual_reconcile_execution_failed",
      });
    }
  };
}

/** The compiled CLI has no Reconcile Runtime composition yet, so it must block. */
export function createUnwiredManualReconcileHandler(): (
  input: ManualReconcileInput,
) => Promise<CliCommandOutcome> {
  return () =>
    Promise.resolve(
      outcome("blocked", {
        operation: "manual_reconcile",
        state: "blocked",
        evidenceCode: "manual_reconcile_runtime_unavailable",
      }),
    );
}
