import { afterEach, describe, expect, it, vi } from "vitest";

import { createProjectUiShellReadModel } from "../../src/cli/ui/index.js";
import { projectListPayloadSchema } from "../../src/cli/project/schema.js";
import { createUiApplication } from "../../src/ui/registry/index.js";
import { startLocalUiServer, type LocalUiServerHandle } from "../../src/ui/server/index.js";

const handles: LocalUiServerHandle[] = [];
const projectId = "project_018f47d2-77a4-7cc1-8ef2-0123456789ab";

function runtimePayload() {
  return projectListPayloadSchema.parse({
    operation: "project_list",
    schemaVersion: 1,
    state: "degraded",
    inventory: { state: "available", rejectedDraftCount: 0 },
    projects: [
      {
        id: projectId,
        displayName: "本機 Production 專案",
        registration: { state: "configuration_incomplete", reason: "activation_missing" },
        nonTerminalProgressCount: null,
        activeLeaseCount: null,
      },
    ],
  });
}

async function start() {
  const read = vi.fn(() =>
    Promise.resolve({ state: "success" as const, payload: runtimePayload() }),
  );
  const application = createUiApplication({ readModel: createProjectUiShellReadModel({ read }) });
  const handle = await startLocalUiServer({
    securityPolicy: application.securityPolicy,
    handler: application.handler,
  });
  handles.push(handle);
  return Object.freeze({ handle, read, application });
}

function cookie(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (value === null) throw new Error("expected session cookie");
  return value.split(";", 1)[0] ?? "";
}

async function exchange(handle: LocalUiServerHandle): Promise<string> {
  const response = await fetch(`${handle.baseUrl}/__session/exchange`, {
    method: "POST",
    headers: { authorization: `Bearer ${handle.sessionToken}` },
  });
  expect(response.status).toBe(204);
  return cookie(response);
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

describe("T06 production localhost UI integration", () => {
  it("bootstraps anonymously, exchanges the one-time bearer, then serves only the authenticated core shell", async () => {
    const { application, handle, read } = await start();

    const anonymousRoot = await fetch(`${handle.baseUrl}/`);
    const bootstrapScript = await fetch(`${handle.baseUrl}/__bootstrap.js`);
    const session = await exchange(handle);
    const authenticatedRoot = await fetch(`${handle.baseUrl}/`, {
      headers: { cookie: session },
    });
    const replay = await fetch(`${handle.baseUrl}/__session/exchange`, {
      method: "POST",
      headers: { authorization: `Bearer ${handle.sessionToken}` },
    });
    const unauthenticatedProjects = await fetch(`${handle.baseUrl}/projects`);
    const unsupportedMethod = await fetch(`${handle.baseUrl}/projects`, {
      method: "POST",
      headers: { cookie: session },
    });
    const rootBody = await authenticatedRoot.text();

    expect(anonymousRoot.status).toBe(200);
    expect(await anonymousRoot.text()).toContain('src="/__bootstrap.js"');
    expect(await bootstrapScript.text()).toContain("window.location.replace");
    expect(authenticatedRoot.status).toBe(200);
    expect(rootBody).toContain("本機 Production 專案");
    expect(rootBody).toContain("降級（degraded）");
    expect(rootBody).toContain("未取得／—");
    expect(rootBody).not.toContain("UI Shell 示範資料");
    expect(rootBody).not.toContain("註冊精靈");
    expect(rootBody).not.toContain(handle.sessionToken);
    expect(authenticatedRoot.headers.get("cache-control")).toBe("no-store");
    expect(authenticatedRoot.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(replay.status).toBe(401);
    expect(unauthenticatedProjects.status).toBe(401);
    expect(unsupportedMethod.status).toBe(405);
    expect(unsupportedMethod.headers.get("allow")).toBe("GET, HEAD");
    expect(read).toHaveBeenCalledExactlyOnceWith({});
    expect(application.routeContracts.map((route) => route.path)).not.toContain("/runtime-status");
    expect(application.routeContracts.map((route) => route.path)).not.toContain("/settings");
  });

  it("refreshes once per authenticated HTML page and calls no mutation or event source", async () => {
    const { handle, read } = await start();
    const session = await exchange(handle);

    for (const path of ["/", "/projects", "/events"] as const) {
      const response = await fetch(`${handle.baseUrl}${path}`, { headers: { cookie: session } });
      expect(response.status).toBe(200);
      if (path === "/events") {
        expect(await response.text()).toContain("T06 尚未接入事件來源");
      }
    }

    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls).toEqual([[{}], [{}], [{}]]);
  });
});
