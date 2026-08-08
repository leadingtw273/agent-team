import { randomUUID } from "node:crypto";

import type {
  ReconcileAllOutcome,
  ReconcileAllRequest,
  ReconcileTargetOutcome,
} from "../../application/reconcile/index.js";
import type { CliCommandOutcome } from "../program.js";

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
 * exposes -- one entry per port method, no aggregation. A composition root (e.g.
 * `composition.ts`'s `buildManualReconcileUseCase`) reports, per request, which of these it
 * actually backed with production logic ("wired") versus which fail closed with an honest
 * `"unavailable"` error today ("unwired"). This lets the CLI payload disclose scope honestly
 * instead of letting a `completed` verdict be misread as "every reconcile capability ran".
 */
export const reconcileCapabilityIds = [
  "lease_reclaim",
  "job_update",
  "active_job_snapshot",
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
  /** E010c: which `ReconcilePorts` capabilities this use case's composition actually backed. */
  readonly disclosedScope: ReconcileDisclosedScope;
}

export interface CreateManualReconcileHandlerOptions {
  readonly reconcile: ManualReconcileUseCase;
  readonly createRequest?: () => ReconcileAllRequest;
}

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

function renderReconcileOutcome(
  result: ReconcileAllOutcome,
  disclosedScope: ReconcileDisclosedScope,
): CliCommandOutcome {
  if (result.state === "failed") {
    return outcome("failed", {
      operation: "manual_reconcile",
      state: "failed",
      evidenceCode: failedEvidence(result.stage),
    });
  }

  // E010c: `completed`/`degraded` are the verdicts an operator is most likely to skim past --
  // disclose scope here so `completed` reads as "the wired capabilities finished cleanly", never
  // as "every reconcile capability ran". Verdict/evidenceCode/state are unchanged from E010b.
  const payload = {
    operation: "manual_reconcile",
    state: result.state,
    evidenceCode:
      result.state === "completed"
        ? ("manual_reconcile_completed" as const)
        : ("manual_reconcile_degraded" as const),
    reclaimedLeaseCount: result.reclaimedLeaseIds.length,
    targetCounts: countTargets(result.targets),
    modelResumeAttempts: result.modelResumeAttempts,
    scopeDisclosure: disclosedScope,
  };
  return outcome(result.state === "completed" ? "success" : "blocked", payload);
}

/**
 * Uses the same Reconcile application contract as the timer. It never turns a
 * blocked or failed application result into CLI success, and excludes raw
 * adapter diagnostics from the user-facing payload.
 */
export function createManualReconcileHandler(
  options: CreateManualReconcileHandlerOptions,
): (input: Readonly<{ all: true }>) => Promise<CliCommandOutcome> {
  const createRequest = options.createRequest ?? createDefaultRequest;
  return async () => {
    try {
      return renderReconcileOutcome(
        await options.reconcile.reconcileAll(createRequest()),
        options.reconcile.disclosedScope,
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
  input: Readonly<{ all: true }>,
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
