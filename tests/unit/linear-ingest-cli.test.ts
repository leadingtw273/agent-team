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
const secret = Buffer.from("linear-webhook-secret", "utf8");
const nowText = "2026-08-05T12:00:30.000Z";
const nowMs = Date.parse(nowText);

function instant(value: string) {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function body(timestamp = nowMs - 60_000): Buffer {
  return Buffer.from(
    JSON.stringify({
      action: "update",
      type: "Issue",
      webhookTimestamp: timestamp,
      data: { id: "linear-issue-1" },
    }),
    "utf8",
  );
}

async function fixture(rawBody = body(), signatureBody = rawBody) {
  const root = await mkdtemp(join(tmpdir(), "agent-team-linear-ingest-"));
  roots.push(root);
  const secretFile = join(root, "secrets", "linear-webhook-secret");
  const headersFile = join(root, "headers.json");
  await mkdir(join(root, "secrets"), { recursive: true });
  await writeFile(secretFile, secret, { mode: 0o600 });
  await chmod(secretFile, 0o600);
  await writeFile(
    headersFile,
    JSON.stringify({
      "content-type": "application/json",
      "linear-signature": createHmac("sha256", secret).update(signatureBody).digest("hex"),
      "linear-delivery": "linear-delivery-1",
      "linear-event": "UnknownFutureEvent",
    }),
  );
  const ingest = createLocalWebhookIngestHandler({
    agentTeamHome: root,
    secretFile,
    stdin: Readable.from([rawBody]),
    clock: createFixedClock(instant(nowText)),
  });
  return { root, headersFile, ingest };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Linear CLI ingest", () => {
  it("accepts the exact 60-second replay boundary and preserves unknown event types", async () => {
    const first = await fixture();
    const accepted = await first.ingest({ provider: "linear", headersFile: first.headersFile });
    const inbox = new DurableInbox(join(first.root, "state", "inbox"));
    const readBack = await inbox.read("linear", "linear-delivery-1");

    expect(accepted.state).toBe("success");
    expect(JSON.parse(accepted.message ?? "null")).toMatchObject({
      accepted: true,
      eventType: "UnknownFutureEvent",
      sourceTimestampMs: nowMs - 60_000,
    });
    expect(readBack.ok).toBe(true);
  });

  it("deduplicates an identical Linear delivery", async () => {
    const first = await fixture();
    const accepted = await first.ingest({ provider: "linear", headersFile: first.headersFile });
    const duplicateHandler = createLocalWebhookIngestHandler({
      agentTeamHome: first.root,
      secretFile: join(first.root, "secrets", "linear-webhook-secret"),
      stdin: Readable.from([body()]),
      clock: createFixedClock(instant(nowText)),
    });
    const duplicate = await duplicateHandler({
      provider: "linear",
      headersFile: first.headersFile,
    });

    expect(accepted.state).toBe("success");
    expect(JSON.parse(duplicate.message ?? "null")).toMatchObject({
      accepted: true,
      classification: "duplicate",
    });
  });

  it("rejects a timestamp older than 60 seconds without writing Inbox", async () => {
    const staleBody = body(nowMs - 60_001);
    const stale = await fixture(staleBody);
    const outcome = await stale.ingest({ provider: "linear", headersFile: stale.headersFile });

    expect(outcome.state).toBe("failed");
    expect(JSON.parse(outcome.message ?? "null")).toEqual({
      accepted: false,
      statusCode: 401,
      reason: "stale_timestamp",
    });
    const inbox = new DurableInbox(join(stale.root, "state", "inbox"));
    expect((await inbox.read("linear", "linear-delivery-1")).ok).toBe(false);
  });

  it("rejects reserialized bytes signed for the original payload", async () => {
    const original = body();
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(original.toString()), null, 2));
    const changed = await fixture(reserialized, original);
    const outcome = await changed.ingest({
      provider: "linear",
      headersFile: changed.headersFile,
    });

    expect(outcome.state).toBe("failed");
    expect(JSON.parse(outcome.message ?? "null")).toMatchObject({ reason: "invalid_signature" });
  });
});
