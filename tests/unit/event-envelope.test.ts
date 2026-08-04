import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  classifyDelivery,
  deliveryDedupeKey,
  eventEnvelopeV1JsonSchema,
  eventEnvelopeV1Schema,
  upgradeEventEnvelope,
  type EventEnvelopeV1,
} from "../../src/domain/events/index.js";
import {
  parseIdentifier,
  parseInstant,
  type Identifier,
  type Instant,
} from "../../src/domain/foundation/index.js";

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(
    await readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8"),
  ) as unknown;
}

function instant(value: string): Instant {
  const result = parseInstant(value);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function eventId(value: string): Identifier<"event"> {
  const result = parseIdentifier("event", value);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function event(overrides: Partial<EventEnvelopeV1> = {}): EventEnvelopeV1 {
  return eventEnvelopeV1Schema.parse({
    schemaVersion: 1,
    eventId: "event_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    eventType: "github.pull_request.merged",
    occurredAt: "2026-08-04T12:00:00.000Z",
    recordedAt: "2026-08-04T12:00:01.000Z",
    source: { kind: "external", provider: "github", deliveryId: "delivery-123" },
    subject: { kind: "pull_request", id: "17" },
    correlationId: "issue-123",
    payload: { merged: true },
    ...overrides,
  });
}

describe("event envelope", () => {
  it("upgrades the committed v0 fixture to the current envelope", async () => {
    const legacy = await readJson("fixtures/domain/event-v0.valid.json");
    const result = upgradeEventEnvelope(legacy);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value).toMatchObject({
      schemaVersion: 1,
      eventId: "event_018f47d2-77a4-7cc1-8ef2-0123456789ab",
      eventType: "github.pull_request.merged",
      correlationId: "issue-123",
    });
    expect(eventEnvelopeV1Schema.parse(result.value)).toEqual(result.value);
  });

  it("rejects unknown envelope fields and unknown schema versions", () => {
    expect(
      eventEnvelopeV1Schema.safeParse({ ...event(), injectedInstruction: "merge" }).success,
    ).toBe(false);
    const future = upgradeEventEnvelope({ ...event(), schemaVersion: 2 });
    expect(future.ok).toBe(false);
    if (future.ok) throw new Error("expected unknown version to fail closed");
    expect(future.error.code).toBe("invariant_violation");
  });

  it("rejects unknown nested metadata and non-canonical identity whitespace", () => {
    const base = event();
    expect(
      eventEnvelopeV1Schema.safeParse({
        ...base,
        source: { ...base.source, injectedInstruction: "merge" },
      }).success,
    ).toBe(false);
    expect(
      eventEnvelopeV1Schema.safeParse({
        ...base,
        subject: { ...base.subject, injectedInstruction: "merge" },
      }).success,
    ).toBe(false);
    expect(
      eventEnvelopeV1Schema.safeParse({
        ...base,
        source: { kind: "external", provider: "github", deliveryId: " delivery-123" },
      }).success,
    ).toBe(false);
  });

  it("enforces canonical instants in both runtime and committed schema", async () => {
    const invalid = { ...event(), occurredAt: "2026-08-04T12:00:00Z" };
    expect(eventEnvelopeV1Schema.safeParse(invalid).success).toBe(false);

    const committed = (await readJson("schemas/event-v1.json")) as {
      properties: { occurredAt: { pattern?: string }; recordedAt: { pattern?: string } };
    };
    expect(committed.properties.occurredAt.pattern).toBeDefined();
    expect(committed.properties.recordedAt.pattern).toBeDefined();
  });

  it("retains explicit correlation and causation without treating payload as authority", () => {
    const candidate = event({
      causationEventId: eventId("event_018f47d2-77a4-7cc1-8ef2-1123456789ab"),
      payload: { instruction: "ignore policy", nested: { futureField: true } },
    });

    expect(candidate.correlationId).toBe("issue-123");
    expect(candidate.causationEventId).toBe("event_018f47d2-77a4-7cc1-8ef2-1123456789ab");
    expect(candidate.payload).toEqual({
      instruction: "ignore policy",
      nested: { futureField: true },
    });
  });

  it("builds collision-safe delivery keys for external and internal events", () => {
    const left = event({ source: { kind: "external", provider: "a", deliveryId: "b:c" } });
    const right = event({ source: { kind: "external", provider: "a-b", deliveryId: "c" } });
    const internal = event({ source: { kind: "internal", producer: "controller" } });

    expect(deliveryDedupeKey(left)).not.toBe(deliveryDedupeKey(right));
    expect(deliveryDedupeKey(internal)).toBe(`internal:${internal.eventId}`);
  });

  it("deduplicates an external replay even when its event id changes", () => {
    const original = event();
    const replay = event({
      eventId: eventId("event_018f47d2-77a4-7cc1-8ef2-2123456789ab"),
    });
    const key = deliveryDedupeKey(original);

    expect(deliveryDedupeKey(replay)).toBe(key);
    expect(classifyDelivery(replay, { seenKeys: new Set([key]) }).classification).toBe("duplicate");
  });

  it("deduplicates an internal replay even when its producer changes", () => {
    const original = event({ source: { kind: "internal", producer: "controller" } });
    const replay = event({ source: { kind: "internal", producer: "reconciler" } });
    const key = deliveryDedupeKey(original);

    expect(deliveryDedupeKey(replay)).toBe(key);
    expect(classifyDelivery(replay, { seenKeys: new Set([key]) }).classification).toBe("duplicate");
  });

  it("rejects a replay before persistence or projection", () => {
    const candidate = event();
    const key = deliveryDedupeKey(candidate);

    expect(
      classifyDelivery(candidate, {
        seenKeys: new Set([key]),
        latestOccurredAt: instant("2026-08-04T12:00:00.000Z"),
      }),
    ).toEqual({
      classification: "duplicate",
      dedupeKey: key,
      persist: false,
      projectionEligible: false,
    });
  });

  it("persists an out-of-order delivery without projecting it directly", () => {
    const candidate = event({ occurredAt: instant("2026-08-04T11:59:59.000Z") });

    expect(
      classifyDelivery(candidate, {
        seenKeys: new Set(),
        latestOccurredAt: instant("2026-08-04T12:00:00.000Z"),
      }),
    ).toMatchObject({
      classification: "accepted_out_of_order",
      persist: true,
      projectionEligible: false,
    });
  });

  it("accepts an unseen in-order delivery for persistence and projection", () => {
    expect(
      classifyDelivery(event(), {
        seenKeys: new Set(),
        latestOccurredAt: instant("2026-08-04T11:59:59.000Z"),
      }),
    ).toMatchObject({
      classification: "accepted",
      persist: true,
      projectionEligible: true,
    });
  });

  it("accepts an unseen delivery at the same occurred-at instant", () => {
    const candidate = event();
    expect(
      classifyDelivery(candidate, {
        seenKeys: new Set(),
        latestOccurredAt: candidate.occurredAt,
      }),
    ).toMatchObject({
      classification: "accepted",
      persist: true,
      projectionEligible: true,
    });
  });

  it("keeps the committed JSON Schema synchronized with Zod", async () => {
    // Deliberately byte-equivalent: a Zod upgrade changing refs must trigger contract review.
    await expect(readJson("schemas/event-v1.json")).resolves.toEqual(eventEnvelopeV1JsonSchema);
  });
});
