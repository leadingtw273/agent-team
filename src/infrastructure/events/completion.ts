import { createHash } from "node:crypto";
import { join } from "node:path";

import { z } from "zod";

import type {
  InboxCompletion,
  InboxCompletionReceipt,
  InboxCompletionStorePort,
} from "../../application/inbox/index.js";
import {
  canonicalInstantPattern,
  domainError,
  err,
  ok,
  parseInstant,
  scopedIdentifierPattern,
  type Instant,
} from "../../domain/foundation/index.js";
import { AtomicFileStore, readJsonWithSchema, writeJsonWithSchema } from "../files/index.js";
import { acquireRecoverableFileLock } from "./locking.js";

const instantSchema = z
  .string()
  .regex(canonicalInstantPattern)
  .refine((value) => parseInstant(value).ok) as unknown as z.ZodType<Instant>;

const completionSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z.enum(["github", "linear"]),
    deliveryId: z.string().min(1).max(512),
    eventId: z.string().regex(scopedIdentifierPattern("event")),
    idempotencyKey: z
      .string()
      .min(1)
      .max(221)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/@+-]*$/u),
    outcome: z.enum(["applied", "ignored"]),
    completedAt: instantSchema,
  })
  .strict() as unknown as z.ZodType<InboxCompletion>;

function completionIdentity(provider: string, deliveryId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([provider, deliveryId]), "utf8")
    .digest("hex");
}

function sameCompletion(left: InboxCompletion, right: InboxCompletion): boolean {
  return (
    left.provider === right.provider &&
    left.deliveryId === right.deliveryId &&
    left.eventId === right.eventId &&
    left.idempotencyKey === right.idempotencyKey &&
    left.outcome === right.outcome
  );
}

export class DurableInboxCompletionStore implements InboxCompletionStorePort {
  readonly #directory: string;
  readonly #store: AtomicFileStore;

  constructor(directory: string, store = new AtomicFileStore()) {
    this.#directory = directory;
    this.#store = store;
  }

  #path(provider: string, deliveryId: string): string {
    return join(this.#directory, `${completionIdentity(provider, deliveryId)}.json`);
  }

  async get(provider: "github" | "linear", deliveryId: string) {
    const completion = await readJsonWithSchema(this.#path(provider, deliveryId), completionSchema);
    if (!completion.ok && completion.error.code === "not_found") return ok(undefined);
    if (!completion.ok) return completion;
    return completion.value.provider === provider && completion.value.deliveryId === deliveryId
      ? ok(completion.value)
      : err(domainError("invariant_violation"));
  }

  async mark(completion: InboxCompletion, options: Readonly<{ readonly idempotencyKey: string }>) {
    const parsed = completionSchema.safeParse(completion);
    if (!parsed.success || parsed.data.idempotencyKey !== options.idempotencyKey) {
      return err(domainError("invariant_violation"));
    }
    const filePath = this.#path(parsed.data.provider, parsed.data.deliveryId);
    const acquired = await acquireRecoverableFileLock(
      `${filePath}.lock`,
      `inbox-completion:${String(process.pid)}`,
    );
    if (!acquired.ok) return acquired;
    const operation = await this.#markLocked(filePath, parsed.data);
    const released = await acquired.value.release();
    if (!operation.ok || released.ok) return operation;
    return ok(Object.freeze({ ...operation.value, lockRelease: "unknown" as const }));
  }

  async #markLocked(filePath: string, completion: InboxCompletion) {
    const existing = await readJsonWithSchema(filePath, completionSchema);
    if (existing.ok) {
      return sameCompletion(existing.value, completion)
        ? ok(
            Object.freeze({
              classification: "duplicate" as const,
              durability: "confirmed" as const,
              lockRelease: "confirmed" as const,
            }),
          )
        : err(domainError("conflict"));
    }
    if (existing.error.code !== "not_found") return existing;
    const written = await writeJsonWithSchema(this.#store, filePath, completionSchema, completion);
    if (!written.ok) return written;
    const confirmed = written.value.durability === "confirmed" && written.value.readBack.ok;
    return ok(
      Object.freeze({
        classification: confirmed ? ("stored" as const) : ("stored_unconfirmed" as const),
        durability: written.value.durability,
        lockRelease: "confirmed" as const,
      }) satisfies InboxCompletionReceipt,
    );
  }
}
