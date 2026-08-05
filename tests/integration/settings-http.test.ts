import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createSettingsUiHandler,
  createSettingsSecretSafeJsonResponse,
  createSettingsUseCase,
  createUiSecurityPolicy,
  FileSettingsStore,
  startLocalUiServer,
  type LocalUiServerHandle,
} from "../../src/ui/index.js";

const handles: LocalUiServerHandle[] = [];
const directories: string[] = [];

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
