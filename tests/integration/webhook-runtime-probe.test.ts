import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { chmod, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import {
  NodeWebhookRuntimeTransport,
  WebhookRuntimeProbeClient,
  type WebhookRuntimeProvider,
} from "../../src/cli/probe/index.js";
import { createLocalWebhookIngestHandler } from "../../src/cli/ingest/index.js";
import { createFixedClock, parseInstant } from "../../src/domain/foundation/index.js";
import { DurableInbox } from "../../src/infrastructure/events/index.js";

const roots: string[] = [];
const servers: Server[] = [];
const secret = Buffer.from("runtime-probe-secret", "utf8");
const nowText = "2026-08-05T12:00:30.000Z";

type RuntimeMode = "normal" | "reserialize" | "drop_delivery" | "wrong_response";

interface CapturedRequest {
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly rawBody: Buffer;
}

function instant() {
  const parsed = parseInstant(nowText);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

async function temporaryRoot() {
  const value = await mkdtemp(join(tmpdir(), "agent-team-runtime-probe-"));
  roots.push(value);
  return value;
}

function providerFromPath(path: string): WebhookRuntimeProvider | undefined {
  if (path === "/webhooks/github") return "github";
  if (path === "/webhooks/linear") return "linear";
  return undefined;
}

function forwardedHeaders(
  headers: IncomingHttpHeaders,
): Readonly<Record<string, string | string[]>> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      (entry): entry is [string, string | string[]] => entry[1] !== undefined,
    ),
  );
}

async function runtime(root: string, mode: RuntimeMode = "normal", responseDelayMs = 0) {
  const secretFile = join(root, "secrets", "webhook-secret");
  await mkdir(join(root, "secrets"), { recursive: true });
  await writeFile(secretFile, secret, { mode: 0o600 });
  await chmod(secretFile, 0o600);
  let captured: CapturedRequest | undefined;
  let sequence = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
      const path = request.url ?? "";
      const rawBody = Buffer.concat(chunks);
      captured = { path, headers: request.headers, rawBody };
      const provider = providerFromPath(path);
      if (provider === undefined) {
        response.writeHead(404).end();
        return;
      }
      const deliveryHeader = provider === "github" ? "x-github-delivery" : "linear-delivery";
      const headers = Object.fromEntries(
        Object.entries(forwardedHeaders(request.headers)).filter(
          ([name]) => mode !== "drop_delivery" || name !== deliveryHeader,
        ),
      );
      let forwardedBody = rawBody;
      if (mode === "reserialize") {
        const parsedBody: unknown = JSON.parse(rawBody.toString("utf8"));
        forwardedBody = Buffer.from(JSON.stringify(parsedBody, null, 2), "utf8");
      }
      const headersFile = join(root, `runtime-headers-${String(sequence)}.json`);
      sequence += 1;
      await writeFile(headersFile, JSON.stringify(headers), { mode: 0o600 });
      await chmod(headersFile, 0o600);
      const ingest = createLocalWebhookIngestHandler({
        agentTeamHome: root,
        secretFile,
        stdin: Readable.from([forwardedBody]),
        clock: createFixedClock(instant()),
      });
      const outcome = await ingest({ provider, headersFile });
      await unlink(headersFile);
      if (responseDelayMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, responseDelayMs);
        });
      }
      let body = outcome.message ?? "";
      if (mode === "wrong_response" && outcome.state === "success") {
        const parsedBody = JSON.parse(body) as Readonly<Record<string, unknown>>;
        body = JSON.stringify({ ...parsedBody, deliveryId: "wrong-delivery" });
      }
      let statusCode = 503;
      try {
        const parsedBody = JSON.parse(body) as { readonly statusCode?: unknown };
        statusCode = typeof parsedBody.statusCode === "number" ? parsedBody.statusCode : statusCode;
      } catch {
        // The Runtime maps an unstructured local failure to service unavailable.
      }
      response.writeHead(outcome.state === "success" ? 200 : statusCode, {
        "content-type": "application/json",
      });
      response.end(body);
    })().catch(() => {
      response.destroy();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing server address");
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    captured: () => captured,
  };
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("external Webhook Runtime Probe", () => {
  it.each(["github", "linear"] as const)(
    "verifies %s exact Raw Body, required headers, Delivery, Inbox, and latency",
    async (provider) => {
      const root = await temporaryRoot();
      const fakeRuntime = await runtime(root);
      const deliveryId = `${provider}-probe-delivery`;
      const outcome = await new WebhookRuntimeProbeClient(
        new NodeWebhookRuntimeTransport(),
        new DurableInbox(join(root, "state", "inbox")),
        createFixedClock(instant()),
        () => deliveryId,
      ).run({ baseUrl: fakeRuntime.baseUrl, provider, secret });
      const captured = fakeRuntime.captured();

      expect(outcome).toMatchObject({
        state: "verified",
        provider,
        deliveryId,
      });
      if (outcome.state !== "verified") throw new Error(outcome.reason);
      expect(typeof outcome.latencyMs).toBe("number");
      if (captured === undefined) throw new Error("Runtime did not receive Probe");
      expect(captured.path).toBe(`/webhooks/${provider}`);
      expect(
        captured.headers[provider === "github" ? "x-github-delivery" : "linear-delivery"],
      ).toBe(deliveryId);
      expect(captured.headers[provider === "github" ? "x-github-event" : "linear-event"]).toBe(
        "agent_team_probe",
      );
      expect(
        captured.headers[provider === "github" ? "x-hub-signature-256" : "linear-signature"],
      ).toEqual(expect.stringMatching(/^(?:sha256=)?[0-9a-f]{64}$/u));
      expect(createHash("sha256").update(captured.rawBody).digest("hex")).toBe(outcome.inboxSha256);
    },
  );

  it.each([
    ["reserialize", "runtime_rejected", 401],
    ["drop_delivery", "runtime_rejected", 400],
    ["wrong_response", "response_mismatch", undefined],
  ] as const)("fails when Runtime violates %s", async (mode, reason, statusCode) => {
    const root = await temporaryRoot();
    const fakeRuntime = await runtime(root, mode);
    const outcome = await new WebhookRuntimeProbeClient(
      new NodeWebhookRuntimeTransport(),
      new DurableInbox(join(root, "state", "inbox")),
      createFixedClock(instant()),
      () => `probe-${mode}`,
    ).run({ baseUrl: fakeRuntime.baseUrl, provider: "github", secret });

    expect(outcome).toMatchObject({
      state: "failed",
      reason,
      ...(statusCode === undefined ? {} : { statusCode }),
    });
  });

  it("fails a Runtime that acknowledges outside the latency contract", async () => {
    const root = await temporaryRoot();
    const fakeRuntime = await runtime(root, "normal", 80);
    const outcome = await new WebhookRuntimeProbeClient(
      new NodeWebhookRuntimeTransport(),
      new DurableInbox(join(root, "state", "inbox")),
      createFixedClock(instant()),
      () => "slow-probe",
    ).run({
      baseUrl: fakeRuntime.baseUrl,
      provider: "linear",
      secret,
      timeoutMs: 500,
      maximumLatencyMs: 10,
    });

    expect(outcome).toMatchObject({
      state: "failed",
      reason: "response_too_slow",
    });
    if (outcome.state !== "failed") throw new Error("expected latency failure");
    expect(typeof outcome.latencyMs).toBe("number");
  });

  it("rejects public plain HTTP and credential-bearing URLs before network access", async () => {
    const root = await temporaryRoot();
    const client = new WebhookRuntimeProbeClient(
      {
        post: () => {
          throw new Error("must not reach transport");
        },
      },
      new DurableInbox(join(root, "state", "inbox")),
      createFixedClock(instant()),
      () => "invalid-url",
    );
    const invalidHttp = await client.run({
      baseUrl: "http://example.com",
      provider: "github",
      secret,
    });
    const credential = await client.run({
      baseUrl: "https://user:password@example.com",
      provider: "github",
      secret,
    });

    expect(invalidHttp).toMatchObject({ state: "failed", reason: "invalid_request" });
    expect(credential).toMatchObject({ state: "failed", reason: "invalid_request" });
  });
});
