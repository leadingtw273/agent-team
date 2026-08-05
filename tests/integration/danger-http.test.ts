import { afterEach, describe, expect, it } from "vitest";

import {
  createDangerApprovalUseCase,
  createDangerUiHandler,
  createUiSecurityPolicy,
  dangerUiRouteContract,
  InMemoryDangerApprovalStore,
  startLocalUiServer,
  type LocalUiServerHandle,
} from "../../src/ui/index.js";

const handles: LocalUiServerHandle[] = [];
afterEach(async () => Promise.all(handles.splice(0).map((handle) => handle.close())));

describe("U006 danger approval HTTP", () => {
  it("requires session, Origin, CSRF and bounded JSON for the exact PUT route", async () => {
    const request = {
      requestId: "danger-http-1",
      projectId: "project-alpha",
      projectName: "Alpha",
      category: "external_write" as const,
      purpose: "建立測試摘要",
      scope: "external test fixture",
      revision: "a".repeat(64),
    };
    const useCase = createDangerApprovalUseCase(new InMemoryDangerApprovalStore([request]));
    const handle = await startLocalUiServer({
      securityPolicy: createUiSecurityPolicy({ routes: [dangerUiRouteContract] }),
      handler: createDangerUiHandler(useCase),
    });
    handles.push(handle);
    const exchange = await fetch(`${handle.baseUrl}/__session/exchange`, {
      method: "POST",
      headers: { authorization: `Bearer ${handle.sessionToken}` },
    });
    const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
    const csrf = exchange.headers.get("x-csrf-token");
    if (cookie === undefined || csrf === null) throw new Error("session exchange failed");

    const body = JSON.stringify({
      requestId: request.requestId,
      projectId: request.projectId,
      category: request.category,
      expectedRevision: request.revision,
      decision: "reject",
    });
    expect((await fetch(`${handle.baseUrl}/api/danger`, { method: "PUT", body })).status).toBe(401);
    expect(
      (
        await fetch(`${handle.baseUrl}/api/danger`, {
          method: "PUT",
          headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
          body,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${handle.baseUrl}/api/danger`, {
          method: "PUT",
          headers: { cookie, origin: handle.baseUrl, "content-type": "application/json" },
          body,
        })
      ).status,
    ).toBe(403);
    const saved = await fetch(`${handle.baseUrl}/api/danger`, {
      method: "PUT",
      headers: {
        cookie,
        origin: handle.baseUrl,
        "content-type": "application/json",
        "x-csrf-token": csrf,
      },
      body,
    });
    expect(saved.status).toBe(200);
    expect(useCase.read().waiting).toEqual([]);
    expect(useCase.read().audit).toHaveLength(1);
  });

  it("returns stale CAS conflicts and never accepts unknown approval decisions", async () => {
    const known = {
      requestId: "danger-stale",
      projectId: "project-alpha",
      projectName: "Alpha",
      category: "deployment" as const,
      purpose: "部署測試版本",
      scope: "namespace agent-team-test",
      revision: "a".repeat(64),
    };
    const unknown = {
      ...known,
      requestId: "danger-unknown",
      category: "unknown" as const,
      revision: "b".repeat(64),
    };
    const useCase = createDangerApprovalUseCase(new InMemoryDangerApprovalStore([known, unknown]));
    const handle = await startLocalUiServer({
      securityPolicy: createUiSecurityPolicy({ routes: [dangerUiRouteContract] }),
      handler: createDangerUiHandler(useCase),
    });
    handles.push(handle);
    const exchange = await fetch(`${handle.baseUrl}/__session/exchange`, {
      method: "POST",
      headers: { authorization: `Bearer ${handle.sessionToken}` },
    });
    const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
    const csrf = exchange.headers.get("x-csrf-token");
    if (cookie === undefined || csrf === null) throw new Error("session exchange failed");
    const decide = async (body: Readonly<Record<string, string>>): Promise<Response> =>
      await fetch(`${handle.baseUrl}/api/danger`, {
        method: "PUT",
        headers: {
          cookie,
          origin: handle.baseUrl,
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify(body),
      });

    expect(
      (
        await decide({
          requestId: known.requestId,
          projectId: known.projectId,
          category: known.category,
          expectedRevision: "c".repeat(64),
          decision: "approve_once",
        })
      ).status,
    ).toBe(409);
    for (const decision of ["approve_once", "allow_project_category"]) {
      expect(
        (
          await decide({
            requestId: unknown.requestId,
            projectId: unknown.projectId,
            category: unknown.category,
            expectedRevision: unknown.revision,
            decision,
          })
        ).status,
      ).toBe(422);
    }
    expect(useCase.read().waiting).toEqual([known, unknown]);
    expect(useCase.read().audit).toEqual([]);
  });
});
