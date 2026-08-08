import { describe, expect, it } from "vitest";

import {
  ReviewerRecoveryPipeline,
  reviewFindingsExternalData,
  type ImplementerPreflightReport,
  type ReviewerRecoveryPipelinePorts,
  type ReviewerRecoveryPipelineRequest,
} from "../../src/application/pipelines/index.js";
import { trustedProjectConfigSchema } from "../../src/application/projects/index.js";
import { buildProviderJobContext } from "../../src/application/provider-job/index.js";
import type {
  ProviderRunCompletion,
  ProviderRunHandle,
  ProviderRunRequest,
} from "../../src/application/ports/index.js";
import { Redactor } from "../../src/infrastructure/redaction/index.js";
import { ok, parseInstant, type Instant } from "../../src/domain/foundation/index.js";
import {
  fixtureCanary,
  fixtureFakeTokens,
  fixtureForgedBoundaryInjection,
  fixtureForgedEndBoundary,
} from "../e2e/security/e118-fixtures.js";
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

const now = instant("2026-08-08T00:00:00.000Z");
const deadline = instant("2026-08-08T00:30:00.000Z");
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
  externalId: "ENG-104",
  title: "Repair reviewer findings",
  dependencies: { kind: "none" },
  changeRegions: [{ path: "src/feature", coverage: "subtree" }],
});
const snapshotResult = createRequirementSnapshot(issue, now);
if (!snapshotResult.ok) throw new Error(snapshotResult.error.code);
const requirementSnapshot = snapshotResult.value;
const trustedConfig = trustedProjectConfigSchema.parse({
  schemaVersion: 1,
  projectId: project.id,
  defaultBranch: "main",
  platforms: { workManagement: project.workManagement, sourceControl: project.sourceControl },
  projectRules: ["Run tests before Push."],
  roleInstructions: { implementer: ["Stay in scope."] },
  commands: { quality: [{ executable: "pnpm", arguments: ["test"] }], visualReview: [] },
});
const worktree = {
  repositoryRoot: project.localRepositoryPath,
  path: "/tmp/reviewer-recovery-worktree",
  branch: "feature/ENG-104-reviewer-recovery",
  headSha: baseSha,
} as const;
const changedPath = "src/feature/index.ts";
const finding = {
  severity: "blocking" as const,
  title: "Missing validation",
  description: "Validate the new branch before merging.",
  acceptanceCriteria: ["Invalid branch is rejected."],
  evidenceSources: ["src/feature/index.ts"],
  path: changedPath,
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

function request(
  overrides: Partial<ReviewerRecoveryPipelineRequest> = {},
): ReviewerRecoveryPipelineRequest {
  return {
    job: job(),
    project,
    trustedConfig,
    requirementSnapshot,
    worktree,
    model: "gpt-balanced",
    remote: "origin",
    commitMessage: "ENG-104 Review 修復",
    controllerDirective: "只修正 reviewer 報告的 blocking finding。",
    findings: [finding],
    externalData: [],
    deadlineAt: deadline,
    idempotencyKeyPrefix: "job:ENG-104:reviewer-recovery",
    ...overrides,
  };
}

function completedHandle(
  completion: ProviderRunCompletion = { outcome: "completed", sessionId: "session-1" },
): ProviderRunHandle {
  return {
    runId: "run-reviewer-recovery",
    events: {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
      },
    },
    completion: () => Promise.resolve(ok(completion)),
    respondToToolRequest: () => Promise.resolve(ok(undefined)),
    interrupt: () => Promise.resolve(ok(undefined)),
  };
}

function fixture() {
  const calls: string[] = [];
  const persistedJobs: ReturnType<typeof job>[] = [];
  const checkpointReasons: string[] = [];
  let providerRequest: ProviderRunRequest | undefined;
  const preflight: ImplementerPreflightReport = {
    headSha: baseSha,
    allowed: true,
    scopeVerified: true,
    changedPaths: [changedPath],
    findings: [],
  };
  const ports: ReviewerRecoveryPipelinePorts = {
    jobs: {
      update: (updated) => {
        calls.push("job:update");
        persistedJobs.push(updated);
        return Promise.resolve(ok({ durability: "confirmed" as const }));
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
      start: (started) => {
        calls.push("provider:start");
        providerRequest = started;
        return Promise.resolve(ok(completedHandle()));
      },
    },
    toolDecisions: {
      decide: () =>
        Promise.resolve(ok({ response: "approve" as const, pause: false, summary: "allowed" })),
    },
    preflight: {
      inspect: () => {
        calls.push("preflight");
        return Promise.resolve(ok(preflight));
      },
    },
    checkpoint: {
      preserve: (input) => {
        calls.push(`checkpoint:${input.reason}`);
        checkpointReasons.push(input.reason);
        return Promise.resolve(ok({ checkpointId: `checkpoint-${input.reason}` }));
      },
    },
    git: {
      stagePaths: (_tree, paths) => {
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
  return {
    pipeline: new ReviewerRecoveryPipeline(ports),
    calls,
    persistedJobs,
    checkpointReasons,
    providerRequest: () => providerRequest,
  };
}

describe("ReviewerRecoveryPipeline", () => {
  it("checkpoints without starting a provider when reviewerFixRounds is already exhausted", async () => {
    const setup = fixture();
    const outcome = await setup.pipeline.run(request({ job: job({ reviewerFixRounds: 2 }) }));

    expect(outcome).toMatchObject({ state: "checkpointed", reason: "attempt_limit_reached" });
    expect(setup.calls).toEqual(["checkpoint:attempt_limit_reached"]);
  });

  it("also checkpoints when reviewRuns is exhausted even if reviewerFixRounds remains available", async () => {
    const setup = fixture();
    const outcome = await setup.pipeline.run(request({ job: job({ reviewRuns: 3 }) }));

    expect(outcome).toMatchObject({ state: "checkpointed", reason: "attempt_limit_reached" });
    expect(setup.calls).toEqual(["checkpoint:attempt_limit_reached"]);
  });

  it("runs the original implementer in the same worktree and durably increments reviewerFixRounds", async () => {
    const setup = fixture();
    const outcome = await setup.pipeline.run(
      request({ job: job({ reviewerFixRounds: 1, reviewRuns: 1 }) }),
    );

    expect(outcome).toMatchObject({
      state: "repair_pushed",
      push: { sha: repairSha, branch: worktree.branch },
    });
    expect(setup.providerRequest()).toMatchObject({
      role: "implementer",
      workingDirectory: worktree.path,
      job: { attempts: { reviewerFixRounds: 1 } },
    });
    expect(setup.persistedJobs).toHaveLength(1);
    expect(setup.persistedJobs[0]?.attempts.reviewerFixRounds).toBe(2);
    expect(setup.calls).toEqual([
      "provider:start",
      "preflight",
      "stage",
      "commit",
      "clean",
      "push",
      "job:update",
    ]);
  });

  it("hands findings to the prompt builder as one redacted, boundary-wrapped external data block", () => {
    const secret = "sk-ant-reviewer-secret-1234567890";
    const block = reviewFindingsExternalData([{ ...finding, description: `Token=${secret}` }]);
    const built = buildProviderJobContext(
      {
        job: job(),
        role: "implementer",
        model: "gpt-balanced",
        workingDirectory: worktree.path,
        requirementSnapshot,
        controllerDirective: "Fix the finding.",
        projectRules: [],
        externalData: [block],
        deadlineAt: deadline,
      },
      new Redactor({ secrets: [secret] }),
    );

    if (!built.ok) throw new Error(built.error.code);
    expect(built.value.context.match(/=== BEGIN EXTERNAL DATA ===/gu)).toHaveLength(1);
    expect(built.value.context.match(/=== END EXTERNAL DATA ===/gu)).toHaveLength(1);
    expect(built.value.context).toContain("Missing validation");
    expect(built.value.context).not.toContain(secret);
  });

  // E118a: the reviewer-finding path is the second (and last) real, already-wired external-data
  // entry point this ticket's threat model names -- same deterministic matrix as
  // `ci-recovery-pipeline.test.ts`'s own E118a describe block, exercised here through
  // `reviewFindingsExternalData` instead of the CI-log path.
  describe("E118a: injection deterministic matrix (shared canary/fake-token fixtures)", () => {
    it("keeps a forged END-boundary injection in a reviewer finding's description strictly inert once boundary-wrapped", () => {
      const block = reviewFindingsExternalData([
        { ...finding, description: fixtureForgedBoundaryInjection() },
      ]);
      const built = buildProviderJobContext(
        {
          job: job(),
          role: "implementer",
          model: "gpt-balanced",
          workingDirectory: worktree.path,
          requirementSnapshot,
          controllerDirective: "Fix the finding.",
          projectRules: [],
          externalData: [block],
          deadlineAt: deadline,
        },
        new Redactor(),
      );
      if (!built.ok) throw new Error(built.error.code);
      const { context } = built.value;
      const begin = context.indexOf("=== BEGIN EXTERNAL DATA ===");
      const end = context.lastIndexOf("=== END EXTERNAL DATA ===");

      expect(context.match(/=== BEGIN EXTERNAL DATA ===/gu)).toHaveLength(1);
      expect(context.match(/=== END EXTERNAL DATA ===/gu)).toHaveLength(1);
      const canaryIndex = context.indexOf(fixtureCanary);
      expect(canaryIndex).toBeGreaterThan(begin);
      expect(canaryIndex).toBeLessThan(end);
      expect(context.slice(0, begin)).not.toContain(fixtureForgedEndBoundary);
    });

    it.each(fixtureFakeTokens)(
      "masks a %s-shaped fake token embedded in a reviewer finding's description with no registered secret needed",
      (fakeToken) => {
        const block = reviewFindingsExternalData([
          { ...finding, description: `Evidence shows token=${fakeToken} marker:${fixtureCanary}` },
        ]);
        const built = buildProviderJobContext(
          {
            job: job(),
            role: "implementer",
            model: "gpt-balanced",
            workingDirectory: worktree.path,
            requirementSnapshot,
            controllerDirective: "Fix the finding.",
            projectRules: [],
            externalData: [block],
            deadlineAt: deadline,
          },
          new Redactor(),
        );
        if (!built.ok) throw new Error(built.error.code);
        expect(built.value.context).not.toContain(fakeToken);
        expect(built.value.context).toContain(fixtureCanary);
      },
    );

    it("never lets the canary or any fake token leak into the pipeline outcome, running the full pipeline end to end", async () => {
      const setup = fixture();
      const outcome = await setup.pipeline.run(
        request({
          findings: [
            {
              ...finding,
              description: `Evidence shows token=${fixtureFakeTokens[0]} marker:${fixtureCanary}`,
            },
          ],
        }),
      );

      expect(outcome.state).toBe("repair_pushed");
      const serialized = JSON.stringify(outcome);
      expect(serialized).not.toContain(fixtureCanary);
      for (const fakeToken of fixtureFakeTokens) expect(serialized).not.toContain(fakeToken);
    });
  });
});
