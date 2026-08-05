import { describe, expect, it } from "vitest";

import {
  LinearProvisionGraphqlAdapter,
  LinearGraphqlTransport,
  type LinearFetch,
} from "../../src/adapters/linear/index.js";
import { linearProvisionDesiredObjects } from "../../src/application/registration/index.js";
import { domainError, err } from "../../src/domain/foundation/index.js";

const target = Object.freeze({ teamId: "team-contract", projectId: "project-contract" });

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function operation(init: RequestInit): string {
  const parsed = JSON.parse(bodyString(init)) as Readonly<Record<string, unknown>>;
  return typeof parsed["operationName"] === "string" ? parsed["operationName"] : "";
}

function bodyString(init: RequestInit): string {
  if (typeof init.body !== "string") throw new TypeError("expected a JSON string body");
  return init.body;
}

function adapter(fetch: LinearFetch): LinearProvisionGraphqlAdapter {
  return new LinearProvisionGraphqlAdapter(
    new LinearGraphqlTransport({ apiKey: "synthetic-test-key", fetch }),
  );
}

describe("O003 Linear provision GraphQL contract", () => {
  it("reads a strict ID inventory and only exposes proven label/template mutations", async () => {
    const operations: string[] = [];
    const fetch: LinearFetch = (_url, init) => {
      const name = operation(init);
      operations.push(name);
      switch (name) {
        case "AgentTeamProvisionIdentity":
          return Promise.resolve(
            json({
              data: {
                team: { id: target.teamId },
                project: {
                  id: target.projectId,
                  teams: {
                    nodes: [{ id: target.teamId }],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            }),
          );
        case "AgentTeamProvisionStates":
          return Promise.resolve(
            json({
              data: {
                team: {
                  states: {
                    nodes: [{ id: "state-1", name: "待辦", type: "backlog" }],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            }),
          );
        case "AgentTeamProvisionLabels":
          return Promise.resolve(
            json({
              data: {
                issueLabels: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            }),
          );
        case "AgentTeamProvisionTemplates":
          return Promise.resolve(json({ data: { templates: [] } }));
        default:
          throw new Error(`unexpected operation ${name}`);
      }
    };

    const result = await adapter(fetch).readInventory(target);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.objects).toEqual([
      expect.objectContaining({ id: "state-1", kind: "workflow_state", name: "待辦" }),
    ]);
    expect(result.value.capabilities).toEqual({
      workflow_state: "manual",
      label_group: "automatic",
      label: "automatic",
      form_template: "automatic",
    });
    expect(operations).toEqual([
      "AgentTeamProvisionIdentity",
      "AgentTeamProvisionStates",
      "AgentTeamProvisionLabels",
      "AgentTeamProvisionTemplates",
    ]);
  });

  it("creates labels and the Form Template without any delete, rename, or update operation", async () => {
    const bodies: string[] = [];
    const fetch: LinearFetch = (_url, init) => {
      bodies.push(bodyString(init));
      const name = operation(init);
      return Promise.resolve(
        name === "AgentTeamProvisionCreateLabel"
          ? json({
              data: {
                issueLabelCreate: { success: true, issueLabel: { id: "created-label" } },
              },
            })
          : json({
              data: {
                templateCreate: { success: true, template: { id: "created-template" } },
              },
            }),
      );
    };
    const port = adapter(fetch);
    const group = linearProvisionDesiredObjects.find((desired) => desired.kind === "label_group");
    const template = linearProvisionDesiredObjects.find(
      (desired) => desired.kind === "form_template",
    );
    const workflow = linearProvisionDesiredObjects.find(
      (desired) => desired.kind === "workflow_state",
    );
    if (group === undefined || template === undefined || workflow === undefined) {
      throw new Error("fixed catalog is incomplete");
    }

    expect(await port.create(target, group, undefined)).toEqual(okReceipt("created-label"));
    expect(await port.create(target, template, undefined)).toEqual(okReceipt("created-template"));
    expect(await port.create(target, workflow, undefined)).toEqual(err(domainError("unavailable")));
    expect(bodies).toHaveLength(2);
    expect(bodies.join("\n")).not.toMatch(/delete|rename|update/iu);
  });

  it.each([
    [
      "401",
      401,
      { errors: [{ extensions: { code: "AUTHENTICATION_ERROR" } }] },
      "permission_denied",
    ],
    ["429", 429, { errors: [{ extensions: { code: "RATELIMITED" } }] }, "rate_limited"],
    [
      "GraphQL partial",
      200,
      { data: { team: null }, errors: [{ extensions: { code: "PARTIAL_ERROR" } }] },
      "external_failure",
    ],
  ])("fails closed on %s before reading more inventory", async (_case, status, body, code) => {
    let calls = 0;
    const result = await adapter(() => {
      calls += 1;
      return Promise.resolve(json(body, status));
    }).readInventory(target);

    expect(result).toEqual(err(domainError(code as "permission_denied")));
    expect(calls).toBe(1);
  });

  it("fails closed on unknown response fields", async () => {
    const result = await adapter(() =>
      Promise.resolve(
        json({
          data: {
            team: { id: target.teamId, unexpected: "field" },
            project: null,
          },
        }),
      ),
    ).readInventory(target);

    expect(result).toEqual(err(domainError("external_failure")));
  });
});

function okReceipt(id: string) {
  return { ok: true, value: { id } } as const;
}
