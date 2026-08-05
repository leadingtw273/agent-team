import { describe, expect, it } from "vitest";

import {
  WatchdogCoordinator,
  type WatchdogActivity,
  type WatchdogCheckpointPort,
  type WatchdogCoordinatorRequest,
  type WatchdogInspectionPort,
  type WatchdogJobPort,
} from "../../src/application/watchdog/index.js";
import { createFixedClock, ok, parseInstant } from "../../src/domain/foundation/index.js";
import { jobSchema, type Job } from "../../src/domain/jobs/index.js";

function instant(value: string) {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const startedAt = instant("2026-08-05T12:00:00.000Z");
const baseJob = jobSchema.parse({
  schemaVersion: 1,
  id: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  projectId: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  issueId: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  createdAt: startedAt,
  startedAt,
  watchdogExtensionGranted: false,
  attempts: { processRecoveries: 0, ciFixRounds: 0, reviewerFixRounds: 0, reviewRuns: 0 },
});

const effectiveActivity: WatchdogActivity = {
  kind: "test_or_build_milestone",
  occurredAt: instant("2026-08-05T12:44:00.000Z"),
  fingerprint: "tests:42-green",
  summary: "A bounded test milestone passed.",
};

interface FixtureOptions {
  readonly now?: string;
  readonly job?: Job;
  readonly activities?: readonly WatchdogActivity[];
  readonly originalAgentCompletionCheaper?: boolean;
  readonly inspectionSummary?: string;
  readonly jobDurability?: "confirmed" | "unknown";
  readonly persistedJob?: Job;
  readonly checkpointDurability?: "confirmed" | "unknown";
  readonly processStopped?: boolean;
  readonly checkpointId?: string;
}

function fixture(options: FixtureOptions = {}) {
  const calls: string[] = [];
  const job = options.job ?? baseJob;
  const activities = options.activities ?? [effectiveActivity];

  const inspection: WatchdogInspectionPort = {
    inspect(request) {
      calls.push(`inspection:${String(request.effectiveProgress.length)}`);
      return Promise.resolve(
        ok({
          originalAgentCompletionCheaper: options.originalAgentCompletionCheaper ?? true,
          summary: options.inspectionSummary ?? "The original agent can finish more cheaply.",
        }),
      );
    },
  };
  const jobs: WatchdogJobPort = {
    update(updatedJob, mutationOptions) {
      calls.push(`job:${mutationOptions.idempotencyKey}`);
      return Promise.resolve(
        ok({
          job:
            options.persistedJob ??
            jobSchema.parse({ ...updatedJob, watchdogExtensionGranted: true }),
          durability: options.jobDurability ?? "confirmed",
        }),
      );
    },
  };
  const checkpoint: WatchdogCheckpointPort = {
    checkpointAndStop(checkpointRequest, mutationOptions) {
      calls.push(
        `checkpoint:${checkpointRequest.reason}:${String(checkpointRequest.activities.length)}:${mutationOptions.idempotencyKey}`,
      );
      return Promise.resolve(
        ok({
          checkpointId: options.checkpointId ?? "checkpoint-watchdog-1",
          processStopped: options.processStopped ?? true,
          durability: options.checkpointDurability ?? "confirmed",
        }),
      );
    },
  };
  const coordinator = new WatchdogCoordinator(
    {
      activities: {
        list(jobId) {
          calls.push(`activities:${jobId}`);
          return Promise.resolve(ok(activities));
        },
      },
      inspection,
      jobs,
      checkpoint,
    },
    { clock: createFixedClock(instant(options.now ?? "2026-08-05T12:45:00.000Z")) },
  );
  const request: WatchdogCoordinatorRequest = {
    job,
    remainingWorkSummary: "One small verified change remains.",
    idempotencyKeyPrefix: "watchdog:job-1",
  };

  return { calls, coordinator, request };
}

describe("watchdog coordinator", () => {
  it("continues before 45 minutes without consuming any port", async () => {
    const setup = fixture({ now: "2026-08-05T12:44:59.999Z" });

    await expect(setup.coordinator.evaluate(setup.request)).resolves.toEqual({
      state: "continue",
      extension: "none",
    });
    expect(setup.calls).toEqual([]);
  });

  it("keeps an already granted extension active until the hard boundary", async () => {
    const setup = fixture({
      now: "2026-08-05T12:59:59.999Z",
      job: jobSchema.parse({ ...baseJob, watchdogExtensionGranted: true }),
    });

    await expect(setup.coordinator.evaluate(setup.request)).resolves.toEqual({
      state: "continue",
      extension: "active",
    });
    expect(setup.calls).toEqual([]);
  });

  it("grants the one-time extension from unique effective evidence at 45 minutes", async () => {
    const setup = fixture({
      activities: [
        { kind: "heartbeat", occurredAt: instant("2026-08-05T12:43:00.000Z") },
        {
          kind: "command_execution",
          occurredAt: instant("2026-08-05T12:43:10.000Z"),
          fingerprint: "pnpm-test",
        },
        {
          kind: "model_output",
          occurredAt: instant("2026-08-05T12:43:20.000Z"),
          fingerprint: "message-1",
        },
        effectiveActivity,
        { ...effectiveActivity, occurredAt: instant("2026-08-05T12:44:30.000Z") },
        {
          kind: "controlled_git_diff",
          occurredAt: instant("2026-08-05T12:44:40.000Z"),
          fingerprint: "diff:a1",
          summary: "A controlled diff exists.",
        },
      ],
    });

    const outcome = await setup.coordinator.evaluate(setup.request);

    expect(outcome.state).toBe("extended");
    if (outcome.state === "extended") {
      expect(outcome.job.watchdogExtensionGranted).toBe(true);
      expect(outcome.effectiveProgress.map(({ kind }) => kind)).toEqual([
        "test_or_build_milestone",
        "controlled_git_diff",
      ]);
    }
    expect(setup.calls).toEqual([
      `activities:${baseJob.id}`,
      "inspection:2",
      "job:watchdog:job-1:grant-extension",
    ]);
  });

  it("checkpoints and replans mechanically when only noisy activity exists", async () => {
    const noisyActivities: WatchdogActivity[] = [
      { kind: "heartbeat", occurredAt: instant("2026-08-05T12:44:00.000Z") },
      {
        kind: "command_execution",
        occurredAt: instant("2026-08-05T12:44:10.000Z"),
        fingerprint: "same-command",
      },
      {
        kind: "model_output",
        occurredAt: instant("2026-08-05T12:44:20.000Z"),
        fingerprint: "unverified-output",
      },
    ];
    const setup = fixture({ activities: noisyActivities });

    await expect(setup.coordinator.evaluate(setup.request)).resolves.toEqual({
      state: "checkpointed",
      reason: "watchdog_replan",
      checkpointId: "checkpoint-watchdog-1",
    });
    expect(setup.calls).toEqual([
      `activities:${baseJob.id}`,
      "checkpoint:watchdog_replan:3:watchdog:job-1:watchdog_replan",
    ]);
  });

  it("checkpoints after inspection when continuing the original agent is not cheaper", async () => {
    const setup = fixture({ originalAgentCompletionCheaper: false });

    await expect(setup.coordinator.evaluate(setup.request)).resolves.toMatchObject({
      state: "checkpointed",
      reason: "watchdog_replan",
    });
    expect(setup.calls).toEqual([
      `activities:${baseJob.id}`,
      "inspection:1",
      "checkpoint:watchdog_replan:1:watchdog:job-1:watchdog_replan",
    ]);
  });

  it("hard-stops at 60 minutes without asking the model inspector", async () => {
    const setup = fixture({ now: "2026-08-05T13:00:00.000Z" });

    await expect(setup.coordinator.evaluate(setup.request)).resolves.toEqual({
      state: "checkpointed",
      reason: "watchdog_hard_stop",
      checkpointId: "checkpoint-watchdog-1",
    });
    expect(setup.calls).toEqual([
      `activities:${baseJob.id}`,
      "checkpoint:watchdog_hard_stop:1:watchdog:job-1:watchdog_hard_stop",
    ]);
  });

  it("fails closed on activity outside the observed job window", async () => {
    const setup = fixture({
      activities: [{ ...effectiveActivity, occurredAt: instant("2026-08-05T12:45:00.001Z") }],
    });

    await expect(setup.coordinator.evaluate(setup.request)).resolves.toMatchObject({
      state: "failed",
      stage: "activities",
      error: { code: "conflict" },
    });
    expect(setup.calls).toEqual([`activities:${baseJob.id}`]);
  });

  it("fails closed when the extension write is not durably confirmed", async () => {
    const setup = fixture({ jobDurability: "unknown" });

    await expect(setup.coordinator.evaluate(setup.request)).resolves.toMatchObject({
      state: "failed",
      stage: "job",
      error: { code: "conflict" },
    });
  });

  it("fails closed when the durable read-back no longer identifies the same job", async () => {
    const setup = fixture({
      persistedJob: jobSchema.parse({
        ...baseJob,
        issueId: "issue_028f47d2-77a4-7cc1-8ef2-0123456789ab",
        watchdogExtensionGranted: true,
      }),
    });

    await expect(setup.coordinator.evaluate(setup.request)).resolves.toMatchObject({
      state: "failed",
      stage: "job",
      error: { code: "conflict" },
    });
  });

  it("fails closed unless checkpoint durability and process stop are confirmed", async () => {
    const setup = fixture({
      activities: [],
      checkpointDurability: "unknown",
      processStopped: false,
    });

    await expect(setup.coordinator.evaluate(setup.request)).resolves.toMatchObject({
      state: "failed",
      stage: "checkpoint",
      error: { code: "external_failure" },
    });
  });

  it("rejects malformed requests before using any port", async () => {
    const setup = fixture();
    const invalidRequest = {
      ...setup.request,
      remainingWorkSummary: " ",
    } satisfies WatchdogCoordinatorRequest;

    await expect(setup.coordinator.evaluate(invalidRequest)).resolves.toMatchObject({
      state: "failed",
      stage: "request",
      error: { code: "invariant_violation" },
    });
    expect(setup.calls).toEqual([]);
  });
});
