/**
 * C015a unit tests: `discoverReadyDispatchCandidates` (src/adapters/dispatch/linear-discovery.ts)
 * against a fake `LinearDiscoveryReadModel` (readContext/listIssueIdsInState/readIssue) -- no
 * real Linear network access. Covers: full candidate conversion (deterministic id derivation,
 * field mapping); an issue with no agent-role label is skipped and visible in `skipped` (the
 * packet's own explicit requirement); a single malformed/unready/unreadable issue never blocks
 * the rest of the batch.
 */
import { describe, expect, it } from "vitest";

import {
  discoverReadyDispatchCandidates,
  projectIssueByExternalId,
  type LinearDiscoveryReadModel,
} from "../../src/adapters/dispatch/linear-discovery.js";
import {
  buildLinearReadCatalog,
  linearAgentRoleNames,
  linearAgentStatusNames,
  linearBlockingReasonNames,
  linearReviewRequirementNames,
  linearWorkStatusNames,
  type LinearIssueSnapshot,
  type LinearLabelRecord,
  type LinearProjectContext,
  type LinearWorkflowStateRecord,
} from "../../src/adapters/linear/model.js";
import {
  domainError,
  err,
  generateDeterministicIdentifier,
  ok,
} from "../../src/domain/foundation/index.js";
import {
  agentRoleSchema,
  reviewRequirementSchema,
  projectSchema,
  type Project,
} from "../../src/domain/project/index.js";
import { agentStatuses, blockingReasons } from "../../src/domain/workflow/index.js";
import {
  humanSummaryTemplate,
  readyGateTemplateHeadings,
} from "../../src/application/registration/linear-provision-model.js";

function project(): Project {
  return projectSchema.parse({
    schemaVersion: 1,
    id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    displayName: "Sandbox",
    localRepositoryPath: "/tmp/sandbox",
    defaultBranch: "main",
    workManagement: { provider: "linear", containerId: "team-1", projectId: "proj-1" },
    sourceControl: { provider: "github", repository: "owner/sandbox" },
  });
}

/** Builds a genuinely complete, `buildLinearReadCatalog`-validated catalog -- same technique the
 * O006 integration test fixtures use -- so this fixture is exactly as strict as the real
 * `LinearReadModel.readContext` would produce, without needing any `any`/unsafe cast. */
function context(): LinearProjectContext {
  const states: LinearWorkflowStateRecord[] = Object.entries(linearWorkStatusNames).map(
    ([status, name], index) => ({ id: `state-${status}-${String(index)}`, name, type: status }),
  );
  function group(groupName: string, id: string): LinearLabelRecord {
    return { id, name: groupName, isGroup: true, parentId: null };
  }
  function child(name: string, parentId: string, id: string): LinearLabelRecord {
    return { id, name, isGroup: false, parentId };
  }
  const groupIds = {
    agentRole: "label-group-agent-role",
    reviewRequirement: "label-group-review-requirement",
    agentStatus: "label-group-agent-status",
    blockingReason: "label-group-blocking-reason",
  };
  const labels: LinearLabelRecord[] = [
    group("Agent 角色", groupIds.agentRole),
    ...agentRoleSchema.options.map((key, index) =>
      child(linearAgentRoleNames[key], groupIds.agentRole, `label-agent-role-${String(index)}`),
    ),
    group("審查需求", groupIds.reviewRequirement),
    ...reviewRequirementSchema.options.map((key, index) =>
      child(
        linearReviewRequirementNames[key],
        groupIds.reviewRequirement,
        `label-review-requirement-${String(index)}`,
      ),
    ),
    group("Agent 狀態", groupIds.agentStatus),
    ...agentStatuses.map((key, index) =>
      child(
        linearAgentStatusNames[key],
        groupIds.agentStatus,
        `label-agent-status-${String(index)}`,
      ),
    ),
    group("阻塞原因", groupIds.blockingReason),
    ...blockingReasons.map((key, index) =>
      child(
        linearBlockingReasonNames[key],
        groupIds.blockingReason,
        `label-blocking-reason-${String(index)}`,
      ),
    ),
  ];
  const catalog = buildLinearReadCatalog(states, labels);
  if (!catalog.ok) throw new Error("fixture invariant violated: catalog must build cleanly");
  return Object.freeze({
    team: Object.freeze({ id: "team-1", name: "Team", key: "TM" }),
    project: Object.freeze({ id: "proj-1", name: "Project" }),
    catalog: catalog.value,
  });
}

function baseSnapshotFields() {
  return {
    id: "linear-issue-1",
    identifier: "SBX-1",
    title: "Ship the thing",
    updatedAt: "2026-08-07T00:00:00.000Z" as never,
    teamId: "team-1",
    projectId: "proj-1",
    workStatus: "ready" as const,
    otherLabelIds: [],
    relations: [],
    comments: [],
  };
}

/** C015j: the default `snapshot()` fixture must carry `changeRegions` (via a minimal, valid Ready
 * Gate description containing only that one heading -- `parseReadyGateTemplate` already tolerates
 * a description with just one heading, see the `dependencies_unparsed` fixture below for the same
 * technique) so that every existing test built on top of the bare `snapshot()` default continues
 * to represent a genuinely dispatch-shaped implementer candidate, not the exact gap this ticket
 * closes (an implementer-role issue missing `changeRegions`). Tests that want to exercise the gap
 * itself override `description` explicitly (see the dedicated test below). */
function minimalChangeRegionsDescription(): string {
  return `## ${readyGateTemplateHeadings.changeRegions}\n- src/adapters/dispatch/linear-discovery.ts\n`;
}

function snapshot(overrides: Partial<LinearIssueSnapshot> = {}): LinearIssueSnapshot {
  return Object.freeze({
    ...baseSnapshotFields(),
    agentRole: "implementer" as const,
    description: minimalChangeRegionsDescription(),
    ...overrides,
  });
}

/** Distinct from `snapshot({agentRole: undefined})` -- `exactOptionalPropertyTypes` forbids
 * assigning `undefined` to an optional property explicitly, so this builds a snapshot that
 * genuinely omits the key altogether (the real shape an issue with no agent-role label has). */
function snapshotWithoutAgentRole(): LinearIssueSnapshot {
  return Object.freeze({ ...baseSnapshotFields() });
}

/** A description that genuinely follows the Ready Gate template (C015b) with every field filled
 * in, including an explicit "無" (no dependencies) -- the shape a real, fully-compliant Linear
 * issue would carry. */
function filledTemplateDescription(): string {
  return `## ${humanSummaryTemplate.heading}
- ${humanSummaryTemplate.objective}：讓 Linear 新單能被人一眼看懂
- ${humanSummaryTemplate.outcome}：看得到三句白話摘要
- ${humanSummaryTemplate.acceptance}：核對三句內容與實際需求一致

## ${readyGateTemplateHeadings.goal}
讓真實 Linear 候選能通過 eligibility。

## ${readyGateTemplateHeadings.background}
C015a 發現沒有解析器；C015b 補上。

## ${readyGateTemplateHeadings.acceptanceCriteria}
- 候選欄位齊全

## ${readyGateTemplateHeadings.inScope}
- 解析器接線

## ${readyGateTemplateHeadings.outOfScope}
- 引擎修改

## ${readyGateTemplateHeadings.dependencies}
無

## ${readyGateTemplateHeadings.estimatedMinutes}
30

## ${readyGateTemplateHeadings.constraints}

## ${readyGateTemplateHeadings.risks}

## ${readyGateTemplateHeadings.changeRegions}
- src/adapters/dispatch/linear-discovery.ts
`;
}

function fakeReadModel(
  overrides: Partial<LinearDiscoveryReadModel> = {},
): LinearDiscoveryReadModel {
  return {
    readContext: () => Promise.resolve(ok(context())),
    listIssueIdsInState: () => Promise.resolve(ok(["linear-issue-1"])),
    readIssue: () => Promise.resolve(ok(snapshot())),
    ...overrides,
  };
}

describe("discoverReadyDispatchCandidates", () => {
  it("converts a ready, fully-projected issue into exactly one candidate", async () => {
    const result = await discoverReadyDispatchCandidates({
      project: project(),
      teamId: "team-1",
      linearProjectId: "proj-1",
      readModel: fakeReadModel(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.candidates).toHaveLength(1);
    expect(result.value.skipped).toHaveLength(0);
    const candidate = result.value.candidates[0];
    expect(candidate?.stage).toBe("implementation");
    expect(candidate?.workKind).toBe("model");
    expect(candidate?.readyAt).toBe("2026-08-07T00:00:00.000Z");
    expect(candidate?.issue.externalId).toBe("linear-issue-1");
    expect(candidate?.issue.agentRole).toBe("implementer");
    expect(candidate?.issue.projectId).toBe(project().id);

    // The domain id is deterministically derived from the Linear id -- stable across polls.
    const expectedId = generateDeterministicIdentifier("issue", "linear-issue-1");
    expect(expectedId.ok).toBe(true);
    if (expectedId.ok) expect(candidate?.issue.id).toBe(expectedId.value);
  });

  it("C015b: projects every Ready Gate template field when the description genuinely follows it", async () => {
    const readModel = fakeReadModel({
      readIssue: () =>
        Promise.resolve(
          ok(
            snapshot({
              description: filledTemplateDescription(),
              humanAcceptanceRequirement: "required",
              verificationLevel: "standard",
            }),
          ),
        ),
    });
    const result = await discoverReadyDispatchCandidates({
      project: project(),
      teamId: "team-1",
      linearProjectId: "proj-1",
      readModel,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.skipped).toHaveLength(0);
    const candidate = result.value.candidates[0];
    expect(candidate?.issue.goal).toBe("讓真實 Linear 候選能通過 eligibility。");
    expect(candidate?.issue.background).toBe("C015a 發現沒有解析器；C015b 補上。");
    expect(candidate?.issue.acceptanceCriteria).toEqual(["候選欄位齊全"]);
    expect(candidate?.issue.inScope).toEqual(["解析器接線"]);
    expect(candidate?.issue.outOfScope).toEqual(["引擎修改"]);
    expect(candidate?.issue.estimatedMinutes).toBe(30);
    expect(candidate?.issue.dependencies).toEqual({ kind: "none" });
    expect(candidate?.issue.changeRegions).toEqual([
      { path: "src/adapters/dispatch/linear-discovery.ts", coverage: "exact" },
    ]);
    expect(candidate?.issue.humanSummary).toEqual({
      objective: "讓 Linear 新單能被人一眼看懂",
      outcome: "看得到三句白話摘要",
      acceptance: "核對三句內容與實際需求一致",
    });
    expect(candidate?.issue.humanAcceptanceRequirement).toBe("required");
    expect(candidate?.issue.verificationLevel).toBe("standard");
  });

  it("C015b: skips (visibly, with its own reason) an issue whose dependencies section has unresolvable free text", async () => {
    const readModel = fakeReadModel({
      readIssue: () =>
        Promise.resolve(
          ok(
            snapshot({
              description: `## ${readyGateTemplateHeadings.dependencies}\n依賴 ENG-42 先完成`,
            }),
          ),
        ),
    });
    const result = await discoverReadyDispatchCandidates({
      project: project(),
      teamId: "team-1",
      linearProjectId: "proj-1",
      readModel,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.candidates).toHaveLength(0);
    expect(result.value.skipped).toEqual([
      { externalIssueId: "linear-issue-1", reason: { code: "dependencies_unparsed" } },
    ]);
  });

  /**
   * C015j: closes the gap C015e's own backlog note flagged -- `evaluateEligibility`
   * (src/domain/eligibility/decision.ts) never checks `changeRegions`, but
   * `ImplementerPipeline.run()`'s `requestShapeValid` (src/application/pipelines/implementer.ts)
   * hard-requires it non-empty for the implementer role, so without this discovery-layer skip an
   * implementer-role candidate missing `changeRegions` would pass eligibility, get dispatched,
   * and only then fail at the pipeline-request stage with a generic `invariant_violation` --
   * exactly what E101's first real run hit.
   */
  it("C015j: skips (visibly, with its own reason) an implementer-role issue missing changeRegions", async () => {
    const readModel = fakeReadModel({
      readIssue: () =>
        Promise.resolve(
          ok(snapshot({ description: `## ${readyGateTemplateHeadings.goal}\n目標內容\n` })),
        ),
    });
    const result = await discoverReadyDispatchCandidates({
      project: project(),
      teamId: "team-1",
      linearProjectId: "proj-1",
      readModel,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.candidates).toHaveLength(0);
    expect(result.value.skipped).toEqual([
      { externalIssueId: "linear-issue-1", reason: { code: "missing_change_regions" } },
    ]);
  });

  /**
   * C015j: the `missing_change_regions` skip is scoped to the implementer role specifically --
   * no other role currently drives a pipeline that reads `changeRegions` at all (see
   * src/cli/dispatch/handlers.ts's `pipeline: "not_applicable_role"` branch), so gating
   * universally would incorrectly block roles that have no such requirement.
   */
  it("C015j: does not require changeRegions for a non-implementer role", async () => {
    const readModel = fakeReadModel({
      readIssue: () =>
        Promise.resolve(
          ok(
            snapshot({
              agentRole: "code_reviewer",
              description: `## ${readyGateTemplateHeadings.goal}\n目標內容\n`,
            }),
          ),
        ),
    });
    const result = await discoverReadyDispatchCandidates({
      project: project(),
      teamId: "team-1",
      linearProjectId: "proj-1",
      readModel,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.skipped).toHaveLength(0);
    expect(result.value.candidates).toHaveLength(1);
    expect(result.value.candidates[0]?.issue.agentRole).toBe("code_reviewer");
    expect(result.value.candidates[0]?.issue.changeRegions).toBeUndefined();
  });

  it("skips (and reports, never silently drops) an issue with no agent-role label", async () => {
    const readModel = fakeReadModel({
      readIssue: () => Promise.resolve(ok(snapshotWithoutAgentRole())),
    });
    const result = await discoverReadyDispatchCandidates({
      project: project(),
      teamId: "team-1",
      linearProjectId: "proj-1",
      readModel,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.candidates).toHaveLength(0);
    expect(result.value.skipped).toEqual([
      { externalIssueId: "linear-issue-1", reason: { code: "no_agent_role" } },
    ]);
  });

  it("skips (defense in depth) an issue whose workStatus is no longer ready", async () => {
    const readModel = fakeReadModel({
      readIssue: () => Promise.resolve(ok(snapshot({ workStatus: "in_progress" }))),
    });
    const result = await discoverReadyDispatchCandidates({
      project: project(),
      teamId: "team-1",
      linearProjectId: "proj-1",
      readModel,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.candidates).toHaveLength(0);
    expect(result.value.skipped).toEqual([
      { externalIssueId: "linear-issue-1", reason: { code: "not_ready" } },
    ]);
  });

  it("a single unreadable issue is skipped without aborting the rest of the batch", async () => {
    const readModel = fakeReadModel({
      listIssueIdsInState: () => Promise.resolve(ok(["linear-issue-1", "linear-issue-2"])),
      readIssue: (_context, issueId) => {
        if (issueId === "linear-issue-1") {
          return Promise.resolve(err(domainError("external_failure")));
        }
        return Promise.resolve(ok(snapshot({ id: "linear-issue-2" })));
      },
    });
    const result = await discoverReadyDispatchCandidates({
      project: project(),
      teamId: "team-1",
      linearProjectId: "proj-1",
      readModel,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.candidates).toHaveLength(1);
    expect(result.value.candidates[0]?.issue.externalId).toBe("linear-issue-2");
    expect(result.value.skipped).toHaveLength(1);
    expect(result.value.skipped[0]?.externalIssueId).toBe("linear-issue-1");
    expect(result.value.skipped[0]?.reason.code).toBe("read_failed");
  });

  it("a title that fails domain Issue validation is skipped as issue_invalid, not thrown", async () => {
    const readModel = fakeReadModel({
      readIssue: () => Promise.resolve(ok(snapshot({ title: "" }))),
    });
    const result = await discoverReadyDispatchCandidates({
      project: project(),
      teamId: "team-1",
      linearProjectId: "proj-1",
      readModel,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.candidates).toHaveLength(0);
    expect(result.value.skipped).toEqual([
      { externalIssueId: "linear-issue-1", reason: { code: "issue_invalid" } },
    ]);
  });

  it("propagates a genuine readContext failure (no listIssueIdsInState/readIssue attempted)", async () => {
    const calls: string[] = [];
    const readModel = fakeReadModel({
      readContext: () => {
        calls.push("readContext");
        return Promise.resolve(err(domainError("external_failure")));
      },
      listIssueIdsInState: () => {
        calls.push("listIssueIdsInState");
        return Promise.resolve(ok([]));
      },
    });
    const result = await discoverReadyDispatchCandidates({
      project: project(),
      teamId: "team-1",
      linearProjectId: "proj-1",
      readModel,
    });
    expect(result.ok).toBe(false);
    expect(calls).toEqual(["readContext"]);
  });
});

describe("projectIssueByExternalId (C015c item 2: resume-time issue re-derivation)", () => {
  it("re-derives the same domain Issue discoverReadyDispatchCandidates would have produced", async () => {
    const readModel = fakeReadModel({
      readIssue: () => Promise.resolve(ok(snapshot({ description: filledTemplateDescription() }))),
    });
    const result = await projectIssueByExternalId(
      project(),
      readModel,
      "team-1",
      "proj-1",
      "linear-issue-1",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.externalId).toBe("linear-issue-1");
    expect(result.value.goal).toBe("讓真實 Linear 候選能通過 eligibility。");
    const expectedId = generateDeterministicIdentifier("issue", "linear-issue-1");
    expect(expectedId.ok).toBe(true);
    if (expectedId.ok) expect(result.value.id).toBe(expectedId.value);
  });

  it("does not require workStatus to still be ready -- original-dispatch eligibility already happened once", async () => {
    const readModel = fakeReadModel({
      readIssue: () => Promise.resolve(ok(snapshot({ workStatus: "in_progress" }))),
    });
    const result = await projectIssueByExternalId(
      project(),
      readModel,
      "team-1",
      "proj-1",
      "linear-issue-1",
    );
    expect(result.ok).toBe(true);
  });

  it("fails closed when the description's dependencies section became unparsed since dispatch", async () => {
    const readModel = fakeReadModel({
      readIssue: () =>
        Promise.resolve(
          ok(
            snapshot({
              description: `## ${readyGateTemplateHeadings.dependencies}\n某些自由文字依賴\n`,
            }),
          ),
        ),
    });
    const result = await projectIssueByExternalId(
      project(),
      readModel,
      "team-1",
      "proj-1",
      "linear-issue-1",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("conflict");
  });

  it("propagates a readIssue failure", async () => {
    const readModel = fakeReadModel({
      readIssue: () => Promise.resolve(err(domainError("external_failure"))),
    });
    const result = await projectIssueByExternalId(
      project(),
      readModel,
      "team-1",
      "proj-1",
      "linear-issue-1",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("external_failure");
  });
});
