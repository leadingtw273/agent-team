import { describe, expect, it } from "vitest";

import {
  ConflictPipeline,
  classifyConflict,
  type ConflictAssessment,
  type ConflictPipelinePorts,
  type ConflictPipelineRequest,
} from "../../src/application/pipelines/index.js";
import type {
  ChangeRequestSnapshot,
  GitRepositorySnapshot,
  GitWorkingTreeSnapshot,
} from "../../src/application/ports/index.js";
import { ok, parseInstant } from "../../src/domain/foundation/index.js";
import { jobSchema } from "../../src/domain/jobs/index.js";
import { issueSchema, projectSchema } from "../../src/domain/project/index.js";
import {
  createRequirementSnapshot,
  createReviewIdentity,
  type EffectiveTreeChange,
} from "../../src/domain/review/index.js";

const headSha = "a".repeat(40);
const resolvedHeadSha = "b".repeat(40);
const baseSha = "c".repeat(40);
const oldObjectSha = "d".repeat(40);
const newObjectSha = "e".repeat(40);
const nowResult = parseInstant("2026-08-05T03:00:00.000Z");
if (!nowResult.ok) throw new Error(nowResult.error.code);
const now = nowResult.value;
const project = projectSchema.parse({
  schemaVersion: 1,
  id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  displayName: "Conflict fixture",
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
  title: "Resolve merge conflicts",
  goal: "Route conflicts without bypassing review.",
  acceptanceCriteria: ["Effective diff changes require a new review."],
  inScope: ["src/application/pipelines"],
  outOfScope: ["Manual Git operations"],
  dependencies: { kind: "none" },
  priority: "high",
  agentRole: "implementer",
  reviewRequirement: "code_review",
  estimatedMinutes: 25,
  changeRegions: [{ path: "src/application/pipelines", coverage: "subtree" }],
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
  attempts: { processRecoveries: 0, ciFixRounds: 0, reviewerFixRounds: 0, reviewRuns: 1 },
});
const worktree = {
  repositoryRoot: project.localRepositoryPath,
  path: "/tmp/conflict-worktree",
  branch: "task/ENG-123",
  headSha,
} as const;

function treeDiff(objectSha = oldObjectSha): readonly EffectiveTreeChange[] {
  return [
    {
      before: null,
      after: {
        path: "src/application/pipelines/feature.ts",
        mode: "100644",
        objectId: { algorithm: "sha1", value: objectSha },
      },
    },
  ];
}

const previousIdentityResult = createReviewIdentity(requirementSnapshot, headSha, treeDiff());
if (!previousIdentityResult.ok) throw new Error(previousIdentityResult.error.code);
const previousReviewIdentity = previousIdentityResult.value;

function assessment(
  requirementsCompatibility: ConflictAssessment["requirementsCompatibility"] = "compatible",
  resolutionNature: ConflictAssessment["resolutionNature"] = "mechanical",
): ConflictAssessment {
  return {
    schemaVersion: 1,
    requirementsCompatibility,
    resolutionNature,
    summary: "Structured conflict evidence.",
    evidenceSources: ["git:merge-tree"],
  };
}

function changeRequest(
  sha: string,
  mergeability: ChangeRequestSnapshot["mergeability"] = "conflicting",
): ChangeRequestSnapshot {
  return {
    id: "PR_node_fixture",
    number: 42,
    url: "https://github.com/owner/repository/pull/42",
    state: "open",
    draft: false,
    baseBranch: "main",
    headBranch: worktree.branch,
    headSha: sha,
    mergeability,
    autoMergeEnabled: false,
    updatedAt: now,
  };
}

interface FixtureOptions {
  readonly initialMergeability?: ChangeRequestSnapshot["mergeability"];
  readonly afterMergeability?: ChangeRequestSnapshot["mergeability"];
  readonly claimState?: "acquired" | "already_used";
  readonly claimDurability?: "confirmed" | "unknown";
  readonly resolutionState?: "resolved" | "unresolved";
  readonly afterDiff?: readonly EffectiveTreeChange[];
  readonly dirtyBefore?: boolean;
  readonly dirtyAfter?: boolean;
  readonly escalationDurability?: "confirmed" | "unknown";
  readonly calls?: string[];
}

function ports(options: FixtureOptions = {}): ConflictPipelinePorts {
  const calls = options.calls ?? [];
  let currentHead = headSha;
  let sourceReads = 0;
  let worktreeReads = 0;
  const repositorySnapshot = (): GitRepositorySnapshot => ({
    rootPath: worktree.path,
    headSha: currentHead,
    branch: worktree.branch,
    clean: worktreeReads > 1 ? options.dirtyAfter !== true : options.dirtyBefore !== true,
  });
  const workingTreeSnapshot = (): GitWorkingTreeSnapshot => ({
    headSha: currentHead,
    changes:
      worktreeReads > 1 && options.dirtyAfter === true
        ? [{ path: "dirty.ts", kind: "modified", mode: "file", staged: false }]
        : options.dirtyBefore === true
          ? [{ path: "dirty.ts", kind: "modified", mode: "file", staged: false }]
          : [],
  });
  return {
    git: {
      inspectWorktree: () => {
        worktreeReads += 1;
        return Promise.resolve(ok(repositorySnapshot()));
      },
      inspectWorkingTree: () => Promise.resolve(ok(workingTreeSnapshot())),
      getEffectiveTreeDiff: () => Promise.resolve(ok(options.afterDiff ?? treeDiff(newObjectSha))),
    },
    sourceControl: {
      getChangeRequest: () => {
        sourceReads += 1;
        return Promise.resolve(
          ok(
            changeRequest(
              currentHead,
              sourceReads === 1
                ? options.initialMergeability
                : (options.afterMergeability ?? "mergeable"),
            ),
          ),
        );
      },
    },
    attempts: {
      claimSimpleAttempt: () => {
        calls.push("claim_simple");
        return Promise.resolve(
          ok({
            state: options.claimState ?? "acquired",
            durability: options.claimDurability ?? "confirmed",
          }),
        );
      },
    },
    resolution: {
      resolve: (resolutionRequest) => {
        calls.push(
          `resolve:${resolutionRequest.assignee.role}:${resolutionRequest.assignee.agentId ?? "new"}`,
        );
        if (options.resolutionState === "unresolved") {
          return Promise.resolve(ok({ state: "unresolved" as const, summary: "Still conflicts." }));
        }
        currentHead = resolvedHeadSha;
        return Promise.resolve(ok({ state: "resolved" as const, pushedHeadSha: resolvedHeadSha }));
      },
    },
    escalation: {
      checkpointAndEscalate: (escalationRequest) => {
        calls.push(`escalate:${escalationRequest.reason}`);
        return Promise.resolve(
          ok({
            checkpointId: "checkpoint-conflict-1",
            durability: options.escalationDurability ?? "confirmed",
          }),
        );
      },
    },
  };
}

function request(overrides: Partial<ConflictPipelineRequest> = {}): ConflictPipelineRequest {
  return {
    job,
    project,
    worktree,
    changeRequestId: "42",
    expectedHeadSha: headSha,
    baseRevision: baseSha,
    requirementSnapshot,
    assessment: assessment(),
    originalImplementerId: "agent-original",
    previousReviewIdentity,
    idempotencyKeyPrefix: "job:ENG-123:conflict",
    ...overrides,
  };
}

describe("conflict classification", () => {
  it.each([
    [assessment("compatible", "mechanical"), "simple"],
    [assessment("compatible", "semantic"), "semantic"],
    [assessment("compatible", "unknown"), "semantic"],
    [assessment("incompatible", "mechanical"), "requirements"],
    [assessment("unknown", "mechanical"), "requirements"],
  ] as const)("classifies structured evidence fail-closed", (input, expected) => {
    expect(classifyConflict(input)).toBe(expected);
  });
});

describe("conflict resolver routing", () => {
  it("gives one claimed simple attempt to the exact original implementer", async () => {
    const calls: string[] = [];
    const outcome = await new ConflictPipeline(ports({ calls })).run(request());

    expect(outcome).toMatchObject({
      state: "resolved",
      role: "implementer",
      headSha: resolvedHeadSha,
      validation: "ci_and_review",
    });
    expect(calls).toEqual(["claim_simple", "resolve:implementer:agent-original"]);
  });

  it("routes a repeated simple conflict to an integration engineer", async () => {
    const calls: string[] = [];
    const outcome = await new ConflictPipeline(ports({ claimState: "already_used", calls })).run(
      request(),
    );

    expect(outcome).toMatchObject({ state: "resolved", role: "integration_engineer" });
    expect(calls).toEqual(["claim_simple", "resolve:integration_engineer:new"]);
  });

  it("routes semantic conflict directly to an integration engineer without spending simple attempt", async () => {
    const calls: string[] = [];
    const outcome = await new ConflictPipeline(ports({ calls })).run(
      request({ assessment: assessment("compatible", "semantic") }),
    );

    expect(outcome).toMatchObject({ state: "resolved", role: "integration_engineer" });
    expect(calls).toEqual(["resolve:integration_engineer:new"]);
  });

  it("reroutes after the original implementer cannot resolve its one simple attempt", async () => {
    const calls: string[] = [];
    const outcome = await new ConflictPipeline(ports({ resolutionState: "unresolved", calls })).run(
      request(),
    );

    expect(outcome).toEqual({
      state: "reroute_required",
      role: "integration_engineer",
      reason: "simple_attempt_unresolved",
    });
    expect(calls).toEqual(["claim_simple", "resolve:implementer:agent-original"]);
  });
});

describe("conflict escalation", () => {
  it.each([
    ["incompatible", "requirements_conflict"],
    ["unknown", "requirements_unknown"],
  ] as const)(
    "checkpoints and escalates %s requirements without running a resolver",
    async (compatibility, reason) => {
      const calls: string[] = [];
      const outcome = await new ConflictPipeline(ports({ calls })).run(
        request({ assessment: assessment(compatibility, "mechanical") }),
      );

      expect(outcome).toEqual({
        state: "escalated",
        reason,
        checkpointId: "checkpoint-conflict-1",
      });
      expect(calls).toEqual([`escalate:${reason}`]);
    },
  );

  it("checkpoints and escalates when the integration engineer remains unresolved", async () => {
    const calls: string[] = [];
    const outcome = await new ConflictPipeline(ports({ resolutionState: "unresolved", calls })).run(
      request({ assessment: assessment("compatible", "semantic") }),
    );

    expect(outcome).toEqual({
      state: "escalated",
      reason: "integration_unresolved",
      checkpointId: "checkpoint-conflict-1",
    });
    expect(calls).toEqual(["resolve:integration_engineer:new", "escalate:integration_unresolved"]);
  });

  it("fails closed when escalation durability is unknown", async () => {
    const outcome = await new ConflictPipeline(ports({ escalationDurability: "unknown" })).run(
      request({ assessment: assessment("unknown", "unknown") }),
    );

    expect(outcome).toMatchObject({ state: "failed", stage: "escalation" });
  });
});

describe("post-resolution validation", () => {
  it("requires only CI when the effective diff is unchanged by conflict resolution", async () => {
    const outcome = await new ConflictPipeline(ports({ afterDiff: treeDiff() })).run(request());

    expect(outcome).toMatchObject({ state: "resolved", validation: "ci_only" });
  });

  it("requires CI and fresh review when conflict resolution changes the effective diff", async () => {
    const outcome = await new ConflictPipeline(ports({ afterDiff: treeDiff(newObjectSha) })).run(
      request(),
    );

    expect(outcome).toMatchObject({ state: "resolved", validation: "ci_and_review" });
  });

  it("does not invoke an Agent when GitHub no longer reports a conflict", async () => {
    const calls: string[] = [];
    const outcome = await new ConflictPipeline(
      ports({ initialMergeability: "mergeable", calls }),
    ).run(request());

    expect(outcome).toEqual({ state: "not_required", reason: "no_longer_conflicting" });
    expect(calls).toEqual([]);
  });

  it("waits without invoking an Agent while GitHub mergeability is unknown", async () => {
    const calls: string[] = [];
    const outcome = await new ConflictPipeline(
      ports({ initialMergeability: "unknown", calls }),
    ).run(request());

    expect(outcome).toEqual({ state: "waiting", reason: "mergeability_unknown" });
    expect(calls).toEqual([]);
  });

  it("fails before model work when the worktree is dirty", async () => {
    const calls: string[] = [];
    const outcome = await new ConflictPipeline(ports({ dirtyBefore: true, calls })).run(request());

    expect(outcome).toMatchObject({ state: "failed", stage: "worktree" });
    expect(calls).toEqual([]);
  });

  it("reroutes when the original implementer pushes a Head that still conflicts", async () => {
    const outcome = await new ConflictPipeline(ports({ afterMergeability: "conflicting" })).run(
      request(),
    );

    expect(outcome).toEqual({
      state: "reroute_required",
      role: "integration_engineer",
      reason: "simple_attempt_unresolved",
    });
  });

  it("does not use an unconfirmed simple-attempt claim", async () => {
    const calls: string[] = [];
    const outcome = await new ConflictPipeline(ports({ claimDurability: "unknown", calls })).run(
      request(),
    );

    expect(outcome).toMatchObject({ state: "failed", stage: "attempt" });
    expect(calls).toEqual(["claim_simple"]);
  });

  it("rejects a stale approval identity or non-exact base revision before provider reads", async () => {
    const calls: string[] = [];
    const staleIdentityResult = createReviewIdentity(
      requirementSnapshot,
      resolvedHeadSha,
      treeDiff(),
    );
    if (!staleIdentityResult.ok) throw new Error(staleIdentityResult.error.code);
    const stale = await new ConflictPipeline(ports({ calls })).run(
      request({ previousReviewIdentity: staleIdentityResult.value }),
    );
    const symbolicBase = await new ConflictPipeline(ports({ calls })).run(
      request({ baseRevision: "main" }),
    );

    expect(stale).toMatchObject({ state: "failed", stage: "request" });
    expect(symbolicBase).toMatchObject({ state: "failed", stage: "request" });
    expect(calls).toEqual([]);
  });
});
