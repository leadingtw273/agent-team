import { describe, expect, it, vi } from "vitest";

import { domainError, type DomainError } from "../../src/domain/foundation/index.js";
import {
  createManualReconcileHandler,
  createUnwiredManualReconcileHandler,
} from "../../src/cli/reconcile/index.js";

function payload(message: string | undefined): Readonly<Record<string, unknown>> {
  expect(message).toBeDefined();
  return JSON.parse(message ?? "") as Readonly<Record<string, unknown>>;
}

describe("O008 manual reconcile CLI adapter", () => {
  it("reports a real completed reconcile rather than manufacturing a generic success", async () => {
    const reconcileAll = vi.fn(() =>
      Promise.resolve({
        state: "completed" as const,
        reclaimedLeaseIds: ["lease-1"],
        targets: [
          { state: "healthy" as const, jobId: "job-1", providerFindings: [], repairedEventIds: [] },
          {
            state: "resumed" as const,
            jobId: "job-2",
            checkpointId: "checkpoint-1",
            processRecoveries: 1,
            providerFindings: [],
            repairedEventIds: [],
          },
        ],
        modelResumeAttempts: 1,
      }),
    );
    const handler = createManualReconcileHandler({
      reconcile: { reconcileAll },
      createRequest: () => ({
        controllerId: "manual-reconcile",
        idempotencyKeyPrefix: "manual-reconcile:test",
      }),
    });

    const outcome = await handler({ all: true });

    expect(outcome.state).toBe("success");
    expect(payload(outcome.message)).toEqual({
      operation: "manual_reconcile",
      state: "completed",
      evidenceCode: "manual_reconcile_completed",
      reclaimedLeaseCount: 1,
      targetCounts: { healthy: 1, resumed: 1, blocked: 0, failed: 0 },
      modelResumeAttempts: 1,
    });
    expect(reconcileAll).toHaveBeenCalledWith({
      controllerId: "manual-reconcile",
      idempotencyKeyPrefix: "manual-reconcile:test",
    });
  });

  it("reports a degraded execution as blocked with fixed evidence", async () => {
    const handler = createManualReconcileHandler({
      reconcile: {
        reconcileAll: () =>
          Promise.resolve({
            state: "degraded",
            reclaimedLeaseIds: [],
            targets: [
              {
                state: "blocked",
                jobId: "job-1",
                reason: "checkpoint_missing",
                providerFindings: [],
                repairedEventIds: [],
              },
            ],
            modelResumeAttempts: 0,
          }),
      },
      createRequest: () => ({
        controllerId: "manual-reconcile",
        idempotencyKeyPrefix: "manual-reconcile:degraded",
      }),
    });

    const outcome = await handler({ all: true });

    expect(outcome.state).toBe("blocked");
    expect(payload(outcome.message)).toEqual({
      operation: "manual_reconcile",
      state: "degraded",
      evidenceCode: "manual_reconcile_degraded",
      reclaimedLeaseCount: 0,
      targetCounts: { healthy: 0, resumed: 0, blocked: 1, failed: 0 },
      modelResumeAttempts: 0,
    });
  });

  it("reports a coordinator failure without leaking its raw error", async () => {
    const marker = "untrusted provider diagnostic https://secret.example.test";
    const handler = createManualReconcileHandler({
      reconcile: {
        reconcileAll: () =>
          Promise.resolve({
            state: "failed",
            stage: "leases",
            error: { ...domainError("external_failure"), rawMessage: marker } as DomainError,
          }),
      },
      createRequest: () => ({
        controllerId: "manual-reconcile",
        idempotencyKeyPrefix: "manual-reconcile:failure",
      }),
    });

    const outcome = await handler({ all: true });

    expect(outcome.state).toBe("failed");
    expect(payload(outcome.message)).toEqual({
      operation: "manual_reconcile",
      state: "failed",
      evidenceCode: "manual_reconcile_failed_leases",
    });
    expect(outcome.message).not.toContain(marker);
  });

  it("keeps the unwired Runtime fail-closed instead of pretending a manual trigger ran", async () => {
    const outcome = await createUnwiredManualReconcileHandler()({ all: true });

    expect(outcome.state).toBe("blocked");
    expect(payload(outcome.message)).toEqual({
      operation: "manual_reconcile",
      state: "blocked",
      evidenceCode: "manual_reconcile_runtime_unavailable",
    });
  });
});
