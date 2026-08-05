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
  return { application, handle, cookie };
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

describe("O002 registration wizard HTTP integration", () => {
  it("composes a page and static CSS only; it does not add a scan or mutation API", async () => {
    const { application, handle, cookie } = await registrationFixture();
    const routePaths = application.routeContracts.map((route) => route.path);
    const page = await fetch(`${handle.baseUrl}/registration`, { headers: { cookie } });
    const stylesheet = await fetch(`${handle.baseUrl}/assets/registration.css`, {
      headers: { cookie },
    });
    const stylesheetHead = await fetch(`${handle.baseUrl}/assets/registration.css`, {
      method: "HEAD",
      headers: { cookie },
    });
    const rejected = await fetch(`${handle.baseUrl}/registration`, {
      method: "POST",
      headers: { cookie, origin: handle.baseUrl },
    });

    expect(routePaths).toContain("/registration");
    expect(routePaths).toContain("/assets/registration.css");
    expect(routePaths.filter((path) => path.includes("registration"))).toEqual([
      "/registration",
      "/assets/registration.css",
    ]);
    expect(routePaths.some((path) => path.startsWith("/api/registration"))).toBe(false);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("註冊精靈");
    expect(stylesheet.status).toBe(200);
    expect(stylesheet.headers.get("content-type")).toContain("text/css");
    expect(stylesheetHead.status).toBe(200);
    expect(await stylesheetHead.text()).toBe("");
    expect(rejected.status).toBe(405);
    expect(rejected.headers.get("allow")).toBe("GET, HEAD");
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
