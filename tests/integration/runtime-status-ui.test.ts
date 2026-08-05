import { afterEach, describe, expect, it } from "vitest";

import {
  createDangerApprovalUseCase,
  createDangerUiFeatureRegistration,
  InMemoryDangerApprovalStore,
} from "../../src/ui/features/danger/index.js";
import { createQuotaUiFeature, QuotaDashboardUseCase } from "../../src/ui/features/quota/index.js";
import { createRoleModelFeature } from "../../src/ui/features/role-model/index.js";
import {
  createRuntimeStatusUiFeatureRegistration,
  fixtureRuntimeStatusReadModel,
  runtimeStatusCssPath,
  runtimeStatusPagePath,
  runtimeStatusUiSecurityRoutes,
} from "../../src/ui/features/runtime-status/index.js";
import {
  createSettingsUiFeatureRegistration,
  createSettingsUseCase,
  type SettingsStore,
} from "../../src/ui/features/settings/index.js";
import {
  createUiApplication,
  fixtureUiShellReadModel,
  startLocalUiServer,
  type LocalUiServerHandle,
} from "../../src/ui/index.js";
import { domainError, err, parseInstant } from "../../src/domain/foundation/index.js";

const handles: LocalUiServerHandle[] = [];

function quotaFeature() {
  const parsed = parseInstant("2026-08-05T12:00:00.000Z");
  if (!parsed.ok) throw new Error(parsed.error.code);
  return createQuotaUiFeature(
    new QuotaDashboardUseCase(
      {
        listProviders: () => Promise.resolve(Object.freeze([])),
        invalidateSnapshot: () => Promise.resolve(undefined),
        refreshSample: () =>
          Promise.resolve(Object.freeze({ state: "rejected" as const, reason: "unused" })),
        resumeDispatch: () =>
          Promise.resolve(Object.freeze({ state: "rejected" as const, reason: "unused" })),
      },
      {
        now: () => parsed.value,
        maxSampleAgeMs: 15 * 60 * 1_000,
        expectedCliVersions: Object.freeze({
          codex: "fixture",
          claude: "fixture",
          gemini: "fixture",
        }),
      },
    ),
  );
}

function dangerFeature() {
  return createDangerUiFeatureRegistration(
    createDangerApprovalUseCase(new InMemoryDangerApprovalStore()),
  );
}

function settingsFeature() {
  const store: SettingsStore = {
    read: () => Promise.resolve(err(domainError("not_found"))),
    save: () => Promise.resolve(Object.freeze({ state: "rejected" as const })),
  };
  return createSettingsUiFeatureRegistration(createSettingsUseCase(store));
}

function application() {
  return createUiApplication({
    readModel: fixtureUiShellReadModel,
    features: [createRuntimeStatusUiFeatureRegistration(fixtureRuntimeStatusReadModel)],
  });
}

async function start(): Promise<LocalUiServerHandle> {
  const ui = application();
  const handle = await startLocalUiServer({
    securityPolicy: ui.securityPolicy,
    handler: ui.handler,
  });
  handles.push(handle);
  return handle;
}

async function request(
  handle: LocalUiServerHandle,
  path: string,
  cookie: string,
  method: "GET" | "HEAD" | "POST" = "GET",
): Promise<Readonly<{ response: Response; body: string }>> {
  const response = await fetch(`${handle.baseUrl}${path}`, {
    method,
    headers: { cookie },
  });
  return Object.freeze({ response, body: await response.text() });
}

async function sessionCookie(handle: LocalUiServerHandle): Promise<string> {
  const response = await fetch(`${handle.baseUrl}/__session/exchange`, {
    method: "POST",
    headers: { authorization: `Bearer ${handle.sessionToken}` },
  });
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined || !response.ok) throw new Error("Session exchange failed.");
  return cookie;
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map(async (handle) => handle.close()));
});

describe("runtime status localhost UI", () => {
  it("registers content-only Runtime Status routes and assets as explicit read-only contracts", () => {
    const registration = createRuntimeStatusUiFeatureRegistration(fixtureRuntimeStatusReadModel);
    const ui = application();

    expect(registration).toMatchObject({ id: "runtime-status", slot: "running" });
    expect(registration.page).toMatchObject({
      path: runtimeStatusPagePath,
      styles: [runtimeStatusCssPath],
    });
    expect(registration.page.scripts).toBeUndefined();
    expect(registration.routes.map((route) => route.contract.path)).toEqual([runtimeStatusCssPath]);
    expect(ui.routeContracts).toEqual(runtimeStatusUiSecurityRoutes);
    expect(
      ui.routeContracts
        .filter(
          (route) => route.path === runtimeStatusPagePath || route.path === runtimeStatusCssPath,
        )
        .every((route) => route.allowedMethods?.join(",") === "GET"),
    ).toBe(true);
  });

  it("serves the four blocker fixtures inside one shell without feature scripts", async () => {
    const handle = await start();
    const { response, body } = await request(
      handle,
      runtimeStatusPagePath,
      await sessionCookie(handle),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(body).toContain("<title>執行中｜Agent Team</title>");
    expect(body).toContain('href="/assets/runtime-status.css"');
    expect(body).toContain('<a class="ui-nav-link" href="/runtime-status" aria-current="page">');
    expect(body.match(/<html\b/gu)).toHaveLength(1);
    expect(body.match(/class="ui-app"/gu)).toHaveLength(1);
    expect(body).toContain("Process 異常結束");
    expect(body).toContain("週額度不足");
    expect(body).toContain("5 小時額度限制");
    expect(body).toContain("等待危險操作核可");
    expect(body).toContain("未知錯誤");
    expect(body).toContain("不顯示完整命令、Secret 或模型隱藏推理");
    expect(body).not.toContain("<script");
  });

  it("keeps Runtime Status pages and assets GET/HEAD-only while isolating its CSS", async () => {
    const handle = await start();
    const cookie = await sessionCookie(handle);

    const [style, shellStyle, head, pagePost, assetPost] = await Promise.all([
      request(handle, runtimeStatusCssPath, cookie),
      request(handle, "/assets/ui-shell.css", cookie),
      request(handle, runtimeStatusCssPath, cookie, "HEAD"),
      request(handle, runtimeStatusPagePath, cookie, "POST"),
      request(handle, runtimeStatusCssPath, cookie, "POST"),
    ]);

    expect(style.response.status).toBe(200);
    expect(style.response.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(style.body).toContain(".ui-runtime-card");
    expect(shellStyle.response.status).toBe(200);
    expect(shellStyle.body).not.toContain(".ui-runtime-");
    expect(head.response.status).toBe(200);
    expect(head.body).toBe("");
    expect(pagePost.response.status).toBe(405);
    expect(pagePost.response.headers.get("allow")).toBe("GET, HEAD");
    expect(assetPost.response.status).toBe(405);
    expect(assetPost.response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("composes all five features through one route, session, shell, and asset union", async () => {
    const ui = createUiApplication({
      readModel: fixtureUiShellReadModel,
      features: [
        createRoleModelFeature(),
        quotaFeature(),
        dangerFeature(),
        settingsFeature(),
        createRuntimeStatusUiFeatureRegistration(fixtureRuntimeStatusReadModel),
      ],
    });
    const paths = ui.routeContracts.map((route) => route.path);

    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toEqual(
      expect.arrayContaining([
        "/roles-models",
        "/quota",
        runtimeStatusPagePath,
        "/assets/role-model.css",
        "/assets/role-model.js",
        "/assets/quota.css",
        "/assets/quota.js",
        "/security",
        "/assets/danger.css",
        "/assets/danger.js",
        "/api/danger",
        "/settings",
        "/assets/settings.css",
        "/assets/settings.js",
        "/api/settings",
        runtimeStatusCssPath,
      ]),
    );

    const handle = await startLocalUiServer({
      securityPolicy: ui.securityPolicy,
      handler: ui.handler,
    });
    handles.push(handle);
    const cookie = await sessionCookie(handle);
    const [runtimePage, rolePage, quotaPage, dangerPage, settingsPage] = await Promise.all([
      request(handle, runtimeStatusPagePath, cookie),
      request(handle, "/roles-models", cookie),
      request(handle, "/quota", cookie),
      request(handle, "/security", cookie),
      request(handle, "/settings", cookie),
    ]);

    expect(runtimePage.response.status).toBe(200);
    expect(runtimePage.body).toContain('href="/assets/runtime-status.css"');
    expect(runtimePage.body).not.toContain('href="/assets/role-model.css"');
    expect(runtimePage.body).not.toContain('href="/assets/quota.css"');
    expect(rolePage.response.status).toBe(200);
    expect(quotaPage.response.status).toBe(200);
    expect(dangerPage.response.status).toBe(200);
    expect(settingsPage.response.status).toBe(200);
    for (const page of [runtimePage, rolePage, quotaPage, dangerPage, settingsPage]) {
      expect(page.body.match(/<html\b/gu)).toHaveLength(1);
      expect(page.body.match(/class="ui-app"/gu)).toHaveLength(1);
    }
    expect(dangerPage.body).toContain('src="/assets/danger.js"');
    expect(settingsPage.body).toContain('src="/assets/settings.js"');
  });
});
