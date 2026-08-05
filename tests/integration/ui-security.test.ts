import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnection } from "node:net";
import { runInNewContext } from "node:vm";

import {
  createSecretSafeJsonResponse,
  createUiSecurityPolicy,
  startLocalUiServer,
  type LocalUiServerHandle,
  type UiRequest,
  type UiSecurityRouteContract,
  type UiServerClock,
} from "../../src/ui/index.js";

const handles: LocalUiServerHandle[] = [];

class MutableClock implements UiServerClock {
  #now: number;

  constructor(now: number) {
    this.#now = now;
  }

  now(): number {
    return this.#now;
  }

  advance(milliseconds: number): void {
    this.#now += milliseconds;
  }
}

async function startSecured(
  options: Parameters<typeof startLocalUiServer>[0] = {},
): Promise<LocalUiServerHandle> {
  const handle = await startLocalUiServer({
    securityPolicy: createUiSecurityPolicy(),
    handler: (request) =>
      request.url === "/api/settings"
        ? createSecretSafeJsonResponse({ configured: false })
        : {
            statusCode: 200,
            headers: { "content-type": "application/json; charset=utf-8" },
            body: JSON.stringify({ method: request.method, auth: request.auth.kind }),
          },
    ...options,
  });
  handles.push(handle);
  return handle;
}

function sessionCookie(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  if (setCookie === null) throw new Error("missing session cookie");
  return setCookie.split(";", 1)[0] ?? "";
}

async function exchange(
  handle: LocalUiServerHandle,
): Promise<{ readonly cookie: string; readonly csrf: string; readonly response: Response }> {
  const response = await fetch(`${handle.baseUrl}/__session/exchange`, {
    method: "POST",
    headers: { authorization: `Bearer ${handle.sessionToken}` },
  });
  const csrf = response.headers.get("x-csrf-token");
  if (csrf === null) throw new Error("missing CSRF token");
  return { cookie: sessionCookie(response), csrf, response };
}

function doublePercentEncoded(value: string): string {
  return Buffer.from(value, "ascii").reduce(
    (encoded, byte) => `${encoded}%25${byte.toString(16).padStart(2, "0")}`,
    "",
  );
}

function percentEncoded(value: string): string {
  return Buffer.from(value, "ascii").reduce(
    (encoded, byte) => `${encoded}%${byte.toString(16).padStart(2, "0")}`,
    "",
  );
}

function triplePercentEncoded(value: string): string {
  return Buffer.from(value, "ascii").reduce(
    (encoded, byte) => `${encoded}%2525${byte.toString(16).padStart(2, "0")}`,
    "",
  );
}

async function rawHttpRequest(handle: LocalUiServerHandle, payload: string): Promise<string> {
  const port = Number(new URL(handle.baseUrl).port);
  return await new Promise<string>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let response = "";
    let settled = false;
    const finish = (failure?: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (failure === undefined) resolve(response);
      else reject(failure);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(2_000, () => {
      finish(new Error("raw HTTP request timed out"));
    });
    socket.on("connect", () => {
      socket.end(payload);
    });
    socket.on("data", (chunk: string) => {
      response += chunk;
    });
    socket.on("end", () => {
      finish();
    });
    socket.on("error", (error) => {
      finish(error);
    });
  });
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map(async (handle) => handle.close()));
  vi.restoreAllMocks();
});

describe("localhost UI browser security layer", () => {
  it("bootstraps through a fragment-safe local script and exchanges Bearer once", async () => {
    const received: UiRequest[] = [];
    const handle = await startSecured({
      handler: (request) => {
        received.push(request);
        return { statusCode: 200, body: request.auth.kind };
      },
    });
    const fragmentUrl = `${handle.baseUrl}/#${handle.sessionToken}`;

    const shell = await fetch(fragmentUrl);
    const shellBody = await shell.text();
    const script = await fetch(`${handle.baseUrl}/__bootstrap.js`);
    const scriptBody = await script.text();
    expect(shell.status).toBe(200);
    expect(shellBody).toContain('src="/__bootstrap.js"');
    expect(`${shell.url}${shellBody}${scriptBody}`).not.toContain(handle.sessionToken);
    expect(scriptBody).toContain("history.replaceState");
    expect(scriptBody).toContain('fetch("/__session/exchange"');
    expect(scriptBody).not.toMatch(/localStorage|[?&](?:token|session)=/u);
    expect(received).toHaveLength(0);

    const browserCalls: string[] = [];
    const storedValues: string[] = [];
    runInNewContext(scriptBody, {
      Event: class {
        constructor(readonly type: string) {}
      },
      document: { getElementById: () => null },
      fetch: (url: string, init: { readonly headers?: { readonly authorization?: string } }) => {
        browserCalls.push(`fetch:${url}:${init.headers?.authorization ?? ""}`);
        return Promise.resolve({
          ok: true,
          headers: { get: () => "browser-csrf" },
        });
      },
      history: {
        replaceState: () => {
          browserCalls.push("fragment-cleared");
        },
      },
      sessionStorage: {
        removeItem: () => undefined,
        setItem: (_key: string, value: string) => {
          storedValues.push(value);
        },
      },
      window: {
        dispatchEvent: (event: { readonly type: string }) => {
          browserCalls.push(event.type);
        },
        location: { hash: `#${handle.sessionToken}`, pathname: "/", search: "" },
      },
    });
    await vi.waitFor(() => {
      expect(browserCalls).toContain("agent-team-session-ready");
    });
    expect(browserCalls.slice(0, 2)).toEqual([
      "fragment-cleared",
      `fetch:/__session/exchange:Bearer ${handle.sessionToken}`,
    ]);
    expect(storedValues).toEqual(["browser-csrf"]);
    expect(browserCalls[1]).not.toContain(`?${handle.sessionToken}`);

    const first = await exchange(handle);
    expect(first.response.status).toBe(204);
    expect(first.response.headers.get("set-cookie")).toMatch(
      /^agent_team_session=[A-Za-z0-9_-]+; HttpOnly; SameSite=Strict; Path=\/$/u,
    );
    expect(first.response.headers.get("set-cookie")).not.toContain("Secure");
    expect(first.cookie).not.toContain(handle.sessionToken);
    expect(first.csrf).not.toBe(handle.sessionToken);

    const replay = await fetch(`${handle.baseUrl}/__session/exchange`, {
      method: "POST",
      headers: { authorization: `Bearer ${handle.sessionToken}` },
    });
    expect(replay.status).toBe(401);
    expect(await replay.text()).toBe("Unauthorized\n");
    expect(replay.headers.get("set-cookie")).toBeNull();
  });

  it("shares the HttpOnly session across tabs and lets each tab obtain CSRF", async () => {
    const handle = await startSecured();
    const firstTab = await exchange(handle);

    const read = await fetch(`${handle.baseUrl}/api/projects`, {
      headers: { cookie: firstTab.cookie },
    });
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toEqual({ method: "GET", auth: "session" });

    const secondTab = await fetch(`${handle.baseUrl}/__session/csrf`, {
      headers: { cookie: firstTab.cookie },
    });
    expect(secondTab.status).toBe(204);
    expect(secondTab.headers.get("x-csrf-token")).toBe(firstTab.csrf);

    const mutation = await fetch(`${handle.baseUrl}/api/settings`, {
      method: "PUT",
      headers: {
        cookie: firstTab.cookie,
        origin: handle.baseUrl,
        "x-csrf-token": firstTab.csrf,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(mutation.status).toBe(200);
    await expect(mutation.json()).resolves.toEqual({ configured: false });
  });

  it("rejects credentials anywhere in the URL and gives handlers only canonical allowlisted input", async () => {
    const received: UiRequest[] = [];
    const handle = await startSecured({
      securityPolicy: createUiSecurityPolicy({
        routes: [
          {
            path: "/api/projects",
            allowedQueryParameters: ["page", "sort"],
            response: "standard",
          },
        ],
      }),
      handler: (request) => {
        received.push(request);
        return { statusCode: 200, body: request.url };
      },
    });
    const session = await exchange(handle);

    const canonical = await fetch(`${handle.baseUrl}/api/projects?sort=name&page=%32`, {
      headers: { cookie: session.cookie },
    });
    expect(canonical.status).toBe(200);
    expect(await canonical.text()).toBe("/api/projects?page=2&sort=name");
    expect(received.map((request) => request.url)).toEqual(["/api/projects?page=2&sort=name"]);

    const sessionToken = session.cookie.split("=", 2)[1];
    if (sessionToken === undefined) throw new Error("missing session token");
    for (const credential of [handle.sessionToken, sessionToken, session.csrf]) {
      for (const target of [
        `/api/projects/${credential}`,
        `/api/projects?sort=${credential}`,
        `/api/projects?probe=prefix-${credential}-suffix`,
      ]) {
        const rejected = await fetch(`${handle.baseUrl}${target}`, {
          headers: { cookie: session.cookie },
        });
        const rendered = `${await rejected.text()}${JSON.stringify([...rejected.headers])}`;
        expect(rejected.status).toBe(400);
        expect(rendered).not.toContain(credential);
      }
    }
    expect(received).toHaveLength(1);
  });

  it("rejects double-encoded credentials and malformed nested encodings before the handler", async () => {
    const recoveredUrls: string[] = [];
    const handler = vi.fn((request: UiRequest) => {
      recoveredUrls.push(decodeURIComponent(decodeURIComponent(request.url)));
      return { statusCode: 200, body: "handled" };
    });
    const handle = await startSecured({
      securityPolicy: createUiSecurityPolicy({
        routes: [
          {
            path: "/api/projects",
            allowedQueryParameters: ["sort"],
            response: "standard",
          },
        ],
      }),
      handler,
    });
    const session = await exchange(handle);
    const sessionToken = session.cookie.split("=", 2)[1];
    if (sessionToken === undefined) throw new Error("missing session token");
    for (const credential of [handle.sessionToken, sessionToken, session.csrf]) {
      const rejected = await fetch(
        `${handle.baseUrl}/api/projects?sort=${doublePercentEncoded(credential)}`,
        { headers: { cookie: session.cookie } },
      );
      const rendered = `${await rejected.text()}${JSON.stringify([...rejected.headers])}`;
      expect(rejected.status).toBe(400);
      expect(rendered).not.toContain(credential);
    }
    const malformedNested = await fetch(`${handle.baseUrl}/api/projects?sort=%25GG`, {
      headers: { cookie: session.cookie },
    });
    expect(malformedNested.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
    expect(recoveredUrls).toEqual([]);
  });

  it("gives handlers no caller-controlled headers, including raw or encoded credentials", async () => {
    const received: UiRequest[] = [];
    const handle = await startSecured({
      handler: (request) => {
        received.push(request);
        return { statusCode: 200, body: "handled" };
      },
    });
    const session = await exchange(handle);

    const result = await fetch(`${handle.baseUrl}/api/projects`, {
      headers: {
        cookie: session.cookie,
        "user-agent": "safe-client-metadata",
        "x-raw-credential": session.csrf,
        "x-encoded-credential": doublePercentEncoded(session.csrf),
      },
    });

    expect(result.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]?.headers).toEqual({});
    expect(JSON.stringify(received[0])).not.toContain(session.csrf);
    expect(JSON.stringify(received[0])).not.toContain(session.cookie);
  });

  it.each([
    ["missing cookie", {}, 401],
    ["missing origin", { cookie: "COOKIE", csrf: "CSRF" }, 403],
    ["cross origin", { cookie: "COOKIE", csrf: "CSRF", origin: "http://evil.invalid" }, 403],
    ["missing csrf", { cookie: "COOKIE", origin: "ORIGIN" }, 403],
    ["wrong csrf", { cookie: "COOKIE", csrf: "wrong", origin: "ORIGIN" }, 403],
  ])("rejects mutation with %s", async (_name, values, expectedStatus) => {
    const handle = await startSecured();
    const session = await exchange(handle);
    const headers: Record<string, string> = {};
    const cookie = "cookie" in values ? values.cookie : undefined;
    const csrf = "csrf" in values ? values.csrf : undefined;
    const origin = "origin" in values ? values.origin : undefined;
    if (cookie === "COOKIE") headers["cookie"] = session.cookie;
    if (csrf === "CSRF") headers["x-csrf-token"] = session.csrf;
    else if (csrf !== undefined) headers["x-csrf-token"] = csrf;
    if (origin === "ORIGIN") headers["origin"] = handle.baseUrl;
    else if (origin !== undefined) headers["origin"] = origin;

    const response = await fetch(`${handle.baseUrl}/api/settings`, { method: "PUT", headers });
    expect(response.status).toBe(expectedStatus);
  });

  it("allows only GET/HEAD reads and the fixed mutation method set", async () => {
    const handler = vi.fn(() => ({ statusCode: 200, body: "handled" }));
    const handle = await startSecured({ handler });
    const session = await exchange(handle);

    for (const method of ["OPTIONS", "PROPFIND", "PURGE"]) {
      const response = await fetch(`${handle.baseUrl}/api/settings`, {
        method,
        headers: { cookie: session.cookie },
      });
      expect(response.status).toBe(405);
    }
    const getExchange = await fetch(`${handle.baseUrl}/__session/exchange`, {
      headers: { cookie: session.cookie },
    });
    expect(getExchange.status).toBe(405);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", []],
    ["duplicate", ["GET", "GET"]],
    ["non-canonical", ["get"]],
    ["unsupported OPTIONS", ["OPTIONS"]],
    ["unsupported CONNECT", ["CONNECT"]],
  ])("rejects an %s route method allowlist", (_name, allowedMethods) => {
    const route = {
      path: "/api/limited",
      allowedQueryParameters: [],
      response: "standard",
      allowedMethods,
    } as unknown as UiSecurityRouteContract;

    expect(() => createUiSecurityPolicy({ routes: [route] })).toThrow(
      "Invalid UI security route contract.",
    );
  });

  it("normalizes an exact route method allowlist and makes GET imply HEAD", async () => {
    const methods: string[] = [];
    const handle = await startSecured({
      securityPolicy: createUiSecurityPolicy({
        routes: [
          {
            path: "/api/limited",
            allowedQueryParameters: [],
            allowedMethods: ["PUT", "GET"],
            response: "standard",
          },
          {
            path: "/api/head-only",
            allowedQueryParameters: [],
            allowedMethods: ["HEAD"],
            response: "standard",
          },
        ],
      }),
      handler: (request) => {
        methods.push(request.method);
        return { statusCode: 204 };
      },
    });
    const session = await exchange(handle);

    for (const method of ["GET", "HEAD", "PUT"]) {
      const result = await fetch(`${handle.baseUrl}/api/limited`, {
        method,
        headers:
          method === "GET" || method === "HEAD"
            ? { cookie: session.cookie }
            : {
                cookie: session.cookie,
                origin: handle.baseUrl,
                "x-csrf-token": session.csrf,
              },
      });
      expect(result.status).toBe(204);
    }

    for (const method of ["POST", "PATCH", "DELETE", "OPTIONS"]) {
      const rejected = await fetch(`${handle.baseUrl}/api/limited`, {
        method,
        headers: { cookie: session.cookie },
      });
      expect(rejected.status).toBe(405);
      expect(await rejected.text()).toBe("Method Not Allowed\n");
      expect(rejected.headers.get("allow")).toBe("GET, HEAD, PUT");
    }
    const headOnly = await fetch(`${handle.baseUrl}/api/head-only`, {
      method: "HEAD",
      headers: { cookie: session.cookie },
    });
    const getHeadOnly = await fetch(`${handle.baseUrl}/api/head-only`, {
      headers: { cookie: session.cookie },
    });
    expect(headOnly.status).toBe(204);
    expect(getHeadOnly.status).toBe(405);
    expect(getHeadOnly.headers.get("allow")).toBe("HEAD");
    expect(methods).toEqual(["GET", "HEAD", "PUT", "HEAD"]);
  });

  it("keeps the legacy six-method default when allowedMethods is omitted", async () => {
    const methods: string[] = [];
    const handle = await startSecured({
      securityPolicy: createUiSecurityPolicy({
        routes: [
          {
            path: "/api/legacy",
            allowedQueryParameters: [],
            response: "standard",
          },
        ],
      }),
      handler: (request) => {
        methods.push(request.method);
        return { statusCode: 204 };
      },
    });
    const session = await exchange(handle);

    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]) {
      const result = await fetch(`${handle.baseUrl}/api/legacy`, {
        method,
        headers:
          method === "GET" || method === "HEAD"
            ? { cookie: session.cookie }
            : {
                cookie: session.cookie,
                origin: handle.baseUrl,
                "x-csrf-token": session.csrf,
              },
      });
      expect(result.status).toBe(204);
    }
    expect(methods).toEqual(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
  });

  it("gives authenticated CONNECT requests only the matched route's canonical Allow contract", async () => {
    const clock = new MutableClock(10_000);
    const handler = vi.fn(() => ({ statusCode: 204 }));
    const handle = await startSecured({
      clock,
      idleTimeoutMs: 100,
      securityPolicy: createUiSecurityPolicy({
        routes: [
          {
            path: "/api/limited",
            allowedQueryParameters: [],
            allowedMethods: ["PUT", "GET"],
            response: "standard",
          },
          {
            path: "/api/legacy",
            allowedQueryParameters: [],
            response: "standard",
          },
        ],
      }),
      handler,
    });
    const session = await exchange(handle);
    clock.advance(90);
    const host = new URL(handle.baseUrl).host;
    const connect = async (path: string, cookie?: string): Promise<string> =>
      await rawHttpRequest(
        handle,
        [
          `CONNECT ${path} HTTP/1.1`,
          `Host: ${host}`,
          ...(cookie === undefined ? [] : [`Cookie: ${cookie}`]),
          "Content-Length: 2",
          "Connection: close",
          "",
          "{",
        ].join("\r\n"),
      );

    const limited = await connect("/api/limited", session.cookie);
    const legacy = await connect("/api/legacy", session.cookie);
    const unknown = await connect("/api/unknown", session.cookie);
    const unauthenticated = await connect("/api/limited");

    for (const response of [limited, legacy, unknown, unauthenticated]) {
      expect(response).toContain("HTTP/1.1 405 Method Not Allowed");
    }
    expect(limited).toMatch(/allow: GET, HEAD, PUT/iu);
    expect(legacy).toMatch(/allow: GET, HEAD, POST, PUT, PATCH, DELETE/iu);
    expect(unknown).not.toMatch(/\r\nallow:/iu);
    expect(unauthenticated).not.toMatch(/\r\nallow:/iu);
    expect(handler).not.toHaveBeenCalled();
    expect(handle.status()).toEqual({ state: "active", idleDeadlineMs: 10_100 });

    clock.advance(11);
    const expiredConnect = await connect("/api/limited", session.cookie);
    expect(expiredConnect).toContain("HTTP/1.1 405 Method Not Allowed");
    expect(expiredConnect).not.toMatch(/\r\nallow:/iu);
    expect(handle.status()).toEqual({ state: "locked" });
    const expired = await fetch(`${handle.baseUrl}/api/limited`, {
      headers: { cookie: session.cookie },
    });
    expect(expired.status).toBe(423);
  });

  it("does not let public, invalid cookie, Origin, or CSRF requests refresh idle", async () => {
    const cases = [
      async (handle: LocalUiServerHandle): Promise<Response> => fetch(`${handle.baseUrl}/`),
      async (handle: LocalUiServerHandle): Promise<Response> =>
        fetch(`${handle.baseUrl}/api/projects`, { headers: { cookie: "agent_team_session=bad" } }),
      async (handle: LocalUiServerHandle, cookie: string, csrf: string): Promise<Response> =>
        fetch(`${handle.baseUrl}/api/settings`, {
          method: "POST",
          headers: { cookie, origin: "http://evil.invalid", "x-csrf-token": csrf },
        }),
      async (handle: LocalUiServerHandle, cookie: string): Promise<Response> =>
        fetch(`${handle.baseUrl}/api/settings`, {
          method: "POST",
          headers: { cookie, origin: handle.baseUrl, "x-csrf-token": "bad" },
        }),
    ];

    for (const invalidRequest of cases) {
      const clock = new MutableClock(10_000);
      const handle = await startSecured({ clock, idleTimeoutMs: 100 });
      const session = await exchange(handle);
      clock.advance(90);
      await invalidRequest(handle, session.cookie, session.csrf);
      clock.advance(11);
      const expired = await fetch(`${handle.baseUrl}/api/projects`, {
        headers: { cookie: session.cookie },
      });
      expect(expired.status).toBe(423);
      await handle.close();
    }
  });

  it("does not refresh idle for authenticated 400, 404, 405, or unknown routes", async () => {
    const cases = [
      {
        expectedStatus: 400,
        method: "GET",
        path: "/api/projects",
        handler: () => ({ statusCode: 400, body: "Bad Request\n" }),
      },
      {
        expectedStatus: 404,
        method: "GET",
        path: "/unknown",
        handler: () => ({ statusCode: 200, body: "must not run" }),
      },
      {
        expectedStatus: 405,
        method: "OPTIONS",
        path: "/api/projects",
        handler: () => ({ statusCode: 200, body: "must not run" }),
      },
    ] as const;

    for (const testCase of cases) {
      const clock = new MutableClock(15_000);
      const handler = vi.fn(testCase.handler);
      const handle = await startSecured({ clock, idleTimeoutMs: 100, handler });
      const session = await exchange(handle);
      clock.advance(90);
      const rejected = await fetch(`${handle.baseUrl}${testCase.path}`, {
        method: testCase.method,
        headers: { cookie: session.cookie },
      });
      expect(rejected.status).toBe(testCase.expectedStatus);
      if (testCase.expectedStatus !== 400) expect(handler).not.toHaveBeenCalled();
      clock.advance(11);
      const expired = await fetch(`${handle.baseUrl}/api/projects`, {
        headers: { cookie: session.cookie },
      });
      expect(expired.status).toBe(423);
      await handle.close();
    }
  });

  it("permanently locks old tabs and new session requests after idle expiry", async () => {
    const clock = new MutableClock(20_000);
    const handle = await startSecured({ clock, idleTimeoutMs: 100 });
    const session = await exchange(handle);
    clock.advance(101);

    const oldTabMutation = await fetch(`${handle.baseUrl}/api/settings`, {
      method: "DELETE",
      headers: {
        cookie: session.cookie,
        origin: handle.baseUrl,
        "x-csrf-token": session.csrf,
      },
    });
    const newTab = await fetch(`${handle.baseUrl}/__session/csrf`, {
      headers: { cookie: session.cookie },
    });
    const bearerAgain = await fetch(`${handle.baseUrl}/__session/exchange`, {
      method: "POST",
      headers: { authorization: `Bearer ${handle.sessionToken}` },
    });
    expect([oldTabMutation.status, newTab.status, bearerAgain.status]).toEqual([423, 423, 423]);
    expect(oldTabMutation.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
  });

  it("invalidates an old process-memory cookie after restart", async () => {
    const policy = createUiSecurityPolicy();
    const first = await startSecured({ securityPolicy: policy });
    const oldSession = await exchange(first);
    await first.close();

    const second = await startSecured({ securityPolicy: policy });
    const response = await fetch(`${second.baseUrl}/api/projects`, {
      headers: { cookie: oldSession.cookie },
    });
    expect(response.status).toBe(401);
  });

  it("adds security headers to success and every controlled error response", async () => {
    const handle = await startSecured({
      securityPolicy: createUiSecurityPolicy({
        routes: [
          { path: "/api/projects", allowedQueryParameters: [], response: "standard" },
          { path: "/api/settings", allowedQueryParameters: [], response: "secret-safe" },
          { path: "/missing", allowedQueryParameters: [], response: "standard" },
          { path: "/explode", allowedQueryParameters: [], response: "standard" },
        ],
      }),
      handler: (request) => {
        if (request.url === "/explode") throw new Error("boom");
        if (request.url === "/missing") return { statusCode: 404, body: "Not Found\n" };
        return { statusCode: 200, body: "ok" };
      },
    });
    const session = await exchange(handle);
    const responses = [
      await fetch(`${handle.baseUrl}/`),
      await fetch(`${handle.baseUrl}/api/projects`, { headers: { cookie: session.cookie } }),
      await fetch(`${handle.baseUrl}/api/projects`),
      await fetch(`${handle.baseUrl}/api/settings`, {
        method: "POST",
        headers: { cookie: session.cookie },
      }),
      await fetch(`${handle.baseUrl}/missing`, { headers: { cookie: session.cookie } }),
      await fetch(`${handle.baseUrl}/explode`, { headers: { cookie: session.cookie } }),
    ];
    for (const response of responses) {
      expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect(response.headers.get("content-security-policy")).toContain(
        "style-src 'self' https://cdn.jsdelivr.net",
      );
      expect(response.headers.get("content-security-policy")).not.toMatch(
        /script-src[^;]*https?:/u,
      );
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("permissions-policy")).toBe(
        "camera=(), geolocation=(), microphone=()",
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("safely rejects CONNECT, Upgrade, and malformed client-error socket bypasses", async () => {
    const handle = await startSecured();
    const host = new URL(handle.baseUrl).host;
    const responses = [
      {
        statusLine: "HTTP/1.1 405 Method Not Allowed",
        response: await rawHttpRequest(
          handle,
          `CONNECT ${handle.sessionToken}:443 HTTP/1.1\r\nHost: ${host}\r\n\r\n`,
        ),
      },
      {
        statusLine: "HTTP/1.1 405 Method Not Allowed",
        response: await rawHttpRequest(
          handle,
          `GET /api/projects/${handle.sessionToken} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
        ),
      },
      {
        statusLine: "HTTP/1.1 400 Bad Request",
        response: await rawHttpRequest(handle, "NOT HTTP\r\n\r\n"),
      },
    ];
    for (const result of responses) {
      expect(result.response.length).toBeGreaterThan(0);
      expect(result.response).toContain(result.statusLine);
      expect(result.response).not.toContain(handle.sessionToken);
      expect(result.response).toMatch(/connection: close/iu);
      expect(result.response).toMatch(/content-security-policy: .*script-src 'self'/iu);
      expect(result.response).toMatch(/x-content-type-options: nosniff/iu);
      expect(result.response).toMatch(/referrer-policy: no-referrer/iu);
      expect(result.response).toMatch(/x-frame-options: DENY/iu);
      expect(result.response).toMatch(
        /permissions-policy: camera=\(\), geolocation=\(\), microphone=\(\)/iu,
      );
      expect(result.response).toMatch(/cache-control: no-store/iu);
    }
  });

  it("does not reflect auth, CSRF, or credentials smuggled through query parameters", async () => {
    const secret = "top-secret-value";
    const csrfAttack = "csrf-reflection-probe";
    const handle = await startSecured();
    const session = await exchange(handle);
    const rejected = await fetch(`${handle.baseUrl}/api/settings`, {
      method: "POST",
      headers: {
        cookie: session.cookie,
        origin: handle.baseUrl,
        "x-csrf-token": csrfAttack,
        "x-probe": secret,
      },
    });
    expect(`${await rejected.text()}${JSON.stringify([...rejected.headers])}`).not.toContain(
      csrfAttack,
    );

    const queryAttack = await fetch(
      `${handle.baseUrl}/api/projects?token=${encodeURIComponent(secret)}`,
      { headers: { cookie: session.cookie } },
    );
    expect(queryAttack.status).toBe(400);
    expect(`${await queryAttack.text()}${JSON.stringify([...queryAttack.headers])}`).not.toContain(
      secret,
    );
  });

  it("enforces the secret-safe response contract at the protected route boundary", async () => {
    const secret = "top-secret-value";
    const safeResponse = createSecretSafeJsonResponse({
      configured: true,
      fingerprint: "sha256:abcd1234",
      lastTestedAt: "2026-08-05T12:00:00.000Z",
      secret,
      token: secret,
      authorization: `Bearer ${secret}`,
      csrf: secret,
    });
    const safeHandle = await startSecured({ handler: () => safeResponse });
    const safeSession = await exchange(safeHandle);
    const safe = await fetch(`${safeHandle.baseUrl}/api/settings`, {
      headers: { cookie: safeSession.cookie },
    });
    expect(safe.status).toBe(200);
    expect(await safe.text()).toBe(
      '{"configured":true,"fingerprint":"sha256:abcd1234","lastTestedAt":"2026-08-05T12:00:00.000Z"}',
    );
    expect(safeResponse.body).not.toContain(secret);
    expect(
      createSecretSafeJsonResponse({ configured: true, fingerprint: secret, lastTestedAt: secret })
        .body,
    ).toBe('{"configured":true}');

    const unsafeHandle = await startSecured({
      handler: () => ({
        statusCode: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: secret,
      }),
    });
    const unsafeSession = await exchange(unsafeHandle);
    const unsafe = await fetch(`${unsafeHandle.baseUrl}/api/settings`, {
      headers: { cookie: unsafeSession.cookie },
    });
    expect(unsafe.status).toBe(500);
    expect(`${await unsafe.text()}${JSON.stringify([...unsafe.headers])}`).not.toContain(secret);
  });

  it.each([300, 400, 404, 500])(
    "replaces an untrusted %i settings response with a fixed safe error",
    async (statusCode) => {
      const secret = `settings-secret-${String(statusCode)}`;
      const handle = await startSecured({
        handler: () => ({
          statusCode,
          headers: { "x-handler-secret": secret },
          body: secret,
        }),
      });
      const session = await exchange(handle);
      const rejected = await fetch(`${handle.baseUrl}/api/settings`, {
        headers: { cookie: session.cookie },
      });
      const rendered = `${await rejected.text()}${JSON.stringify([...rejected.headers])}`;
      expect(rejected.status).toBe(500);
      expect(rendered).not.toContain(secret);
      expect(rejected.headers.get("x-handler-secret")).toBeNull();
    },
  );

  it.each([400, 500])(
    "blocks double-encoded credentials in outbound %i bodies and headers",
    async (statusCode) => {
      let encodedCredential = "";
      const handle = await startSecured({
        handler: () => ({
          statusCode,
          headers: { "x-handler-result": `prefix-${encodedCredential}-suffix` },
          body: `failure:${encodedCredential}`,
        }),
      });
      const session = await exchange(handle);
      encodedCredential = doublePercentEncoded(session.csrf);

      const rejected = await fetch(`${handle.baseUrl}/api/projects`, {
        headers: { cookie: session.cookie },
      });
      const rendered = `${await rejected.text()}${JSON.stringify([...rejected.headers])}`;

      expect(rejected.status).toBe(500);
      expect(rejected.headers.get("x-handler-result")).toBeNull();
      expect(rendered).not.toContain(encodedCredential);
      expect(decodeURIComponent(decodeURIComponent(rendered))).not.toContain(session.csrf);
    },
  );

  it("allows credential-free handler output containing CSS percentages, URLs, and malformed percent text", async () => {
    const body =
      ".progress{width:100%;background:url('/assets/font%20name.woff2?coverage=100%25')}/* literal %, malformed %GG/%FF, nested %252541 */";
    const handle = await startSecured({
      handler: () => ({
        statusCode: 200,
        headers: { "content-type": "text/css; charset=utf-8", "x-source-url": "/font%20name" },
        body,
      }),
    });
    const session = await exchange(handle);
    const response = await fetch(`${handle.baseUrl}/api/projects`, {
      headers: { cookie: session.cookie },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-source-url")).toBe("/font%20name");
    expect(await response.text()).toBe(body);
  });

  it("blocks raw and one-, two-, or three-layer encoded bearer, session, and CSRF credentials in body or headers", async () => {
    let body = "safe";
    let header = "safe";
    const handle = await startSecured({
      handler: () => ({ statusCode: 200, headers: { "x-handler-result": header }, body }),
    });
    const session = await exchange(handle);
    const sessionToken = session.cookie.split("=", 2)[1];
    if (sessionToken === undefined) throw new Error("missing session token");

    for (const credential of [handle.sessionToken, sessionToken, session.csrf]) {
      for (const representation of [
        credential,
        percentEncoded(credential),
        doublePercentEncoded(credential),
        triplePercentEncoded(credential),
      ]) {
        for (const location of ["body", "header"] as const) {
          body = location === "body" ? `malformed-%GG-${representation}-suffix` : "safe";
          header = location === "header" ? `malformed-%GG-${representation}-suffix` : "safe";
          const rejected = await fetch(`${handle.baseUrl}/api/projects`, {
            headers: { cookie: session.cookie },
          });
          const rendered = `${await rejected.text()}${JSON.stringify([...rejected.headers])}`;

          expect(rejected.status).toBe(500);
          expect(rejected.headers.get("x-handler-result")).toBeNull();
          expect(rendered).not.toContain(credential);
          expect(rendered).not.toContain(representation);
        }
      }
    }
  });

  it("does not let contiguous malformed percent escapes hide encoded credentials", async () => {
    let body = "safe";
    let header = "safe";
    const handle = await startSecured({
      handler: () => ({ statusCode: 200, headers: { "x-handler-result": header }, body }),
    });
    const session = await exchange(handle);
    const sessionToken = session.cookie.split("=", 2)[1];
    if (sessionToken === undefined) throw new Error("missing session token");

    for (const credential of [handle.sessionToken, sessionToken, session.csrf]) {
      for (const encoded of [percentEncoded(credential), doublePercentEncoded(credential)]) {
        for (const representation of [`%FF${encoded}`, `${encoded}%FF`, `%41%FF${encoded}%FE%42`]) {
          for (const location of ["body", "header"] as const) {
            body = location === "body" ? representation : "safe";
            header = location === "header" ? representation : "safe";
            const rejected = await fetch(`${handle.baseUrl}/api/projects`, {
              headers: { cookie: session.cookie },
            });
            const rendered = `${await rejected.text()}${JSON.stringify([...rejected.headers])}`;

            expect(rejected.status).toBe(500);
            expect(rejected.headers.get("x-handler-result")).toBeNull();
            expect(rendered).not.toContain(credential);
            expect(rendered).not.toContain(encoded);
          }
        }
      }
    }
  });

  it("does not let callers recover and forge the secret-safe response brand", async () => {
    const trusted = createSecretSafeJsonResponse({ configured: false });
    const recoveredBrand = Object.fromEntries(
      Object.getOwnPropertySymbols(trusted).map((symbol) => [symbol, true]),
    );
    const secret = "forged-settings-secret";
    const forged = {
      ...recoveredBrand,
      statusCode: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: secret,
    };
    const handle = await startSecured({ handler: () => forged });
    const session = await exchange(handle);
    const rejected = await fetch(`${handle.baseUrl}/api/settings`, {
      headers: { cookie: session.cookie },
    });
    const rendered = `${await rejected.text()}${JSON.stringify([...rejected.headers])}`;
    expect(rejected.status).toBe(500);
    expect(rendered).not.toContain(secret);
  });

  it("rejects handler header injection independently from secret body filtering", async () => {
    const handle = await startSecured({
      handler: () => ({
        statusCode: 200,
        headers: { "x-unsafe\r\ninjected": "harmless" },
        body: "public body",
      }),
    });
    const session = await exchange(handle);
    const unsafe = await fetch(`${handle.baseUrl}/api/projects`, {
      headers: { cookie: session.cookie },
    });
    expect(unsafe.status).toBe(500);
    expect(`${await unsafe.text()}${JSON.stringify([...unsafe.headers])}`).not.toContain(
      "injected",
    );
  });
});
