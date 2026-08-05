import { z } from "zod";

import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import {
  registrationDegradationReasons,
  registrationGateIds,
  registrationGateStates,
  registrationStates,
  type RegistrationGateRecord,
  type RegistrationGateSnapshot,
  type RegistrationState,
  type RegistrationStateSnapshot,
  type RegistrationTransitionRequest,
} from "./model.js";

export const registrationStateSchema = z.enum(registrationStates);
export const registrationGateStateSchema = z.enum(registrationGateStates);
export const registrationDegradationReasonSchema = z.enum(registrationDegradationReasons);

const registrationGateRecordShape = Object.fromEntries(
  registrationGateIds.map((gate) => [gate, registrationGateStateSchema]),
) as Record<(typeof registrationGateIds)[number], typeof registrationGateStateSchema>;

const registrationGateSnapshotShape = Object.fromEntries(
  registrationGateIds.map((gate) => [gate, registrationGateStateSchema.optional()]),
) as Record<
  (typeof registrationGateIds)[number],
  z.ZodOptional<typeof registrationGateStateSchema>
>;

export const registrationGateRecordSchema = z.object(registrationGateRecordShape).strict();
export const registrationGateSnapshotSchema = z.object(registrationGateSnapshotShape).strict();

export const registrationStateSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    state: registrationStateSchema,
    gates: registrationGateRecordSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.state !== "registered") return;
    for (const gate of registrationGateIds) {
      if (snapshot.gates[gate] !== "passed") {
        context.addIssue({
          code: "custom",
          message: "A registered project requires every Registration Gate to pass.",
          path: ["gates", gate],
        });
      }
    }
  })
  .describe(
    "Versioned Registration state. Unknown state or Gate fields fail closed; registered requires every Gate to pass at runtime.",
  );

export const registrationTransitionRequestSchema = z.discriminatedUnion("cause", [
  z
    .object({
      cause: z.literal("revalidation_succeeded"),
      gates: registrationGateSnapshotSchema,
    })
    .strict(),
  z
    .object({
      cause: z.literal("revalidation_failed"),
      gates: registrationGateSnapshotSchema,
    })
    .strict(),
  z
    .object({
      cause: z.literal("operational_degradation"),
      reason: registrationDegradationReasonSchema,
    })
    .strict(),
  z.object({ cause: z.literal("user_disabled") }).strict(),
  z.object({ cause: z.literal("user_enabled") }).strict(),
]);

export const registrationStateSnapshotJsonSchema = z.toJSONSchema(registrationStateSnapshotSchema, {
  target: "draft-2020-12",
});

function invalidRegistrationInput(): Result<never, DomainError<"invariant_violation">> {
  return err(domainError("invariant_violation"));
}

function freezeGateRecord(gates: RegistrationGateRecord): RegistrationGateRecord {
  return Object.freeze({ ...gates });
}

function freezeSnapshot(snapshot: RegistrationStateSnapshot): RegistrationStateSnapshot {
  return Object.freeze({
    schemaVersion: snapshot.schemaVersion,
    state: snapshot.state,
    gates: freezeGateRecord(snapshot.gates),
  });
}

export function parseRegistrationState(
  input: unknown,
): Result<RegistrationState, DomainError<"invariant_violation">> {
  const parsed = registrationStateSchema.safeParse(input);
  return parsed.success ? ok(parsed.data) : invalidRegistrationInput();
}

export function parseRegistrationGateSnapshot(
  input: unknown,
): Result<RegistrationGateSnapshot, DomainError<"invariant_violation">> {
  const parsed = registrationGateSnapshotSchema.safeParse(input);
  return parsed.success
    ? ok(Object.freeze({ ...parsed.data }) as RegistrationGateSnapshot)
    : invalidRegistrationInput();
}

export function parseRegistrationTransitionRequest(
  input: unknown,
): Result<RegistrationTransitionRequest, DomainError<"invariant_violation">> {
  const parsed = registrationTransitionRequestSchema.safeParse(input);
  return parsed.success
    ? ok(parsed.data as RegistrationTransitionRequest)
    : invalidRegistrationInput();
}

export function parseRegistrationStateSnapshot(
  input: unknown,
): Result<RegistrationStateSnapshot, DomainError<"invariant_violation">> {
  const parsed = registrationStateSnapshotSchema.safeParse(input);
  return parsed.success
    ? ok(freezeSnapshot(parsed.data as RegistrationStateSnapshot))
    : invalidRegistrationInput();
}
