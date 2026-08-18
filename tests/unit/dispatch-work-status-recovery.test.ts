import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FileJobProgressStore,
  JobProgressWorkStatusLifecycleLedger,
} from "../../src/adapters/dispatch/index.js";
import { WorkStatusLifecycleCoordinator } from "../../src/application/pipelines/index.js";
import {
  domainError,
  err,
  ok,
  parseIdentifier,
  parseInstant,
  type Identifier,
} from "../../src/domain/foundation/index.js";
import { jobSchema } from "../../src/domain/jobs/index.js";
import { issueSchema, projectSchema } from "../../src/domain/project/index.js";
import { sha256Digest } from "../../src/domain/review/index.js";
import { createAgentCondition, type WorkStatus } from "../../src/domain/workflow/index.js";
import { WorkStatusRecoveryCoordinator } from "../../src/cli/dispatch/work-status-recovery-coordinator.js";

function id<Scope extends string>(scope: Scope, value: string): Identifier<Scope> {
  const parsed = parseIdentifier(scope, value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}
function instant(value: string) {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const now = instant("2026-08-18T01:00:00.000Z");
const project = projectSchema.parse({
  schemaVersion: 1,
  id: id("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab"),
  displayName: "Sandbox",
  localRepositoryPath: "/tmp/sandbox",
  defaultBranch: "main",
  workManagement: { provider: "linear", containerId: "team-1", projectId: "linear-project" },
  sourceControl: { provider: "github", repository: "owner/sandbox" },
});
const issue = issueSchema.parse({
  schemaVersion: 1,
  id: id("issue", "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab"),
  projectId: project.id,
  externalId: "linear-53",
  title: "Recovery",
});
const job = jobSchema.parse({
  schemaVersion: 1,
  id: id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab"),
  projectId: project.id,
  issueId: issue.id,
  createdAt: now,
  watchdogExtensionGranted: false,
  attempts: { processRecoveries: 0, ciFixRounds: 0, reviewerFixRounds: 0, reviewRuns: 0 },
});
const transitionInstance = "1".repeat(64);
const capabilityDigest = "2".repeat(64);

class FakeWorkManagement {
  status: WorkStatus;
  stateId: string;
  setStatusCalls = 0;
  readonly entries: {
    id: string;
    createdAt: typeof now;
    actorKind: "automation";
    fromStateId: string | null;
    toStateId: string | null;
    fromTeamId: null;
    toTeamId: null;
    fromProjectId: null;
    toProjectId: null;
    archived: null;
    trashed: null;
  }[] = [];

  constructor(status: WorkStatus) {
    this.status = status;
    this.stateId = status === "ready" ? "state-ready" : "state-progress";
  }

  getIssue() {
    return Promise.resolve(
      ok({
        issue,
        workStatus: this.status,
        workStatusStateId: this.stateId,
        agentCondition: createAgentCondition("executing"),
        trashed: false,
        updatedAt: now,
        revision: `revision-${String(this.entries.length)}`,
      }),
    );
  }

  getIssueHistory() {
    return Promise.resolve(
      ok({
        currentStateId: this.stateId,
        stateIdByWorkStatus: {
          backlog: "state-backlog",
          ready: "state-ready",
          requires_manual: "state-manual",
          in_progress: "state-progress",
          in_review: "state-review",
          completed: "state-completed",
          canceled: "state-canceled",
        },
        entries: this.entries,
        stateSpans: [
          {
            id: "span-ready",
            stateId: "state-ready",
            startedAt: now,
            endedAt: this.status === "ready" ? null : now,
          },
          ...(this.status === "in_progress"
            ? [
                {
                  id: "span-progress",
                  stateId: "state-progress",
                  startedAt: now,
                  endedAt: null,
                },
              ]
            : []),
        ],
      }),
    );
  }

  setWorkStatus(_reference: unknown, status: WorkStatus) {
    this.setStatusCalls += 1;
    this.entries.push({
      id: `history-${String(this.entries.length + 1)}`,
      createdAt: now,
      actorKind: "automation",
      fromStateId: this.stateId,
      toStateId: status === "in_progress" ? "state-progress" : "state-other",
      fromTeamId: null,
      toTeamId: null,
      fromProjectId: null,
      toProjectId: null,
      archived: null,
      trashed: null,
    });
    this.status = status;
    this.stateId = status === "in_progress" ? "state-progress" : "state-other";
    return this.getIssue();
  }

  setAgentCondition() {
    return this.getIssue();
  }
  clearAgentCondition() {
    return this.getIssue();
  }
}

async function harness(
  current: WorkStatus,
  onLockAcquire?: (workManagement: FakeWorkManagement) => void,
) {
  const root = await mkdtemp(join(tmpdir(), "agent-team-work-status-recovery-"));
  const progress = new FileJobProgressStore(join(root, "progress"));
  const prefixDigest = sha256Digest({ schemaVersion: 1, entries: [] });
  if (!prefixDigest.ok) throw new Error(prefixDigest.error.code);
  const stored = await progress.compareAndSwap(job.id, null, {
    jobId: job.id,
    projectId: project.id,
    issueId: issue.id,
    externalIssueId: issue.externalId,
    model: "gpt-test",
    stage: {
      kind: "requires_manual",
      cause: {
        stage: "dispatch",
        reasonCode: "work_status_lifecycle_failed",
        attempts: { count: 1 },
      },
    },
    branch: "agent/recovery",
    worktreePath: join(root, "worktree"),
    workStatusLifecycle: {
      admissionMode: "enforce",
      capabilityDigest,
      phase: "work_start",
      transitions: [
        {
          step: "work_start",
          instance: transitionInstance,
          mainTarget: "in_progress",
          allowedMainSources: ["ready", "in_progress"],
          agentTarget: { kind: "set", status: "executing" },
          main: { state: "sent_unknown", idempotencyKey: "old-main", errorCode: "timeout" },
          agent: {
            state: "confirmed",
            idempotencyKey: "old-agent",
            confirmedAt: now,
            observedRevision: "revision-0",
          },
          mainFailures: { count: 1, lastErrorCode: "timeout", lastInvocation: "3".repeat(64) },
          agentFailures: { count: 0 },
          historyEvidence: {
            preStateId: "state-ready",
            targetStateId: "state-progress",
            observedRevision: "revision-0",
            historyPrefixDigest: prefixDigest.value,
            historyEntryCount: 0,
            preStateSpanId: "span-ready",
          },
        },
      ],
      incident: { reasonCode: "mutation_unconfirmed", channel: "main" },
    },
  });
  if (!stored.ok) throw new Error(stored.error.code);
  const workManagement = new FakeWorkManagement(current);
  const locks = {
    acquire: (_scope: unknown, holderId: string) => {
      onLockAcquire?.(workManagement);
      return Promise.resolve(
        ok({
          scopeDigest: "4".repeat(64),
          holderId,
          release: () => Promise.resolve(ok(undefined)),
        }),
      );
    },
  };
  const lifecycle = new WorkStatusLifecycleCoordinator({
    workManagement,
    history: workManagement,
    ledger: new JobProgressWorkStatusLifecycleLedger(progress),
    locks,
  });
  const dependencies = {
    jobs: {
      create: () => Promise.resolve(ok({ durability: "confirmed" as const })),
      readAll: () => Promise.resolve(ok([job])),
    },
    admission: {
      load: () =>
        Promise.resolve(
          ok({
            schemaVersion: 1 as const,
            revision: 1,
            projectId: project.id,
            issueId: issue.id,
            externalIssueId: issue.externalId,
            jobId: job.id,
            state: "active" as const,
            claimedAt: now,
            updatedAt: now,
          }),
        ),
    },
    leases: {
      acquire: () =>
        Promise.resolve(
          ok({ value: { id: id("lease", "lease_018f47d2-77a4-7cc1-8ef2-0123456789ab") } }),
        ),
      release: () => Promise.resolve(ok({ value: {} })),
    } as never,
    locks,
    workManagement,
    lifecycle,
    project,
  };
  const makeCoordinator = (progressPort: typeof progress | object = progress) =>
    new WorkStatusRecoveryCoordinator({ ...dependencies, progress: progressPort as never });
  return { coordinator: makeCoordinator(), makeCoordinator, progress, workManagement };
}

describe("dispatch work-status recovery", () => {
  it("settles target-observed with an operator receipt while preserving sent_unknown", async () => {
    const test = await harness("in_progress");
    await expect(
      test.coordinator.run({
        jobId: job.id,
        transitionInstance,
        holderId: "operator",
        dryRun: false,
      }),
    ).resolves.toMatchObject({ state: "recovered", disposition: "target_observed" });
    const record = await test.progress.load(job.id);
    expect(record.ok && record.value?.stage.kind).toBe("work_start_pending");
    expect(record.ok && record.value?.workStatusLifecycle?.transitions[0]?.main.state).toBe(
      "sent_unknown",
    );
    expect(record.ok && record.value?.workStatusLifecycle?.recoveries).toHaveLength(1);
    expect(test.workManagement.setStatusCalls).toBe(0);
  });

  it("reissues one bounded transition only when the exact pre-state is restored", async () => {
    const test = await harness("ready");
    await expect(
      test.coordinator.run({
        jobId: job.id,
        transitionInstance,
        holderId: "operator",
        dryRun: false,
      }),
    ).resolves.toMatchObject({ state: "recovered", disposition: "pre_state_reissued" });
    const record = await test.progress.load(job.id);
    expect(record.ok && record.value?.stage.kind).toBe("work_start_pending");
    expect(record.ok && record.value?.workStatusLifecycle?.transitions).toHaveLength(2);
    expect(record.ok && record.value?.workStatusLifecycle?.transitions[0]?.main.state).toBe(
      "sent_unknown",
    );
    expect(record.ok && record.value?.workStatusLifecycle?.transitions[1]?.main.state).toBe(
      "confirmed",
    );
    expect(test.workManagement.setStatusCalls).toBe(1);
  });

  it("dry-run reports a legal plan without receipt, lease, or Linear mutation", async () => {
    const test = await harness("ready");
    await expect(
      test.coordinator.run({
        jobId: job.id,
        transitionInstance,
        holderId: "operator",
        dryRun: true,
      }),
    ).resolves.toMatchObject({ state: "ready", plannedMutation: "new_bounded_transition" });
    const record = await test.progress.load(job.id);
    expect(record.ok && record.value?.workStatusLifecycle?.recoveries).toBeUndefined();
    expect(test.workManagement.setStatusCalls).toBe(0);
  });

  it("fails closed on work-status drift without writing a receipt or mutation", async () => {
    const test = await harness("in_review");
    await expect(
      test.coordinator.run({
        jobId: job.id,
        transitionInstance,
        holderId: "operator",
        dryRun: false,
      }),
    ).resolves.toEqual({ state: "blocked", reason: "work_status_not_recoverable" });
    const record = await test.progress.load(job.id);
    expect(record.ok && record.value?.workStatusLifecycle?.recoveries).toBeUndefined();
    expect(test.workManagement.setStatusCalls).toBe(0);
  });

  it("re-reads issue and history under the shared lock and rejects state changed after preflight", async () => {
    const test = await harness("ready", (workManagement) => {
      workManagement.status = "in_review";
      workManagement.stateId = "state-review";
    });

    await expect(
      test.coordinator.run({
        jobId: job.id,
        transitionInstance,
        holderId: "operator",
        dryRun: false,
      }),
    ).resolves.toEqual({ state: "blocked", reason: "work_status_not_recoverable" });
    const record = await test.progress.load(job.id);
    expect(record.ok && record.value?.workStatusLifecycle?.recoveries).toBeUndefined();
    expect(test.workManagement.setStatusCalls).toBe(0);
  });

  it("restarts from the durable operator receipt without appending another recovery epoch", async () => {
    const test = await harness("in_progress");
    let writes = 0;
    const crashAfterReceipt = {
      load: test.progress.load.bind(test.progress),
      compareAndSwap: (...arguments_: Parameters<typeof test.progress.compareAndSwap>) => {
        writes += 1;
        return writes === 2
          ? Promise.resolve(err(domainError("conflict")))
          : test.progress.compareAndSwap(...arguments_);
      },
    };
    await expect(
      test.makeCoordinator(crashAfterReceipt).run({
        jobId: job.id,
        transitionInstance,
        holderId: "operator-first",
        dryRun: false,
      }),
    ).resolves.toEqual({ state: "blocked", reason: "checkpoint_conflict" });
    let record = await test.progress.load(job.id);
    expect(record.ok && record.value?.stage.kind).toBe("requires_manual");
    expect(record.ok && record.value?.workStatusLifecycle?.recoveries).toHaveLength(1);

    await expect(
      test.makeCoordinator().run({
        jobId: job.id,
        transitionInstance,
        holderId: "operator-second",
        dryRun: false,
      }),
    ).resolves.toMatchObject({ state: "recovered", disposition: "target_observed" });
    record = await test.progress.load(job.id);
    expect(record.ok && record.value?.workStatusLifecycle?.recoveries).toHaveLength(1);
    expect(test.workManagement.setStatusCalls).toBe(0);
  });
});
