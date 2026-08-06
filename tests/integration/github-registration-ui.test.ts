import { afterEach, describe, expect, it } from "vitest";

import {
  createFixtureRegistrationWizardUiFeatureRegistration,
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

async function startRegistration(): Promise<LocalUiServerHandle> {
  const application = createUiApplication({
    features: [createFixtureRegistrationWizardUiFeatureRegistration()],
  });
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

async function trustedPreview(
  handle: LocalUiServerHandle,
  cookie: string,
): Promise<Readonly<{ expectedRevision: string; confirmationToken: string }>> {
  const response = await fetch(`${handle.baseUrl}/registration`, { headers: { cookie } });
  const html = await response.text();
  const match =
    /data-github-policy-panel data-expected-revision="([a-f0-9]{64})" data-confirmation-token="([A-Za-z0-9_-]{20,12288}\.[A-Za-z0-9_-]{43})"/u.exec(
      html,
    );
  if (response.status !== 200 || match?.[1] === undefined || match[2] === undefined) {
    throw new Error("trusted GitHub preview missing");
  }
  return Object.freeze({ expectedRevision: match[1], confirmationToken: match[2] });
}

function confirmationBody(
  preview: Readonly<{ expectedRevision: string; confirmationToken: string }>,
): Readonly<Record<string, string>> {
  return Object.freeze({
    operation: "apply_github_policy",
    confirmationText: "套用 GitHub 合併保護",
    ...preview,
  });
}

async function apply(
  handle: LocalUiServerHandle,
  session: Readonly<{ cookie: string; csrf: string }>,
  body: Readonly<Record<string, string>>,
): Promise<Response> {
  return fetch(`${handle.baseUrl}${githubRegistrationPolicyApiPath}`, {
    method: "PUT",
    headers: {
      cookie: session.cookie,
      origin: handle.baseUrl,
      "content-type": "application/json",
      "x-csrf-token": session.csrf,
    },
    body: JSON.stringify(body),
  });
}

afterEach(async () => Promise.all(handles.splice(0).map(async (handle) => handle.close())));

describe("O004 GitHub registration UI security", () => {
  it("requires localhost session, Origin, CSRF, exact PUT, and bounded JSON", async () => {
    const handle = await start();
    const session = await exchange(handle);
    const body = JSON.stringify({
      operation: "apply_github_policy",
      confirmationText: "套用 GitHub 合併保護",
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

  it("binds the integrated proof to the trusted session and rejects wrong operation or token", async () => {
    const handle = await startRegistration();
    const firstSession = await exchange(handle);
    const firstPreview = await trustedPreview(handle, firstSession.cookie);

    const wrongOperation = await apply(handle, firstSession, {
      ...confirmationBody(firstPreview),
      operation: "preview_github_policy",
    });
    expect(wrongOperation.status).toBe(422);
    expect(await wrongOperation.json()).toEqual({
      state: "error",
      code: "invalid_confirmation",
    });

    const forgedToken = await apply(handle, firstSession, {
      ...confirmationBody(firstPreview),
      confirmationToken: `${"A".repeat(20)}.${"A".repeat(43)}`,
    });
    expect(forgedToken.status).toBe(422);
    expect(await forgedToken.json()).toEqual({
      state: "blocked",
      reason: "confirmation_invalid",
    });

    const secondHandle = await startRegistration();
    const secondSession = await exchange(secondHandle);
    const secondPreview = await trustedPreview(secondHandle, secondSession.cookie);
    expect(secondPreview.confirmationToken).not.toBe(firstPreview.confirmationToken);
    const crossSession = await apply(secondHandle, secondSession, confirmationBody(firstPreview));
    expect(crossSession.status).toBe(422);
    expect(await crossSession.json()).toEqual({
      state: "blocked",
      reason: "confirmation_invalid",
    });
  });

  it("applies once with CAS read-back and rejects replay after the authoritative revision changes", async () => {
    const handle = await startRegistration();
    const session = await exchange(handle);
    const preview = await trustedPreview(handle, session.cookie);
    const command = confirmationBody(preview);

    const configured = await apply(handle, session, command);
    expect(configured.status).toBe(200);
    expect(await configured.json()).toEqual({ state: "configured", changed: true });

    const replay = await apply(handle, session, command);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({ state: "blocked", reason: "inventory_changed" });
  });
});
