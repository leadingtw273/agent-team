import { afterEach, describe, expect, it } from "vitest";

import {
  createRoleModelFeature,
  defaultRoleModelRoutingConfig,
  handleRoleModelTypedApiRequest,
} from "../../src/ui/features/role-model/index.js";
import {
  createUiShellHandler,
  startLocalUiServer,
  type LocalUiServerHandle,
} from "../../src/ui/index.js";

const handles: LocalUiServerHandle[] = [];

async function start(): Promise<LocalUiServerHandle> {
  const feature = createRoleModelFeature();
  const handle = await startLocalUiServer({ handler: createUiShellHandler(undefined, feature) });
  handles.push(handle);
  return handle;
}

async function request(
  handle: LocalUiServerHandle,
  path: string,
): Promise<Readonly<{ status: number; body: string }>> {
  const response = await fetch(`${handle.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${handle.sessionToken}` },
  });
  return Object.freeze({ status: response.status, body: await response.text() });
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map(async (handle) => handle.close()));
});

describe("role model page integration", () => {
  it("renders a completed role and model page in the U003 shell without requesting inline CLI", async () => {
    const handle = await start();

    const page = await request(handle, "/roles-models");

    expect(page.status).toBe(200);
    expect(page.body).toContain("<title>角色與模型｜Agent Team</title>");
    expect(page.body).toContain("<h1>角色與模型</h1>");
    expect(page.body).toContain('href="/roles-models" aria-current="page"');
    expect(page.body).toContain("團隊管理者");
    expect(page.body).toContain("開發工程師");
    expect(page.body).toContain("代碼審查者");
    expect(page.body).toContain("視覺審查者");
    expect(page.body).toContain("整合工程師");
    expect(page.body).toContain("Codex");
    expect(page.body).toContain("gpt-5.6-terra");
    expect(page.body).toContain("可用能力");
    expect(page.body).toContain("執行中的工作不會因為這次儲存而切換模型。");
    expect(page.body).not.toMatch(/(?:--model|--provider|inline cli|行內 CLI)/iu);
    expect(page.body).not.toContain('name="model-command"');
  });

  it("keeps the page state backed by the same typed configuration that the use case saves", async () => {
    const feature = createRoleModelFeature();
    const initial = defaultRoleModelRoutingConfig();
    const reordered = {
      ...initial,
      routes: initial.routes.map((route) =>
        route.role === "implementer"
          ? { ...route, candidates: [...route.candidates].reverse() }
          : route,
      ),
    };

    const saved = await handleRoleModelTypedApiRequest(feature, {
      method: "PUT",
      input: reordered,
    });
    const rendered = await feature.render();

    expect(saved.statusCode).toBe(200);
    expect(rendered).toContain('data-role="implementer"');
    const implementerStart = rendered.indexOf('data-role="implementer"');
    const implementerEnd = rendered.indexOf("</article>", implementerStart);
    const implementerCard = rendered.slice(implementerStart, implementerEnd);
    expect(implementerCard.indexOf("Claude")).toBeLessThan(
      implementerCard.indexOf("gpt-5.6-terra"),
    );

    const rejected = await handleRoleModelTypedApiRequest(feature, {
      method: "PUT",
      input: { schemaVersion: 1, routes: [] },
    });
    const readBack = await handleRoleModelTypedApiRequest(feature, { method: "GET" });
    expect(rejected).toEqual({ statusCode: 422, body: { error: "invalid_input" } });
    expect(readBack.statusCode).toBe(200);
    if (readBack.statusCode !== 200) return;
    const implementer = readBack.body.config.routes.find((route) => route.role === "implementer");
    expect(implementer?.candidates[0]).toEqual({ provider: "claude", model: "sonnet" });
  });
});
