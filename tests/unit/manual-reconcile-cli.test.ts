import { describe, expect, it, vi } from "vitest";

import { domainError, type DomainError } from "../../src/domain/foundation/index.js";
import {
  createManualReconcileHandler,
  createUnwiredManualReconcileHandler,
  type ReconcileDisclosedScope,
} from "../../src/cli/reconcile/index.js";

function payload(message: string | undefined): Readonly<Record<string, unknown>> {
  expect(message).toBeDefined();
  return JSON.parse(message ?? "") as Readonly<Record<string, unknown>>;
}

// E010c: a fixture disclosed-scope, standing in for whatever a real composition (see
// composition.ts's `describeDisclosedScope`) derives from its actually-built ports. This test
// module only exercises the CLI rendering layer, so the fixture's exact split doesn't need to
// mirror production's -- only that the handler passes it through into the payload untouched.
const fixtureDisclosedScope: ReconcileDisclosedScope = Object.freeze({
  wiredCapabilities: Object.freeze(["lease_reclaim", "job_update"] as const),
  unwiredCapabilities: Object.freeze([
    "active_job_snapshot",
    "provider_readback",
    "event_repair",
    "process_inspect",
    "process_resume",
    "block_record",
    "lease_recovery_prepare",
    "lease_recovery_release",
  ] as const),
});

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
      reconcile: { reconcileAll, disclosedScope: fixtureDisclosedScope },
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
      scopeDisclosure: fixtureDisclosedScope,
    });
    expect(reconcileAll).toHaveBeenCalledWith({
      controllerId: "manual-reconcile",
      idempotencyKeyPrefix: "manual-reconcile:test",
    });
  });

  it("discloses scope on a completed verdict without letting it change the verdict itself (E010c)", async () => {
    // Same "completed" reconcileAll result as a fully-wired run would produce, but paired with a
    // disclosed scope where nothing beyond lease reclaim is wired -- exactly today's production
    // shape. The verdict/evidenceCode/exit-mapping must stay E010b's, only the payload gains data.
    const handler = createManualReconcileHandler({
      reconcile: {
        reconcileAll: () =>
          Promise.resolve({
            state: "completed" as const,
            reclaimedLeaseIds: [],
            targets: [],
            modelResumeAttempts: 0,
          }),
        disclosedScope: fixtureDisclosedScope,
      },
      createRequest: () => ({
        controllerId: "manual-reconcile",
        idempotencyKeyPrefix: "manual-reconcile:scope",
      }),
    });

    const outcome = await handler({ all: true });

    expect(outcome.state).toBe("success");
    const body = payload(outcome.message);
    expect(body["state"]).toBe("completed");
    expect(body["evidenceCode"]).toBe("manual_reconcile_completed");
    expect(body["scopeDisclosure"]).toEqual(fixtureDisclosedScope);
    const scope = body["scopeDisclosure"] as ReconcileDisclosedScope;
    expect(scope.unwiredCapabilities).toContain("provider_readback");
    expect(scope.unwiredCapabilities).toContain("active_job_snapshot");
    expect(scope.wiredCapabilities).not.toContain("provider_readback");
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
        disclosedScope: fixtureDisclosedScope,
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
      scopeDisclosure: fixtureDisclosedScope,
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
        disclosedScope: fixtureDisclosedScope,
      },
      createRequest: () => ({
        controllerId: "manual-reconcile",
        idempotencyKeyPrefix: "manual-reconcile:failure",
      }),
    });

    const outcome = await handler({ all: true });

    expect(outcome.state).toBe("failed");
    // E010c: an outright-failed request/jobs/leases stage carries no target/scope data at all --
    // scope disclosure is deliberately withheld here, not because it changes, but because there is
    // nothing to disclose: the run never got far enough to say anything but "it failed".
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
