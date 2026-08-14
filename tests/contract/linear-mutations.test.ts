import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it, vi, type Mock } from "vitest";

import {
  buildLinearReadCatalog,
  createLinearIssueSnapshot,
  LinearGraphqlTransport,
  LinearMutationClient,
  type LinearCommentRecord,
  type LinearFetch,
  type LinearIssueReader,
  type LinearIssueRecord,
  type LinearLabelRecord,
  type LinearProjectContext,
  type LinearRelationRecord,
  type LinearWorkflowStateRecord,
} from "../../src/adapters/linear/index.js";
import { blockingReasons } from "../../src/domain/workflow/index.js";

interface Fixture {
  readonly team: { readonly id: string; readonly name: string; readonly key: string };
  readonly project: { readonly id: string; readonly name: string };
  readonly states: readonly LinearWorkflowStateRecord[];
  readonly labels: readonly LinearLabelRecord[];
  readonly issue: LinearIssueRecord;
  readonly relations: readonly LinearRelationRecord[];
  readonly comments: readonly LinearCommentRecord[];
}

interface GraphqlBody {
  readonly operationName?: unknown;
  readonly variables?: unknown;
}

interface MutationVariables extends Readonly<Record<string, unknown>> {
  readonly input?: unknown;
  readonly issueId?: unknown;
}

const fixtureUrl = new URL("../../fixtures/adapters/linear/read-model.json", import.meta.url);
let fixture: Fixture;
let context: LinearProjectContext;

beforeAll(async () => {
  fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as Fixture;
  const catalog = buildLinearReadCatalog(fixture.states, fixture.labels);
  if (!catalog.ok) throw new Error("fixture_catalog_invalid");
  context = Object.freeze({ team: fixture.team, project: fixture.project, catalog: catalog.value });
});

function bodyOf(init: RequestInit): GraphqlBody {
  if (typeof init.body !== "string") throw new Error("expected_string_body");
  const parsed: unknown = JSON.parse(init.body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("expected_object_body");
  }
  return parsed;
}

function variablesOf(body: GraphqlBody): MutationVariables {
  const variables = body.variables;
  if (typeof variables !== "object" || variables === null || Array.isArray(variables)) {
    throw new Error("expected_variables");
  }
  return variables as MutationVariables;
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected_record");
  }
  return value as Readonly<Record<string, unknown>>;
}

function json(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    headers: { "content-type": "application/json" },
  });
}

class MutationHarness {
  issue: LinearIssueRecord = { ...fixture.issue };
  comments: LinearCommentRecord[] = fixture.comments.map((comment) => ({ ...comment }));
  readonly relations = fixture.relations.map((relation) => ({ ...relation }));
  readonly fetch: Mock<LinearFetch>;
  readonly reader: LinearIssueReader;
  ignoreIssueUpdates = false;
  commentCreateCount = 0;
  commentMutationPayload?: unknown;

  constructor() {
    this.reader = {
      readIssue: (requestedContext, issueId) => {
        if (issueId !== this.issue.id) {
          return Promise.resolve({
            ok: false,
            error: {
              kind: "domain_error",
              code: "not_found",
              category: "state",
              message: "The requested resource was not found.",
              retryable: false,
            },
          } as const);
        }
        return Promise.resolve(
          createLinearIssueSnapshot(requestedContext, this.issue, this.relations, this.comments),
        );
      },
    };
    this.fetch = vi.fn<LinearFetch>().mockImplementation((_url, init) => {
      const body = bodyOf(init);
      const variables = variablesOf(body);
      const input = recordOf(variables.input);
      switch (body.operationName) {
        case "AgentTeamCreateIssue": {
          const labelIds = input["labelIds"];
          if (!Array.isArray(labelIds) || !labelIds.every((id) => typeof id === "string")) {
            throw new Error("expected_label_ids");
          }
          this.issue = {
            id: "issue-created",
            identifier: "FIX-100",
            title: String(input["title"]),
            description: String(input["description"]),
            priority: Number(input["priority"]),
            updatedAt: "2026-08-04T13:00:00.000Z",
            teamId: String(input["teamId"]),
            projectId: String(input["projectId"]),
            stateId: String(input["stateId"]),
            labelIds,
          };
          return Promise.resolve(
            json({
              issueCreate: {
                success: true,
                issue: { id: this.issue.id, identifier: this.issue.identifier },
              },
            }),
          );
        }
        case "AgentTeamUpdateIssue": {
          if (!this.ignoreIssueUpdates) {
            this.issue = {
              ...this.issue,
              ...(typeof input["stateId"] === "string" ? { stateId: input["stateId"] } : {}),
              ...(Array.isArray(input["labelIds"])
                ? {
                    labelIds: input["labelIds"].filter(
                      (id): id is string => typeof id === "string",
                    ),
                  }
                : {}),
            };
          }
          return Promise.resolve(
            json({
              issueUpdate: {
                success: true,
                issue: { id: this.issue.id, identifier: this.issue.identifier },
              },
            }),
          );
        }
        case "AgentTeamCreateComment": {
          this.commentCreateCount += 1;
          if (this.commentMutationPayload !== undefined) {
            return Promise.resolve(json(this.commentMutationPayload));
          }
          const comment = {
            id: `comment-created-${String(this.commentCreateCount)}`,
            body: String(input["body"]),
            createdAt: "2026-08-04T14:00:00.000Z",
          };
          this.comments.push(comment);
          return Promise.resolve(json({ commentCreate: { success: true, comment } }));
        }
        default:
          throw new Error("unexpected_operation");
      }
    });
  }

  client(): LinearMutationClient {
    return new LinearMutationClient(
      new LinearGraphqlTransport({ apiKey: "fixture-key", fetch: this.fetch }),
      this.reader,
    );
  }
}

describe("Linear mutation contract", () => {
  it("creates an issue with typed status, priority, and controlled labels then reads it back", async () => {
    const harness = new MutationHarness();
    const result = await harness.client().createIssue(context, {
      title: "Created fixture",
      description: "Created description",
      priority: "urgent",
      workStatus: "ready",
      agentRole: "implementer",
      reviewRequirement: "dual_review",
      agentStatus: "queued",
      otherLabelIds: ["label-extra", "label-extra"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(
      expect.objectContaining({
        id: "issue-created",
        identifier: "FIX-100",
        priority: "urgent",
        workStatus: "ready",
        agentRole: "implementer",
        reviewRequirement: "dual_review",
        agentCondition: { status: "queued", blockingReasons: [] },
        otherLabelIds: ["label-extra"],
      }),
    );
  });

  it("sets every Agent status and blocking reason with post-mutation read-back", async () => {
    const harness = new MutationHarness();
    const client = harness.client();
    for (const status of ["queued", "executing", "waiting", "paused"] as const) {
      const result = await client.setAgentCondition(context, harness.issue.id, { status });
      expect(result.ok ? result.value.agentCondition?.status : result.error.code).toBe(status);
    }
    const invalidTransition = await client.setAgentCondition(context, harness.issue.id, {
      status: "executing",
    });
    expect(invalidTransition.ok ? "ok" : invalidTransition.error.code).toBe("conflict");
    const resume = await client.setAgentCondition(context, harness.issue.id, { status: "queued" });
    expect(resume.ok).toBe(true);
    for (const blockingReason of blockingReasons) {
      const result = await client.setAgentCondition(context, harness.issue.id, {
        status: "blocked",
        blockingReason,
      });
      expect(result.ok ? result.value.agentCondition : result.error.code).toEqual({
        status: "blocked",
        blockingReasons: [blockingReason],
      });
      const reset = await client.setAgentCondition(context, harness.issue.id, { status: "queued" });
      expect(reset.ok).toBe(true);
    }
    expect(
      await client.setAgentCondition(context, harness.issue.id, { status: "blocked" }),
    ).toEqual(expect.objectContaining({ ok: false }));
    expect(
      await client.setAgentCondition(context, harness.issue.id, {
        status: "executing",
        blockingReason: "merge_conflict",
      }),
    ).toEqual(expect.objectContaining({ ok: false }));
  });

  it("enforces domain work transitions, merge completion, user cancellation, and read-back", async () => {
    const harness = new MutationHarness();
    const client = harness.client();
    const review = await client.transitionWorkStatus(context, harness.issue.id, {
      target: "in_review",
      cause: "review_started",
    });
    expect(review.ok ? review.value.workStatus : review.error.code).toBe("in_review");
    const directCompletion = await client.transitionWorkStatus(context, harness.issue.id, {
      target: "completed",
      cause: "automation_reconcile",
    });
    expect(directCompletion.ok ? "ok" : directCompletion.error.code).toBe("conflict");
    const completed = await client.observeGithubMerge(context, harness.issue.id);
    expect(completed.ok ? completed.value.workStatus : completed.error.code).toBe("completed");

    const cancelHarness = new MutationHarness();
    const canceled = await cancelHarness
      .client()
      .cancelIssueByUser(context, cancelHarness.issue.id);
    expect(canceled.ok ? canceled.value.workStatus : canceled.error.code).toBe("canceled");

    const readBackHarness = new MutationHarness();
    readBackHarness.ignoreIssueUpdates = true;
    const falseReadBack = await readBackHarness
      .client()
      .transitionWorkStatus(context, readBackHarness.issue.id, {
        target: "in_review",
        cause: "review_started",
      });
    expect(falseReadBack.ok ? "ok" : falseReadBack.error.code).toBe("external_failure");
  });

  it("moves a Ready issue into the formal requires-manual workflow state with read-back", async () => {
    const harness = new MutationHarness();
    harness.issue = { ...harness.issue, stateId: context.catalog.stateIdByWorkStatus.ready };
    const result = await harness.client().requireManualIntervention(context, harness.issue.id);
    expect(result.ok ? result.value.workStatus : result.error.code).toBe("requires_manual");
    expect(harness.issue.stateId).toBe(context.catalog.stateIdByWorkStatus.requires_manual);
  });

  it("replaces ordinary labels while preserving all controlled Label Group values", async () => {
    const harness = new MutationHarness();
    const client = harness.client();
    const changed = await client.setOtherLabels(context, harness.issue.id, ["label-new"]);
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.value.otherLabelIds).toEqual(["label-new"]);
    expect(changed.value.agentRole).toBe("implementer");
    expect(changed.value.reviewRequirement).toBe("code_review");
    expect(changed.value.agentCondition).toEqual({
      status: "blocked",
      blockingReasons: ["merge_conflict"],
    });
    const controlled = await client.setOtherLabels(context, harness.issue.id, ["role-lead"]);
    expect(controlled.ok ? "ok" : controlled.error.code).toBe("external_failure");
  });

  it("deduplicates sequential and concurrent comment retries by hashed idempotency marker", async () => {
    const harness = new MutationHarness();
    const client = harness.client();
    const first = await client.appendComment(
      context,
      harness.issue.id,
      "timeline body",
      "retry-key",
    );
    const retry = await client.appendComment(
      context,
      harness.issue.id,
      "timeline body",
      "retry-key",
    );
    expect(first.ok && first.value.reused).toBe(false);
    expect(retry.ok && retry.value.reused).toBe(true);
    expect(harness.commentCreateCount).toBe(1);
    expect(harness.comments.at(-1)?.body).not.toContain("retry-key");
    expect(harness.comments.at(-1)?.body).toMatch(/agent-team:idempotency:[a-f0-9]{64}/u);

    const concurrentOne = client.appendComment(context, harness.issue.id, "other", "parallel-key");
    const concurrentTwo = client.appendComment(context, harness.issue.id, "other", "parallel-key");
    expect(concurrentOne).toBe(concurrentTwo);
    const [one, two] = await Promise.all([concurrentOne, concurrentTwo]);
    expect(one).toEqual(two);
    expect(harness.commentCreateCount).toBe(2);

    const mixedOne = client.appendComment(context, harness.issue.id, "first", "mixed-key");
    const mixedTwo = client.appendComment(context, harness.issue.id, "second", "mixed-key");
    const [, mixedConflict] = await Promise.all([mixedOne, mixedTwo]);
    expect(mixedConflict.ok ? "ok" : mixedConflict.error.code).toBe("conflict");
    expect(harness.commentCreateCount).toBe(3);

    const conflict = await client.appendComment(
      context,
      harness.issue.id,
      "different body",
      "retry-key",
    );
    expect(conflict.ok ? "ok" : conflict.error.code).toBe("conflict");
  });

  it("fails closed on unsuccessful and malformed comment mutation payloads", async () => {
    for (const payload of [
      { commentCreate: { success: false, comment: null } },
      { commentCreate: { success: true, comment: null, unexpected: true } },
    ]) {
      const harness = new MutationHarness();
      harness.commentMutationPayload = payload;
      const result = await harness
        .client()
        .appendComment(context, harness.issue.id, "body", "failure-key");
      expect(result.ok ? "ok" : result.error.code).toBe("external_failure");
      expect(harness.comments).toEqual(fixture.comments);
    }
  });
});
