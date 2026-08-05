import { afterEach, describe, expect, it, vi } from "vitest";

import { parseInstant, type Instant } from "../../src/domain/foundation/index.js";
import {
  createQuotaUiFeature,
  quotaUiSecurityRoutes,
  QuotaDashboardUseCase,
  type QuotaDashboardPort,
  type QuotaProviderRecord,
} from "../../src/ui/features/quota/index.js";
import {
  createUiShellHandler,
  createUiSecurityPolicy,
  fixtureUiShellReadModel,
  startLocalUiServer,
  type LocalUiServerHandle,
  type UiServerClock,
} from "../../src/ui/index.js";

function instant(value: string): Instant {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

class RecordingQuotaPort implements QuotaDashboardPort {
  readonly invalidated: string[] = [];
  readonly refreshed: string[] = [];
  readonly resumed: string[] = [];

  constructor(readonly providers: readonly QuotaProviderRecord[] = []) {}

  listProviders = vi.fn(() => Promise.resolve(this.providers));
  invalidateSnapshot = vi.fn((provider: string) => {
    this.invalidated.push(provider);
    return Promise.resolve();
  });
  refreshSample = vi.fn((provider: string) => {
    this.refreshed.push(provider);
    return Promise.resolve({ state: "accepted" as const, reason: "refresh_started" });
  });
  resumeDispatch = vi.fn((provider: string) => {
    this.resumed.push(provider);
    return Promise.resolve({ state: "accepted" as const, reason: "manual_review_recorded" });
  });
}

class MutableClock implements UiServerClock {
  constructor(private value: number) {}

  now(): number {
    return this.value;
  }

  advance(milliseconds: number): void {
    this.value += milliseconds;
  }
}

const handles: LocalUiServerHandle[] = [];

function useCase(port: QuotaDashboardPort): QuotaDashboardUseCase {
  return new QuotaDashboardUseCase(port, {
    now: () => instant("2026-08-04T12:05:00.000Z"),
    maxSampleAgeMs: 15 * 60 * 1_000,
    expectedCliVersions: { codex: "0.146.0", claude: "2.1.221", gemini: "0.52.0" },
  });
}

async function start(
  port: RecordingQuotaPort,
  options: Readonly<{ clock?: UiServerClock; idleTimeoutMs?: number }> = {},
): Promise<LocalUiServerHandle> {
  const feature = createQuotaUiFeature(useCase(port));
  const handle = await startLocalUiServer({
    ...options,
    securityPolicy: createUiSecurityPolicy({ routes: quotaUiSecurityRoutes }),
    handler: async (request) =>
      (await feature.handle(request)) ?? { statusCode: 404, body: "Not Found\n" },
  });
  handles.push(handle);
  return handle;
}

async function session(handle: LocalUiServerHandle): Promise<{
  readonly cookie: string;
  readonly csrf: string;
}> {
  const response = await fetch(`${handle.baseUrl}/__session/exchange`, {
    method: "POST",
    headers: { authorization: `Bearer ${handle.sessionToken}` },
  });
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  const csrf = response.headers.get("x-csrf-token");
  if (cookie === undefined || csrf === null) throw new Error("Session exchange failed.");
  return { cookie, csrf };
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map(async (handle) => handle.close()));
});

describe("quota UI secured mutations", () => {
  it("declares exact read and POST-only mutation methods for every feature route", () => {
    expect(quotaUiSecurityRoutes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/api/quota/refresh",
          allowedMethods: ["POST"],
          mutationBody: "bounded-json",
        }),
        expect.objectContaining({
          path: "/api/quota/resume",
          allowedMethods: ["POST"],
          mutationBody: "bounded-json",
        }),
      ]),
    );
    expect(
      quotaUiSecurityRoutes
        .filter((route) => !route.path.startsWith("/api/"))
        .every((route) => route.allowedMethods?.join(",") === "GET"),
    ).toBe(true);
  });

  it("rejects missing Session, Origin, or CSRF before either action reaches the port", async () => {
    const port = new RecordingQuotaPort();
    const handle = await start(port);
    const authenticated = await session(handle);
    const body = JSON.stringify({ provider: "codex" });
    const common = {
      "content-length": String(Buffer.byteLength(body)),
      "content-type": "application/json",
    };

    const responses = [
      await fetch(`${handle.baseUrl}/api/quota/refresh`, { method: "POST", headers: common, body }),
      await fetch(`${handle.baseUrl}/api/quota/refresh`, {
        method: "POST",
        headers: { ...common, cookie: authenticated.cookie },
        body,
      }),
      await fetch(`${handle.baseUrl}/api/quota/resume`, {
        method: "POST",
        headers: {
          ...common,
          cookie: authenticated.cookie,
          origin: handle.baseUrl,
          "x-csrf-token": "wrong",
        },
        body,
      }),
    ];

    expect(responses.map((response) => response.status)).toEqual([401, 403, 403]);
    expect(port.refreshed).toEqual([]);
    expect(port.resumed).toEqual([]);
  });

  it("executes refresh and resume independently with explicit POST and safe read-back", async () => {
    const port = new RecordingQuotaPort();
    const handle = await start(port);
    const authenticated = await session(handle);
    const headers = {
      cookie: authenticated.cookie,
      origin: handle.baseUrl,
      "x-csrf-token": authenticated.csrf,
      "content-type": "application/json",
    };

    const refresh = await fetch(`${handle.baseUrl}/api/quota/refresh`, {
      method: "POST",
      headers,
      body: JSON.stringify({ provider: "codex" }),
    });
    expect(refresh.status).toBe(200);
    await expect(refresh.json()).resolves.toEqual({
      action: "refresh_sample",
      provider: "codex",
      state: "accepted",
      reason: "refresh_started",
    });
    expect(port.refreshed).toEqual(["codex"]);
    expect(port.resumed).toEqual([]);

    const resume = await fetch(`${handle.baseUrl}/api/quota/resume`, {
      method: "POST",
      headers,
      body: JSON.stringify({ provider: "claude" }),
    });
    expect(resume.status).toBe(200);
    await expect(resume.json()).resolves.toEqual({
      action: "resume_dispatch",
      provider: "claude",
      state: "accepted",
      reason: "manual_review_recorded",
    });
    expect(port.refreshed).toEqual(["codex"]);
    expect(port.resumed).toEqual(["claude"]);
  });

  it.each(["PUT", "PATCH", "DELETE"])(
    "rejects a bodyless %s before mutation and without refreshing idle",
    async (method) => {
      const clock = new MutableClock(10_000);
      const port = new RecordingQuotaPort();
      const handle = await start(port, { clock, idleTimeoutMs: 100 });
      const authenticated = await session(handle);
      clock.advance(90);

      const response = await fetch(`${handle.baseUrl}/api/quota/refresh`, {
        method,
        headers: {
          cookie: authenticated.cookie,
          origin: handle.baseUrl,
          "x-csrf-token": authenticated.csrf,
        },
      });

      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
      expect(await response.text()).toBe("Method Not Allowed\n");
      expect(port.invalidated).toEqual([]);
      expect(port.refreshed).toEqual([]);
      expect(port.resumed).toEqual([]);
      expect(handle.status()).toEqual({ state: "active", idleDeadlineMs: 10_100 });
      clock.advance(11);
      expect(handle.status()).toEqual({ state: "locked" });
    },
  );

  it("rejects any body beyond the exact provider command", async () => {
    const port = new RecordingQuotaPort();
    const handle = await start(port);
    const authenticated = await session(handle);
    const headers = {
      cookie: authenticated.cookie,
      origin: handle.baseUrl,
      "x-csrf-token": authenticated.csrf,
      "content-type": "application/json",
    };

    const extraField = await fetch(`${handle.baseUrl}/api/quota/resume`, {
      method: "POST",
      headers,
      body: JSON.stringify({ provider: "claude", rawProviderOutput: "must-not-pass" }),
    });
    expect(extraField.status).toBe(400);
    expect(await extraField.text()).not.toContain("must-not-pass");
    expect(port.invalidated).toEqual([]);
    expect(port.refreshed).toEqual([]);
    expect(port.resumed).toEqual([]);
  });

  it("keeps GET rendering free of account-switch invalidation side effects", async () => {
    const port = new RecordingQuotaPort([
      {
        provider: "gemini",
        activeIdentity: { provider: "gemini", accountFingerprint: "gemini-new-account-002" },
        snapshot: {
          provider: "gemini",
          accountFingerprint: "gemini-old-account-001",
          samples: [],
        },
      },
    ]);
    const feature = createQuotaUiFeature(useCase(port));

    expect(await feature.render()).toContain("偵測到帳號切換");
    expect(port.invalidated).toEqual([]);
    expect(port.refreshed).toEqual([]);
    expect(port.resumed).toEqual([]);
  });

  it("mounts the quota read model and local client in the authenticated shell", async () => {
    const port = new RecordingQuotaPort([
      {
        provider: "gemini",
        activeIdentity: { provider: "gemini", accountFingerprint: "gemini-new-account-002" },
        snapshot: {
          provider: "gemini",
          accountFingerprint: "gemini-old-account-001",
          samples: [],
        },
      },
    ]);
    const feature = createQuotaUiFeature(useCase(port));
    const handle = await startLocalUiServer({
      securityPolicy: createUiSecurityPolicy({ routes: quotaUiSecurityRoutes }),
      handler: createUiShellHandler(fixtureUiShellReadModel, { quota: feature }),
    });
    handles.push(handle);
    const authenticated = await session(handle);
    const page = await fetch(`${handle.baseUrl}/quota`, {
      headers: { cookie: authenticated.cookie },
    });
    const style = await fetch(`${handle.baseUrl}/assets/ui-shell.css`, {
      headers: { cookie: authenticated.cookie },
    });
    const html = await page.text();

    expect(page.status).toBe(200);
    expect(html).toContain("<title>額度｜Agent Team</title>");
    expect(html).toContain('src="/assets/quota.js"');
    expect(html).toContain('href="/quota" aria-current="page"');
    expect(html).toContain("偵測到帳號切換");
    expect(style.status).toBe(200);
    expect(style.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(html).not.toContain("gemini-new-account-002");
    expect(html).not.toContain("gemini-old-account-001");
    expect(port.invalidated).toEqual([]);
    expect(port.refreshed).toEqual([]);
    expect(port.resumed).toEqual([]);
  });
});
