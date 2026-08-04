import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GitHubWebhookAdapter } from "../../src/adapters/github/index.js";
import { LinearWebhookAdapter } from "../../src/adapters/linear/index.js";
import type { RawWebhookRequest, WebhookInbox } from "../../src/adapters/webhook/index.js";
import {
  domainError,
  err,
  ok,
  parseInstant,
  type DomainError,
  type Result,
} from "../../src/domain/foundation/index.js";
import { DurableInbox, type InboxReceipt } from "../../src/infrastructure/events/index.js";

const temporaryDirectories: string[] = [];
const githubSecret = Buffer.from("It's a Secret to Everybody", "utf8");
const linearSecret = Buffer.from("linear-contract-secret", "utf8");

async function temporaryInbox(): Promise<DurableInbox> {
  const root = await mkdtemp(join(tmpdir(), "agent-team-webhook-"));
  temporaryDirectories.push(root);
  return new DurableInbox(join(root, "inbox"));
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function receivedAt(value = "2026-08-04T12:00:30.000Z") {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function hmac(secret: Uint8Array, body: Uint8Array): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function githubRequest(
  body: Uint8Array,
  overrides: Partial<RawWebhookRequest> = {},
): RawWebhookRequest {
  return {
    rawBody: body,
    receivedAt: receivedAt(),
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Hub-Signature-256": `sha256=${hmac(githubSecret, body)}`,
      "X-GitHub-Delivery": "github-delivery-1",
      "X-GitHub-Event": "pull_request",
      Authorization: "must-not-enter-core",
    },
    ...overrides,
  };
}

function linearRequest(
  body: Uint8Array,
  overrides: Partial<RawWebhookRequest> = {},
): RawWebhookRequest {
  return {
    rawBody: body,
    receivedAt: receivedAt(),
    headers: {
      "content-type": "application/json",
      "linear-signature": hmac(linearSecret, body),
      "linear-delivery": "linear-delivery-1",
      "linear-event": "Issue",
    },
    ...overrides,
  };
}

describe("GitHub webhook adapter", () => {
  it("matches the official HMAC vector, stores exact raw bytes, and deduplicates replay", async () => {
    const inbox = await temporaryInbox();
    const officialBody = Buffer.from("Hello, World!", "utf8");
    const officialHeaders = {
      "x-hub-signature-256":
        "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
      "x-github-delivery": "official-vector",
      "x-github-event": "ping",
    };
    const adapter = new GitHubWebhookAdapter(inbox, githubSecret);
    const official = await adapter.ingest({
      rawBody: officialBody,
      headers: officialHeaders,
      receivedAt: receivedAt(),
    });

    const body = Buffer.from('{"zen":"Keep it logically awesome."}', "utf8");
    const request = githubRequest(body, {
      headers: {
        ...githubRequest(body).headers,
        "X-GitHub-Delivery": "github-json-delivery",
        "X-GitHub-Event": "ping",
      },
    });

    const accepted = await adapter.ingest(request);
    const duplicate = await adapter.ingest(request);
    const readBack = await inbox.read("github", "github-json-delivery");

    expect(official).toEqual({ accepted: false, reason: "invalid_json", statusCode: 400 });
    expect(accepted).toMatchObject({ accepted: true, classification: "accepted", statusCode: 200 });
    expect(duplicate).toMatchObject({
      accepted: true,
      classification: "duplicate",
      statusCode: 200,
    });
    expect(readBack.ok && Buffer.from(readBack.value.bodyBase64, "base64")).toEqual(body);
  });

  it.each([
    [
      "modified bytes",
      (request: RawWebhookRequest) => ({
        ...request,
        rawBody: Buffer.concat([request.rawBody, Buffer.from("\n")]),
      }),
      "invalid_signature",
      401,
    ],
    [
      "missing prefix",
      (request: RawWebhookRequest) => ({
        ...request,
        headers: { ...request.headers, "X-Hub-Signature-256": hmac(githubSecret, request.rawBody) },
      }),
      "invalid_signature",
      401,
    ],
    [
      "missing delivery",
      (request: RawWebhookRequest) => ({
        ...request,
        headers: {
          "X-Hub-Signature-256": request.headers["X-Hub-Signature-256"],
          "X-GitHub-Event": "pull_request",
        },
      }),
      "missing_required_header",
      400,
    ],
  ] as const)("rejects %s without writing Inbox", async (_name, mutate, reason, statusCode) => {
    const inbox = await temporaryInbox();
    const body = Buffer.from('{"pull_request":{"id":42}}', "utf8");
    const result = await new GitHubWebhookAdapter(inbox, githubSecret).ingest(
      mutate(githubRequest(body)),
    );

    expect(result).toEqual({ accepted: false, reason, statusCode });
    const readBack = await inbox.read("github", "github-delivery-1");
    expect(readBack.ok ? "stored" : readBack.error.code).toBe("not_found");
  });

  it("verifies signature before JSON parsing and rejects ambiguous case-insensitive headers", async () => {
    const inbox = await temporaryInbox();
    const invalidJson = Buffer.from("{", "utf8");
    const signed = githubRequest(invalidJson);
    const invalidJsonResult = await new GitHubWebhookAdapter(inbox, githubSecret).ingest(signed);
    const ambiguous = await new GitHubWebhookAdapter(inbox, githubSecret).ingest({
      ...signed,
      headers: {
        ...signed.headers,
        "x-hub-signature-256": signed.headers["X-Hub-Signature-256"],
      },
    });

    expect(invalidJsonResult).toEqual({ accepted: false, reason: "invalid_json", statusCode: 400 });
    expect(ambiguous).toEqual({ accepted: false, reason: "invalid_signature", statusCode: 401 });
  });
});

describe("Linear webhook adapter", () => {
  it("accepts the 60-second boundary, rejects stale timestamp, and preserves older deliveries", async () => {
    const inbox = await temporaryInbox();
    const adapter = new LinearWebhookAdapter(inbox, linearSecret);
    const boundaryBody = Buffer.from(
      '{"action":"update","type":"Issue","webhookTimestamp":1785844770000,"data":{"id":"issue-1"}}',
      "utf8",
    );
    const staleBody = Buffer.from(
      '{"action":"update","type":"Issue","webhookTimestamp":1785844769999,"data":{"id":"issue-1"}}',
      "utf8",
    );
    const newerBody = Buffer.from(
      '{"action":"update","type":"Issue","webhookTimestamp":1785844820000,"data":{"id":"issue-1"}}',
      "utf8",
    );

    const boundary = await adapter.ingest(linearRequest(boundaryBody));
    const stale = await adapter.ingest(
      linearRequest(staleBody, {
        headers: { ...linearRequest(staleBody).headers, "linear-delivery": "linear-stale" },
      }),
    );
    const newer = await adapter.ingest(
      linearRequest(newerBody, {
        headers: { ...linearRequest(newerBody).headers, "linear-delivery": "linear-newer" },
      }),
    );
    const olderAfterNewer = await adapter.ingest(
      linearRequest(boundaryBody, {
        headers: { ...linearRequest(boundaryBody).headers, "linear-delivery": "linear-older" },
      }),
    );

    expect(boundary).toMatchObject({ accepted: true, sourceTimestampMs: 1_785_844_770_000 });
    expect(stale).toEqual({ accepted: false, reason: "stale_timestamp", statusCode: 401 });
    expect(newer).toMatchObject({ accepted: true, classification: "accepted" });
    expect(olderAfterNewer).toMatchObject({ accepted: true, classification: "accepted" });
    expect((await inbox.read("linear", "linear-newer")).ok).toBe(true);
    expect((await inbox.read("linear", "linear-older")).ok).toBe(true);
  });

  it("rejects reserialized bytes, missing delivery, malformed timestamp, and changed replay", async () => {
    const inbox = await temporaryInbox();
    const adapter = new LinearWebhookAdapter(inbox, linearSecret);
    const body = Buffer.from('{"webhookTimestamp":1785844830000,"data":{"id":"issue-1"}}', "utf8");
    const original = linearRequest(body);
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(body.toString("utf8")), null, 2));
    const missingDelivery = { ...original.headers };
    delete (missingDelivery as Record<string, unknown>)["linear-delivery"];

    const changedBytes = await adapter.ingest({ ...original, rawBody: reserialized });
    const missing = await adapter.ingest({ ...original, headers: missingDelivery });
    const malformedTimestampBody = Buffer.from('{"webhookTimestamp":"now"}', "utf8");
    const malformedTimestamp = await adapter.ingest(linearRequest(malformedTimestampBody));
    const accepted = await adapter.ingest(original);
    const changedBody = Buffer.from(
      '{"webhookTimestamp":1785844830000,"data":{"id":"issue-2"}}',
      "utf8",
    );
    const changedReplay = await adapter.ingest({
      ...linearRequest(changedBody),
      headers: { ...linearRequest(changedBody).headers, "linear-delivery": "linear-delivery-1" },
    });

    expect(changedBytes).toEqual({ accepted: false, reason: "invalid_signature", statusCode: 401 });
    expect(missing).toEqual({
      accepted: false,
      reason: "missing_required_header",
      statusCode: 400,
    });
    expect(malformedTimestamp).toEqual({
      accepted: false,
      reason: "stale_timestamp",
      statusCode: 401,
    });
    expect(accepted.accepted).toBe(true);
    expect(changedReplay).toEqual({
      accepted: false,
      reason: "inbox_unavailable",
      statusCode: 500,
    });
  });
});

describe("webhook ACK boundary", () => {
  it("waits for confirmed durable Inbox and maps storage uncertainty to retryable 500", async () => {
    let resolveStore: ((value: Result<InboxReceipt, DomainError>) => void) | undefined;
    const pendingStore = new Promise<Result<InboxReceipt, DomainError>>((resolve) => {
      resolveStore = resolve;
    });
    const inbox: WebhookInbox = { store: () => pendingStore };
    const body = Buffer.from('{"repository":{"id":1}}', "utf8");
    let settled = false;
    const pending = new GitHubWebhookAdapter(inbox, githubSecret)
      .ingest(githubRequest(body))
      .finally(() => {
        settled = true;
      });
    await Promise.resolve();
    expect(settled).toBe(false);
    resolveStore?.(err(domainError("unavailable")));
    expect(await pending).toEqual({
      accepted: false,
      reason: "inbox_unavailable",
      statusCode: 500,
    });

    const unconfirmedInbox: WebhookInbox = {
      store: () =>
        Promise.resolve(
          ok({
            classification: "stored_unconfirmed",
            lockRelease: "confirmed",
            record: {
              schemaVersion: 1,
              provider: "github",
              deliveryId: "delivery",
              receivedAt: receivedAt(),
              mediaType: "application/json",
              sha256: "0".repeat(64),
              bodyBase64: "e30=",
            },
          }),
        ),
    };
    const unconfirmed = await new GitHubWebhookAdapter(unconfirmedInbox, githubSecret).ingest(
      githubRequest(body),
    );
    expect(unconfirmed).toEqual({ accepted: false, reason: "inbox_unavailable", statusCode: 500 });
  });
});
