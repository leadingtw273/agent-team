import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { projectInboxDelivery, type InboxDelivery } from "../../src/application/inbox/index.js";
import { parseProviderRevisionIdentity } from "../../src/application/reconcile/index.js";
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
    expect(first.value.payload).not.toHaveProperty("providerEventId");
  });

  it("projects matching provider revision metadata only from complete authoritative payloads", () => {
    const githubBody = Buffer.from(
      JSON.stringify({
        action: "synchronize",
        repository: { full_name: "owner/repository" },
        pull_request: {
          node_id: "PR_kwDO_fixture_42",
          number: 42,
          state: "open",
          draft: false,
          merged: false,
          created_at: "2026-08-05T11:00:00Z",
          updated_at: "2026-08-05T12:00:00Z",
          closed_at: null,
          merged_at: null,
          base: { sha: "0123456789abcdef0123456789abcdef01234567" },
          head: { sha: "fedcba9876543210fedcba9876543210fedcba98" },
        },
      }),
      "utf8",
    );
    const linearBody = Buffer.from(
      JSON.stringify({
        action: "update",
        type: "Issue",
        webhookTimestamp: Date.parse("2026-08-05T12:00:00.000Z"),
        data: {
          id: "issue-42",
          identifier: "AT-42",
          title: "Recover a missed webhook",
          description: "Authoritative issue snapshot",
          priority: 2,
          updatedAt: "2026-08-05T12:00:00Z",
          teamId: "linear-team-fixture",
          projectId: "linear-project-fixture",
          stateId: "state-in-progress",
        },
      }),
      "utf8",
    );
    const github = projectInboxDelivery(
      delivery({
        provider: "github",
        deliveryId: "github-complete-delivery",
        eventType: "pull_request",
        streamKey: "PR_kwDO_fixture_42",
        sha256: createHash("sha256").update(githubBody).digest("hex"),
        bodyBase64: githubBody.toString("base64"),
      }),
    );
    const linear = projectInboxDelivery(
      delivery({
        eventType: "Issue",
        streamKey: "issue-42",
        sha256: createHash("sha256").update(linearBody).digest("hex"),
        bodyBase64: linearBody.toString("base64"),
      }),
    );

    expect(github.ok && linear.ok).toBe(true);
    if (!github.ok || !linear.ok) return;
    const githubIdentity = parseProviderRevisionIdentity(
      (github.value.payload as Record<string, unknown>)["providerEventId"],
    );
    const linearIdentity = parseProviderRevisionIdentity(
      (linear.value.payload as Record<string, unknown>)["providerEventId"],
    );
    expect(githubIdentity).toMatchObject({
      provider: "github",
      resourceType: "pull_request",
      resourceId: "PR_kwDO_fixture_42",
      updatedAt: "2026-08-05T12:00:00.000Z",
    });
    expect(linearIdentity).toMatchObject({
      provider: "linear",
      resourceType: "issue",
      resourceId: "issue-42",
      updatedAt: "2026-08-05T12:00:00.000Z",
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
