import { describe, expect, it, vi } from "vitest";

import {
  ImplementerPipeline,
  type ImplementerPipelinePorts,
  type ImplementerPipelineRequest,
  type ImplementerPreflightReport,
} from "../../src/application/pipelines/index.js";
import {
  domainError,
  err,
  ok,
  parseInstant,
  type Instant,
} from "../../src/domain/foundation/index.js";
import { jobSchema } from "../../src/domain/jobs/index.js";
import { issueSchema, projectSchema } from "../../src/domain/project/index.js";
import { createRequirementSnapshot } from "../../src/domain/review/index.js";
import { trustedProjectConfigSchema } from "../../src/application/projects/index.js";
import type {
  ProviderEvent,
  ProviderRunCompletion,
  ProviderRunHandle,
} from "../../src/application/ports/index.js";
import { jobSkillSnapshotSchema, skillRuntimeFailure } from "../../src/application/skills/index.js";

const baseSha = "a".repeat(40);
const commitSha = "b".repeat(40);

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
  title: "Implement pipeline",
  goal: "Create a safe pipeline.",
  background: "The dispatcher already created a Job.",
  acceptanceCriteria: ["A Draft PR waits for CI."],
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
const job = jobSchema.parse({
  schemaVersion: 1,
  id: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  projectId: project.id,
  issueId: issue.id,
  createdAt: now,
  watchdogExtensionGranted: false,
  attempts: { processRecoveries: 0, ciFixRounds: 0, reviewerFixRounds: 0, reviewRuns: 0 },
});
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
  commands: {
    quality: [{ executable: "pnpm", arguments: ["test"] }],
    visualReview: [],
  },
});
const worktree = {
  repositoryRoot: project.localRepositoryPath,
  path: "/tmp/worktree",
  branch: "feature/ENG-123-pipeline",
  headSha: baseSha,
} as const;
const workingChange = {
  path: "src/feature/index.ts",
  kind: "modified",
  mode: "file",
  staged: false,
} as const;
const preflightReport: ImplementerPreflightReport = {
  headSha: baseSha,
  allowed: true,
  scopeVerified: true,
  changedPaths: [workingChange.path],
  findings: [],
};

function request(overrides: Partial<ImplementerPipelineRequest> = {}): ImplementerPipelineRequest {
  return {
    job,
    project,
    trustedConfig,
    requirementSnapshot,
    role: "implementer",
    model: "gpt-balanced",
    repositoryRoot: project.localRepositoryPath,
    baseRevision: baseSha,
    worktreePath: worktree.path,
    branch: worktree.branch,
    remote: "origin",
    commitMessage: "ENG-123 implement pipeline",
    pullRequest: { title: "ENG-123 implement pipeline", body: "Implements the approved AC." },
    controllerDirective: "Implement only the approved requirement and stop after editing files.",
    externalData: [],
    deadlineAt: deadline,
    idempotencyKeyPrefix: "job:ENG-123:first",
    ...overrides,
  };
}

function runHandle(
  events: readonly ProviderEvent[] = [],
  completion: ProviderRunCompletion = { outcome: "completed", sessionId: "session-1" },
) {
  const responses: (readonly [string, "approve" | "decline"])[] = [];
  let interrupted = false;
  const handle: ProviderRunHandle = {
    runId: "run-1",
    events: {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        for (const event of events) yield event;
      },
    },
    completion: () => Promise.resolve(ok(completion)),
    respondToToolRequest: (requestId, decision) => {
      responses.push([requestId, decision]);
      return Promise.resolve(ok(undefined));
    },
    interrupt: () => {
      interrupted = true;
      return Promise.resolve(ok(undefined));
    },
  };
  return { handle, responses, wasInterrupted: () => interrupted };
}

interface PortFixture {
  readonly ports: ImplementerPipelinePorts;
  readonly calls: string[];
  readonly handle: ReturnType<typeof runHandle>;
}

function fixture(
  options: {
    readonly report?: ImplementerPreflightReport;
    readonly providerEvents?: readonly ProviderEvent[];
    readonly providerCompletion?: ProviderRunCompletion;
    readonly toolPause?: boolean;
  } = {},
): PortFixture {
  const calls: string[] = [];
  const handle = runHandle(options.providerEvents, options.providerCompletion);
  const report = options.report ?? preflightReport;
  const ports: ImplementerPipelinePorts = {
    git: {
      createWorktree: (command) => {
        calls.push("worktree");
        expect(command).toMatchObject({ startPoint: baseSha, branch: worktree.branch });
        return Promise.resolve(ok(worktree));
      },
      stagePaths: (_tree, paths) => {
        calls.push("stage");
        expect(paths).toEqual(report.changedPaths);
        return Promise.resolve(
          ok({
            headSha: baseSha,
            changes: [{ ...workingChange, staged: true }],
          }),
        );
      },
      commit: (command) => {
        calls.push("commit");
        expect(command.expectedStagedPaths).toEqual(report.changedPaths);
        return Promise.resolve(ok({ sha: commitSha, branch: worktree.branch }));
      },
      inspectWorkingTree: () => {
        calls.push("post-commit");
        return Promise.resolve(ok({ headSha: commitSha, changes: [] }));
      },
      push: () => {
        calls.push("push");
        return Promise.resolve(ok({ remote: "origin", branch: worktree.branch, sha: commitSha }));
      },
    },
    preflight: {
      inspect: () => {
        calls.push("preflight");
        return Promise.resolve(ok(report));
      },
    },
    provider: {
      inspectCapabilities: () => Promise.resolve(err(domainError("unavailable"))),
      start: (providerRequest) => {
        calls.push("provider");
        expect(providerRequest).toMatchObject({
          workingDirectory: worktree.path,
          projectRules: ["Run tests before Push.", "Stay in scope."],
          requirementSnapshot,
        });
        return Promise.resolve(ok(handle.handle));
      },
    },
    sourceControl: {
      createDraftChangeRequest: () => {
        calls.push("draft-pr");
        return Promise.resolve(
          ok({
            id: "PR_node",
            number: 50,
            url: "https://github.com/owner/repository/pull/50",
            state: "open",
            draft: true,
            baseBranch: "main",
            headBranch: worktree.branch,
            headSha: commitSha,
            mergeability: "unknown",
            autoMergeEnabled: false,
            updatedAt: now,
          }),
        );
      },
      getCommitChecks: (_repository, sha) => {
        calls.push("checks");
        return Promise.resolve(ok({ headSha: sha, aggregate: "pending", checks: [] }));
      },
    },
    scopeCheckpoint: {
      preserve: (checkpointRequest) => {
        calls.push("checkpoint");
        expect(checkpointRequest.findings).toEqual(report.findings);
        return Promise.resolve(ok({ checkpointId: "checkpoint-scope" }));
      },
    },
    toolDecisions: {
      decide: () => {
        calls.push("tool-decision");
        return Promise.resolve(
          ok({
            response: options.toolPause === true ? "decline" : "approve",
            pause: options.toolPause === true,
            summary: options.toolPause === true ? "等待危險操作核可" : "一般操作",
          }),
        );
      },
    },
  };
  return { ports, calls, handle };
}

describe("Implementer Pipeline", () => {
  it("revalidates Skill content before creating a worktree or starting Provider", async () => {
    const test = fixture();
    const skillSnapshot = jobSkillSnapshotSchema.parse({
      schemaVersion: 1,
      jobId: job.id,
      projectId: project.id,
      skills: [
        {
          name: "godot-testing-patterns",
          displayName: "Godot 測試模式",
          mode: "knowledge_only",
          source: {
            repository: "https://github.com/example/skills",
            commit: "a".repeat(40),
            path: "skills/godot-testing-patterns",
            treeDigest: "1".repeat(64),
          },
          installedTreeDigest: "2".repeat(64),
          fileDigests: { "SKILL.md": "3".repeat(64) },
          allowedReferences: [],
          requirement: "required",
        },
      ],
      omitted: [],
    });
    const configWithSkills = trustedProjectConfigSchema.parse({
      ...trustedConfig,
      skillPolicy: {
        catalogId: "fixture-catalog",
        catalogDigest: "4".repeat(64),
        allowlist: ["godot-testing-patterns"],
      },
    });
    const result = await new ImplementerPipeline({
      ...test.ports,
      skillRuntime: {
        admit: () => Promise.resolve(err(skillRuntimeFailure("content_changed"))),
        materialize: () =>
          Promise.resolve(err(skillRuntimeFailure("content_changed", "godot-testing-patterns"))),
      },
    }).run(request({ trustedConfig: configWithSkills, skillSnapshot }));

    expect(result).toMatchObject({
      state: "failed",
      stage: "request",
      error: { code: "invariant_violation" },
    });
    expect(test.calls).toEqual([]);
  });

  it("creates context-bound work, preflights before Push, opens Draft, and waits for CI", async () => {
    const test = fixture();
    const result = await new ImplementerPipeline(test.ports).run(request());

    expect(result).toMatchObject({
      state: "ci_waiting",
      worktree,
      commit: { sha: commitSha },
      push: { sha: commitSha },
      changeRequest: { draft: true, headSha: commitSha },
      checks: { aggregate: "pending", headSha: commitSha },
      providerSessionId: "session-1",
    });
    expect(test.calls).toEqual([
      "worktree",
      "provider",
      "preflight",
      "stage",
      "commit",
      "post-commit",
      "push",
      "draft-pr",
      "checks",
    ]);
    expect(test.calls.indexOf("preflight")).toBeLessThan(test.calls.indexOf("push"));
  });

  it("preserves scope overrun locally and never stages, pushes, or opens a PR", async () => {
    const report: ImplementerPreflightReport = {
      ...preflightReport,
      allowed: false,
      findings: [{ code: "outside_declared_region", path: "src/other.ts" }],
      changedPaths: ["src/other.ts"],
    };
    const test = fixture({ report });
    const result = await new ImplementerPipeline(test.ports).run(request());

    expect(result).toMatchObject({
      state: "paused",
      reason: "scope_overrun",
      checkpointId: "checkpoint-scope",
      findings: report.findings,
    });
    expect(test.calls).toEqual(["worktree", "provider", "preflight", "checkpoint"]);
  });

  it("declines and pauses a Provider tool request that needs safety approval", async () => {
    const toolRequest: ProviderEvent = {
      kind: "tool_request",
      observedAt: now,
      requestId: "tool-1",
      tool: "command_execution",
      payload: { command: ["git", "push", "--force"] },
    };
    const test = fixture({ providerEvents: [toolRequest], toolPause: true });
    const result = await new ImplementerPipeline(test.ports).run(request());

    expect(result).toMatchObject({
      state: "paused",
      reason: "safety_approval_required",
      toolSummary: "等待危險操作核可",
    });
    expect(test.handle.responses).toEqual([["tool-1", "decline"]]);
    expect(test.handle.wasInterrupted()).toBe(true);
    expect(test.calls).toEqual(["worktree", "provider", "tool-decision"]);
  });

  it("does not start Reviewer and pauses when Provider produced no Diff", async () => {
    const test = fixture({ report: { ...preflightReport, changedPaths: [] } });
    const result = await new ImplementerPipeline(test.ports).run(request());

    expect(result).toMatchObject({ state: "paused", reason: "no_changes" });
    expect(test.calls).toEqual(["worktree", "provider", "preflight"]);
    expect("reviewer" in test.ports).toBe(false);
  });

  it("fails closed when Draft PR read-back is not Draft or not bound to pushed SHA", async () => {
    const test = fixture();
    test.ports.sourceControl.createDraftChangeRequest = vi.fn(() =>
      Promise.resolve(
        ok({
          id: "PR_node",
          number: 50,
          url: "https://github.com/owner/repository/pull/50",
          state: "open" as const,
          draft: false,
          baseBranch: "main",
          headBranch: worktree.branch,
          headSha: baseSha,
          mergeability: "unknown" as const,
          autoMergeEnabled: false,
          updatedAt: now,
        }),
      ),
    );

    await expect(new ImplementerPipeline(test.ports).run(request())).resolves.toMatchObject({
      state: "failed",
      stage: "draft_pull_request",
      error: { code: "conflict" },
    });
  });

  it("rejects mismatched project or missing declared Region before creating Worktree", async () => {
    const test = fixture();
    const withoutRegions: Partial<typeof issue> = { ...issue };
    delete withoutRegions.changeRegions;
    const noRegions = issueSchema.parse(withoutRegions);
    const invalidSnapshot = createRequirementSnapshot(noRegions, now);
    if (!invalidSnapshot.ok) throw new Error(invalidSnapshot.error.code);

    await expect(
      new ImplementerPipeline(test.ports).run(
        request({ requirementSnapshot: invalidSnapshot.value }),
      ),
    ).resolves.toMatchObject({ state: "failed", stage: "request" });
    expect(test.calls).toEqual([]);
  });
});
