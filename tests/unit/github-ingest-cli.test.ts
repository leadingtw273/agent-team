import { createHmac } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { createLocalWebhookIngestHandler } from "../../src/cli/ingest/index.js";
import { createFixedClock, parseInstant } from "../../src/domain/foundation/index.js";
import { DurableInbox } from "../../src/infrastructure/events/index.js";

const roots: string[] = [];
const body = Buffer.from('{"pull_request":{"id":42}}', "utf8");
const secret = Buffer.from("github-webhook-secret", "utf8");

function instant(value: string) {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function input(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return Readable.from([bytes]);
}

function signature(bytes: Uint8Array, key: Uint8Array = secret): string {
  return `sha256=${createHmac("sha256", key).update(bytes).digest("hex")}`;
}

interface Files {
  readonly root: string;
  readonly secretFile: string;
  readonly headersFile: string;
}

async function files(
  options: { readonly secretMode?: number; readonly signedWith?: Uint8Array } = {},
): Promise<Files> {
  const root = await mkdtemp(join(tmpdir(), "agent-team-github-ingest-"));
  roots.push(root);
  const secretFile = join(root, "secrets", "github-webhook-secret");
  const headersFile = join(root, "headers.json");
  await mkdir(join(root, "secrets"), { recursive: true });
  await writeFile(secretFile, Buffer.concat([secret, Buffer.from("\n")]), {
    mode: options.secretMode ?? 0o600,
  });
  await chmod(secretFile, options.secretMode ?? 0o600);
  await writeFile(
    headersFile,
    JSON.stringify({
      "content-type": "application/json",
      "x-hub-signature-256": signature(body, options.signedWith ?? secret),
      "x-github-delivery": "delivery-1",
      "x-github-event": "pull_request",
      authorization: "must-be-ignored",
    }),
    { mode: 0o600 },
  );
  return { root, secretFile, headersFile };
}

function handler(file: Files, rawBody = body) {
  return createLocalWebhookIngestHandler({
    agentTeamHome: file.root,
    secretFile: file.secretFile,
    stdin: input(rawBody),
    clock: createFixedClock(instant("2026-08-05T12:00:00.000Z")),
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("GitHub CLI ingest", () => {
  it("verifies exact stdin bytes, atomically stores Inbox, and reports duplicate replay", async () => {
    const file = await files();
    const accepted = await handler(file)({ provider: "github", headersFile: file.headersFile });
    const duplicate = await handler(file)({ provider: "github", headersFile: file.headersFile });
    const inbox = new DurableInbox(join(file.root, "state", "inbox"));
    const readBack = await inbox.read("github", "delivery-1");

    expect(accepted.state).toBe("success");
    expect(JSON.parse(accepted.message ?? "null")).toMatchObject({
      accepted: true,
      classification: "accepted",
      statusCode: 200,
    });
    expect(JSON.parse(duplicate.message ?? "null")).toMatchObject({
      accepted: true,
      classification: "duplicate",
    });
    if (!readBack.ok || readBack.value.schemaVersion !== 2) {
      throw new Error("expected processable Inbox v2 record");
    }
    expect(Buffer.from(readBack.value.bodyBase64, "base64")).toEqual(body);
    expect(readBack.value).toMatchObject({
      eventType: "pull_request",
      streamKey: "42",
      sourceTimestampMs: Date.parse("2026-08-05T12:00:00.000Z"),
    });
  });

  it("rejects a bad signature without creating Inbox data", async () => {
    const file = await files({ signedWith: Buffer.from("wrong-secret") });
    const outcome = await handler(file)({ provider: "github", headersFile: file.headersFile });

    expect(outcome.state).toBe("failed");
    expect(JSON.parse(outcome.message ?? "null")).toEqual({
      accepted: false,
      statusCode: 401,
      reason: "invalid_signature",
    });
    const inbox = new DurableInbox(join(file.root, "state", "inbox"));
    expect((await inbox.read("github", "delivery-1")).ok).toBe(false);
  });

  it("blocks when the Secret file is not private 0600", async () => {
    const file = await files({ secretMode: 0o644 });
    const outcome = await handler(file)({ provider: "github", headersFile: file.headersFile });

    expect(outcome).toMatchObject({ state: "blocked" });
    expect(outcome.message).not.toContain(file.secretFile);
  });

  it("bounds stdin before allocating or persisting an oversized payload", async () => {
    const file = await files();
    const oversized = Buffer.alloc(16 * 1024 * 1024 + 1, 0x20);
    const outcome = await handler(
      file,
      oversized,
    )({
      provider: "github",
      headersFile: file.headersFile,
    });

    expect(outcome.state).toBe("failed");
    expect(JSON.parse(outcome.message ?? "null")).toEqual({
      accepted: false,
      statusCode: 400,
      reason: "payload_too_large",
    });
  });

  it("fails closed when durable Inbox cannot finish before the ACK deadline", async () => {
    const file = await files();
    const never = new Promise<never>(() => undefined);
    const ingest = createLocalWebhookIngestHandler({
      secretFile: file.secretFile,
      stdin: input(body),
      clock: createFixedClock(instant("2026-08-05T12:00:00.000Z")),
      ackDeadlineMs: 5,
      inbox: { store: () => never },
    });

    const outcome = await ingest({ provider: "github", headersFile: file.headersFile });

    expect(outcome.state).toBe("failed");
    expect(JSON.parse(outcome.message ?? "null")).toEqual({
      accepted: false,
      statusCode: 500,
      reason: "ack_deadline_exceeded",
    });
  });
});
