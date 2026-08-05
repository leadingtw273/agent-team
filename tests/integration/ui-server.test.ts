import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LocalUiServerError,
  startLocalUiServer,
  type LocalUiServerHandle,
  type UiRequest,
  type UiServerClock,
} from "../../src/ui/index.js";

const handles: LocalUiServerHandle[] = [];
const occupiedServers: Server[] = [];

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

async function start(
  options: Parameters<typeof startLocalUiServer>[0] = {},
): Promise<LocalUiServerHandle> {
  const handle = await startLocalUiServer(options);
  handles.push(handle);
  return handle;
}

async function request(
  handle: LocalUiServerHandle,
  token?: string,
): Promise<{ readonly status: number; readonly body: string }> {
  const response = await fetch(`${handle.baseUrl}/probe?value=1`, {
    method: "POST",
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: await response.text() };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map(async (handle) => handle.close()));
  await Promise.all(occupiedServers.splice(0).map(closeServer));
  vi.restoreAllMocks();
});

describe("localhost UI server", () => {
  it("binds real 127.0.0.1 ephemeral HTTP and delegates authenticated routing", async () => {
    const received: UiRequest[] = [];
    const handler = vi.fn((input: UiRequest) => {
      received.push(input);
      return { statusCode: 201, body: "accepted" };
    });
    const handle = await start({ handler });

    expect(new URL(handle.baseUrl).hostname).toBe("127.0.0.1");
    expect(Number(new URL(handle.baseUrl).port)).toBeGreaterThan(0);
    await expect(request(handle)).resolves.toEqual({ status: 401, body: "Unauthorized\n" });
    await expect(request(handle, "wrong-token")).resolves.toEqual({
      status: 401,
      body: "Unauthorized\n",
    });
    await expect(request(handle, handle.sessionToken)).resolves.toEqual({
      status: 201,
      body: "accepted",
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ method: "POST", url: "/probe?value=1" }),
    );
    expect(received[0]?.headers.authorization).toBeUndefined();
  });

  it.each(["0.0.0.0", "localhost", "::1"])(
    "rejects non-exact loopback host %s before session initialization",
    async (host) => {
      const tokenSource = vi.fn(() => new Uint8Array(32));

      await expect(startLocalUiServer({ host, tokenSource })).rejects.toThrow(
        "Local UI server must bind to 127.0.0.1.",
      );
      expect(tokenSource).not.toHaveBeenCalled();
    },
  );

  it.each([0, -1, 1.5])(
    "rejects invalid idle timeout %s before listening",
    async (idleTimeoutMs) => {
      const tokenSource = vi.fn(() => new Uint8Array(32));

      await expect(startLocalUiServer({ idleTimeoutMs, tokenSource })).rejects.toThrow(
        "Local UI server idle timeout is invalid.",
      );
      expect(tokenSource).not.toHaveBeenCalled();
    },
  );

  it("uses a fresh 256-bit base64url token for every start and invalidates the old token", async () => {
    const first = await start({ handler: () => ({ statusCode: 200, body: "first" }) });
    expect(first.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    await first.close();

    const second = await start({ handler: () => ({ statusCode: 200, body: "second" }) });
    expect(second.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(second.sessionToken).not.toBe(first.sessionToken);
    await expect(request(second, first.sessionToken)).resolves.toEqual({
      status: 401,
      body: "Unauthorized\n",
    });
    await expect(request(second, second.sessionToken)).resolves.toEqual({
      status: 200,
      body: "second",
    });
  });

  it("does not let missing or invalid authentication refresh the idle deadline", async () => {
    const clock = new MutableClock(1_000);
    const handler = vi.fn(() => ({ statusCode: 200, body: "ok" }));
    const handle = await start({ clock, idleTimeoutMs: 100, handler });

    clock.advance(90);
    await expect(request(handle, "invalid")).resolves.toMatchObject({ status: 401 });
    clock.advance(11);
    await expect(request(handle, handle.sessionToken)).resolves.toEqual({
      status: 423,
      body: "Locked\n",
    });
    expect(handle.status()).toEqual({ state: "locked" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("refreshes idle time only after authentication and remains permanently locked", async () => {
    const clock = new MutableClock(5_000);
    const handle = await start({
      clock,
      idleTimeoutMs: 100,
      handler: () => ({ statusCode: 200, body: "ok" }),
    });

    clock.advance(90);
    await expect(request(handle, handle.sessionToken)).resolves.toMatchObject({ status: 200 });
    expect(handle.status()).toEqual({ state: "active", idleDeadlineMs: 5_190 });
    clock.advance(101);
    await expect(request(handle, handle.sessionToken)).resolves.toMatchObject({ status: 423 });
    clock.advance(-1_000);
    await expect(request(handle, handle.sessionToken)).resolves.toMatchObject({ status: 423 });
  });

  it("contains handler failures and refuses to reflect the session token", async () => {
    let leakedBody = false;
    let tokenToLeak = "";
    const handle = await start({
      handler: () => {
        if (!leakedBody) {
          leakedBody = true;
          throw new Error("sensitive handler details");
        }
        return { statusCode: 200, body: tokenToLeak };
      },
    });
    tokenToLeak = handle.sessionToken;

    const failed = await request(handle, handle.sessionToken);
    const reflected = await request(handle, handle.sessionToken);
    expect(failed).toEqual({ status: 500, body: "Internal Server Error\n" });
    expect(reflected).toEqual({ status: 500, body: "Internal Server Error\n" });
    expect(`${failed.body}${reflected.body}`).not.toContain(handle.sessionToken);
  });

  it("maps listen failures safely without returning or logging the token", async () => {
    const occupied = createServer();
    occupiedServers.push(occupied);
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
    const address = occupied.address();
    if (address === null || typeof address === "string") throw new Error("missing address");
    const secretTokenBytes = new Uint8Array(32).fill(7);
    const secretToken = Buffer.from(secretTokenBytes).toString("base64url");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    let caught: unknown;
    try {
      await startLocalUiServer({ port: address.port, tokenSource: () => secretTokenBytes });
    } catch (failure) {
      caught = failure;
    }

    expect(caught).toBeInstanceOf(LocalUiServerError);
    expect(String(caught)).not.toContain(secretToken);
    expect(
      `${JSON.stringify(log.mock.calls)}${JSON.stringify(warn.mock.calls)}${JSON.stringify(error.mock.calls)}`,
    ).not.toContain(secretToken);
  });

  it("rejects short injected token material without exposing it", async () => {
    await expect(
      startLocalUiServer({ tokenSource: () => Buffer.from("too-short", "utf8") }),
    ).rejects.toThrow("Unable to initialize local UI session.");
  });

  it("closes idempotently and stops serving requests", async () => {
    const handle = await start({ handler: () => ({ statusCode: 200, body: "ok" }) });

    await Promise.all([handle.close(), handle.close(), handle.close()]);

    expect(handle.status()).toEqual({ state: "closed" });
    await expect(fetch(handle.baseUrl)).rejects.toThrow();
  });
});
