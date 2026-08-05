import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { eventEnvelopeV1Schema, type EventEnvelopeV1 } from "../../src/domain/events/index.js";
import {
  ok,
  parseIdentifier,
  parseInstant,
  type Identifier,
  type Instant,
} from "../../src/domain/foundation/index.js";
import {
  DurableInbox,
  JsonlEventStore,
  readEventLog,
  replayProjection,
  type InboxMessage,
} from "../../src/infrastructure/events/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-events-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function instant(value: string): Instant {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function eventId(value: string): Identifier<"event"> {
  const parsed = parseIdentifier("event", value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function event(overrides: Partial<EventEnvelopeV1> = {}): EventEnvelopeV1 {
  return eventEnvelopeV1Schema.parse({
    schemaVersion: 1,
    eventId: "event_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    eventType: "github.change_request.merged",
    occurredAt: "2026-08-04T12:00:00.000Z",
    recordedAt: "2026-08-04T12:00:01.000Z",
    source: { kind: "external", provider: "github", deliveryId: "delivery-123" },
    subject: { kind: "change_request", id: "17" },
    correlationId: "issue-123",
    payload: { merged: true },
    ...overrides,
  });
}

describe("durable inbox", () => {
  it("stores raw bytes once and rejects a changed replay for the same delivery", async () => {
    const root = await temporaryDirectory();
    const inbox = new DurableInbox(join(root, "inbox"));
    const message = {
      provider: "github",
      deliveryId: "delivery-123",
      eventType: "pull_request",
      streamKey: "17",
      sourceTimestampMs: Date.parse("2026-08-04T12:00:00.000Z"),
      receivedAt: instant("2026-08-04T12:00:00.000Z"),
      mediaType: "application/json",
      rawBody: Buffer.from('{"action":"opened"}', "utf8"),
    } satisfies InboxMessage;

    const stored = await inbox.store(message);
    const duplicate = await inbox.store({
      ...message,
      receivedAt: instant("2026-08-04T12:00:05.000Z"),
      sourceTimestampMs: Date.parse("2026-08-04T12:00:05.000Z"),
    });
    const changed = await inbox.store({
      ...message,
      rawBody: Buffer.from('{"action":"closed"}', "utf8"),
    });
    const changedMetadata = await inbox.store({ ...message, eventType: "issues" });

    if (!stored.ok || !duplicate.ok) throw new Error("expected durable inbox receipts");
    expect(stored.value.classification).toBe("stored");
    expect(stored.value.lockRelease).toBe("confirmed");
    expect(duplicate.value.classification).toBe("duplicate");
    expect(duplicate.value.record.sha256).toBe(stored.value.record.sha256);
    expect(changed.ok).toBe(false);
    if (changed.ok) throw new Error("changed duplicate must fail closed");
    expect(changed.error.code).toBe("conflict");
    expect(changedMetadata).toMatchObject({ ok: false, error: { code: "conflict" } });

    const readBack = await inbox.read(message.provider, message.deliveryId);
    const listed = await inbox.list();
    if (!readBack.ok) throw new Error(readBack.error.code);
    expect(Buffer.from(readBack.value.bodyBase64, "base64")).toEqual(message.rawBody);
    expect(listed).toMatchObject({
      ok: true,
      value: [{ schemaVersion: 2, eventType: "pull_request", streamKey: "17" }],
    });
  });
});

describe("JSONL event store", () => {
  it("does not persist or project a duplicate external delivery", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "events", "events.jsonl");
    const store = new JsonlEventStore(path);
    const original = event();
    const replay = event({
      eventId: eventId("event_018f47d2-77a4-7cc1-8ef2-1123456789ab"),
      recordedAt: instant("2026-08-04T12:00:02.000Z"),
    });

    const accepted = await store.append(original);
    const duplicate = await store.append(replay);
    const divergent = await store.append(
      event({
        eventId: eventId("event_018f47d2-77a4-7cc1-8ef2-9123456789ab"),
        payload: { merged: false },
      }),
    );
    if (!accepted.ok || !duplicate.ok) throw new Error("expected append receipts");
    expect(accepted.value.persistence).toBe("persisted_confirmed");
    expect(duplicate.value).toMatchObject({
      classification: "duplicate",
      persistence: "duplicate",
    });
    expect(divergent.ok).toBe(false);
    if (divergent.ok) throw new Error("divergent duplicate must fail closed");
    expect(divergent.error.code).toBe("conflict");
    expect((await readFile(path, "utf8")).trimEnd().split("\n")).toHaveLength(1);

    const projected = await replayProjection(path, 0, (count) => ok(count + 1));
    if (!projected.ok) throw new Error(projected.error.code);
    expect(projected.value.state).toBe(1);
    expect(projected.value.duplicatesSkipped).toBe(0);
  });

  it("atomically persists one external revision across different concurrent deliveries", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "events", "events.jsonl");
    const providerEventId = `provider-revision:v1:github:pull_request:UFJfaWQ:2026-08-04T12:00:00.000Z:${"a".repeat(64)}`;
    const first = event({
      eventType: "github.pull_request",
      payload: { providerEventId, representation: "webhook" },
    });
    const second = event({
      eventId: eventId("event_018f47d2-77a4-7cc1-8ef2-8123456789ab"),
      eventType: "github.pull_request",
      source: { kind: "external", provider: "github", deliveryId: "readback-delivery" },
      payload: { providerEventId, representation: "readback" },
    });

    const receipts = await Promise.all([
      new JsonlEventStore(path).append(first),
      new JsonlEventStore(path).append(second),
    ]);
    const log = await readEventLog(path);

    expect(
      receipts.every((receipt) => receipt.ok),
      JSON.stringify(receipts),
    ).toBe(true);
    expect(
      receipts.map((receipt) => (receipt.ok ? receipt.value.persistence : "failed")).sort(),
    ).toEqual(["duplicate", "persisted_confirmed"]);
    expect(log.ok && log.value.events).toHaveLength(1);
  });

  it("persists distinct github.push deliveries despite valid pull-request revision metadata", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "events", "events.jsonl");
    const store = new JsonlEventStore(path);
    const providerEventId = `provider-revision:v1:github:pull_request:UFJfaWQ:2026-08-04T12:00:00.000Z:${"d".repeat(64)}`;
    const first = event({
      eventType: "github.push",
      payload: { providerEventId, representation: "push-webhook" },
    });
    const second = event({
      eventId: eventId("event_018f47d2-77a4-7cc1-8ef2-2123456789ab"),
      eventType: "github.push",
      source: { kind: "external", provider: "github", deliveryId: "push-readback-delivery" },
      payload: { providerEventId, representation: "push-readback" },
    });

    const firstReceipt = await store.append(first);
    const secondReceipt = await store.append(second);
    const log = await readEventLog(path);

    expect(firstReceipt).toMatchObject({ ok: true, value: { persistence: "persisted_confirmed" } });
    expect(secondReceipt).toMatchObject({
      ok: true,
      value: { persistence: "persisted_confirmed" },
    });
    expect(log.ok && log.value.events).toHaveLength(2);
  });

  it("skips historical semantic duplicates during projection but ignores invalid claims", async () => {
    const root = await temporaryDirectory();
    const semanticPath = join(root, "semantic-duplicates.jsonl");
    const invalidPath = join(root, "invalid-semantic-claims.jsonl");
    const overlongPath = join(root, "overlong-semantic-claims.jsonl");
    const crossProviderPath = join(root, "cross-provider-claims.jsonl");
    const providerEventId = `provider-revision:v1:github:pull_request:UFJfaWQ:2026-08-04T12:00:00.000Z:${"b".repeat(64)}`;
    const first = event({
      eventType: "github.pull_request",
      payload: { providerEventId, representation: "webhook" },
    });
    const second = event({
      eventId: eventId("event_018f47d2-77a4-7cc1-8ef2-7123456789ab"),
      eventType: "github.pull_request",
      source: { kind: "external", provider: "github", deliveryId: "different-delivery" },
      payload: { providerEventId, representation: "readback" },
    });
    const invalidFirst = event({ payload: { providerEventId: "not-a-provider-revision" } });
    const invalidSecond = event({
      eventId: eventId("event_018f47d2-77a4-7cc1-8ef2-6123456789ab"),
      source: { kind: "external", provider: "github", deliveryId: "another-delivery" },
      payload: { providerEventId: "not-a-provider-revision" },
    });
    const overlongProviderEventId = `provider-revision:v1:github:pull_request:${"x".repeat(400)}:2026-08-04T12:00:00.000Z:${"c".repeat(64)}`;
    const overlongFirst = event({ payload: { providerEventId: overlongProviderEventId } });
    const overlongSecond = event({
      eventId: eventId("event_018f47d2-77a4-7cc1-8ef2-5123456789ab"),
      source: { kind: "external", provider: "github", deliveryId: "overlong-delivery" },
      payload: { providerEventId: overlongProviderEventId },
    });
    await writeFile(semanticPath, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`, "utf8");
    const invalidReceipts = await Promise.all([
      new JsonlEventStore(invalidPath).append(invalidFirst),
      new JsonlEventStore(invalidPath).append(invalidSecond),
    ]);
    const overlongReceipts = await Promise.all([
      new JsonlEventStore(overlongPath).append(overlongFirst),
      new JsonlEventStore(overlongPath).append(overlongSecond),
    ]);
    const crossProviderReceipts = await Promise.all([
      new JsonlEventStore(crossProviderPath).append(first),
      new JsonlEventStore(crossProviderPath).append(
        event({
          eventId: eventId("event_018f47d2-77a4-7cc1-8ef2-4123456789ab"),
          eventType: "linear.issue",
          source: { kind: "external", provider: "linear", deliveryId: "linear-delivery" },
          payload: { providerEventId, representation: "provider-mismatch" },
        }),
      ),
    ]);

    const semantic = await replayProjection(semanticPath, 0, (count) => ok(count + 1));
    const invalid = await replayProjection(invalidPath, 0, (count) => ok(count + 1));
    const overlong = await replayProjection(overlongPath, 0, (count) => ok(count + 1));
    const crossProvider = await replayProjection(crossProviderPath, 0, (count) => ok(count + 1));

    expect(semantic).toMatchObject({ ok: true, value: { state: 1, duplicatesSkipped: 1 } });
    expect(invalidReceipts.every((receipt) => receipt.ok)).toBe(true);
    expect(invalid).toMatchObject({ ok: true, value: { state: 2, duplicatesSkipped: 0 } });
    expect(overlongReceipts.every((receipt) => receipt.ok)).toBe(true);
    expect(overlong).toMatchObject({ ok: true, value: { state: 2, duplicatesSkipped: 0 } });
    expect(crossProviderReceipts.every((receipt) => receipt.ok)).toBe(true);
    expect(crossProvider).toMatchObject({ ok: true, value: { state: 2, duplicatesSkipped: 0 } });
  });

  it("replays distinct github.push deliveries despite valid pull-request revision metadata", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "push-revisions.jsonl");
    const providerEventId = `provider-revision:v1:github:pull_request:UFJfaWQ:2026-08-04T12:00:00.000Z:${"e".repeat(64)}`;
    const first = event({
      eventType: "github.push",
      payload: { providerEventId, representation: "push-webhook" },
    });
    const second = event({
      eventId: eventId("event_018f47d2-77a4-7cc1-8ef2-3123456789ab"),
      eventType: "github.push",
      source: { kind: "external", provider: "github", deliveryId: "push-replay-delivery" },
      payload: { providerEventId, representation: "push-readback" },
    });
    await writeFile(path, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`, "utf8");

    const replayed = await replayProjection(path, 0, (count) => ok(count + 1));

    expect(replayed).toMatchObject({ ok: true, value: { state: 2, duplicatesSkipped: 0 } });
  });

  it("reuses the same permanent lock inode after the previous append releases it", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "events.jsonl");
    const lockPath = `${path}.lock`;
    const store = new JsonlEventStore(path);
    const first = await store.append(event());
    if (!first.ok) throw new Error(first.error.code);
    const firstIdentity = await stat(lockPath);
    const second = await store.append(
      event({
        eventId: eventId("event_018f47d2-77a4-7cc1-8ef2-4123456789ab"),
        source: { kind: "external", provider: "github", deliveryId: "delivery-456" },
      }),
    );
    if (!second.ok) throw new Error(second.error.code);
    expect(first.value.persistence).toBe("persisted_confirmed");
    expect(second.value.persistence).toBe("persisted_confirmed");
    expect((await stat(lockPath)).ino).toBe(firstIdentity.ino);
    const log = await readEventLog(path);
    if (!log.ok) throw new Error(log.error.code);
    expect(log.value.events).toHaveLength(2);
  });

  it("ignores a partial tail during replay and repairs it before the next append", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "events.jsonl");
    const first = event();
    await writeFile(path, `${JSON.stringify(first)}\n{"schemaVersion":`, "utf8");

    const before = await replayProjection(path, [] as string[], (types, candidate) =>
      ok([...types, candidate.eventType]),
    );
    if (!before.ok) throw new Error(before.error.code);
    expect(before.value.state).toEqual([first.eventType]);
    expect(before.value.partialTailIgnored).toBe(true);

    const second = event({
      eventId: eventId("event_018f47d2-77a4-7cc1-8ef2-2123456789ab"),
      eventType: "linear.issue.updated",
      source: { kind: "external", provider: "linear", deliveryId: "delivery-456" },
      occurredAt: instant("2026-08-04T12:01:00.000Z"),
      recordedAt: instant("2026-08-04T12:01:01.000Z"),
    });
    const appended = await new JsonlEventStore(path).append(second);
    if (!appended.ok) throw new Error(appended.error.code);
    expect(appended.value.partialTailRecovered).toBe(true);

    const after = await readEventLog(path);
    if (!after.ok) throw new Error(after.error.code);
    expect(after.value.partialTailIgnored).toBe(false);
    expect(after.value.events.map((candidate) => candidate.eventType)).toEqual([
      first.eventType,
      second.eventType,
    ]);
  });

  it("replays out-of-order events deterministically and idempotently", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "events.jsonl");
    const store = new JsonlEventStore(path);
    const later = event({
      eventType: "later",
      occurredAt: instant("2026-08-04T12:02:00.000Z"),
      source: { kind: "external", provider: "github", deliveryId: "later" },
    });
    const earlier = event({
      eventId: eventId("event_018f47d2-77a4-7cc1-8ef2-3123456789ab"),
      eventType: "earlier",
      occurredAt: instant("2026-08-04T12:01:00.000Z"),
      recordedAt: instant("2026-08-04T12:03:00.000Z"),
      source: { kind: "external", provider: "github", deliveryId: "earlier" },
    });
    await store.append(later);
    const outOfOrder = await store.append(earlier);
    if (!outOfOrder.ok) throw new Error(outOfOrder.error.code);
    expect(outOfOrder.value.classification).toBe("accepted_out_of_order");

    const reducer = (types: readonly string[], candidate: EventEnvelopeV1) =>
      ok([...types, candidate.eventType] as readonly string[]);
    const firstReplay = await replayProjection(path, [] as readonly string[], reducer);
    const secondReplay = await replayProjection(path, [] as readonly string[], reducer);
    expect(firstReplay).toEqual(secondReplay);
    if (!firstReplay.ok) throw new Error(firstReplay.error.code);
    expect(firstReplay.value.state).toEqual(["earlier", "later"]);
  });

  it("fails closed on a corrupt complete line but skips duplicate lines during projection", async () => {
    const root = await temporaryDirectory();
    const duplicatePath = join(root, "duplicates.jsonl");
    const corruptPath = join(root, "corrupt.jsonl");
    const candidate = event();
    await writeFile(
      duplicatePath,
      `${JSON.stringify(candidate)}\n${JSON.stringify(candidate)}\n`,
      "utf8",
    );
    await writeFile(corruptPath, `${JSON.stringify(candidate)}\nnot-json\n`, "utf8");

    const duplicateReplay = await replayProjection(duplicatePath, 0, (count) => ok(count + 1));
    if (!duplicateReplay.ok) throw new Error(duplicateReplay.error.code);
    expect(duplicateReplay.value.state).toBe(1);
    expect(duplicateReplay.value.duplicatesSkipped).toBe(1);

    const corruptReplay = await replayProjection(corruptPath, 0, (count) => ok(count + 1));
    expect(corruptReplay.ok).toBe(false);
    if (corruptReplay.ok) throw new Error("corrupt complete line must fail closed");
    expect(corruptReplay.error.code).toBe("invariant_violation");
  });
});
