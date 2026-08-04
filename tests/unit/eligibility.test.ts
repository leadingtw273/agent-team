import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { evaluateEligibility } from "../../src/domain/eligibility/index.js";
import { issueSchema, type Issue } from "../../src/domain/project/index.js";

async function validIssue(): Promise<Issue> {
  const input = JSON.parse(
    await readFile(new URL("../../fixtures/domain/issue-v1.valid.json", import.meta.url), "utf8"),
  ) as unknown;
  return issueSchema.parse(input);
}

const requiredFields = [
  ["goal", "missing_goal"],
  ["background", "missing_background"],
  ["acceptanceCriteria", "missing_acceptance_criteria"],
  ["inScope", "missing_in_scope"],
  ["outOfScope", "missing_out_of_scope"],
  ["dependencies", "missing_dependencies"],
  ["priority", "missing_priority"],
  ["reviewRequirement", "missing_review_requirement"],
  ["estimatedMinutes", "missing_estimate"],
] as const;

describe("eligibility decision", () => {
  it.each(requiredFields)("reports a missing %s field", async (field, expectedCode) => {
    const issue = await validIssue();
    const candidate = { ...issue, [field]: undefined };

    expect(evaluateEligibility(candidate).blockers).toContainEqual({ code: expectedCode });
    expect(evaluateEligibility(candidate).readyForAutomation).toBe(false);
    expect(evaluateEligibility(candidate).eligibleForDispatch).toBe(false);
  });

  it("classifies an issue without an Agent role as human work", async () => {
    const issue = await validIssue();

    expect(evaluateEligibility({ ...issue, agentRole: undefined })).toEqual({
      ownership: "human",
      readyForAutomation: false,
      eligibleForDispatch: false,
      blockers: [{ code: "human_owned" }],
    });
  });

  it("requires every declared dependency to be completed", async () => {
    const issue = await validIssue();
    if (issue.dependencies?.kind !== "issues") throw new Error("expected dependency fixture");
    const dependencyId = issue.dependencies.issueIds[0];
    if (dependencyId === undefined) throw new Error("expected dependency id");

    expect(evaluateEligibility(issue).blockers).toEqual([
      { code: "dependency_not_completed", dependencyId, state: "unknown" },
    ]);
    expect(
      evaluateEligibility(issue, { dependencyStates: { [dependencyId]: "incomplete" } }),
    ).toEqual({
      ownership: "agent",
      readyForAutomation: true,
      eligibleForDispatch: false,
      blockers: [{ code: "dependency_not_completed", dependencyId, state: "incomplete" }],
    });
    expect(
      evaluateEligibility(issue, { dependencyStates: { [dependencyId]: "completed" } }),
    ).toEqual({
      ownership: "agent",
      readyForAutomation: true,
      eligibleForDispatch: true,
      blockers: [],
    });
  });

  it("accepts an explicit no-dependency declaration without dependency state", async () => {
    const issue = await validIssue();
    expect(evaluateEligibility({ ...issue, dependencies: { kind: "none" } })).toEqual({
      ownership: "agent",
      readyForAutomation: true,
      eligibleForDispatch: true,
      blockers: [],
    });
  });

  it("requires tasks over 45 minutes to be split before dispatch", async () => {
    const issue = await validIssue();
    const decision = evaluateEligibility({
      ...issue,
      dependencies: { kind: "none" },
      estimatedMinutes: 46,
    });

    expect(decision).toEqual({
      ownership: "agent",
      readyForAutomation: false,
      eligibleForDispatch: false,
      blockers: [{ code: "task_too_large" }],
    });
  });

  it("keeps the exact 45-minute boundary eligible", async () => {
    const issue = await validIssue();

    expect(
      evaluateEligibility({
        ...issue,
        dependencies: { kind: "none" },
        estimatedMinutes: 45,
      }).eligibleForDispatch,
    ).toBe(true);
  });

  it("returns blockers in stable Ready Gate order", async () => {
    const issue = await validIssue();
    const decision = evaluateEligibility({
      ...issue,
      goal: undefined,
      background: undefined,
      dependencies: undefined,
      reviewRequirement: undefined,
    });

    expect(decision.blockers.map(({ code }) => code)).toEqual([
      "missing_goal",
      "missing_background",
      "missing_dependencies",
      "missing_review_requirement",
    ]);
  });
});
