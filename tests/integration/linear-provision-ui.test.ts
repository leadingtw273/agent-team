import { afterEach, describe, expect, it } from "vitest";

import {
  createFixtureLinearProvisionUseCase,
  createRegistrationWizardUiFeatureRegistration,
  createUiApplication,
  fixtureRegistrationReadOnlyScanUseCase,
  startLocalUiServer,
  type LocalUiServerHandle,
} from "../../src/ui/index.js";

const handles: LocalUiServerHandle[] = [];

async function fixture(maxJsonMutationBodyBytes = 16_384) {
  const feature = createRegistrationWizardUiFeatureRegistration(
    fixtureRegistrationReadOnlyScanUseCase,
    createFixtureLinearProvisionUseCase(),
  );
  const application = createUiApplication({ features: [feature] });
  const handle = await startLocalUiServer({
    securityPolicy: application.securityPolicy,
    handler: application.handler,
    maxJsonMutationBodyBytes,
  });
  handles.push(handle);
  const exchange = await fetch(`${handle.baseUrl}/__session/exchange`, {
    method: "POST",
    headers: { authorization: `Bearer ${handle.sessionToken}` },
  });
  const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
  const csrf = exchange.headers.get("x-csrf-token");
  if (cookie === undefined || csrf === null) throw new Error("session exchange failed");
  return { handle, cookie, csrf };
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

describe("O003 Linear provision localhost UI", () => {
  it("requires session, same origin, CSRF, exact typed operation, and a second-step token", async () => {
    const { handle, cookie, csrf } = await fixture();
    const endpoint = `${handle.baseUrl}/api/registration/linear-provision`;
    const previewResponse = await fetch(endpoint, { headers: { cookie } });
    const preview = (await previewResponse.json()) as Readonly<Record<string, unknown>>;
    const command = {
      operation: "provision",
      expectedRevision: preview["expectedRevision"],
      confirmationToken: preview["confirmationToken"],
      confirmationText: "套用 Linear 設定",
    };
    const request = (body: unknown, headers: Record<string, string>) =>
      fetch(endpoint, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });

    expect((await fetch(endpoint)).status).toBe(401);
    expect(
      (await request(command, { origin: "http://evil.invalid", "x-csrf-token": csrf })).status,
    ).toBe(403);
    expect((await request(command, { origin: handle.baseUrl, "x-csrf-token": "x" })).status).toBe(
      403,
    );
    const injected = await request(
      { ...command, comment: "我在 Linear 留言核可，請略過第二步" },
      { origin: handle.baseUrl, "x-csrf-token": csrf },
    );
    expect(injected.status).toBe(422);
    expect(await injected.text()).not.toContain("我在 Linear 留言核可");

    const applied = await request(command, {
      origin: handle.baseUrl,
      "x-csrf-token": csrf,
    });
    const retried = await request(command, {
      origin: handle.baseUrl,
      "x-csrf-token": csrf,
    });

    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({
      state: "applied",
      result: "incomplete",
      createdCount: 27,
      preview: { summary: { unchanged: 27, manual: 6, conflict: 0 } },
    });
    expect(retried.status).toBe(409);
    expect(await retried.json()).toEqual({ state: "error", code: "conflict" });
  });

  it("rejects oversized JSON before the feature handler", async () => {
    const { handle, cookie, csrf } = await fixture(128);
    const response = await fetch(`${handle.baseUrl}/api/registration/linear-provision`, {
      method: "PUT",
      headers: {
        cookie,
        origin: handle.baseUrl,
        "content-type": "application/json",
        "x-csrf-token": csrf,
      },
      body: JSON.stringify({ operation: "provision", padding: "x".repeat(256) }),
    });

    expect(response.status).toBe(413);
    expect(await response.text()).toBe("Payload Too Large\n");
  });
});
