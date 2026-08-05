import { createHash } from "node:crypto";

import { z } from "zod";

import { eventEnvelopeV1Schema } from "../../domain/events/index.js";
import {
  canonicalInstantPattern,
  domainError,
  err,
  instantFromDate,
  ok,
  parseIdentifier,
  parseInstant,
  type Instant,
} from "../../domain/foundation/index.js";
import type { InboxDelivery, InboxProjectionResult } from "./model.js";

const eventTypePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const boundedIdentifierPattern = /^(?:\S|\S[\s\S]*\S)$/u;
const instantSchema = z
  .string()
  .regex(canonicalInstantPattern)
  .refine((value) => parseInstant(value).ok) as unknown as z.ZodType<Instant>;
const inboxDeliverySchema = z
  .object({
    schemaVersion: z.literal(2),
    provider: z.enum(["github", "linear"]),
    deliveryId: z.string().min(1).max(512).regex(boundedIdentifierPattern),
    eventType: z.string().regex(eventTypePattern),
    streamKey: z.string().min(1).max(512).regex(boundedIdentifierPattern),
    sourceTimestampMs: z.number().int(),
    receivedAt: instantSchema,
    mediaType: z.string().min(1).max(255),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    bodyBase64: z.string().max(32 * 1024 * 1024),
  })
  .strict() as unknown as z.ZodType<InboxDelivery>;

function deterministicEventId(provider: string, deliveryId: string) {
  const digest = createHash("sha256")
    .update(JSON.stringify([provider, deliveryId]), "utf8")
    .digest("hex");
  const versioned = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  return parseIdentifier("event", `event_${versioned}`);
}

function decodeBody(delivery: InboxDelivery): Readonly<Record<string, unknown>> | undefined {
  const body = Buffer.from(delivery.bodyBase64, "base64");
  if (
    body.toString("base64") !== delivery.bodyBase64 ||
    createHash("sha256").update(body).digest("hex") !== delivery.sha256
  ) {
    return undefined;
  }
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(body);
    const parsed = JSON.parse(decoded) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function projectInboxDelivery(input: unknown): InboxProjectionResult {
  const parsed = inboxDeliverySchema.safeParse(input);
  if (!parsed.success) return err(domainError("invariant_violation"));
  const delivery = parsed.data;
  const body = decodeBody(delivery);
  if (body === undefined) return err(domainError("invariant_violation"));
  const eventId = deterministicEventId(delivery.provider, delivery.deliveryId);
  const occurredAt = instantFromDate(new Date(delivery.sourceTimestampMs));
  if (!eventId.ok || !occurredAt.ok) return err(domainError("invariant_violation"));

  const event = eventEnvelopeV1Schema.safeParse({
    schemaVersion: 1,
    eventId: eventId.value,
    eventType: `${delivery.provider}.${delivery.eventType.toLowerCase()}`,
    occurredAt: occurredAt.value,
    recordedAt: delivery.receivedAt,
    source: {
      kind: "external",
      provider: delivery.provider,
      deliveryId: delivery.deliveryId,
    },
    subject: { kind: "webhook", id: delivery.streamKey },
    correlationId: delivery.streamKey,
    payload: { providerEventType: delivery.eventType, body },
  });
  return event.success ? ok(event.data) : err(domainError("invariant_violation"));
}
