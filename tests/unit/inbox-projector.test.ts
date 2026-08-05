import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { projectInboxDelivery, type InboxDelivery } from "../../src/application/inbox/index.js";
import { parseInstant } from "../../src/domain/foundation/index.js";

const rawBody = Buffer.from(
  JSON.stringify({ action: "update", type: "Issue", data: { id: "issue-1" } }),
  "utf8",
);

function receivedAt() {
  const parsed = parseInstant("2026-08-05T12:00:30.000Z");
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function delivery(overrides: Partial<InboxDelivery> = {}): InboxDelivery {
  return {
    schemaVersion: 2,
    provider: "linear",
    deliveryId: "linear-delivery-1",
    eventType: "UnknownFutureEvent",
    streamKey: "issue-1",
    sourceTimestampMs: Date.parse("2026-08-05T12:00:00.000Z"),
    receivedAt: receivedAt(),
    mediaType: "application/json",
    sha256: createHash("sha256").update(rawBody).digest("hex"),
    bodyBase64: rawBody.toString("base64"),
    ...overrides,
  };
}

describe("Inbox delivery projection", () => {
  it("creates a deterministic envelope while preserving an unknown provider event type", () => {
    const first = projectInboxDelivery(delivery());
    const second = projectInboxDelivery(delivery());

    expect(first).toEqual(second);
    if (!first.ok) throw new Error(first.error.code);
    expect(first.value).toMatchObject({
      eventType: "linear.unknownfutureevent",
      occurredAt: "2026-08-05T12:00:00.000Z",
      recordedAt: "2026-08-05T12:00:30.000Z",
      source: { kind: "external", provider: "linear", deliveryId: "linear-delivery-1" },
      subject: { kind: "webhook", id: "issue-1" },
      correlationId: "issue-1",
      payload: {
        providerEventType: "UnknownFutureEvent",
        body: { action: "update", type: "Issue", data: { id: "issue-1" } },
      },
    });
  });

  it("changes Event ID with Delivery ID and rejects tampered or malformed durable bytes", () => {
    const first = projectInboxDelivery(delivery());
    const another = projectInboxDelivery(delivery({ deliveryId: "linear-delivery-2" }));
    const tampered = projectInboxDelivery(delivery({ sha256: "0".repeat(64) }));
    const unsupported = projectInboxDelivery({ ...delivery(), provider: "other" });
    const invalidJsonBody = Buffer.from("{", "utf8");
    const malformed = projectInboxDelivery(
      delivery({
        sha256: createHash("sha256").update(invalidJsonBody).digest("hex"),
        bodyBase64: invalidJsonBody.toString("base64"),
      }),
    );

    expect(first.ok && another.ok && first.value.eventId !== another.value.eventId).toBe(true);
    expect(tampered).toMatchObject({ ok: false, error: { code: "invariant_violation" } });
    expect(unsupported).toMatchObject({ ok: false, error: { code: "invariant_violation" } });
    expect(malformed).toMatchObject({ ok: false, error: { code: "invariant_violation" } });
  });
});
