import { describe, expect, it } from "vitest";

import {
  ReconcileCoordinator,
  type ReconcileAllRequest,
  type ReconcilePorts,
  type ReconcileProviderFinding,
  type ReconcileTarget,
} from "../../src/application/reconcile/index.js";
import {
  domainError,
  err,
  ok,
  parseInstant,
  type DomainError,
  type Result,
} from "../../src/domain/foundation/index.js";
import { jobSchema, type Job } from "../../src/domain/jobs/index.js";
import { projectSchema } from "../../src/domain/project/index.js";

function instant(value: string) {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const project = projectSchema.parse({
  schemaVersion: 1,
  id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  displayName: "Reconcile fixture",
  localRepositoryPath: "/tmp/reconcile-fixture",
  defaultBranch: "main",
  workManagement: { provider: "linear", containerId: "workspace", projectId: "team" },
  sourceControl: { provider: "github", repository: "owner/repository" },
});
const baseJob = jobSchema.parse({
  schemaVersion: 1,
  id: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  projectId: project.id,
  issueId: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  createdAt: instant("2026-08-05T12:00:00.000Z"),
  startedAt: instant("2026-08-05T12:01:00.000Z"),
  watchdogExtensionGranted: false,
  attempts: { processRecoveries: 0, ciFixRounds: 0, reviewerFixRounds: 0, reviewRuns: 0 },
});

function target(job: Job = baseJob, checkpointId: string | null = "checkpoint-job-1") {
  return {
    project,
    externalIssueId: "ENG-123",
    job,
    ...(checkpointId === null ? {} : { checkpointId }),
  } satisfies ReconcileTarget;
}

const missedStatus: ReconcileProviderFinding = {
  source: "linear",
  kind: "work_status_changed",
  fingerprint: "linear-revision-42",
};

interface FixtureOptions {
  readonly targets?: readonly ReconcileTarget[];
  readonly leasePersistence?: "unchanged" | "confirmed" | "unknown";
  readonly lockRelease?: "confirmed" | "unknown";
  readonly reclaimedLeaseIds?: readonly string[];
  readonly recoveryLeaseReady?: boolean;
  readonly recoveryLeaseId?: string;
  readonly recoveryLeaseDurability?: "confirmed" | "unknown";
  readonly provider?: Result<
    Readonly<{ findings: readonly ReconcileProviderFinding[] }>,
    DomainError
  >;
  readonly providerByJob?: Readonly<
    Record<string, Result<Readonly<{ findings: readonly ReconcileProviderFinding[] }>, DomainError>>
  >;
  readonly repairedEventIds?: readonly string[];
  readonly eventDurability?: "unchanged" | "confirmed" | "unknown";
  readonly processState?: "running" | "exited" | "missing";
  readonly processStateByJob?: Readonly<Record<string, "running" | "exited" | "missing">>;
  readonly updateDurability?: "confirmed" | "unknown";
  readonly persistedJob?: Job;
  readonly resumeStarted?: boolean;
  readonly resumeDurability?: "confirmed" | "unknown";
  readonly blockDurability?: "confirmed" | "unknown";
}

function fixture(options: FixtureOptions = {}) {
  const calls: string[] = [];
  const activeTargets = options.targets ?? [target()];
  const ports: ReconcilePorts = {
    jobs: {
      listActive() {
        calls.push("jobs:list");
        return Promise.resolve(ok(activeTargets));
      },
      update(job, mutationOptions) {
        calls.push(`jobs:update:${job.id}:${mutationOptions.idempotencyKey}`);
        return Promise.resolve(
          ok({
            job: options.persistedJob ?? job,
            durability: options.updateDurability ?? "confirmed",
          }),
        );
      },
    },
    leases: {
      reclaimExpired(controllerId, mutationOptions) {
        calls.push(`leases:${controllerId}:${mutationOptions.idempotencyKey}`);
        return Promise.resolve(
          ok({
            reclaimedLeaseIds: options.reclaimedLeaseIds ?? [],
            persistence: options.leasePersistence ?? "unchanged",
            lockRelease: options.lockRelease ?? "confirmed",
          }),
        );
      },
      prepareRecovery(reconcileTarget, controllerId, mutationOptions) {
        calls.push(
          `lease:recovery:${reconcileTarget.job.id}:${controllerId}:${mutationOptions.idempotencyKey}`,
        );
        return Promise.resolve(
          ok({
            ready: options.recoveryLeaseReady ?? true,
            leaseId: options.recoveryLeaseId ?? "lease-recovery-1",
            durability: options.recoveryLeaseDurability ?? "confirmed",
          }),
        );
      },
      releaseRecovery(leaseId, controllerId, mutationOptions) {
        calls.push(`lease:release:${leaseId}:${controllerId}:${mutationOptions.idempotencyKey}`);
        return Promise.resolve(ok({ durability: "confirmed" }));
      },
    },
    providers: {
      readBack(reconcileTarget) {
        calls.push(`providers:${reconcileTarget.job.id}`);
        return Promise.resolve(
          options.providerByJob?.[reconcileTarget.job.id] ??
            options.provider ??
            ok({ findings: [] }),
        );
      },
    },
    events: {
      repairMissing(repairRequest, mutationOptions) {
        calls.push(
          `events:${repairRequest.target.job.id}:${String(repairRequest.providerFindings.length)}:${mutationOptions.idempotencyKey}`,
        );
        return Promise.resolve(
          ok({
            repairedEventIds: options.repairedEventIds ?? [],
            durability: options.eventDurability ?? "unchanged",
          }),
        );
      },
    },
    processes: {
      inspect(job) {
        calls.push(`process:inspect:${job.id}`);
        return Promise.resolve(
          ok({ state: options.processStateByJob?.[job.id] ?? options.processState ?? "running" }),
        );
      },
      resumeFromCheckpoint(resumeRequest, mutationOptions) {
        calls.push(
          `process:resume:${resumeRequest.job.id}:${resumeRequest.checkpointId}:${mutationOptions.idempotencyKey}`,
        );
        return Promise.resolve(
          ok({
            started: options.resumeStarted ?? true,
            durability: options.resumeDurability ?? "confirmed",
          }),
        );
      },
    },
    blocks: {
      record(blockRequest, mutationOptions) {
        calls.push(
          `block:${blockRequest.target.job.id}:${blockRequest.reason}:${mutationOptions.idempotencyKey}`,
        );
        return Promise.resolve(ok({ durability: options.blockDurability ?? "confirmed" }));
      },
    },
  };
  const coordinator = new ReconcileCoordinator(ports);
  const request: ReconcileAllRequest = {
    controllerId: "reconciler-1",
    idempotencyKeyPrefix: "reconcile:tick-1",
  };
  return { calls, coordinator, request };
}

describe("reconcile coordinator", () => {
  it("uses no model work on the healthy deterministic path", async () => {
    const setup = fixture();

    await expect(setup.coordinator.reconcileAll(setup.request)).resolves.toEqual({
      state: "completed",
      reclaimedLeaseIds: [],
      targets: [
        {
          state: "healthy",
          jobId: baseJob.id,
          providerFindings: [],
          repairedEventIds: [],
        },
      ],
      modelResumeAttempts: 0,
    });
    expect(setup.calls).toEqual([
      "jobs:list",
      "leases:reconciler-1:reconcile:tick-1:reclaim-expired-leases",
      `providers:${baseJob.id}`,
      `events:${baseJob.id}:0:reconcile:tick-1:repair-events:${baseJob.id}`,
      `process:inspect:${baseJob.id}`,
    ]);
  });

  it("records reclaimed zombie leases and durable repairs for missed events", async () => {
    const setup = fixture({
      reclaimedLeaseIds: ["lease-stale-1"],
      leasePersistence: "confirmed",
      provider: ok({ findings: [missedStatus] }),
      repairedEventIds: ["event-reconciled-1"],
      eventDurability: "confirmed",
    });

    await expect(setup.coordinator.reconcileAll(setup.request)).resolves.toMatchObject({
      state: "completed",
      reclaimedLeaseIds: ["lease-stale-1"],
      targets: [
        {
          state: "healthy",
          providerFindings: [missedStatus],
          repairedEventIds: ["event-reconciled-1"],
        },
      ],
      modelResumeAttempts: 0,
    });
  });

  it("resumes an unexpectedly dead Job exactly once from a durable checkpoint", async () => {
    const setup = fixture({ processState: "exited" });

    const outcome = await setup.coordinator.reconcileAll(setup.request);

    expect(outcome).toMatchObject({
      state: "completed",
      targets: [
        {
          state: "resumed",
          checkpointId: "checkpoint-job-1",
          processRecoveries: 1,
        },
      ],
      modelResumeAttempts: 1,
    });
    expect(setup.calls).toContain(
      `lease:recovery:${baseJob.id}:reconciler-1:reconcile:tick-1:prepare-recovery-lease:${baseJob.id}`,
    );
    expect(setup.calls).toContain(
      `jobs:update:${baseJob.id}:reconcile:tick-1:consume-recovery:${baseJob.id}`,
    );
    expect(setup.calls.at(-1)).toBe(
      `process:resume:${baseJob.id}:checkpoint-job-1:reconcile:tick-1:resume:${baseJob.id}`,
    );
  });

  it("blocks a dead Job without a checkpoint and never starts a model", async () => {
    const setup = fixture({ targets: [target(baseJob, null)], processState: "missing" });

    await expect(setup.coordinator.reconcileAll(setup.request)).resolves.toMatchObject({
      state: "degraded",
      targets: [{ state: "blocked", reason: "checkpoint_missing" }],
      modelResumeAttempts: 0,
    });
    expect(setup.calls.some((call) => call.startsWith("process:resume:"))).toBe(false);
  });

  it("blocks a second process death after the single recovery allowance is spent", async () => {
    const exhausted = jobSchema.parse({
      ...baseJob,
      attempts: { ...baseJob.attempts, processRecoveries: 1 },
    });
    const setup = fixture({ targets: [target(exhausted)], processState: "exited" });

    await expect(setup.coordinator.reconcileAll(setup.request)).resolves.toMatchObject({
      state: "degraded",
      targets: [{ state: "blocked", reason: "recovery_limit_reached" }],
      modelResumeAttempts: 0,
    });
  });

  it("does not consume recovery or start a model without a durable recovery Lease", async () => {
    const setup = fixture({ processState: "exited", recoveryLeaseReady: false });

    await expect(setup.coordinator.reconcileAll(setup.request)).resolves.toMatchObject({
      state: "degraded",
      targets: [{ state: "blocked", reason: "lease_unavailable" }],
      modelResumeAttempts: 0,
    });
    expect(setup.calls.some((call) => call.startsWith("jobs:update:"))).toBe(false);
    expect(setup.calls.some((call) => call.startsWith("process:resume:"))).toBe(false);
  });

  it("repairs all targets independently when one provider source is unavailable", async () => {
    const secondJob = jobSchema.parse({
      ...baseJob,
      id: "job_028f47d2-77a4-7cc1-8ef2-0123456789ab",
      issueId: "issue_028f47d2-77a4-7cc1-8ef2-0123456789ab",
    });
    const setup = fixture({
      targets: [target(), target(secondJob, "checkpoint-job-2")],
      providerByJob: {
        [baseJob.id]: err(domainError("external_failure")),
        [secondJob.id]: ok({ findings: [] }),
      },
    });

    await expect(setup.coordinator.reconcileAll(setup.request)).resolves.toMatchObject({
      state: "degraded",
      targets: [
        { state: "failed", jobId: baseJob.id, stage: "provider" },
        { state: "healthy", jobId: secondJob.id },
      ],
      modelResumeAttempts: 0,
    });
    expect(setup.calls).toContain(`process:inspect:${secondJob.id}`);
  });

  it("does not inspect or resume a process when event repair is not durable", async () => {
    const setup = fixture({
      provider: ok({ findings: [missedStatus] }),
      eventDurability: "unknown",
      processState: "exited",
    });

    await expect(setup.coordinator.reconcileAll(setup.request)).resolves.toMatchObject({
      state: "degraded",
      targets: [{ state: "blocked", reason: "event_repair_unconfirmed" }],
      modelResumeAttempts: 0,
    });
    expect(setup.calls.some((call) => call.startsWith("process:inspect:"))).toBe(false);
  });

  it("does not resume when the recovery attempt write cannot be confirmed", async () => {
    const setup = fixture({ processState: "exited", updateDurability: "unknown" });

    await expect(setup.coordinator.reconcileAll(setup.request)).resolves.toMatchObject({
      state: "degraded",
      targets: [{ state: "failed", stage: "job" }],
      modelResumeAttempts: 0,
    });
    expect(setup.calls.some((call) => call.startsWith("process:resume:"))).toBe(false);
    expect(setup.calls).toContain(
      `lease:release:lease-recovery-1:reconciler-1:reconcile:tick-1:release-recovery-lease:${baseJob.id}`,
    );
  });

  it("counts an attempted resume even when the process start is not confirmed", async () => {
    const setup = fixture({
      processState: "exited",
      resumeStarted: false,
      resumeDurability: "unknown",
    });

    await expect(setup.coordinator.reconcileAll(setup.request)).resolves.toMatchObject({
      state: "degraded",
      targets: [{ state: "failed", stage: "recovery" }],
      modelResumeAttempts: 1,
    });
  });

  it("fails globally before provider reads when lease reclamation is uncertain", async () => {
    const setup = fixture({ leasePersistence: "unknown" });

    await expect(setup.coordinator.reconcileAll(setup.request)).resolves.toMatchObject({
      state: "failed",
      stage: "leases",
      error: { code: "conflict" },
    });
    expect(setup.calls.some((call) => call.startsWith("providers:"))).toBe(false);
  });

  it("rejects duplicate or malformed active Job snapshots before mutation", async () => {
    const setup = fixture({ targets: [target(), target()] });

    await expect(setup.coordinator.reconcileAll(setup.request)).resolves.toMatchObject({
      state: "failed",
      stage: "jobs",
      error: { code: "conflict" },
    });
    expect(setup.calls).toEqual(["jobs:list"]);
  });
});
