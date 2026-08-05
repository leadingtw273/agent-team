import { afterEach, describe, expect, it } from "vitest";

import {
  createGitHubRegistrationUiContribution,
  createUiApplication,
  fixtureGitHubRegistrationPolicyPreview,
  fixtureGitHubRegistrationUiController,
  githubRegistrationPolicyApiPath,
  startLocalUiServer,
  type LocalUiServerHandle,
  type UiFeatureRegistration,
} from "../../src/ui/index.js";

const handles: LocalUiServerHandle[] = [];

function testFeature(): UiFeatureRegistration {
  const contribution = createGitHubRegistrationUiContribution(
    fixtureGitHubRegistrationUiController,
  );
  return Object.freeze({
    id: "github-registration-policy-test",
    slot: "registration",
    page: Object.freeze({
      path: "/registration-github-policy-test",
      title: "GitHub Registration Policy Test",
      description: "Synthetic O004 integration surface.",
      scripts: contribution.scripts,
      render: contribution.render,
    }),
    routes: contribution.routes,
  });
}

async function start(): Promise<LocalUiServerHandle> {
  const application = createUiApplication({ features: [testFeature()] });
  const handle = await startLocalUiServer({
    handler: application.handler,
    securityPolicy: application.securityPolicy,
  });
  handles.push(handle);
  return handle;
}

async function exchange(handle: LocalUiServerHandle) {
  const response = await fetch(`${handle.baseUrl}/__session/exchange`, {
    method: "POST",
    headers: { authorization: `Bearer ${handle.sessionToken}` },
  });
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  const csrf = response.headers.get("x-csrf-token");
  if (cookie === undefined || csrf === null) throw new Error("session exchange failed");
  return { cookie, csrf };
}

afterEach(async () => Promise.all(handles.splice(0).map(async (handle) => handle.close())));

describe("O004 GitHub registration UI security", () => {
  it("requires localhost session, Origin, CSRF, exact PUT, and bounded JSON", async () => {
    const handle = await start();
    const session = await exchange(handle);
    const body = JSON.stringify({
      expectedRevision: fixtureGitHubRegistrationPolicyPreview.expectedRevision,
      confirmationToken: fixtureGitHubRegistrationPolicyPreview.confirmationToken,
    });
    expect(
      (
        await fetch(`${handle.baseUrl}${githubRegistrationPolicyApiPath}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${handle.baseUrl}${githubRegistrationPolicyApiPath}`, {
          method: "PUT",
          headers: {
            cookie: session.cookie,
            "content-type": "application/json",
            "x-csrf-token": session.csrf,
          },
          body,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${handle.baseUrl}${githubRegistrationPolicyApiPath}`, {
          method: "PUT",
          headers: {
            cookie: session.cookie,
            origin: handle.baseUrl,
            "content-type": "application/json",
            "x-csrf-token": session.csrf,
          },
          body: JSON.stringify({ ...JSON.parse(body), extra: "not accepted" }),
        })
      ).status,
    ).toBe(422);
    const configured = await fetch(`${handle.baseUrl}${githubRegistrationPolicyApiPath}`, {
      method: "PUT",
      headers: {
        cookie: session.cookie,
        origin: handle.baseUrl,
        "content-type": "application/json",
        "x-csrf-token": session.csrf,
      },
      body,
    });
    expect(configured.status).toBe(200);
    expect(await configured.json()).toEqual({ state: "configured", changed: true });
    expect(
      (
        await fetch(`${handle.baseUrl}${githubRegistrationPolicyApiPath}`, {
          method: "GET",
          headers: { cookie: session.cookie },
        })
      ).status,
    ).toBe(405);
  });
});
