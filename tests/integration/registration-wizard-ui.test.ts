import { afterEach, describe, expect, it } from "vitest";

import {
  createRegistrationWizardUiFeatureRegistration,
  createUiApplication,
  fixtureRegistrationReadOnlyScanUseCase,
  startLocalUiServer,
  type LocalUiServerHandle,
} from "../../src/ui/index.js";

const handles: LocalUiServerHandle[] = [];

async function registrationFixture() {
  const registration = createRegistrationWizardUiFeatureRegistration(
    fixtureRegistrationReadOnlyScanUseCase,
  );
  const application = createUiApplication({ features: [registration] });
  const handle = await startLocalUiServer({
    securityPolicy: application.securityPolicy,
    handler: application.handler,
  });
  handles.push(handle);
  const exchanged = await fetch(`${handle.baseUrl}/__session/exchange`, {
    method: "POST",
    headers: { authorization: `Bearer ${handle.sessionToken}` },
  });
  const cookie = exchanged.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined) throw new Error("Registration Wizard session exchange failed.");
  const csrf = exchanged.headers.get("x-csrf-token");
  if (csrf === null) throw new Error("Registration Wizard CSRF exchange failed.");
  return { application, handle, cookie, csrf };
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

describe("O002/O003/O004 registration wizard HTTP integration", () => {
  it("composes one page with bounded Linear and GitHub mutation APIs under the shared policy", async () => {
    const { application, handle, cookie, csrf } = await registrationFixture();
    const routePaths = application.routeContracts.map((route) => route.path);
    const page = await fetch(`${handle.baseUrl}/registration`, { headers: { cookie } });
    const stylesheet = await fetch(`${handle.baseUrl}/assets/registration.css`, {
      headers: { cookie },
    });
    const stylesheetHead = await fetch(`${handle.baseUrl}/assets/registration.css`, {
      method: "HEAD",
      headers: { cookie },
    });
    const script = await fetch(`${handle.baseUrl}/assets/registration.js`, {
      headers: { cookie },
    });
    const githubScript = await fetch(`${handle.baseUrl}/assets/registration-github-policy.js`, {
      headers: { cookie },
    });
    const setupStylesheet = await fetch(`${handle.baseUrl}/assets/registration-setup.css`, {
      headers: { cookie },
    });
    const setupScript = await fetch(`${handle.baseUrl}/assets/registration-setup.js`, {
      headers: { cookie },
    });
    const setupPreview = await fetch(`${handle.baseUrl}/api/registration/setup`, {
      headers: { cookie },
    });
    const preview = await fetch(`${handle.baseUrl}/api/registration/linear-provision`, {
      headers: { cookie },
    });
    const deniedMutation = await fetch(`${handle.baseUrl}/api/registration/linear-provision`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const rejected = await fetch(`${handle.baseUrl}/registration`, {
      method: "POST",
      headers: { cookie, origin: handle.baseUrl },
    });
    const setupWithoutCsrf = await fetch(`${handle.baseUrl}/api/registration/setup`, {
      method: "PUT",
      headers: { cookie, origin: handle.baseUrl, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const setupInjectedSource = await fetch(`${handle.baseUrl}/api/registration/setup`, {
      method: "PUT",
      headers: {
        cookie,
        origin: handle.baseUrl,
        "content-type": "application/json",
        "x-csrf-token": csrf,
      },
      body: JSON.stringify({
        action: "refresh",
        setupSessionId: "setup-session",
        operationId: "operation-1",
        repositoryPath: "/tmp/attacker-controlled",
      }),
    });

    expect(routePaths).toContain("/registration");
    expect(routePaths).toContain("/assets/registration.css");
    expect(routePaths.filter((path) => path.includes("registration"))).toEqual([
      "/registration",
      "/assets/registration.css",
      "/assets/registration.js",
      "/assets/registration-github-policy.js",
      "/assets/registration-setup.css",
      "/assets/registration-setup.js",
      "/api/registration/setup",
      "/api/registration/linear-provision",
      "/api/registration/github-policy",
    ]);
    expect(page.status).toBe(200);
    const pageBody = await page.text();
    expect(pageBody).toContain("註冊精靈");
    expect(pageBody).toContain("Linear 設定預覽");
    expect(pageBody).toContain("GitHub 合併保護");
    expect(pageBody).toContain("可信設定 Setup");
    expect(pageBody).toContain("production_dependencies_unwired");
    expect(stylesheet.status).toBe(200);
    expect(stylesheet.headers.get("content-type")).toContain("text/css");
    expect(stylesheetHead.status).toBe(200);
    expect(await stylesheetHead.text()).toBe("");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("text/javascript");
    expect(githubScript.status).toBe(200);
    expect(githubScript.headers.get("content-type")).toContain("text/javascript");
    expect(setupStylesheet.status).toBe(200);
    expect(setupStylesheet.headers.get("content-type")).toContain("text/css");
    expect(setupScript.status).toBe(200);
    expect(setupScript.headers.get("content-type")).toContain("text/javascript");
    expect(setupPreview.status).toBe(200);
    expect(await setupPreview.json()).toMatchObject({ state: "configuration_incomplete" });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ state: "preview", readiness: "incomplete" });
    expect(deniedMutation.status).toBe(403);
    expect(rejected.status).toBe(405);
    expect(rejected.headers.get("allow")).toBe("GET, HEAD");
    expect(setupWithoutCsrf.status).toBe(403);
    expect(setupInjectedSource.status).toBe(422);
  });

  it("requires the local session and never reflects its bootstrap credential", async () => {
    const { handle, cookie } = await registrationFixture();
    const unauthorized = await fetch(`${handle.baseUrl}/registration`);
    const authorized = await fetch(`${handle.baseUrl}/registration`, { headers: { cookie } });
    const body = await authorized.text();

    expect(unauthorized.status).toBe(401);
    expect(authorized.status).toBe(200);
    expect(body).toContain("合成示範資料");
    expect(body).not.toContain(handle.sessionToken);
  });
});
