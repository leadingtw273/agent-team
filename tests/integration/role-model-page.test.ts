import { createConnection } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRoleModelFeature,
  defaultRoleModelRoutingConfig,
  roleModelUiSecurityRoutes,
  type RoleModelFeature,
  type RoleModelSettingsStore,
} from "../../src/ui/features/role-model/index.js";
import {
  createUiSecurityPolicy,
  createUiShellHandler,
  startLocalUiServer,
  type LocalUiServerHandle,
} from "../../src/ui/index.js";

const handles: LocalUiServerHandle[] = [];

class MismatchingReadBackStore implements RoleModelSettingsStore {
  readonly replacements: Parameters<RoleModelSettingsStore["replace"]>[0][] = [];
  readonly #initial = structuredClone(defaultRoleModelRoutingConfig());
  readonly #conflictingReadBack: ReturnType<typeof defaultRoleModelRoutingConfig>;
  #wasReplaced = false;

  constructor() {
    const config = structuredClone(defaultRoleModelRoutingConfig());
    this.#conflictingReadBack = {
      ...config,
      routes: config.routes.map((route) =>
        route.role === "team_lead"
          ? { ...route, candidates: [...route.candidates].reverse() }
          : route,
      ),
    };
  }

  read(): Promise<unknown> {
    const value = this.#wasReplaced ? this.#conflictingReadBack : this.#initial;
    return Promise.resolve(structuredClone(value));
  }

  replace(config: Parameters<RoleModelSettingsStore["replace"]>[0]): Promise<void> {
    this.replacements.push(structuredClone(config));
    this.#wasReplaced = true;
    return Promise.resolve();
  }
}

async function start(feature: RoleModelFeature = createRoleModelFeature()) {
  const handler = vi.fn(createUiShellHandler(undefined, feature));
  const handle = await startLocalUiServer({
    handler,
    securityPolicy: createUiSecurityPolicy({ routes: roleModelUiSecurityRoutes }),
  });
  handles.push(handle);
  return Object.freeze({ feature, handle, handler });
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

async function openRawRequest(
  handle: LocalUiServerHandle,
  payload: string,
): Promise<Readonly<{ response: Promise<string> }>> {
  const url = new URL(handle.baseUrl);
  const socket = createConnection({ host: url.hostname, port: Number(url.port) });
  const response = new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    socket.setTimeout(2_000, () => {
      socket.destroy(new Error("raw HTTP request timed out"));
    });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(payload);
  return Object.freeze({ response });
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map(async (handle) => handle.close()));
});

describe("role model page integration", () => {
  it("declares exact read and API method contracts for every feature route", () => {
    const api = roleModelUiSecurityRoutes.find((route) => route.path === "/api/role-models");
    const reads = roleModelUiSecurityRoutes.filter((route) => route !== api);

    expect(api?.allowedMethods).toEqual(["GET", "PUT"]);
    expect(reads).not.toHaveLength(0);
    expect(reads.every((route) => route.allowedMethods?.join(",") === "GET")).toBe(true);
  });

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
    expect(page).toContain("輸入驗證失敗時保留舊設定；寫入後讀回確認");
    expect(page).not.toContain("失敗時保留舊設定。");

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

  it("returns 503 read_back_mismatch after one write without attempting rollback", async () => {
    const store = new MismatchingReadBackStore();
    const { handle } = await start(createRoleModelFeature({ settingsStore: store }));
    const session = await exchange(handle);
    const next = {
      ...defaultRoleModelRoutingConfig(),
      routes: defaultRoleModelRoutingConfig().routes.map((route) =>
        route.role === "implementer"
          ? { ...route, candidates: [...route.candidates].reverse() }
          : route,
      ),
    };

    const result = await putApi(handle, session, next);

    expect(result.response.status).toBe(503);
    expect(JSON.parse(result.body)).toEqual({ error: "read_back_mismatch" });
    expect(store.replacements).toEqual([next]);
    expect(await store.read()).not.toEqual(defaultRoleModelRoutingConfig());
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

  it.each(["POST", "PATCH", "DELETE"])(
    "rejects the %s method before reading its body or reaching the handler",
    async (method) => {
      const { handle, handler } = await start();
      const session = await exchange(handle);
      const headers = [
        `Host: ${new URL(handle.baseUrl).host}`,
        `Cookie: ${session.cookie}`,
        `Origin: ${handle.baseUrl}`,
        `X-CSRF-Token: ${session.csrf}`,
        "Content-Type: application/json",
        "Content-Length: 2",
        "Connection: close",
      ].join("\r\n");
      const pending = await openRawRequest(
        handle,
        `${method} /api/role-models HTTP/1.1\r\n${headers}\r\n\r\n{`,
      );
      const response = await pending.response;

      expect(response).toContain("HTTP/1.1 405 Method Not Allowed");
      expect(response).toMatch(/allow: GET, HEAD, PUT/iu);
      expect(handler).not.toHaveBeenCalled();
    },
  );
});
