import { describe, expect, it, vi } from "vitest";

import { domainError, err, ok, type DomainError } from "../../src/domain/foundation/index.js";
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
  wiredCapabilities: Object.freeze([
    "lease_reclaim",
    "job_update",
    "durable_progress_inventory",
  ] as const),
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

const emptyInventory = () =>
  Promise.resolve(ok(Object.freeze({ resumable: [], blocked: [], terminal: [] })));
const emptyResume = () =>
  Promise.resolve(Object.freeze({ outcomes: Object.freeze([]), blocked: Object.freeze([]) }));

describe("O008 manual reconcile CLI adapter", () => {
  it("reconciles one exact Job without invoking global inventory, lease, or resume paths", async () => {
    const reconcileAll = vi.fn();
    const readJobProgressInventory = vi.fn();
    const resumeJobProgress = vi.fn();
    const reconcileJob = vi.fn(() =>
      Promise.resolve({
        state: "completed" as const,
        projectId: "project-1",
        jobId: "job-1",
      }),
    );
    const handler = createManualReconcileHandler({
      reconcile: {
        reconcileAll,
        readJobProgressInventory,
        resumeJobProgress,
        reconcileJob,
        disclosedScope: fixtureDisclosedScope,
      },
    });

    const result = await handler({ jobId: "job-1" });

    expect(result.state).toBe("success");
    expect(payload(result.message)).toEqual({
      operation: "manual_reconcile_job",
      state: "completed",
      projectId: "project-1",
      jobId: "job-1",
    });
    expect(reconcileJob).toHaveBeenCalledWith("job-1");
    expect(reconcileAll).not.toHaveBeenCalled();
    expect(readJobProgressInventory).not.toHaveBeenCalled();
    expect(resumeJobProgress).not.toHaveBeenCalled();
  });

  it("fails closed with zero global work when exact-job Runtime support is absent", async () => {
    const reconcileAll = vi.fn();
    const result = await createManualReconcileHandler({
      reconcile: {
        reconcileAll,
        readJobProgressInventory: vi.fn(),
        resumeJobProgress: vi.fn(),
        disclosedScope: fixtureDisclosedScope,
      },
    })({ jobId: "job-1" });

    expect(result.state).toBe("blocked");
    expect(payload(result.message)).toEqual({
      operation: "manual_reconcile_job",
      state: "blocked",
      jobId: "job-1",
      reason: "runtime_unavailable",
    });
    expect(reconcileAll).not.toHaveBeenCalled();
  });

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
      reconcile: {
        reconcileAll,
        readJobProgressInventory: emptyInventory,
        resumeJobProgress: emptyResume,
        disclosedScope: fixtureDisclosedScope,
      },
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
      jobProgressCounts: { resumable: 0, blocked: 0, terminal: 0, total: 0 },
      jobProgressResume: { outcomes: [], blocked: [] },
      jobProgressBlocked: [],
      workStatusOrphanScans: [],
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
        readJobProgressInventory: emptyInventory,
        resumeJobProgress: emptyResume,
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
    expect(scope.wiredCapabilities).toContain("durable_progress_inventory");
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
        readJobProgressInventory: emptyInventory,
        resumeJobProgress: emptyResume,
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
      jobProgressCounts: { resumable: 0, blocked: 0, terminal: 0, total: 0 },
      jobProgressResume: { outcomes: [], blocked: [] },
      jobProgressBlocked: [],
      workStatusOrphanScans: [],
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
        readJobProgressInventory: emptyInventory,
        resumeJobProgress: emptyResume,
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

  it("reports durable resumable or blocked progress as degraded until the resume bridge handles it", async () => {
    const reconcileAll = vi.fn(() =>
      Promise.resolve({
        state: "completed" as const,
        reclaimedLeaseIds: [],
        targets: [],
        modelResumeAttempts: 0,
      }),
    );
    const handler = createManualReconcileHandler({
      reconcile: {
        reconcileAll,
        readJobProgressInventory: () =>
          Promise.resolve(
            ok(
              Object.freeze({
                resumable: [
                  {
                    projectId: "project-1",
                    jobId: "job-1",
                    stage: { kind: "ci_waiting" },
                  } as never,
                ],
                blocked: [
                  { projectId: "project-1", jobId: "job-2", stage: { kind: "paused" } } as never,
                ],
                terminal: [
                  { projectId: "project-1", jobId: "job-3", stage: { kind: "completed" } } as never,
                ],
              }),
            ),
          ),
        resumeJobProgress: emptyResume,
        disclosedScope: fixtureDisclosedScope,
      },
    });

    const outcome = await handler({ all: true });
    expect(outcome.state).toBe("blocked");
    expect(payload(outcome.message)).toMatchObject({
      state: "degraded",
      evidenceCode: "manual_reconcile_degraded",
      jobProgressCounts: { resumable: 1, blocked: 1, terminal: 1, total: 3 },
    });
    expect(reconcileAll).toHaveBeenCalledOnce();
  });

  it("runs the resume bridge after lease reclaim and renders the post-resume inventory", async () => {
    const resumable = {
      projectId: "project-1",
      jobId: "job-1",
      stage: { kind: "ci_waiting" },
    };
    const terminal = { ...resumable, stage: { kind: "completed" } };
    const readJobProgressInventory = vi
      .fn()
      .mockResolvedValueOnce(ok({ resumable: [resumable as never], blocked: [], terminal: [] }))
      .mockResolvedValueOnce(ok({ resumable: [], blocked: [], terminal: [terminal as never] }));
    const resumeJobProgress = vi.fn(() =>
      Promise.resolve({
        outcomes: [{ jobId: "job-1", outcome: "completed" as const }],
        blocked: [],
      }),
    );
    const handler = createManualReconcileHandler({
      reconcile: {
        reconcileAll: () =>
          Promise.resolve({
            state: "completed" as const,
            reclaimedLeaseIds: [],
            targets: [],
            modelResumeAttempts: 0,
          }),
        readJobProgressInventory,
        resumeJobProgress,
        disclosedScope: fixtureDisclosedScope,
      },
    });

    const outcome = await handler({ all: true });

    expect(outcome.state).toBe("success");
    expect(resumeJobProgress).toHaveBeenCalledWith([resumable]);
    expect(readJobProgressInventory).toHaveBeenCalledTimes(2);
    expect(payload(outcome.message)).toMatchObject({
      state: "completed",
      jobProgressCounts: { resumable: 0, blocked: 0, terminal: 1, total: 1 },
      jobProgressResume: {
        outcomes: [{ jobId: "job-1", outcome: "completed" }],
        blocked: [],
      },
    });
  });

  it("treats the final inventory as authoritative when another process completed a candidate", async () => {
    const resumable = {
      projectId: "project-1",
      jobId: "job-1",
      stage: { kind: "ci_waiting" },
    };
    const readJobProgressInventory = vi
      .fn()
      .mockResolvedValueOnce(ok({ resumable: [resumable as never], blocked: [], terminal: [] }))
      .mockResolvedValueOnce(
        ok({
          resumable: [],
          blocked: [],
          terminal: [{ ...resumable, stage: { kind: "completed" } }],
        }),
      );
    const handler = createManualReconcileHandler({
      reconcile: {
        reconcileAll: () =>
          Promise.resolve({
            state: "completed" as const,
            reclaimedLeaseIds: [],
            targets: [],
            modelResumeAttempts: 0,
          }),
        readJobProgressInventory,
        resumeJobProgress: () =>
          Promise.resolve({
            outcomes: [
              {
                jobId: "job-1",
                outcome: "candidate_changed" as const,
                reason: "revision_changed" as const,
              },
            ],
            blocked: [],
          }),
        disclosedScope: fixtureDisclosedScope,
      },
    });

    const outcome = await handler({ all: true });

    expect(outcome.state).toBe("success");
    expect(payload(outcome.message)).toMatchObject({
      state: "completed",
      jobProgressCounts: { resumable: 0, blocked: 0, terminal: 1, total: 1 },
    });
  });

  it("redacts raw resume diagnostics while preserving the fixed error code", async () => {
    const marker = "secret resume diagnostic";
    const resumable = {
      projectId: "project-1",
      jobId: "job-1",
      stage: { kind: "ci_waiting" },
    };
    const handler = createManualReconcileHandler({
      reconcile: {
        reconcileAll: () =>
          Promise.resolve({
            state: "completed" as const,
            reclaimedLeaseIds: [],
            targets: [],
            modelResumeAttempts: 0,
          }),
        readJobProgressInventory: () =>
          Promise.resolve(ok({ resumable: [resumable as never], blocked: [], terminal: [] })),
        resumeJobProgress: () =>
          Promise.resolve({
            outcomes: [
              {
                jobId: "job-1",
                outcome: "failed" as const,
                stage: "provider_run",
                error: { ...domainError("external_failure"), rawMessage: marker } as DomainError,
              },
            ],
            blocked: [],
          }),
        disclosedScope: fixtureDisclosedScope,
      },
    });

    const outcome = await handler({ all: true });
    const body = payload(outcome.message);

    expect(outcome.state).toBe("blocked");
    expect(body["jobProgressResume"]).toEqual({
      outcomes: [
        {
          jobId: "job-1",
          outcome: "failed",
          stage: "provider_run",
          errorCode: "external_failure",
        },
      ],
      blocked: [],
    });
    expect(outcome.message).not.toContain(marker);
  });

  it("fails closed before reconcile mutations when the durable inventory cannot be read", async () => {
    const reconcileAll = vi.fn();
    const handler = createManualReconcileHandler({
      reconcile: {
        reconcileAll,
        readJobProgressInventory: () => Promise.resolve(err(domainError("external_failure"))),
        resumeJobProgress: emptyResume,
        disclosedScope: fixtureDisclosedScope,
      },
    });

    const outcome = await handler({ all: true });
    expect(outcome.state).toBe("failed");
    expect(payload(outcome.message)).toEqual({
      operation: "manual_reconcile",
      state: "failed",
      evidenceCode: "manual_reconcile_failed_jobs",
    });
    expect(reconcileAll).not.toHaveBeenCalled();
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
