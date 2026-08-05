import { describe, expect, it } from "vitest";

import {
  CiRecoveryPipeline,
  type CiRecoveryPipelinePorts,
  type CiRecoveryPipelineRequest,
  type ImplementerPreflightReport,
} from "../../src/application/pipelines/index.js";
import { trustedProjectConfigSchema } from "../../src/application/projects/index.js";
import type {
  CommitChecksSnapshot,
  ProviderEvent,
  ProviderRunCompletion,
  ProviderRunHandle,
} from "../../src/application/ports/index.js";
import { ok, parseInstant, type Instant } from "../../src/domain/foundation/index.js";
import { jobSchema, type JobAttemptCounters } from "../../src/domain/jobs/index.js";
import { issueSchema, projectSchema } from "../../src/domain/project/index.js";
import { createRequirementSnapshot } from "../../src/domain/review/index.js";

const baseSha = "a".repeat(40);
const repairSha = "b".repeat(40);

function instant(value: string): Instant {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const now = instant("2026-08-05T00:00:00.000Z");
const deadline = instant("2026-08-05T00:30:00.000Z");
const project = projectSchema.parse({
  schemaVersion: 1,
  id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  displayName: "Fixture",
  localRepositoryPath: "/tmp/repository",
  defaultBranch: "main",
  workManagement: { provider: "linear", containerId: "workspace", projectId: "team" },
  sourceControl: { provider: "github", repository: "owner/repository" },
});
const issue = issueSchema.parse({
  schemaVersion: 1,
  id: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  projectId: project.id,
  externalId: "ENG-123",
  title: "Recover CI",
  goal: "Return failed CI to the original implementer.",
  background: "A Draft PR already exists.",
  acceptanceCriteria: ["CI repairs stop after two rounds."],
  inScope: ["src/feature"],
  outOfScope: ["Reviewer"],
  dependencies: { kind: "none" },
  priority: "high",
  agentRole: "implementer",
  reviewRequirement: "code_review",
  estimatedMinutes: 30,
  changeRegions: [{ path: "src/feature", coverage: "subtree" }],
});
const snapshotResult = createRequirementSnapshot(issue, now);
if (!snapshotResult.ok) throw new Error(snapshotResult.error.code);
const requirementSnapshot = snapshotResult.value;
const trustedConfig = trustedProjectConfigSchema.parse({
  schemaVersion: 1,
  projectId: project.id,
  defaultBranch: "main",
  platforms: {
    workManagement: project.workManagement,
    sourceControl: project.sourceControl,
  },
  projectRules: ["Run tests before Push."],
  roleInstructions: { implementer: ["Stay in scope."] },
  commands: { quality: [{ executable: "pnpm", arguments: ["test"] }], visualReview: [] },
});
const worktree = {
  repositoryRoot: project.localRepositoryPath,
  path: "/tmp/worktree",
  branch: "feature/ENG-123-ci-recovery",
  headSha: baseSha,
} as const;
const changeRequest = {
  id: "pr-7",
  number: 7,
  url: "https://example.invalid/pr/7",
  state: "open",
  draft: true,
  baseBranch: "main",
  headBranch: worktree.branch,
  headSha: baseSha,
  mergeability: "mergeable",
  autoMergeEnabled: false,
  updatedAt: now,
} as const;
const failedChecks: CommitChecksSnapshot = {
  headSha: baseSha,
  aggregate: "failure",
  checks: [{ name: "test", status: "completed", conclusion: "failure" }],
};
const pendingChecks: CommitChecksSnapshot = {
  headSha: baseSha,
  aggregate: "pending",
  checks: [{ name: "test", status: "in_progress", conclusion: null }],
};
const successfulChecks: CommitChecksSnapshot = {
  headSha: baseSha,
  aggregate: "success",
  checks: [{ name: "test", status: "completed", conclusion: "success" }],
};
const repairedChecks: CommitChecksSnapshot = {
  headSha: repairSha,
  aggregate: "pending",
  checks: [{ name: "test", status: "queued", conclusion: null }],
};
const changedPath = "src/feature/index.ts";
const preflightReport: ImplementerPreflightReport = {
  headSha: baseSha,
  allowed: true,
  scopeVerified: true,
  changedPaths: [changedPath],
  findings: [],
};

function job(attempts: Partial<JobAttemptCounters> = {}) {
  return jobSchema.parse({
    schemaVersion: 1,
    id: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    projectId: project.id,
    issueId: issue.id,
    createdAt: now,
    watchdogExtensionGranted: false,
    attempts: {
      processRecoveries: 0,
      ciFixRounds: 0,
      reviewerFixRounds: 0,
      reviewRuns: 0,
      ...attempts,
    },
  });
}

function request(overrides: Partial<CiRecoveryPipelineRequest> = {}): CiRecoveryPipelineRequest {
  return {
    trigger: { kind: "polling" },
    job: job(),
    project,
    trustedConfig,
    requirementSnapshot,
    worktree,
    changeRequest,
    model: "gpt-balanced",
    remote: "origin",
    commitMessage: "ENG-123 repair CI",
    controllerDirective: "Fix only the reported CI failure and leave a tested diff.",
    externalData: [],
    deadlineAt: deadline,
    idempotencyKeyPrefix: "job:ENG-123:ci",
    ...overrides,
  };
}

function runHandle(
  events: readonly ProviderEvent[] = [],
  completion: ProviderRunCompletion = { outcome: "completed", sessionId: "session-original" },
) {
  let interrupted = false;
  const responses: (readonly [string, "approve" | "decline"])[] = [];
  const handle: ProviderRunHandle = {
    runId: "run-ci-repair",
    events: {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        for (const event of events) yield event;
      },
    },
    completion: () => Promise.resolve(ok(completion)),
    respondToToolRequest: (id, decision) => {
      responses.push([id, decision]);
      return Promise.resolve(ok(undefined));
    },
    interrupt: () => {
      interrupted = true;
      return Promise.resolve(ok(undefined));
    },
  };
  return { handle, responses, interrupted: () => interrupted };
}

function fixture(
  options: {
    readonly initialChecks?: CommitChecksSnapshot;
    readonly newChecks?: CommitChecksSnapshot;
    readonly preflight?: ImplementerPreflightReport;
    readonly durability?: "confirmed" | "unknown";
    readonly events?: readonly ProviderEvent[];
    readonly pauseTool?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const persistedJobs: ReturnType<typeof job>[] = [];
  const checkpoints: string[] = [];
  const handle = runHandle(options.events);
  let checkRead = 0;
  const ports: CiRecoveryPipelinePorts = {
    sourceControl: {
      getCommitChecks: (_repository, sha) => {
        calls.push(`checks:${sha}`);
        checkRead += 1;
        return Promise.resolve(
          ok(
            checkRead === 1
              ? (options.initialChecks ?? failedChecks)
              : (options.newChecks ?? repairedChecks),
          ),
        );
      },
    },
    jobs: {
      update: (updated) => {
        calls.push("job:update");
        persistedJobs.push(updated);
        return Promise.resolve(ok({ durability: options.durability ?? "confirmed" }));
      },
    },
    provider: {
      inspectCapabilities: () =>
        Promise.resolve(
          ok({
            provider: "fixture",
            cliVersion: "1",
            models: ["gpt-balanced"],
            supportsResume: true,
            supportsStructuredEvents: true,
            supportsDynamicApproval: true,
            supportsVisualInput: false,
          }),
        ),
      start: (runRequest) => {
        calls.push(`provider:${runRequest.model}:${String(runRequest.job.attempts.ciFixRounds)}`);
        expect(runRequest.workingDirectory).toBe(worktree.path);
        expect(runRequest.role).toBe("implementer");
        return Promise.resolve(ok(handle.handle));
      },
    },
    toolDecisions: {
      decide: () =>
        Promise.resolve(
          ok({
            response: options.pauseTool ? "decline" : "approve",
            pause: options.pauseTool ?? false,
            summary: options.pauseTool ? "等待危險操作核可" : "allowed",
          }),
        ),
    },
    preflight: {
      inspect: () => {
        calls.push("preflight");
        return Promise.resolve(ok(options.preflight ?? preflightReport));
      },
    },
    checkpoint: {
      preserve: (checkpointRequest) => {
        calls.push(`checkpoint:${checkpointRequest.reason}`);
        checkpoints.push(checkpointRequest.reason);
        return Promise.resolve(ok({ checkpointId: `checkpoint-${checkpointRequest.reason}` }));
      },
    },
    git: {
      stagePaths: (_worktree, paths) => {
        calls.push("stage");
        return Promise.resolve(
          ok({
            headSha: baseSha,
            changes: paths.map((path) => ({
              path,
              kind: "modified" as const,
              mode: "file" as const,
              staged: true,
            })),
          }),
        );
      },
      commit: () => {
        calls.push("commit");
        return Promise.resolve(ok({ sha: repairSha, branch: worktree.branch }));
      },
      inspectWorkingTree: () => {
        calls.push("clean");
        return Promise.resolve(ok({ headSha: repairSha, changes: [] }));
      },
      push: () => {
        calls.push("push");
        return Promise.resolve(ok({ remote: "origin", branch: worktree.branch, sha: repairSha }));
      },
    },
  };
  return { pipeline: new CiRecoveryPipeline(ports), calls, persistedJobs, checkpoints, handle };
}

describe("CiRecoveryPipeline", () => {
  it("keeps pending CI mechanical and does not start a model", async () => {
    const setup = fixture({ initialChecks: pendingChecks });
    const outcome = await setup.pipeline.run(request());

    expect(outcome.state).toBe("ci_waiting");
    expect(outcome).toMatchObject({ source: "polling", checks: pendingChecks });
    expect(setup.calls).toEqual([`checks:${baseSha}`]);
  });

  it("uses webhook as a wake-up hint but requires authoritative exact-SHA success", async () => {
    const setup = fixture({ initialChecks: successfulChecks });
    const outcome = await setup.pipeline.run(
      request({
        trigger: { kind: "webhook", observedChecks: successfulChecks },
      }),
    );

    expect(outcome.state).toBe("ready_for_review");
    expect(outcome).toMatchObject({ source: "webhook", checks: successfulChecks });
    expect(setup.calls).toEqual([`checks:${baseSha}`]);
  });

  it("returns a failure to the original implementer and counts only a pushed repair", async () => {
    const setup = fixture();
    const outcome = await setup.pipeline.run(
      request({
        job: job({ reviewerFixRounds: 1, reviewRuns: 1 }),
      }),
    );

    expect(outcome.state).toBe("repair_pushed");
    expect(outcome).toMatchObject({
      job: { attempts: { ciFixRounds: 1, reviewerFixRounds: 1, reviewRuns: 1 } },
      commit: { sha: repairSha },
      push: { sha: repairSha },
      checks: repairedChecks,
      providerSessionId: "session-original",
    });
    expect(setup.persistedJobs[0]?.attempts).toMatchObject({
      ciFixRounds: 1,
      reviewerFixRounds: 1,
      reviewRuns: 1,
    });
    expect(setup.calls).toEqual([
      `checks:${baseSha}`,
      "provider:gpt-balanced:0",
      "preflight",
      "stage",
      "commit",
      "clean",
      "push",
      "job:update",
      `checks:${repairSha}`,
    ]);
  });

  it("allows the second CI repair round and preserves independent Reviewer counters", async () => {
    const setup = fixture();
    const outcome = await setup.pipeline.run(
      request({
        job: job({ ciFixRounds: 1, reviewerFixRounds: 1, reviewRuns: 2 }),
      }),
    );

    expect(outcome).toMatchObject({
      state: "repair_pushed",
      job: {
        attempts: { ciFixRounds: 2, reviewerFixRounds: 1, reviewRuns: 2 },
      },
    });
    expect(setup.persistedJobs).toHaveLength(1);
    expect(setup.persistedJobs[0]?.attempts).toMatchObject({
      ciFixRounds: 2,
      reviewerFixRounds: 1,
      reviewRuns: 2,
    });
  });

  it.each([
    ["CI", { ciFixRounds: 2 }],
    ["Reviewer fix", { reviewerFixRounds: 2 }],
    ["review run", { reviewRuns: 3 }],
  ] as const)(
    "checkpoints before model work when the %s limit is reached",
    async (_name, attempts) => {
      const setup = fixture();
      const original = job(attempts);
      const outcome = await setup.pipeline.run(request({ job: original }));

      expect(outcome).toMatchObject({
        state: "checkpointed",
        reason: "attempt_limit_reached",
        job: original,
        checkpointId: "checkpoint-attempt_limit_reached",
      });
      expect(setup.calls).toEqual([`checks:${baseSha}`, "checkpoint:attempt_limit_reached"]);
    },
  );

  it("fails closed when the consumed attempt is not durably persisted", async () => {
    const setup = fixture({ durability: "unknown" });
    const outcome = await setup.pipeline.run(request());

    expect(outcome).toMatchObject({ state: "failed", stage: "attempt_persistence" });
    expect(setup.calls).toEqual([
      `checks:${baseSha}`,
      "provider:gpt-balanced:0",
      "preflight",
      "stage",
      "commit",
      "clean",
      "push",
      "job:update",
    ]);
  });

  it("checkpoints an out-of-scope repair without staging or pushing", async () => {
    const finding = { code: "outside_declared_region" as const, path: "README.md" };
    const setup = fixture({
      preflight: {
        headSha: baseSha,
        allowed: false,
        scopeVerified: false,
        changedPaths: ["README.md"],
        findings: [finding],
      },
    });
    const outcome = await setup.pipeline.run(request());

    expect(outcome).toMatchObject({
      state: "checkpointed",
      reason: "scope_overrun",
      findings: [finding],
    });
    expect(setup.calls).toEqual([
      `checks:${baseSha}`,
      "provider:gpt-balanced:0",
      "preflight",
      "checkpoint:scope_overrun",
    ]);
  });

  it("interrupts on a dangerous tool request and does not publish a diff", async () => {
    const toolRequest: ProviderEvent = {
      kind: "tool_request",
      observedAt: now,
      requestId: "danger-1",
      tool: "shell",
      payload: { command: "dangerous" },
    };
    const setup = fixture({ events: [toolRequest], pauseTool: true });
    const outcome = await setup.pipeline.run(request());

    expect(outcome).toMatchObject({
      state: "paused",
      reason: "safety_approval_required",
      toolSummary: "等待危險操作核可",
    });
    expect(setup.handle.responses).toEqual([["danger-1", "decline"]]);
    expect(setup.handle.interrupted()).toBe(true);
    expect(setup.calls).toEqual([`checks:${baseSha}`, "provider:gpt-balanced:0"]);
  });

  it("treats a stale webhook observation as a wake-up hint and converges by read-back", async () => {
    const setup = fixture({ initialChecks: successfulChecks });
    const outcome = await setup.pipeline.run(
      request({
        trigger: {
          kind: "webhook",
          observedChecks: { ...successfulChecks, headSha: "c".repeat(40) },
        },
      }),
    );

    expect(outcome).toMatchObject({
      state: "ready_for_review",
      source: "webhook",
      checks: successfulChecks,
    });
    expect(setup.calls).toEqual([`checks:${baseSha}`]);
  });

  it("rejects a malformed webhook observation before read-back", async () => {
    const setup = fixture({ initialChecks: successfulChecks });
    const outcome = await setup.pipeline.run(
      request({
        trigger: {
          kind: "webhook",
          observedChecks: {
            ...successfulChecks,
            checks: [{ name: "", status: "completed", conclusion: "success" }],
          },
        },
      }),
    );

    expect(outcome).toMatchObject({ state: "failed", stage: "request" });
    expect(setup.calls).toEqual([]);
  });

  it("rejects authoritative checks that do not bind to the exact PR head", async () => {
    const setup = fixture({
      initialChecks: { ...successfulChecks, headSha: "c".repeat(40) },
    });
    const outcome = await setup.pipeline.run(request());

    expect(outcome).toMatchObject({ state: "failed", stage: "checks" });
    expect(setup.calls).toEqual([`checks:${baseSha}`]);
  });
});
