import { afterEach, describe, expect, it } from "vitest";

import {
  createFixtureLinearProvisionUseCaseFactory,
  createFixtureRegistrationWizardUiFeatureRegistration,
  createUiApplication,
  fixtureManualRemoteId,
  fixtureRegistrationReadOnlyScanUseCase,
  startLocalUiServer,
  type LocalUiServerHandle,
} from "../../src/ui/index.js";

const handles: LocalUiServerHandle[] = [];

async function fixture(
  maxJsonMutationBodyBytes = 16_384,
  linearUseCaseFactory = createFixtureLinearProvisionUseCaseFactory(),
) {
  const feature = createFixtureRegistrationWizardUiFeatureRegistration(
    fixtureRegistrationReadOnlyScanUseCase,
    linearUseCaseFactory,
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

  it("previews and confirms manual ID read-back with an operation-specific one-shot token", async () => {
    const { handle, cookie, csrf } = await fixture();
    const endpoint = `${handle.baseUrl}/api/registration/linear-provision`;
    const headers = {
      cookie,
      origin: handle.baseUrl,
      "content-type": "application/json",
      "x-csrf-token": csrf,
    };
    const logicalKey = "work_status.backlog";
    const remoteId = fixtureManualRemoteId(logicalKey);
    const put = (body: unknown) =>
      fetch(endpoint, { method: "PUT", headers, body: JSON.stringify(body) });

    const rejectedExtra = await put({
      operation: "preview_manual_readback",
      logicalKey,
      remoteId,
      comment: "Linear 留言已核可",
    });
    expect(rejectedExtra.status).toBe(422);
    expect(await rejectedExtra.text()).not.toContain("Linear 留言已核可");

    const previewResponse = await put({
      operation: "preview_manual_readback",
      logicalKey,
      remoteId,
    });
    const preview = (await previewResponse.json()) as Readonly<Record<string, unknown>>;
    expect(previewResponse.status).toBe(200);
    expect(preview).toMatchObject({ state: "manual_preview", logicalKey, name: "待辦" });
    expect(JSON.stringify(preview)).not.toContain(remoteId);

    const crossOperation = await put({
      operation: "provision",
      expectedRevision: preview["expectedRevision"],
      confirmationToken: preview["confirmationToken"],
      confirmationText: "套用 Linear 設定",
    });
    expect(crossOperation.status).toBe(409);

    const command = {
      operation: "confirm_manual_readback",
      logicalKey,
      remoteId,
      expectedRevision: preview["expectedRevision"],
      confirmationToken: preview["confirmationToken"],
      confirmationText: "確認 Linear ID read-back",
    };
    const applied = await put(command);
    const replayed = await put(command);
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({
      state: "manual_applied",
      preview: { summary: { unchanged: 1, create: 27, manual: 5, conflict: 0 } },
    });
    expect(replayed.status).toBe(409);
    expect(await replayed.json()).toEqual({ state: "error", code: "conflict" });
  });

  it("binds provision confirmation to two real authenticated route sessions", async () => {
    const sharedUseCaseFactory = createFixtureLinearProvisionUseCaseFactory();
    const first = await fixture(16_384, sharedUseCaseFactory);
    const second = await fixture(16_384, sharedUseCaseFactory);
    const firstEndpoint = `${first.handle.baseUrl}/api/registration/linear-provision`;
    const secondEndpoint = `${second.handle.baseUrl}/api/registration/linear-provision`;
    const previews = (await Promise.all([
      fetch(firstEndpoint, { headers: { cookie: first.cookie } }).then((response) =>
        response.json(),
      ),
      fetch(secondEndpoint, { headers: { cookie: second.cookie } }).then((response) =>
        response.json(),
      ),
    ])) as readonly Readonly<Record<string, unknown>>[];
    const firstPreview = previews[0];
    const secondPreview = previews[1];
    if (firstPreview === undefined || secondPreview === undefined) {
      throw new Error("missing route previews");
    }
    expect(firstPreview["confirmationToken"]).not.toBe(secondPreview["confirmationToken"]);

    const crossed = await fetch(secondEndpoint, {
      method: "PUT",
      headers: {
        cookie: second.cookie,
        origin: second.handle.baseUrl,
        "content-type": "application/json",
        "x-csrf-token": second.csrf,
      },
      body: JSON.stringify({
        operation: "provision",
        expectedRevision: firstPreview["expectedRevision"],
        confirmationToken: firstPreview["confirmationToken"],
        confirmationText: "套用 Linear 設定",
      }),
    });
    expect(crossed.status).toBe(409);
  });

  it("binds manual confirmation to two real authenticated route sessions", async () => {
    const sharedUseCaseFactory = createFixtureLinearProvisionUseCaseFactory();
    const first = await fixture(16_384, sharedUseCaseFactory);
    const second = await fixture(16_384, sharedUseCaseFactory);
    const firstEndpoint = `${first.handle.baseUrl}/api/registration/linear-provision`;
    const secondEndpoint = `${second.handle.baseUrl}/api/registration/linear-provision`;
    const logicalKey = "work_status.backlog";
    const remoteId = fixtureManualRemoteId(logicalKey);
    const firstPreviewResponse = await fetch(firstEndpoint, {
      method: "PUT",
      headers: {
        cookie: first.cookie,
        origin: first.handle.baseUrl,
        "content-type": "application/json",
        "x-csrf-token": first.csrf,
      },
      body: JSON.stringify({ operation: "preview_manual_readback", logicalKey, remoteId }),
    });
    const firstPreview = (await firstPreviewResponse.json()) as Readonly<Record<string, unknown>>;

    const crossed = await fetch(secondEndpoint, {
      method: "PUT",
      headers: {
        cookie: second.cookie,
        origin: second.handle.baseUrl,
        "content-type": "application/json",
        "x-csrf-token": second.csrf,
      },
      body: JSON.stringify({
        operation: "confirm_manual_readback",
        logicalKey,
        remoteId,
        expectedRevision: firstPreview["expectedRevision"],
        confirmationToken: firstPreview["confirmationToken"],
        confirmationText: "確認 Linear ID read-back",
      }),
    });
    expect(crossed.status).toBe(409);
  });
});
