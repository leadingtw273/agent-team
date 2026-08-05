import { createConnection } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createUiSecurityPolicy,
  startLocalUiServer,
  type LocalUiServerHandle,
  type UiRequest,
  type UiRequestHandler,
  type UiServerClock,
  type UiSecurityPolicy,
} from "../../src/ui/index.js";

const handles: LocalUiServerHandle[] = [];

class MutableClock implements UiServerClock {
  private valid = true;

  constructor(private value: number) {}

  now(): number {
    return this.valid ? this.value : Number.NaN;
  }

  advance(milliseconds: number): void {
    this.value += milliseconds;
  }

  makeInvalid(): void {
    this.valid = false;
  }
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

async function startMutationServer(
  handler: UiRequestHandler,
  options: Readonly<{
    maxBodyBytes?: number;
    clock?: UiServerClock;
    idleTimeoutMs?: number;
    securityPolicy?: UiSecurityPolicy;
  }> = {},
): Promise<LocalUiServerHandle> {
  const handle = await startLocalUiServer({
    ...(options.maxBodyBytes === undefined
      ? {}
      : { maxJsonMutationBodyBytes: options.maxBodyBytes }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    securityPolicy: options.securityPolicy ?? createMutationSecurityPolicy(),
    handler,
  });
  handles.push(handle);
  return handle;
}

function createMutationSecurityPolicy(): UiSecurityPolicy {
  return createUiSecurityPolicy({
    routes: [
      {
        path: "/api/mutations",
        allowedQueryParameters: [],
        response: "standard",
        mutationBody: "bounded-json",
      },
    ],
  });
}

function createPutMutationSecurityPolicy(): UiSecurityPolicy {
  return createUiSecurityPolicy({
    routes: [
      {
        path: "/api/mutations",
        allowedQueryParameters: [],
        allowedMethods: ["GET", "PUT"],
        response: "standard",
        mutationBody: "bounded-json",
      },
    ],
  });
}

function observedMutationPolicy(onAuthorized: () => void): Readonly<{
  policy: UiSecurityPolicy;
  invalidate: () => void;
}> {
  const source = createMutationSecurityPolicy();
  const invalidate = vi.fn(() => {
    source.invalidate();
  });
  return Object.freeze({
    invalidate,
    policy: Object.freeze({
      ...source,
      authorize: (request: Parameters<UiSecurityPolicy["authorize"]>[0]) => {
        const decision = source.authorize(request);
        if (request.url === "/api/mutations" && decision.kind === "allow") {
          onAuthorized();
        }
        return decision;
      },
      invalidate,
    }),
  });
}

async function mutate(
  handle: LocalUiServerHandle,
  session: Readonly<{ cookie: string; csrf: string }>,
  body: string | Uint8Array,
  contentType = "application/json",
): Promise<Response> {
  return fetch(`${handle.baseUrl}/api/mutations`, {
    method: "POST",
    headers: {
      cookie: session.cookie,
      origin: handle.baseUrl,
      "x-csrf-token": session.csrf,
      "content-type": contentType,
    },
    body,
  });
}

function rawRequest(
  handle: LocalUiServerHandle,
  bytes: Uint8Array | string,
): Promise<Readonly<{ response: string; error?: Error }>> {
  const url = new URL(handle.baseUrl);
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    let socketError: Error | undefined;
    socket.on("connect", () => {
      socket.end(bytes);
    });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", (error: Error) => {
      socketError = error;
    });
    socket.on("close", () => {
      const result = { response: Buffer.concat(chunks).toString("utf8") };
      resolve(socketError === undefined ? result : { ...result, error: socketError });
    });
  });
}

async function openRawRequest(
  handle: LocalUiServerHandle,
  bytes: Uint8Array | string,
): Promise<Readonly<{ socket: ReturnType<typeof createConnection>; response: Promise<string> }>> {
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
  socket.write(bytes);
  return Object.freeze({ socket, response });
}

function authenticatedHeaders(
  handle: LocalUiServerHandle,
  session: Readonly<{ cookie: string; csrf: string }>,
  extra: readonly string[],
): string {
  return [
    `Host: ${new URL(handle.baseUrl).host}`,
    `Cookie: ${session.cookie}`,
    `Origin: ${handle.baseUrl}`,
    `X-CSRF-Token: ${session.csrf}`,
    "Connection: close",
    ...extra,
  ].join("\r\n");
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map(async (handle) => handle.close()));
});

describe("bounded JSON mutation transport", () => {
  it("delivers only deeply immutable, null-prototype JSON after policy authorization", async () => {
    const received: UiRequest[] = [];
    const handle = await startMutationServer((request) => {
      received.push(request);
      return { statusCode: 202, body: "accepted" };
    });
    const session = await exchange(handle);

    const response = await mutate(
      handle,
      session,
      JSON.stringify({ action: "approve", nested: { enabled: true }, values: [1, "two"] }),
      "application/json; charset=utf-8",
    );

    expect(response.status).toBe(202);
    expect(received).toHaveLength(1);
    const request = received[0];
    expect(request?.auth.kind).toBe("session");
    expect(request?.headers).toEqual({});
    expect(request?.body).toEqual({
      action: "approve",
      nested: { enabled: true },
      values: [1, "two"],
    });
    expect(Object.getPrototypeOf(request?.body)).toBeNull();
    expect(Object.isFrozen(request?.body)).toBe(true);
    expect(Object.isFrozen(request?.body?.["nested"])).toBe(true);
    expect(Object.isFrozen(request?.body?.["values"])).toBe(true);
  });

  it.each([
    "application/json",
    "Application/JSON; Charset=UTF-8",
    'application/json;charset="utf-8"',
  ])("accepts the explicit UTF-8 JSON media type form %j", async (contentType) => {
    const handler = vi.fn(() => ({ statusCode: 204 }));
    const handle = await startMutationServer(handler);
    const session = await exchange(handle);

    const response = await mutate(handle, session, "{}", contentType);

    expect(response.status).toBe(204);
    expect(handler).toHaveBeenCalledOnce();
  });

  it.each([
    "application/json; charset=latin1",
    "application/json; charset=utf-8; version=1",
    "text/json",
    "application/problem+json",
    "",
  ])("rejects unsupported content type %j without invoking the handler", async (contentType) => {
    const handler = vi.fn(() => ({ statusCode: 200, body: "must not run" }));
    const handle = await startMutationServer(handler);
    const session = await exchange(handle);
    const headers: Record<string, string> = {
      cookie: session.cookie,
      origin: handle.baseUrl,
      "x-csrf-token": session.csrf,
    };
    if (contentType.length > 0) headers["content-type"] = contentType;

    const response = await fetch(`${handle.baseUrl}/api/mutations`, {
      method: "POST",
      headers,
      body: "{}",
    });

    expect(response.status).toBe(415);
    expect(await response.text()).toBe("Unsupported Media Type\n");
    expect(handler).not.toHaveBeenCalled();
  });

  it("requires a bounded Content-Length and rejects chunked transfer coding", async () => {
    const handler = vi.fn(() => ({ statusCode: 200, body: "must not run" }));
    const handle = await startMutationServer(handler, { maxBodyBytes: 32 });
    const session = await exchange(handle);
    const common = authenticatedHeaders(handle, session, ["Content-Type: application/json"]);

    const chunked = await rawRequest(
      handle,
      `POST /api/mutations HTTP/1.1\r\n${common}\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n`,
    );
    const oversized = await rawRequest(
      handle,
      `POST /api/mutations HTTP/1.1\r\n${common}\r\nContent-Length: 64\r\n\r\n${" ".repeat(64)}`,
    );

    expect(chunked.response).toContain(" 400 ");
    expect(oversized.response).toContain(" 413 ");
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects an absent or empty JSON body", async () => {
    const handler = vi.fn(() => ({ statusCode: 200, body: "must not run" }));
    const handle = await startMutationServer(handler);
    const session = await exchange(handle);
    const common = authenticatedHeaders(handle, session, ["Content-Type: application/json"]);

    const absent = await rawRequest(handle, `POST /api/mutations HTTP/1.1\r\n${common}\r\n\r\n`);
    const empty = await rawRequest(
      handle,
      `POST /api/mutations HTTP/1.1\r\n${common}\r\nContent-Length: 0\r\n\r\n`,
    );

    expect(absent.response).toContain(" 411 ");
    expect(empty.response).toContain(" 400 ");
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", new TextEncoder().encode('{"action":}')],
    ["duplicate key", new TextEncoder().encode('{"action":"a","action":"b"}')],
    ["prototype key", new TextEncoder().encode('{"nested":{"__proto__":{}}}')],
    ["constructor key", new TextEncoder().encode('{"constructor":{"prototype":{}}}')],
    ["non-object root", new TextEncoder().encode('["approve"]')],
    [
      "malformed UTF-8",
      Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]),
    ],
  ] as const)("rejects %s with a fixed response", async (_name, payload) => {
    const secret = "secret-never-reflect";
    const handler = vi.fn(() => ({ statusCode: 200, body: secret }));
    const handle = await startMutationServer(handler);
    const session = await exchange(handle);

    const response = await mutate(handle, session, payload);
    const rendered = `${await response.text()}${JSON.stringify([...response.headers])}`;

    expect(response.status).toBe(400);
    expect(rendered).toBe(rendered.replaceAll(secret, ""));
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not authorize or consume an invalid body before Session, Origin, and CSRF", async () => {
    const handler = vi.fn(() => ({ statusCode: 200, body: "must not run" }));
    const handle = await startMutationServer(handler);
    const session = await exchange(handle);
    const invalid = '{"duplicate":1,"duplicate":2}';

    const unauthorized = await fetch(`${handle.baseUrl}/api/mutations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: invalid,
    });
    const wrongOrigin = await fetch(`${handle.baseUrl}/api/mutations`, {
      method: "POST",
      headers: {
        cookie: session.cookie,
        origin: "http://evil.invalid",
        "x-csrf-token": session.csrf,
        "content-type": "application/json",
      },
      body: invalid,
    });

    expect(unauthorized.status).toBe(401);
    expect(wrongOrigin.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("never reads a GET or HEAD body and preserves the CONNECT bypass guard", async () => {
    const bodies: unknown[] = [];
    const handle = await startMutationServer((request) => {
      bodies.push(request.body);
      return { statusCode: 200, body: "ok" };
    });
    const session = await exchange(handle);
    const common = authenticatedHeaders(handle, session, [
      "Content-Type: application/json",
      "Content-Length: 2",
    ]);

    const get = await rawRequest(handle, `GET /api/mutations HTTP/1.1\r\n${common}\r\n\r\n{}`);
    const head = await rawRequest(handle, `HEAD /api/mutations HTTP/1.1\r\n${common}\r\n\r\n{}`);
    const connect = await rawRequest(
      handle,
      `CONNECT /api/mutations HTTP/1.1\r\nHost: ${new URL(handle.baseUrl).host}\r\nConnection: close\r\n\r\n`,
    );

    expect(get.response).toContain(" 200 ");
    expect(head.response).toContain(" 200 ");
    expect(bodies).toEqual([undefined, undefined]);
    expect(connect.response).toContain(" 405 ");
  });

  it("rejects disallowed bounded-json mutations before reading the body or refreshing idle", async () => {
    const clock = new MutableClock(10_000);
    const handler = vi.fn(() => ({ statusCode: 204 }));
    const handle = await startMutationServer(handler, {
      clock,
      idleTimeoutMs: 100,
      securityPolicy: createPutMutationSecurityPolicy(),
    });
    const session = await exchange(handle);
    clock.advance(90);
    const common = authenticatedHeaders(handle, session, [
      "Content-Type: application/json",
      "Content-Length: 2",
    ]);

    for (const method of ["POST", "PATCH", "DELETE"]) {
      const pending = await openRawRequest(
        handle,
        `${method} /api/mutations HTTP/1.1\r\n${common}\r\n\r\n{`,
      );
      const response = await pending.response;
      expect(response).toContain(" 405 ");
      expect(response).toMatch(/allow: GET, HEAD, PUT/iu);
    }

    expect(handler).not.toHaveBeenCalled();
    expect(handle.status()).toEqual({ state: "active", idleDeadlineMs: 10_100 });
    clock.advance(11);
    const expired = await fetch(`${handle.baseUrl}/api/mutations`, {
      headers: { cookie: session.cookie },
    });
    expect(expired.status).toBe(423);
  });

  it("reads bounded JSON only for an allowed mutation method", async () => {
    const received: UiRequest[] = [];
    const handle = await startMutationServer(
      (request) => {
        received.push(request);
        return { statusCode: 204 };
      },
      { securityPolicy: createPutMutationSecurityPolicy() },
    );
    const session = await exchange(handle);

    const response = await fetch(`${handle.baseUrl}/api/mutations`, {
      method: "PUT",
      headers: {
        cookie: session.cookie,
        origin: handle.baseUrl,
        "x-csrf-token": session.csrf,
        "content-type": "application/json",
      },
      body: '{"action":"save"}',
    });

    expect(response.status).toBe(204);
    expect(received).toHaveLength(1);
    expect(received[0]?.method).toBe("PUT");
    expect(received[0]?.body).toEqual({ action: "save" });
  });

  it("never reflects a rejected raw body", async () => {
    const handler = vi.fn(() => ({ statusCode: 200 }));
    const handle = await startMutationServer(handler);
    const session = await exchange(handle);
    const secret = "secret-never-reflect";

    const response = await mutate(handle, session, `{"token":"${secret}",}`);
    const rendered = `${await response.text()}${JSON.stringify([...response.headers])}`;

    expect(response.status).toBe(400);
    expect(rendered).not.toContain(secret);
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not refresh idle for rejected JSON but does after an accepted mutation", async () => {
    const clock = new MutableClock(10_000);
    const handle = await startMutationServer(() => ({ statusCode: 204 }), {
      clock,
      idleTimeoutMs: 100,
    });
    const session = await exchange(handle);
    clock.advance(90);

    const rejected = await mutate(handle, session, "not-json");
    expect(rejected.status).toBe(400);
    expect(handle.status()).toEqual({ state: "active", idleDeadlineMs: 10_100 });

    const accepted = await mutate(handle, session, "{}");
    expect(accepted.status).toBe(204);
    expect(handle.status()).toEqual({ state: "active", idleDeadlineMs: 10_190 });
  });

  it("locks a mutation whose body finishes after its authorized session expires", async () => {
    const clock = new MutableClock(10_000);
    let signalAuthorized: (() => void) | undefined;
    const authorized = new Promise<void>((resolve) => {
      signalAuthorized = resolve;
    });
    const observed = observedMutationPolicy(() => signalAuthorized?.());
    const handler = vi.fn(() => ({ statusCode: 204 }));
    const handle = await startMutationServer(handler, {
      clock,
      idleTimeoutMs: 60_000,
      securityPolicy: observed.policy,
    });
    const session = await exchange(handle);
    const headers = authenticatedHeaders(handle, session, [
      "Content-Type: application/json",
      "Content-Length: 2",
    ]);
    const pending = await openRawRequest(
      handle,
      `POST /api/mutations HTTP/1.1\r\n${headers}\r\n\r\n{`,
    );
    await authorized;

    clock.advance(60_000);
    pending.socket.end("}");
    const response = await pending.response;

    expect(response).toContain(" 423 ");
    expect(response).toContain("Locked\n");
    expect(handler).not.toHaveBeenCalled();
    expect(observed.invalidate).toHaveBeenCalledOnce();
    expect(handle.status()).toEqual({ state: "locked" });

    clock.advance(-60_000);
    const replay = await mutate(handle, session, "{}");
    expect(replay.status).toBe(423);
    expect(handler).not.toHaveBeenCalled();
    expect(observed.invalidate).toHaveBeenCalledOnce();
  });

  it("prefers a fixed locked response when body rejection and expiry coincide", async () => {
    const clock = new MutableClock(20_000);
    const secret = "secret-never-reflect-after-expiry";
    const body = JSON.stringify({ secret });
    const observed = observedMutationPolicy(() => {
      clock.advance(60_000);
    });
    const handler = vi.fn(() => ({ statusCode: 204 }));
    const handle = await startMutationServer(handler, {
      clock,
      idleTimeoutMs: 60_000,
      maxBodyBytes: 8,
      securityPolicy: observed.policy,
    });
    const session = await exchange(handle);
    const headers = [
      `Host: ${new URL(handle.baseUrl).host}`,
      `Cookie: ${session.cookie}`,
      `Origin: ${handle.baseUrl}`,
      `X-CSRF-Token: ${session.csrf}`,
      "Content-Type: application/json",
      `Content-Length: ${String(Buffer.byteLength(body))}`,
    ].join("\r\n");

    const pending = await openRawRequest(
      handle,
      `POST /api/mutations HTTP/1.1\r\n${headers}\r\n\r\n${body}`,
    );
    const response = await pending.response;

    expect(response).toContain(" 423 ");
    expect(response.toLowerCase()).toContain("connection: close");
    expect(response.match(/HTTP\/1\.1/gu)).toHaveLength(1);
    expect(response).not.toContain(secret);
    expect(handler).not.toHaveBeenCalled();
    expect(observed.invalidate).toHaveBeenCalledOnce();
    expect(handle.status()).toEqual({ state: "locked" });
  });

  it("fails closed when the server closes while an authorized body is being read", async () => {
    let signalAuthorized: (() => void) | undefined;
    const authorized = new Promise<void>((resolve) => {
      signalAuthorized = resolve;
    });
    const observed = observedMutationPolicy(() => signalAuthorized?.());
    const handler = vi.fn(() => ({ statusCode: 204 }));
    const handle = await startMutationServer(handler, { securityPolicy: observed.policy });
    const session = await exchange(handle);
    const headers = authenticatedHeaders(handle, session, [
      "Content-Type: application/json",
      "Content-Length: 2",
    ]);
    const pending = await openRawRequest(
      handle,
      `POST /api/mutations HTTP/1.1\r\n${headers}\r\n\r\n{`,
    );
    await authorized;

    const closing = handle.close();
    pending.socket.end("}");
    const response = await pending.response;
    await closing;

    expect(response).toContain(" 503 ");
    expect(response).toContain("Service Unavailable\n");
    expect(handler).not.toHaveBeenCalled();
    expect(observed.invalidate).toHaveBeenCalledOnce();
    expect(handle.status()).toEqual({ state: "closed" });
  });

  it("fails closed when the clock becomes invalid while an authorized body is being read", async () => {
    const clock = new MutableClock(30_000);
    let signalAuthorized: (() => void) | undefined;
    const authorized = new Promise<void>((resolve) => {
      signalAuthorized = resolve;
    });
    const observed = observedMutationPolicy(() => signalAuthorized?.());
    const handler = vi.fn(() => ({ statusCode: 204 }));
    const handle = await startMutationServer(handler, {
      clock,
      idleTimeoutMs: 60_000,
      securityPolicy: observed.policy,
    });
    const session = await exchange(handle);
    const headers = authenticatedHeaders(handle, session, [
      "Content-Type: application/json",
      "Content-Length: 2",
    ]);
    const pending = await openRawRequest(
      handle,
      `POST /api/mutations HTTP/1.1\r\n${headers}\r\n\r\n{`,
    );
    await authorized;

    clock.makeInvalid();
    pending.socket.end("}");
    const response = await pending.response;

    expect(response).toContain(" 423 ");
    expect(response).toContain("Locked\n");
    expect(handler).not.toHaveBeenCalled();
    expect(observed.invalidate).toHaveBeenCalledOnce();
    expect(handle.status()).toEqual({ state: "locked" });
  });

  it("does not invoke the handler when the client interrupts a declared body", async () => {
    const handler = vi.fn(() => ({ statusCode: 200 }));
    const handle = await startMutationServer(handler);
    const session = await exchange(handle);
    const url = new URL(handle.baseUrl);
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const common = authenticatedHeaders(handle, session, [
      "Content-Type: application/json",
      "Content-Length: 20",
    ]);
    socket.write(`POST /api/mutations HTTP/1.1\r\n${common}\r\n\r\n{"a":`);
    socket.destroy();
    await vi.waitFor(() => {
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
