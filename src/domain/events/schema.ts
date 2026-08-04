import { z } from "zod";

import {
  domainError,
  err,
  scopedIdentifierPattern,
  ok,
  parseInstant,
  type DomainError,
  type Identifier,
  type Instant,
  type Result,
} from "../foundation/index.js";

const eventIdSchema = z.string().regex(scopedIdentifierPattern("event")) as unknown as z.ZodType<
  Identifier<"event">
>;

const instantSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine(
    (value) => parseInstant(value).ok,
    "Timestamp must be a canonical ISO instant.",
  ) as unknown as z.ZodType<Instant>;

const boundedKeySchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[a-z][a-z0-9_.-]*$/u);

const boundedIdentifierSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^(?:\S|\S[\s\S]*\S)$/u);

export const eventSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("internal"),
      producer: boundedKeySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("external"),
      provider: boundedKeySchema,
      deliveryId: boundedIdentifierSchema,
    })
    .strict(),
]);

export type EventSource = z.infer<typeof eventSourceSchema>;

export const eventSubjectSchema = z
  .object({
    kind: boundedKeySchema,
    id: boundedIdentifierSchema,
  })
  .strict();

export type EventSubject = z.infer<typeof eventSubjectSchema>;

const sharedEnvelopeShape = {
  occurredAt: instantSchema,
  recordedAt: instantSchema,
  source: eventSourceSchema,
  subject: eventSubjectSchema,
  correlationId: boundedIdentifierSchema,
  causationEventId: eventIdSchema.optional(),
  payload: z.json(),
};

export const eventEnvelopeV0Schema = z
  .object({
    schemaVersion: z.literal(0),
    id: eventIdSchema,
    type: boundedKeySchema,
    ...sharedEnvelopeShape,
  })
  .strict();

export type EventEnvelopeV0 = z.infer<typeof eventEnvelopeV0Schema>;

export const eventEnvelopeV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: eventIdSchema,
    eventType: boundedKeySchema,
    ...sharedEnvelopeShape,
  })
  .strict();

export type EventEnvelopeV1 = z.infer<typeof eventEnvelopeV1Schema>;

export const eventEnvelopeV1JsonSchema = z.toJSONSchema(eventEnvelopeV1Schema, {
  target: "draft-2020-12",
});

export function upgradeEventEnvelope(
  input: unknown,
): Result<EventEnvelopeV1, DomainError<"invariant_violation">> {
  const current = eventEnvelopeV1Schema.safeParse(input);
  if (current.success) return ok(current.data);

  const legacy = eventEnvelopeV0Schema.safeParse(input);
  if (!legacy.success) return err(domainError("invariant_violation"));

  const { id, type, ...shared } = legacy.data;
  return ok({
    ...shared,
    schemaVersion: 1,
    eventId: id,
    eventType: type,
  });
}
