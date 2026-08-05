import { describe, expect, it } from "vitest";

import {
  ChangeControlCoordinator,
  classifyRequirementChange,
  type ChangeAssessment,
  type ChangeControlPersistencePort,
  type ChangeControlRequest,
  type RequirementChangeReason,
} from "../../src/application/change-control/index.js";
import { ok, parseInstant } from "../../src/domain/foundation/index.js";
import { jobSchema } from "../../src/domain/jobs/index.js";
import {
  issueIdSchema,
  issueSchema,
  projectSchema,
  type Issue,
} from "../../src/domain/project/index.js";
import { createRequirementSnapshot } from "../../src/domain/review/index.js";

const nowResult = parseInstant("2026-08-05T04:00:00.000Z");
if (!nowResult.ok) throw new Error(nowResult.error.code);
const now = nowResult.value;
const project = projectSchema.parse({
  schemaVersion: 1,
  id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  displayName: "Change control fixture",
  localRepositoryPath: "/tmp/repository",
  defaultBranch: "main",
  workManagement: { provider: "linear", containerId: "workspace", projectId: "team" },
  sourceControl: { provider: "github", repository: "owner/repository" },
});
const currentIssue = issueSchema.parse({
  schemaVersion: 1,
  id: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  projectId: project.id,
  externalId: "ENG-123",
  title: "Classify requirement changes",
  goal: "Continue only when acceptance behavior remains unchanged.",
  background: "The work is already executing.",
  acceptanceCriteria: ["Classify every controlled field."],
  inScope: ["src/application/change-control"],
  outOfScope: ["UI"],
  dependencies: { kind: "none" },
  priority: "high",
  agentRole: "implementer",
  reviewRequirement: "code_review",
  estimatedMinutes: 25,
  constraints: ["Do not invent requirements."],
  risks: ["False-small classification bypasses reapproval."],
  changeRegions: [{ path: "src/application/change-control", coverage: "subtree" }],
});
const snapshotResult = createRequirementSnapshot(currentIssue, now);
if (!snapshotResult.ok) throw new Error(snapshotResult.error.code);
const currentSnapshot = snapshotResult.value;
const job = jobSchema.parse({
  schemaVersion: 1,
  id: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  projectId: project.id,
  issueId: currentIssue.id,
  createdAt: now,
  watchdogExtensionGranted: false,
  attempts: { processRecoveries: 0, ciFixRounds: 0, reviewerFixRounds: 0, reviewRuns: 0 },
});
const worktree = {
  repositoryRoot: project.localRepositoryPath,
  path: "/tmp/change-control-worktree",
  branch: "task/ENG-123",
  headSha: "a".repeat(40),
} as const;

function assessment(overrides: Partial<ChangeAssessment> = {}): ChangeAssessment {
  return {
    schemaVersion: 1,
    narrativeChange: "none",
    observableOutcomeChanged: false,
    externalServiceAdded: false,
    dangerousOperationAdded: false,
    deliverableChanged: false,
    edgeCaseAdded: false,
    summary: "Structured change assessment.",
    evidenceSources: ["linear:issue-revision"],
    ...overrides,
  };
}

function proposed(overrides: Partial<Issue>): Issue {
  return issueSchema.parse({ ...currentIssue, ...overrides });
}

function expectSubstantive(
  issue: Issue,
  expectedReason: RequirementChangeReason,
  changeAssessment = assessment(),
): void {
  const result = classifyRequirementChange(currentIssue, issue, changeAssessment);
  expect(result.kind).toBe("substantive");
  if (result.kind === "substantive") expect(result.reasons).toContain(expectedReason);
}

describe("requirement change policy", () => {
  it("returns no change for an identical issue and ignores ordering-only list differences", () => {
    const reordered = proposed({
      acceptanceCriteria: ["Classify every controlled field."],
      changeRegions: [{ path: "src/application/change-control", coverage: "subtree" }],
    });

    expect(classifyRequirementChange(currentIssue, currentIssue, assessment())).toEqual({
      kind: "no_change",
      changedFields: [],
    });
    expect(classifyRequirementChange(currentIssue, reordered, assessment())).toEqual({
      kind: "no_change",
      changedFields: [],
    });
  });

  it.each([
    ["title typo", proposed({ title: "Classify requirement change" }), "clerical"],
    [
      "existing term explanation",
      proposed({
        background: "The work is already executing. Controller means deterministic code.",
      }),
      "clarification",
    ],
    [
      "input example",
      proposed({ background: "The work is already executing. Example input: title typo." }),
      "clarification",
    ],
  ] as const)("allows %s as a recorded small supplement", (_name, issue, narrativeChange) => {
    expect(
      classifyRequirementChange(currentIssue, issue, assessment({ narrativeChange })),
    ).toMatchObject({ kind: "small_supplement" });
  });

  it("allows a priority-only operational adjustment without rewriting the approved snapshot", () => {
    expect(
      classifyRequirementChange(currentIssue, proposed({ priority: "urgent" }), assessment()),
    ).toEqual({ kind: "small_supplement", changedFields: ["priority"] });
  });

  it("classifies every controlled requirements field as substantive", () => {
    const dependencyId = issueIdSchema.parse("issue_028f47d2-77a4-7cc1-8ef2-0123456789ab");
    const cases: readonly [Issue, RequirementChangeReason][] = [
      [
        proposed({ acceptanceCriteria: ["Classify every controlled field.", "New edge case."] }),
        "acceptance_criteria_changed",
      ],
      [proposed({ inScope: [...(currentIssue.inScope ?? []), "src/new"] }), "scope_changed"],
      [proposed({ outOfScope: ["UI", "CLI"] }), "scope_changed"],
      [
        proposed({ dependencies: { kind: "issues", issueIds: [dependencyId] } }),
        "dependencies_changed",
      ],
      [proposed({ agentRole: "integration_engineer" }), "agent_role_changed"],
      [proposed({ reviewRequirement: "dual_review" }), "review_requirement_changed"],
      [proposed({ estimatedMinutes: 30 }), "estimate_changed"],
      [
        proposed({ constraints: ["Do not invent requirements.", "Use an external API."] }),
        "constraints_changed",
      ],
      [proposed({ risks: ["A new security risk."] }), "risks_changed"],
      [
        proposed({ changeRegions: [{ path: "src", coverage: "subtree" }] }),
        "change_regions_changed",
      ],
    ];

    for (const [issue, reason] of cases) expectSubstantive(issue, reason);
  });

  it.each([
    [{ narrativeChange: "observable_change" }, "observable_outcome_changed"],
    [{ observableOutcomeChanged: true }, "observable_outcome_changed"],
    [{ externalServiceAdded: true }, "external_service_added"],
    [{ dangerousOperationAdded: true }, "dangerous_operation_added"],
    [{ deliverableChanged: true }, "deliverable_changed"],
    [{ edgeCaseAdded: true }, "edge_case_added"],
  ] as const)("treats a declared material signal as substantive", (overrides, reason) => {
    expectSubstantive(currentIssue, reason, assessment(overrides));
  });

  it("treats every unknown or inconsistent assessment as substantive", () => {
    for (const input of [
      assessment({ observableOutcomeChanged: "unknown" }),
      assessment({ externalServiceAdded: "unknown" }),
      assessment({ narrativeChange: "unknown" }),
      assessment({ narrativeChange: "clarification" }),
    ]) {
      expectSubstantive(currentIssue, "uncertain_change", input);
    }
    expectSubstantive(
      proposed({ background: "Changed without assessment." }),
      "uncertain_change",
      assessment(),
    );
  });
});

interface PersistenceOptions {
  readonly durability?: "confirmed" | "unknown";
  readonly calls?: string[];
}

function persistence(options: PersistenceOptions = {}): ChangeControlPersistencePort {
  const calls = options.calls ?? [];
  return {
    recordSupplement: (record) => {
      calls.push(
        `supplement:${String(record.preserveApprovedSnapshot)}:${record.changedFields.join(",")}`,
      );
      return Promise.resolve(
        ok({ supplementId: "supplement-1", durability: options.durability ?? "confirmed" }),
      );
    },
    checkpointAndReturnToBacklog: (change) => {
      calls.push(`checkpoint:${String(change.requiresUserReapproval)}:${change.reasons.join(",")}`);
      return Promise.resolve(
        ok({ checkpointId: "checkpoint-1", durability: options.durability ?? "confirmed" }),
      );
    },
  };
}

function request(overrides: Partial<ChangeControlRequest> = {}): ChangeControlRequest {
  return {
    job,
    project,
    worktree,
    currentSnapshot,
    proposedIssue: currentIssue,
    assessment: assessment(),
    idempotencyKeyPrefix: "job:ENG-123:change-control",
    ...overrides,
  };
}

describe("change control coordinator", () => {
  it("does not persist anything when no requirement data changed", async () => {
    const calls: string[] = [];
    const result = await new ChangeControlCoordinator(persistence({ calls })).evaluate(request());

    expect(result).toEqual({ state: "unchanged" });
    expect(calls).toEqual([]);
  });

  it("records a small supplement while preserving the exact approved snapshot", async () => {
    const calls: string[] = [];
    const result = await new ChangeControlCoordinator(persistence({ calls })).evaluate(
      request({
        proposedIssue: proposed({ background: "The work is executing. Existing term explained." }),
        assessment: assessment({ narrativeChange: "clarification" }),
      }),
    );

    expect(result).toMatchObject({
      state: "continue",
      supplementId: "supplement-1",
      approvedSnapshot: currentSnapshot,
      changedFields: ["background"],
    });
    expect(calls).toEqual(["supplement:true:background"]);
  });

  it("checkpoints and returns substantive change to Backlog for user reapproval", async () => {
    const calls: string[] = [];
    const result = await new ChangeControlCoordinator(persistence({ calls })).evaluate(
      request({ proposedIssue: proposed({ reviewRequirement: "dual_review" }) }),
    );

    expect(result).toEqual({
      state: "requires_reapproval",
      checkpointId: "checkpoint-1",
      reasons: ["review_requirement_changed"],
      changedFields: ["reviewRequirement"],
    });
    expect(calls).toEqual(["checkpoint:true:review_requirement_changed"]);
  });

  it("fails closed when persistence durability is unknown", async () => {
    const supplement = await new ChangeControlCoordinator(
      persistence({ durability: "unknown" }),
    ).evaluate(
      request({
        proposedIssue: proposed({ title: "Corrected title" }),
        assessment: assessment({ narrativeChange: "clerical" }),
      }),
    );
    const checkpoint = await new ChangeControlCoordinator(
      persistence({ durability: "unknown" }),
    ).evaluate(request({ proposedIssue: proposed({ estimatedMinutes: 30 }) }));

    expect(supplement).toMatchObject({ state: "failed", stage: "supplement" });
    expect(checkpoint).toMatchObject({ state: "failed", stage: "checkpoint" });
  });

  it("rejects issue identity changes before persistence", async () => {
    const calls: string[] = [];
    const changedIdentity = {
      ...currentIssue,
      externalId: "ENG-999",
    };
    const result = await new ChangeControlCoordinator(persistence({ calls })).evaluate(
      request({ proposedIssue: changedIdentity }),
    );

    expect(result).toMatchObject({ state: "failed", stage: "request" });
    expect(calls).toEqual([]);
  });
});
