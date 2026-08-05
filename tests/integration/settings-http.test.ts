import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSettingsUiHandler,
  createSettingsSecretSafeJsonResponse,
  createSettingsUseCase,
  createUiSecurityPolicy,
  FileSettingsStore,
  startLocalUiServer,
  type LocalUiServerHandle,
  type UiServerClock,
} from "../../src/ui/index.js";

const handles: LocalUiServerHandle[] = [];
const directories: string[] = [];

class MutableClock implements UiServerClock {
  constructor(private value: number) {}

  now(): number {
    return this.value;
  }

  advance(milliseconds: number): void {
    this.value += milliseconds;
  }
}

function openIncompleteRequest(
  handle: LocalUiServerHandle,
  bytes: string,
): Promise<Readonly<{ response: Promise<string> }>> {
  const url = new URL(handle.baseUrl);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    const response = new Promise<string>((resolveResponse, rejectResponse) => {
      socket.setTimeout(2_000, () => {
        socket.destroy(new Error("raw request timed out"));
      });
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("error", rejectResponse);
      socket.on("close", () => {
        resolveResponse(Buffer.concat(chunks).toString("utf8"));
      });
    });
    socket.once("connect", () => {
      socket.write(bytes);
      resolve(Object.freeze({ response }));
    });
    socket.once("error", reject);
  });
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "settings-http-"));
  directories.push(directory);
  await mkdir(join(directory, "config"));
  const path = join(directory, "config", "settings.yaml");
  const useCase = createSettingsUseCase(new FileSettingsStore(path));
  const handle = await startLocalUiServer({
    securityPolicy: createUiSecurityPolicy(),
    handler: createSettingsUiHandler(useCase),
  });
  handles.push(handle);
  const exchanged = await fetch(`${handle.baseUrl}/__session/exchange`, {
    method: "POST",
    headers: { authorization: `Bearer ${handle.sessionToken}` },
  });
  const cookie = exchanged.headers.get("set-cookie")?.split(";", 1)[0];
  const csrf = exchanged.headers.get("x-csrf-token");
  if (cookie === undefined || csrf === null) throw new Error("session exchange failed");
  return { handle, path, cookie, csrf };
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("U008 settings HTTP route", () => {
  it("declares every default page, asset, and projects route as GET with implicit HEAD", async () => {
    const handler = vi.fn(() => ({ statusCode: 204 }));
    const handle = await startLocalUiServer({
      securityPolicy: createUiSecurityPolicy(),
      handler,
    });
    handles.push(handle);
    const exchanged = await fetch(`${handle.baseUrl}/__session/exchange`, {
      method: "POST",
      headers: { authorization: `Bearer ${handle.sessionToken}` },
    });
    const cookie = exchanged.headers.get("set-cookie")?.split(";", 1)[0];
    const csrf = exchanged.headers.get("x-csrf-token");
    if (cookie === undefined || csrf === null) throw new Error("session exchange failed");

    const readRoutes = [
      "/assets/icons.svg",
      "/assets/tabler-1.4.0.min.css",
      "/assets/ui-shell.css",
      "/settings",
      "/assets/settings.js",
      "/api/projects",
    ];
    for (const path of readRoutes) {
      for (const method of ["GET", "HEAD"]) {
        const allowed = await fetch(`${handle.baseUrl}${path}`, {
          method,
          headers: { cookie },
        });
        expect(allowed.status).toBe(204);
      }
      const rejected = await fetch(`${handle.baseUrl}${path}`, {
        method: "POST",
        headers: {
          cookie,
          origin: handle.baseUrl,
          "x-csrf-token": csrf,
        },
      });
      expect(rejected.status).toBe(405);
      expect(rejected.headers.get("allow")).toBe("GET, HEAD");
    }
    expect(handler).toHaveBeenCalledTimes(readRoutes.length * 2);
  });

  it("rejects disallowed settings methods before body, handler, or idle refresh", async () => {
    const directory = await mkdtemp(join(tmpdir(), "settings-methods-"));
    directories.push(directory);
    await mkdir(join(directory, "config"));
    const clock = new MutableClock(10_000);
    const featureHandler = createSettingsUiHandler(
      createSettingsUseCase(new FileSettingsStore(join(directory, "config", "settings.yaml"))),
    );
    const handler = vi.fn(featureHandler);
    const handle = await startLocalUiServer({
      clock,
      idleTimeoutMs: 100,
      securityPolicy: createUiSecurityPolicy(),
      handler,
    });
    handles.push(handle);
    const exchanged = await fetch(`${handle.baseUrl}/__session/exchange`, {
      method: "POST",
      headers: { authorization: `Bearer ${handle.sessionToken}` },
    });
    const cookie = exchanged.headers.get("set-cookie")?.split(";", 1)[0];
    const csrf = exchanged.headers.get("x-csrf-token");
    if (cookie === undefined || csrf === null) throw new Error("session exchange failed");
    clock.advance(90);

    for (const method of ["POST", "DELETE"]) {
      const rejected = await fetch(`${handle.baseUrl}/api/settings`, {
        method,
        headers: {
          cookie,
          origin: handle.baseUrl,
          "x-csrf-token": csrf,
        },
      });
      expect(rejected.status).toBe(405);
      expect(rejected.headers.get("allow")).toBe("GET, HEAD, PUT");
    }
    const rawHeaders = [
      `Host: ${new URL(handle.baseUrl).host}`,
      `Cookie: ${cookie}`,
      `Origin: ${handle.baseUrl}`,
      `X-CSRF-Token: ${csrf}`,
      "Content-Type: application/json",
      "Content-Length: 2",
      "Connection: close",
      "",
      "{",
    ].join("\r\n");
    const incomplete = await openIncompleteRequest(
      handle,
      `PATCH /api/settings HTTP/1.1\r\n${rawHeaders}`,
    );
    const rawResponse = await incomplete.response;
    expect(rawResponse).toContain(" 405 ");
    expect(rawResponse).toMatch(/allow: GET, HEAD, PUT/iu);

    expect(handler).not.toHaveBeenCalled();
    expect(handle.status()).toEqual({ state: "active", idleDeadlineMs: 10_100 });
    clock.advance(11);
    const expired = await fetch(`${handle.baseUrl}/api/settings`, { headers: { cookie } });
    expect(expired.status).toBe(423);
  });

  it("cannot brand arbitrary or credential-bearing JSON as a settings response", async () => {
    const exported = await import("../../src/ui/index.js");
    expect(exported).not.toHaveProperty("createCredentialFreeJsonResponse");
    for (const key of ["authorization", "password", "token", "secret", "cookie", "extra"]) {
      expect(() =>
        createSettingsSecretSafeJsonResponse(200, {
          state: "ready",
          source: "defaults",
          revision: null,
          webhookRuntimeBaseUrl: null,
          concurrency: {
            globalModelJobs: 2,
            perProviderModelJobs: { codex: 1, claude: 1, gemini: 1 },
            perProjectModelJobs: 2,
            perRepositoryIntegrationJobs: 1,
          },
          rawYaml: "schemaVersion: 1\n",
          [key]: "review-payload",
        }),
      ).toThrow("Invalid settings response projection");
    }
    expect(() =>
      createSettingsSecretSafeJsonResponse(200, {
        state: "ready",
        source: "defaults",
        revision: null,
        webhookRuntimeBaseUrl: null,
        concurrency: {
          globalModelJobs: 2,
          perProviderModelJobs: { codex: 1, claude: 1, gemini: 1 },
          perProjectModelJobs: 2,
          perRepositoryIntegrationJobs: 1,
        },
        rawYaml: "github_pat_abcdefghijklmnopqrstuvwxyz\n",
      }),
    ).toThrow("Unsafe secret-safe JSON response");
  });

  it("uses GET and PUT with session, Origin, CSRF, CAS, and safe fixed errors", async () => {
    const { handle, path, cookie, csrf } = await fixture();
    const headers = { cookie };
    const initial = await fetch(`${handle.baseUrl}/api/settings`, { headers });
    const initialBody = (await initial.json()) as { revision: string | null; rawYaml: string };
    expect(initial.status).toBe(200);
    expect(initialBody.revision).toBeNull();

    const nextYaml = initialBody.rawYaml.replace("globalModelJobs: 2", "globalModelJobs: 3");
    const mutate = (revision: string | null, rawYaml: string) =>
      fetch(`${handle.baseUrl}/api/settings`, {
        method: "PUT",
        headers: {
          cookie,
          origin: handle.baseUrl,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify({ expectedRevision: revision, rawYaml }),
      });
    const saved = await mutate(null, nextYaml);
    const savedBody = (await saved.json()) as { revision: string; rawYaml: string };
    expect(saved.status).toBe(200);
    expect(savedBody.revision).toMatch(/^[a-f0-9]{64}$/u);
    expect(await readFile(path, "utf8")).toBe(nextYaml);

    const stale = await mutate(null, initialBody.rawYaml);
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({ state: "error", code: "conflict" });
    const invalid = await mutate(savedBody.revision, "schemaVersion: nope\n");
    expect(invalid.status).toBe(422);
    await expect(invalid.json()).resolves.toEqual({ state: "error", code: "invalid_settings" });
    expect(await readFile(path, "utf8")).toBe(nextYaml);

    for (const method of ["POST", "PATCH", "DELETE"]) {
      const response = await fetch(`${handle.baseUrl}/api/settings`, {
        method,
        headers: {
          cookie,
          origin: handle.baseUrl,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(response.status).toBe(405);
    }
    const page = await fetch(`${handle.baseUrl}/settings`, { headers });
    const html = await page.text();
    expect(html).toContain("編輯 Raw YAML");
    expect(html).toContain("readonly");
    expect(html).toContain("/assets/settings.js");
  });
});
