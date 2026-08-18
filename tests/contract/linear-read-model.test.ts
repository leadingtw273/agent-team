import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it, vi, type Mock } from "vitest";

import {
  buildLinearReadCatalog,
  createLinearIssueSnapshot,
  LinearGraphqlTransport,
  LinearReadModel,
  type LinearCommentRecord,
  type LinearFetch,
  type LinearIssueRecord,
  type LinearLabelRecord,
  type LinearRelationRecord,
  type LinearWorkflowStateRecord,
} from "../../src/adapters/linear/index.js";
import { agentRoleSchema, reviewRequirementSchema } from "../../src/domain/project/index.js";
import { agentStatuses, blockingReasons, workStatuses } from "../../src/domain/workflow/index.js";

interface Fixture {
  readonly team: { readonly id: string; readonly name: string; readonly key: string };
  readonly project: { readonly id: string; readonly name: string };
  readonly states: readonly LinearWorkflowStateRecord[];
  readonly labels: readonly LinearLabelRecord[];
  readonly issue: LinearIssueRecord;
  readonly relations: readonly LinearRelationRecord[];
  readonly comments: readonly LinearCommentRecord[];
}

const fixtureUrl = new URL("../../fixtures/adapters/linear/read-model.json", import.meta.url);
let fixture: Fixture;

interface GraphqlRequestBody {
  readonly operationName?: unknown;
  readonly variables?: unknown;
}

interface GraphqlVariables extends Readonly<Record<string, unknown>> {
  readonly after?: unknown;
  readonly teamId?: unknown;
}

beforeAll(async () => {
  fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as Fixture;
});

function bodyOf(init: RequestInit): GraphqlRequestBody {
  if (typeof init.body !== "string") throw new Error("expected_string_body");
  const parsed: unknown = JSON.parse(init.body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("expected_object_body");
  }
  return parsed;
}

function variablesOf(body: GraphqlRequestBody): GraphqlVariables {
  const variables = body.variables;
  if (typeof variables !== "object" || variables === null || Array.isArray(variables)) {
    throw new Error("expected_variables");
  }
  return variables as GraphqlVariables;
}

function json(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    headers: { "content-type": "application/json" },
  });
}

function connection<Node>(nodes: readonly Node[], after: unknown, splitAt?: number) {
  if (splitAt === undefined || nodes.length <= splitAt) {
    return { nodes, pageInfo: { hasNextPage: false, endCursor: null } };
  }
  if (after === null) {
    return {
      nodes: nodes.slice(0, splitAt),
      pageInfo: { hasNextPage: true, endCursor: "fixture-next" },
    };
  }
  if (after === "fixture-next") {
    return { nodes: nodes.slice(splitAt), pageInfo: { hasNextPage: false, endCursor: null } };
  }
  throw new Error("unexpected_cursor");
}

function createFixtureFetch(overrides: Readonly<Record<string, unknown>> = {}): Mock<LinearFetch> {
  return vi.fn<LinearFetch>().mockImplementation((_url, init) => {
    const body = bodyOf(init);
    const operationName = body.operationName;
    const variables = variablesOf(body);
    const override = typeof operationName === "string" ? overrides[operationName] : undefined;
    if (override !== undefined) return Promise.resolve(json(override));

    switch (operationName) {
      case "AgentTeamReadIdentity":
        return Promise.resolve(json({ team: fixture.team, project: fixture.project }));
      case "AgentTeamReadStates":
        return Promise.resolve(
          json({ team: { states: connection(fixture.states, variables.after) } }),
        );
      case "AgentTeamReadProjectTeams":
        return Promise.resolve(
          json({
            project: {
              teams: connection([{ id: fixture.team.id }], variables.after),
            },
          }),
        );
      case "AgentTeamReadLabels":
        return Promise.resolve(
          json({
            issueLabels: connection(
              fixture.labels.map((label) => ({
                id: label.id,
                name: label.name,
                isGroup: label.isGroup,
                parent: label.parentId === null ? null : { id: label.parentId },
              })),
              variables.after,
              13,
            ),
          }),
        );
      case "AgentTeamReadIssue":
        return Promise.resolve(
          json({
            issue: {
              id: fixture.issue.id,
              identifier: fixture.issue.identifier,
              title: fixture.issue.title,
              description: fixture.issue.description,
              priority: fixture.issue.priority,
              updatedAt: fixture.issue.updatedAt,
              archivedAt: null,
              trashed: false,
              team: { id: fixture.issue.teamId },
              project: fixture.issue.projectId === null ? null : { id: fixture.issue.projectId },
              state: { id: fixture.issue.stateId },
            },
          }),
        );
      case "AgentTeamReadIssueLabels":
        return Promise.resolve(
          json({
            issue: {
              labels: connection(
                fixture.issue.labelIds.map((id) => ({ id })),
                variables.after,
              ),
            },
          }),
        );
      case "AgentTeamReadIssueRelations":
        return Promise.resolve(
          json({
            issue: {
              relations: connection(
                fixture.relations
                  .filter((relation) => relation.direction === "outbound")
                  .map((relation) => ({
                    id: relation.id,
                    type: relation.type,
                    relatedIssue: {
                      id: relation.relatedIssueId,
                      identifier: relation.relatedIssueIdentifier,
                    },
                  })),
                variables.after,
              ),
            },
          }),
        );
      case "AgentTeamReadIssueInverseRelations":
        return Promise.resolve(
          json({
            issue: {
              inverseRelations: connection(
                fixture.relations
                  .filter((relation) => relation.direction === "inbound")
                  .map((relation) => ({
                    id: relation.id,
                    type: relation.type,
                    relatedIssue: {
                      id: relation.relatedIssueId,
                      identifier: relation.relatedIssueIdentifier,
                    },
                  })),
                variables.after,
              ),
            },
          }),
        );
      case "AgentTeamReadIssueComments":
        return Promise.resolve(
          json({ issue: { comments: connection(fixture.comments, variables.after) } }),
        );
      default:
        throw new Error("unexpected_operation");
    }
  });
}

describe("Linear read model contract", () => {
  it("reads Team, Project, statuses, labels, issue, relations, and comments by ID", async () => {
    const fetch = createFixtureFetch();
    const readModel = new LinearReadModel(
      new LinearGraphqlTransport({ apiKey: "fixture-key", fetch }),
    );
    const context = await readModel.readContext(fixture.team.id, fixture.project.id);
    expect(context.ok).toBe(true);
    if (!context.ok) return;
    const issue = await readModel.readIssue(context.value, fixture.issue.id);

    expect(issue.ok).toBe(true);
    if (!issue.ok) return;
    expect(issue.value.id).toBe("issue-fixture");
    expect(issue.value.identifier).toBe("FIX-42");
    expect(issue.value.priority).toBe("high");
    expect(issue.value.workStatus).toBe("in_progress");
    expect(issue.value.agentRole).toBe("implementer");
    expect(issue.value.reviewRequirement).toBe("code_review");
    expect(issue.value.agentCondition).toEqual({
      status: "blocked",
      blockingReasons: ["merge_conflict"],
    });
    expect(issue.value.otherLabelIds).toEqual(["label-extra"]);
    expect(issue.value.relations).toEqual(fixture.relations);
    expect(issue.value.comments).toEqual(fixture.comments);
    expect(fetch).toHaveBeenCalledTimes(10);
    const requests = fetch.mock.calls.map((call) => bodyOf(call[1]));
    expect(requests[0]?.operationName).toBe("AgentTeamReadIdentity");
    expect(variablesOf(requests[0] ?? {}).teamId).toBe(fixture.team.id);
    expect(
      requests
        .filter((request) => request.operationName === "AgentTeamReadLabels")
        .map((request) => variablesOf(request).after),
    ).toEqual([null, "fixture-next"]);
  });

  it("builds complete typed catalogs for every approved enum value", () => {
    const result = buildLinearReadCatalog(fixture.states, fixture.labels);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value.stateIdByWorkStatus).sort()).toEqual([...workStatuses].sort());
    expect(Object.keys(result.value.agentRole.labelIdByValue).sort()).toEqual(
      [...agentRoleSchema.options].sort(),
    );
    expect(Object.keys(result.value.reviewRequirement.labelIdByValue).sort()).toEqual(
      [...reviewRequirementSchema.options].sort(),
    );
    expect(Object.keys(result.value.agentStatus.labelIdByValue).sort()).toEqual(
      [...agentStatuses].sort(),
    );
    expect(Object.keys(result.value.blockingReason.labelIdByValue).sort()).toEqual(
      [...blockingReasons].sort(),
    );
  });

  it("fails closed on unknown, duplicate, or missing controlled Label values", () => {
    const unknown = [
      ...fixture.labels,
      { id: "unknown-role", name: "未知角色", isGroup: false, parentId: "group-role" },
    ];
    const duplicate = [
      ...fixture.labels,
      { id: "duplicate-role", name: "開發工程師", isGroup: false, parentId: "group-role" },
    ];
    const missing = fixture.labels.filter((label) => label.id !== "block-unknown");

    for (const labels of [unknown, duplicate, missing]) {
      const result = buildLinearReadCatalog(fixture.states, labels);
      expect(result.ok ? "ok" : result.error.code).toBe("external_failure");
    }
  });

  it("fails closed on duplicate single-select labels and invalid Agent condition combinations", () => {
    const catalog = buildLinearReadCatalog(fixture.states, fixture.labels);
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;
    const firstRelation = fixture.relations[0];
    const firstComment = fixture.comments[0];
    if (firstRelation === undefined || firstComment === undefined) {
      throw new Error("fixture_requires_relation_and_comment");
    }
    const context = { team: fixture.team, project: fixture.project, catalog: catalog.value };
    const duplicateRole = createLinearIssueSnapshot(
      context,
      { ...fixture.issue, labelIds: [...fixture.issue.labelIds, "role-lead"] },
      fixture.relations,
      fixture.comments,
    );
    const activeWithBlocker = createLinearIssueSnapshot(
      context,
      {
        ...fixture.issue,
        labelIds: fixture.issue.labelIds.map((id) =>
          id === "agent-blocked" ? "agent-executing" : id,
        ),
      },
      fixture.relations,
      fixture.comments,
    );
    const duplicateRelation = createLinearIssueSnapshot(
      context,
      fixture.issue,
      [...fixture.relations, firstRelation],
      fixture.comments,
    );
    const duplicateComment = createLinearIssueSnapshot(context, fixture.issue, fixture.relations, [
      ...fixture.comments,
      firstComment,
    ]);
    expect(duplicateRole.ok ? "ok" : duplicateRole.error.code).toBe("external_failure");
    expect(activeWithBlocker.ok ? "ok" : activeWithBlocker.error.code).toBe("external_failure");
    expect(duplicateRelation.ok ? "ok" : duplicateRelation.error.code).toBe("external_failure");
    expect(duplicateComment.ok ? "ok" : duplicateComment.error.code).toBe("external_failure");
  });

  it("preserves missing Agent role as human work while requiring a complete remote catalog", () => {
    const catalog = buildLinearReadCatalog(fixture.states, fixture.labels);
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;
    const snapshot = createLinearIssueSnapshot(
      { team: fixture.team, project: fixture.project, catalog: catalog.value },
      {
        ...fixture.issue,
        labelIds: fixture.issue.labelIds.filter(
          (id) => !["role-implementer", "agent-blocked", "block-conflict"].includes(id),
        ),
      },
      [],
      [],
    );
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.agentRole).toBeUndefined();
    expect(snapshot.value.agentCondition).toBeUndefined();
  });

  it("uses exact Team, Project, and Issue IDs and reports missing objects", async () => {
    const readModel = new LinearReadModel(
      new LinearGraphqlTransport({
        apiKey: "fixture-key",
        fetch: createFixtureFetch({ AgentTeamReadIdentity: { team: fixture.team, project: null } }),
      }),
    );
    const context = await readModel.readContext(fixture.team.id, "missing-project");
    expect(context.ok ? "ok" : context.error.code).toBe("not_found");
  });

  it("rejects a Project that is not associated with the configured Team", async () => {
    const readModel = new LinearReadModel(
      new LinearGraphqlTransport({
        apiKey: "fixture-key",
        fetch: createFixtureFetch({
          AgentTeamReadProjectTeams: {
            project: {
              teams: {
                nodes: [{ id: "different-team" }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        }),
      }),
    );
    const context = await readModel.readContext(fixture.team.id, fixture.project.id);
    expect(context.ok ? "ok" : context.error.code).toBe("external_failure");
  });

  it("rejects identity payloads whose IDs do not match the requested IDs", async () => {
    for (const identity of [
      { team: { ...fixture.team, id: "different-team" }, project: fixture.project },
      { team: fixture.team, project: { ...fixture.project, id: "different-project" } },
    ]) {
      const readModel = new LinearReadModel(
        new LinearGraphqlTransport({
          apiKey: "fixture-key",
          fetch: createFixtureFetch({ AgentTeamReadIdentity: identity }),
        }),
      );
      const context = await readModel.readContext(fixture.team.id, fixture.project.id);
      expect(context.ok ? "ok" : context.error.code).toBe("external_failure");
    }
  });
});
