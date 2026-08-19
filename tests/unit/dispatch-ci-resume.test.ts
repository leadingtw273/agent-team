import { describe, expect, it, vi } from "vitest";

import { CiResumeCoordinator } from "../../src/cli/dispatch/ci-resume-coordinator.js";
import { createCiResumeHandler } from "../../src/cli/dispatch/ci-resume-handlers.js";
import type { JobProgressRecord } from "../../src/adapters/dispatch/job-progress-store.js";
import {
  ok,
  parseIdentifier,
  parseInstant,
  type Identifier,
} from "../../src/domain/foundation/index.js";
import { issueSchema, projectSchema } from "../../src/domain/project/index.js";
import { createAgentCondition } from "../../src/domain/workflow/index.js";

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
const now = instant("2026-08-20T00:00:00.000Z");
const project = projectSchema.parse({
  schemaVersion: 1,
  id: id("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab"),
  displayName: "Tank",
  localRepositoryPath: "/tmp/tank",
  defaultBranch: "main",
  workManagement: { provider: "linear", containerId: "team", projectId: "linear-project" },
  sourceControl: { provider: "github", repository: "owner/tank" },
});
const issue = issueSchema.parse({
  schemaVersion: 1,
  id: id("issue", "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab"),
  projectId: project.id,
  externalId: "linear-82",
  title: "CI resume",
  agentRole: "implementer",
});
const jobId = id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const headSha = "a".repeat(40);

function fixture(
  options: {
    ci?: "success" | "failure";
    failClearOnce?: boolean;
    failWorkStartOnce?: boolean;
  } = {},
) {
  let record = {
    schemaVersion: 1,
    revision: 10,
    jobId,
    projectId: project.id,
    issueId: issue.id,
    externalIssueId: issue.externalId,
    model: "gpt-test",
    stage: {
      kind: "requires_manual",
      cause: {
        stage: "ci_recovery",
        reasonCode: "ci_recovery_paused",
        attempts: { count: 1 },
      },
    },
    branch: `agent-team/${jobId}`,
    worktreePath: `/tmp/${jobId}`,
    baseRevision: "b".repeat(40),
    headSha,
    changeRequestId: "26",
    workStatusLifecycle: {
      admissionMode: "enforce",
      capabilityDigest: "c".repeat(64),
      phase: "terminal",
      transitions: [
        {
          step: "work_start",
          instance: "1".repeat(64),
          mainTarget: "in_progress",
          allowedMainSources: ["ready"],
          agentTarget: { kind: "set", status: "executing" },
          main: { state: "confirmed" },
          agent: { state: "confirmed" },
          mainFailures: { count: 0 },
          agentFailures: { count: 0 },
        },
        {
          step: "requires_manual",
          instance: "2".repeat(64),
          mainTarget: "requires_manual",
          allowedMainSources: ["in_progress"],
          agentTarget: {
            kind: "set",
            status: "blocked",
            blockingReason: "integration_failure",
          },
          main: { state: "confirmed" },
          agent: { state: "confirmed" },
          mainFailures: { count: 0 },
          agentFailures: { count: 0 },
        },
      ],
    },
    updatedAt: now,
  } as unknown as JobProgressRecord;
  let workStatus: "requires_manual" | "ready" | "in_progress" = "requires_manual";
  let agentCondition = createAgentCondition("blocked", ["integration_failure"]);
  let failClearOnce = options.failClearOnce === true;
  let failWorkStartOnce = options.failWorkStartOnce === true;
  const compareAndSwap = vi.fn((_: string, expectedRevision: number, mutation: never) => {
    if (record.revision !== expectedRevision) throw new Error("unexpected_revision");
    record = {
      ...(mutation as object),
      schemaVersion: 1,
      revision: record.revision + 1,
      updatedAt: now,
    } as JobProgressRecord;
    return Promise.resolve(ok(record));
  });
  const acquire = vi.fn(() =>
    Promise.resolve(
      ok({
        value: { id: id("lease", "lease_018f47d2-77a4-7cc1-8ef2-0123456789ab") },
      } as never),
    ),
  );
  const release = vi.fn(() => Promise.resolve(ok({} as never)));
  const acquireLock = vi.fn((_: unknown, holderId: string) =>
    Promise.resolve(
      ok({
        holderId,
        scopeDigest: "d".repeat(64),
        release: () => Promise.resolve(ok(undefined)),
      }),
    ),
  );
  const lifecycleRequests: { step: string; transitionInstance: string }[] = [];
  const transitionWhileLockHeld = vi.fn((request: never) => {
    const typed = request as {
      step: "clear_condition" | "work_start";
      transitionInstance: string;
      mainTarget: "ready" | "in_progress";
      allowedMainSources: string[];
      agentTarget: { kind: "clear" } | { kind: "set"; status: "executing" };
      phase: "work_start" | "implementing";
    };
    lifecycleRequests.push(typed);
    const checkpoint = record.workStatusLifecycle;
    if (checkpoint === undefined) throw new Error("missing_lifecycle_checkpoint");
    const existing = checkpoint.transitions.find(
      (transition: { instance: string }) => transition.instance === typed.transitionInstance,
    );
    if (existing === undefined) {
      record = {
        ...record,
        revision: record.revision + 1,
        workStatusLifecycle: {
          ...checkpoint,
          phase: typed.phase,
          transitions: [
            ...checkpoint.transitions,
            {
              step: typed.step,
              instance: typed.transitionInstance,
              mainTarget: typed.mainTarget,
              allowedMainSources: typed.allowedMainSources,
              agentTarget: typed.agentTarget,
              main: { state: "confirmed" },
              agent: { state: "confirmed" },
              mainFailures: { count: 0 },
              agentFailures: { count: 0 },
            },
          ],
        },
      } as JobProgressRecord;
    }
    workStatus = typed.mainTarget;
    if (typed.agentTarget.kind === "clear") agentCondition = createAgentCondition("queued");
    else agentCondition = createAgentCondition("executing");
    if (typed.step === "clear_condition" && failClearOnce) {
      failClearOnce = false;
      return Promise.resolve({
        state: "permitted" as const,
        mode: "enforce" as const,
        main: "confirmed" as const,
        agent: "pending" as const,
      });
    }
    if (typed.step === "work_start" && failWorkStartOnce) {
      failWorkStartOnce = false;
      return Promise.resolve({
        state: "permitted" as const,
        mode: "enforce" as const,
        main: "confirmed" as const,
        agent: "pending" as const,
      });
    }
    return Promise.resolve({
      state: "permitted" as const,
      mode: "enforce" as const,
      main: "confirmed" as const,
      agent: "confirmed" as const,
    });
  });
  const coordinator = new CiResumeCoordinator({
    project,
    progress: { load: () => Promise.resolve(ok(record)), compareAndSwap },
    jobs: {
      readAll: () =>
        Promise.resolve(ok([{ id: jobId, projectId: project.id, issueId: issue.id }] as never)),
    } as never,
    admission: {
      load: () =>
        Promise.resolve(
          ok({
            state: "active",
            projectId: project.id,
            issueId: issue.id,
            externalIssueId: issue.externalId,
            jobId,
            revision: 3,
          } as never),
        ),
    },
    leases: { acquire, release },
    locks: { acquire: acquireLock },
    workManagement: {
      getIssue: () =>
        Promise.resolve(
          ok({
            issue,
            workStatus,
            agentCondition,
            updatedAt: now,
            revision: `linear-${String(record.revision)}`,
          }),
        ),
    },
    lifecycle: { transitionWhileLockHeld },
    sourceControl: {
      getChangeRequest: () =>
        Promise.resolve(
          ok({
            id: "pr-node-26",
            number: 26,
            url: "https://example.test/pr/26",
            state: "open",
            draft: true,
            baseBranch: "main",
            headBranch: `agent-team/${jobId}`,
            headSha,
            mergeability: "mergeable",
            mergeStateStatus: "blocked",
            autoMergeEnabled: false,
            updatedAt: now,
          }),
        ),
      getCommitChecks: () =>
        Promise.resolve(
          ok({
            headSha,
            aggregate: options.ci ?? "success",
            checks: [
              {
                name: "quality",
                status: "completed",
                conclusion: options.ci === "failure" ? "failure" : "success",
              },
            ],
          }),
        ),
    },
  });
  return {
    coordinator,
    acquire,
    release,
    acquireLock,
    compareAndSwap,
    transitionWhileLockHeld,
    lifecycleRequests,
    record: () => record,
    workStatus: () => workStatus,
  };
}

describe("exact-job CI resume", () => {
  it("dry-run performs authoritative admission with zero mutation", async () => {
    const test = fixture();
    const result = await test.coordinator.run({ jobId, holderId: "ci-resume:test", dryRun: true });

    expect(result).toMatchObject({ state: "ready", dryRun: true, jobId, headSha });
    expect(test.acquire).not.toHaveBeenCalled();
    expect(test.acquireLock).not.toHaveBeenCalled();
    expect(test.transitionWhileLockHeld).not.toHaveBeenCalled();
    expect(test.compareAndSwap).not.toHaveBeenCalled();
  });

  it("restores requires_manual through ready and in_progress before checkpointing ci_waiting", async () => {
    const test = fixture();
    const result = await test.coordinator.run({ jobId, holderId: "ci-resume:test", dryRun: false });

    expect(result).toMatchObject({ state: "checkpointed", dryRun: false, jobId, headSha });
    expect(test.lifecycleRequests.map((request) => request.step)).toEqual([
      "clear_condition",
      "work_start",
    ]);
    expect(test.workStatus()).toBe("in_progress");
    expect(test.record().stage).toEqual({ kind: "ci_waiting" });
    expect(test.acquire).toHaveBeenCalledTimes(1);
    expect(test.release).toHaveBeenCalledTimes(1);
  });

  it("fails closed before Lease and lifecycle when same-Head CI is not successful", async () => {
    const test = fixture({ ci: "failure" });
    await expect(
      test.coordinator.run({ jobId, holderId: "ci-resume:test", dryRun: false }),
    ).resolves.toMatchObject({ state: "blocked", reason: "ci_not_successful" });
    expect(test.acquire).not.toHaveBeenCalled();
    expect(test.transitionWhileLockHeld).not.toHaveBeenCalled();
  });

  it("does not start work or write a checkpoint when clearing requires_manual is incomplete", async () => {
    const test = fixture({ failClearOnce: true });

    await expect(
      test.coordinator.run({ jobId, holderId: "ci-resume:test", dryRun: false }),
    ).resolves.toMatchObject({ state: "blocked", reason: "lifecycle_transition_failed" });
    expect(test.lifecycleRequests.map((request) => request.step)).toEqual(["clear_condition"]);
    expect(test.compareAndSwap).not.toHaveBeenCalled();
  });

  it("reuses persisted lifecycle instances after a partial work-start publication", async () => {
    const test = fixture({ failWorkStartOnce: true });
    await expect(
      test.coordinator.run({ jobId, holderId: "ci-resume:first", dryRun: false }),
    ).resolves.toMatchObject({ state: "blocked", reason: "lifecycle_transition_failed" });
    expect(test.lifecycleRequests.map((request) => request.step)).toEqual([
      "clear_condition",
      "work_start",
    ]);

    await expect(
      test.coordinator.run({ jobId, holderId: "ci-resume:second", dryRun: false }),
    ).resolves.toMatchObject({ state: "checkpointed" });
    expect(test.lifecycleRequests.map((request) => request.step)).toEqual([
      "clear_condition",
      "work_start",
      "work_start",
    ]);
    expect(test.lifecycleRequests[1]?.transitionInstance).toBe(
      test.lifecycleRequests[2]?.transitionInstance,
    );
    expect(test.record().stage).toEqual({ kind: "ci_waiting" });
  });
});

describe("exact-job CI resume handler", () => {
  it("continues only the checkpoint revision returned by the coordinator", async () => {
    const run = vi.fn(() =>
      Promise.resolve({
        state: "checkpointed" as const,
        dryRun: false as const,
        projectId: project.id,
        jobId,
        headSha,
        revision: 14,
      }),
    );
    const continueExistingJob = vi.fn(() =>
      Promise.resolve({
        state: "resumed" as const,
        outcomes: [{ jobId, outcome: "completed" as const }],
      }),
    );
    const handler = createCiResumeHandler({
      agentTeamHome: "/tmp/unused",
      generateHolderId: () => "ci-resume:test",
      runtimeFactory: () =>
        Promise.resolve({
          coordinator: { run } as unknown as CiResumeCoordinator,
          continueExistingJob,
        }),
    });

    const outcome = await handler({ jobId });

    expect(run).toHaveBeenCalledWith({
      jobId,
      holderId: "ci-resume:test",
      dryRun: false,
    });
    expect(continueExistingJob).toHaveBeenCalledOnce();
    expect(continueExistingJob).toHaveBeenCalledWith(14);
    expect(outcome.state).toBe("success");
    expect(JSON.parse(outcome.message ?? "null")).toMatchObject({
      operation: "ci-resume",
      state: "continued",
      jobId,
      checkpointRevision: 14,
      resume: { state: "resumed", outcomes: [{ jobId, outcome: "completed" }] },
    });
  });
});
