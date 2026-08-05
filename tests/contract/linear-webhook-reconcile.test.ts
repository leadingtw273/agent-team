import { describe, expect, it, vi, type Mock } from "vitest";

import { LinearGraphqlTransport, type LinearFetch } from "../../src/adapters/linear/transport.js";
import { LinearWebhookReconcileAdapter } from "../../src/adapters/linear/webhook-reconcile.js";
import { parseProviderRevisionIdentity } from "../../src/application/reconcile/provider-revision.js";
import { parseInstant } from "../../src/domain/foundation/index.js";
import { projectSchema, type Project } from "../../src/domain/project/index.js";

const project: Project = projectSchema.parse({
  schemaVersion: 1,
  id: "project_12345678-1234-1234-9234-123456789abc",
  displayName: "Linear webhook reconcile fixture",
  localRepositoryPath: "/tmp/linear-webhook-reconcile",
  defaultBranch: "main",
  workManagement: {
    provider: "linear",
    containerId: "linear-team-fixture",
    projectId: "linear-project-fixture",
  },
  sourceControl: { provider: "github", repository: "owner/repository" },
});

const fromInclusive = instant("2026-08-05T12:00:00.000Z");
const throughInclusive = instant("2026-08-05T12:05:00.000Z");

interface GraphqlRequestBody {
  readonly operationName?: unknown;
  readonly query?: unknown;
  readonly variables?: unknown;
}

interface GraphqlVariables extends Readonly<Record<string, unknown>> {
  readonly after?: unknown;
  readonly projectId?: unknown;
  readonly fromInclusive?: unknown;
  readonly throughInclusive?: unknown;
}

function instant(value: string) {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function bodyOf(init: RequestInit): GraphqlRequestBody {
  if (typeof init.body !== "string") throw new Error("expected_string_body");
  const parsed: unknown = JSON.parse(init.body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("expected_graphql_request_body");
  }
  return parsed;
}

function variablesOf(body: GraphqlRequestBody): GraphqlVariables {
  if (
    typeof body.variables !== "object" ||
    body.variables === null ||
    Array.isArray(body.variables)
  ) {
    throw new Error("expected_variables");
  }
  return body.variables as GraphqlVariables;
}

function json(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    headers: { "content-type": "application/json" },
  });
}

function issue(
  id: string,
  updatedAt: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    id,
    identifier: `AT-${id}`,
    title: `Issue ${id}`,
    description: `Authoritative snapshot for ${id}`,
    priority: 2,
    updatedAt,
    team: { id: "linear-team-fixture" },
    project: { id: project.workManagement.projectId },
    state: { id: "state-in-progress" },
    ...overrides,
  };
}

function page(
  nodes: readonly unknown[],
  hasNextPage = false,
  endCursor: string | null = null,
): Readonly<Record<string, unknown>> {
  return { issues: { nodes, pageInfo: { hasNextPage, endCursor } } };
}

function adapter(fetch: LinearFetch): LinearWebhookReconcileAdapter {
  return new LinearWebhookReconcileAdapter(
    new LinearGraphqlTransport({ apiKey: "linear-contract-test-key", fetch }),
  );
}

function request(overrides: Readonly<Record<string, unknown>> = {}) {
  return { project, provider: "linear" as const, fromInclusive, throughInclusive, ...overrides };
}

describe("Linear webhook reconcile read-back adapter", () => {
  it("binds a project plus inclusive updatedAt window, canonicalizes timestamps, and sorts output", async () => {
    const fetch = vi.fn<LinearFetch>().mockImplementation((_url, init) => {
      const body = bodyOf(init);
      expect(body.operationName).toBe("AgentTeamReadWebhookReconcileIssues");
      expect(body.query).toContain("project: { id: { eq: $projectId } }");
      expect(body.query).toContain("updatedAt: { gte: $fromInclusive, lte: $throughInclusive }");
      expect(variablesOf(body)).toEqual({
        projectId: project.workManagement.projectId,
        fromInclusive,
        throughInclusive,
        after: null,
      });
      return Promise.resolve(
        json(
          page([
            issue("issue-through", "2026-08-05T12:05:00Z"),
            issue("issue-from", "2026-08-05T12:00:00.000Z"),
          ]),
        ),
      );
    });

    const result = await adapter(fetch).readChanges(request());

    expect(result).toMatchObject({
      ok: true,
      value: [
        {
          eventType: "Issue",
          occurredAt: "2026-08-05T12:00:00.000Z",
          streamKey: "issue-from",
          payload: { issue: { id: "issue-from", stateId: "state-in-progress" } },
        },
        {
          eventType: "Issue",
          occurredAt: "2026-08-05T12:05:00.000Z",
          streamKey: "issue-through",
          payload: { issue: { id: "issue-through", stateId: "state-in-progress" } },
        },
      ],
    });
    if (!result.ok) return;
    for (const change of result.value) {
      expect(change.payload).toMatchObject({ providerEventId: change.providerEventId });
      expect(parseProviderRevisionIdentity(change.providerEventId)).toMatchObject({
        provider: "linear",
        resourceType: "issue",
        resourceId: change.streamKey,
        updatedAt: change.occurredAt,
      });
    }
    expect(JSON.stringify(result)).not.toContain("linear-contract-test-key");
  });

  it("fails closed when Linear returns any revision outside the requested inclusive window", async () => {
    const fetch = vi
      .fn<LinearFetch>()
      .mockResolvedValue(
        json(
          page([
            issue("issue-inside", "2026-08-05T12:01:00.000Z"),
            issue("issue-outside", "2026-08-05T12:05:00.001Z"),
          ]),
        ),
      );

    const result = await adapter(fetch).readChanges(request());

    expect(result.ok ? "ok" : result.error.code).toBe("external_failure");
  });

  it("changes revision identity when authoritative content changes at the same timestamp", async () => {
    const originalFetch = vi
      .fn<LinearFetch>()
      .mockResolvedValue(json(page([issue("issue-identity", "2026-08-05T12:01:00.000Z")])));
    const changedFetch = vi.fn<LinearFetch>().mockResolvedValue(
      json(
        page([
          issue("issue-identity", "2026-08-05T12:01:00.000Z", {
            title: "Changed title at the same provider timestamp",
            state: { id: "state-done" },
          }),
        ]),
      ),
    );

    const original = await adapter(originalFetch).readChanges(request());
    const changed = await adapter(changedFetch).readChanges(request());

    expect(original.ok && changed.ok).toBe(true);
    if (!original.ok || !changed.ok) return;
    expect(original.value[0]?.providerEventId).not.toBe(changed.value[0]?.providerEventId);
    expect(original.value[0]?.payload).toMatchObject({
      providerEventId: original.value[0]?.providerEventId,
    });
    expect(changed.value[0]?.payload).toMatchObject({
      providerEventId: changed.value[0]?.providerEventId,
    });
  });

  it("uses transport pagination and gives identical ordered revisions on a rerun", async () => {
    const calls: GraphqlVariables[] = [];
    const fetch = vi.fn<LinearFetch>().mockImplementation((_url, init) => {
      const variables = variablesOf(bodyOf(init));
      calls.push(variables);
      if (variables.after === null) {
        return Promise.resolve(
          json(page([issue("issue-later", "2026-08-05T12:04:00.000Z")], true, "next-page")),
        );
      }
      if (variables.after === "next-page") {
        return Promise.resolve(json(page([issue("issue-earlier", "2026-08-05T12:01:00.000Z")])));
      }
      throw new Error("unexpected_cursor");
    });

    const first = await adapter(fetch).readChanges(request());
    const second = await adapter(fetch).readChanges(request());

    expect(first).toEqual(second);
    expect(first.ok && first.value.map((change) => change.streamKey)).toEqual([
      "issue-earlier",
      "issue-later",
    ]);
    expect(calls.map((variables) => variables.after)).toEqual([
      null,
      "next-page",
      null,
      "next-page",
    ]);
  });

  it("fails closed on malformed later pages, provider failure, and a project mismatch", async () => {
    const malformedLaterPage = vi
      .fn<LinearFetch>()
      .mockResolvedValueOnce(
        json(page([issue("issue-first", "2026-08-05T12:01:00.000Z")], true, "next-page")),
      )
      .mockResolvedValueOnce(json(page([{ id: "missing-required-issue-fields" }])));
    const rateLimited = vi.fn<LinearFetch>().mockResolvedValue(new Response("", { status: 429 }));
    const wrongProject = vi.fn<LinearFetch>().mockResolvedValue(
      json(
        page([
          issue("issue-wrong-project", "2026-08-05T12:01:00.000Z", {
            project: { id: "different-project" },
          }),
        ]),
      ),
    );

    const malformed = await adapter(malformedLaterPage).readChanges(request());
    const failed = await adapter(rateLimited).readChanges(request());
    const mismatched = await adapter(wrongProject).readChanges(request());

    expect(malformed.ok ? "ok" : malformed.error.code).toBe("external_failure");
    expect(failed.ok ? "ok" : failed.error.code).toBe("rate_limited");
    expect(mismatched.ok ? "ok" : mismatched.error.code).toBe("external_failure");
  });

  it("rejects provider or project-provider mismatches before reading Linear", async () => {
    const fetch = vi.fn<LinearFetch>();
    const githubProvider = await adapter(fetch).readChanges(request({ provider: "github" }));
    const githubProject = await adapter(fetch).readChanges(
      request({
        project: { ...project, workManagement: { ...project.workManagement, provider: "github" } },
      }),
    );

    expect(githubProvider.ok ? "ok" : githubProvider.error.code).toBe("invariant_violation");
    expect(githubProject.ok ? "ok" : githubProject.error.code).toBe("invariant_violation");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("honors a pre-aborted read without issuing a GraphQL request", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch: Mock<LinearFetch> = vi.fn<LinearFetch>();

    const result = await adapter(fetch).readChanges(request(), { signal: controller.signal });

    expect(result.ok ? "ok" : result.error.code).toBe("interrupted");
    expect(fetch).not.toHaveBeenCalled();
  });
});
