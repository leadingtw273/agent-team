import { afterEach, describe, expect, it } from "vitest";

import {
  createRoleModelFeature,
  defaultRoleModelRoutingConfig,
  roleModelUiSecurityRoutes,
} from "../../src/ui/features/role-model/index.js";
import {
  createUiSecurityPolicy,
  createUiShellHandler,
  startLocalUiServer,
  type LocalUiServerHandle,
} from "../../src/ui/index.js";

const handles: LocalUiServerHandle[] = [];

async function start() {
  const feature = createRoleModelFeature();
  const handle = await startLocalUiServer({
    handler: createUiShellHandler(undefined, feature),
    securityPolicy: createUiSecurityPolicy({ routes: roleModelUiSecurityRoutes }),
  });
  handles.push(handle);
  return Object.freeze({ feature, handle });
}

async function exchange(handle: LocalUiServerHandle): Promise<{
  readonly cookie: string;
  readonly csrf: string;
}> {
  const response = await fetch(`${handle.baseUrl}/__session/exchange`, {
    method: "POST",
    headers: { authorization: `Bearer ${handle.sessionToken}` },
  });
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  const csrf = response.headers.get("x-csrf-token");
  if (response.status !== 204 || cookie === undefined || csrf === null) {
    throw new Error("session exchange failed");
  }
  return Object.freeze({ cookie, csrf });
}

async function readApi(handle: LocalUiServerHandle, cookie: string) {
  const response = await fetch(`${handle.baseUrl}/api/role-models`, { headers: { cookie } });
  return Object.freeze({ response, body: await response.json() });
}

async function putApi(
  handle: LocalUiServerHandle,
  session: Readonly<{ cookie: string; csrf: string }>,
  input: unknown,
  overrides: Readonly<{ origin?: string; csrf?: string | null }> = {},
) {
  const csrf = overrides.csrf === undefined ? session.csrf : overrides.csrf;
  const headers: Record<string, string> = {
    cookie: session.cookie,
    origin: overrides.origin ?? handle.baseUrl,
    "content-type": "application/json",
  };
  if (csrf !== null) headers["x-csrf-token"] = csrf;
  const response = await fetch(`${handle.baseUrl}/api/role-models`, {
    method: "PUT",
    headers,
    body: JSON.stringify(input),
  });
  return Object.freeze({ response, body: await response.text() });
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map(async (handle) => handle.close()));
});

describe("role model page integration", () => {
  it("serves the completed page and only self-hosted behavior behind a real session", async () => {
    const { handle } = await start();
    const session = await exchange(handle);
    const response = await fetch(`${handle.baseUrl}/roles-models`, {
      headers: { cookie: session.cookie },
    });
    const page = await response.text();

    expect(response.status).toBe(200);
    expect(page).toContain("<title>角色與模型｜Agent Team</title>");
    expect(page).toContain('href="/roles-models" aria-current="page"');
    expect(page).toContain('src="/assets/role-model.js"');
    expect(page).toContain('href="/assets/role-model.css"');
    expect(page).not.toMatch(/<script(?![^>]*\bsrc=)/iu);
    expect(page).not.toMatch(/(?:--model|--provider|inline cli|行內 CLI)/iu);

    const script = await fetch(`${handle.baseUrl}/assets/role-model.js`, {
      headers: { cookie: session.cookie },
    });
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await script.text()).toContain('fetch("/api/role-models"');
  });

  it("PUTs immutable bounded JSON, reads it back, and leaves an active assignment unchanged", async () => {
    const { handle } = await start();
    const session = await exchange(handle);
    const initial = defaultRoleModelRoutingConfig();
    const reordered = {
      ...initial,
      routes: initial.routes.map((route) =>
        route.role === "implementer"
          ? { ...route, candidates: [...route.candidates].reverse() }
          : route,
      ),
    };

    const before = await readApi(handle, session.cookie);
    const saved = await putApi(handle, session, reordered);
    const after = await readApi(handle, session.cookie);

    expect(before.response.status).toBe(200);
    expect(saved.response.status).toBe(200);
    expect(after.response.status).toBe(200);
    expect(after.body).toMatchObject({
      config: reordered,
      activeAssignments: [
        {
          jobId: "job-running-implementer",
          role: "implementer",
          candidate: { provider: "claude", model: "sonnet" },
          candidateIndex: 1,
        },
      ],
    });
    expect(after.body).toMatchObject({
      activeAssignments: (before.body as { activeAssignments: unknown }).activeAssignments,
    });
  });

  it.each([
    ["missing CSRF", { csrf: null }],
    ["wrong CSRF", { csrf: "wrong" }],
    ["cross origin", { origin: "http://evil.invalid" }],
  ])("rejects %s before mutation and keeps the old config", async (_name, overrides) => {
    const { handle } = await start();
    const session = await exchange(handle);
    const initial = await readApi(handle, session.cookie);
    const reordered = {
      ...defaultRoleModelRoutingConfig(),
      routes: [...defaultRoleModelRoutingConfig().routes].reverse(),
    };

    const rejected = await putApi(handle, session, reordered, overrides);
    const after = await readApi(handle, session.cookie);

    expect(rejected.response.status).toBe(403);
    expect(after.body).toEqual(initial.body);
  });

  it("rejects a mutation without a session before reaching the feature", async () => {
    const { handle } = await start();
    const response = await fetch(`${handle.baseUrl}/api/role-models`, {
      method: "PUT",
      headers: { origin: handle.baseUrl, "content-type": "application/json" },
      body: JSON.stringify(defaultRoleModelRoutingConfig()),
    });

    expect(response.status).toBe(401);
  });

  it.each([
    ["missing roles", { schemaVersion: 1, routes: [] }],
    [
      "duplicate candidate",
      {
        ...defaultRoleModelRoutingConfig(),
        routes: defaultRoleModelRoutingConfig().routes.map((route) =>
          route.role === "implementer"
            ? { ...route, candidates: [route.candidates[0], route.candidates[0]] }
            : route,
        ),
      },
    ],
    [
      "unknown candidate",
      {
        ...defaultRoleModelRoutingConfig(),
        routes: defaultRoleModelRoutingConfig().routes.map((route) =>
          route.role === "implementer"
            ? { ...route, candidates: [{ provider: "unknown", model: "unknown" }] }
            : route,
        ),
      },
    ],
  ])("fails closed for %s without overwriting the old config", async (_name, input) => {
    const { handle } = await start();
    const session = await exchange(handle);
    const initial = await readApi(handle, session.cookie);

    const rejected = await putApi(handle, session, input);
    const after = await readApi(handle, session.cookie);

    expect(rejected.response.status).toBe(422);
    expect(after.body).toEqual(initial.body);
  });

  it.each(["POST", "PATCH", "DELETE"])("rejects the %s method without mutation", async (method) => {
    const { handle } = await start();
    const session = await exchange(handle);
    const before = await readApi(handle, session.cookie);
    const response = await fetch(`${handle.baseUrl}/api/role-models`, {
      method,
      headers: {
        cookie: session.cookie,
        origin: handle.baseUrl,
        "x-csrf-token": session.csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify(defaultRoleModelRoutingConfig()),
    });
    const after = await readApi(handle, session.cookie);

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, PUT");
    expect(after.body).toEqual(before.body);
  });
});
