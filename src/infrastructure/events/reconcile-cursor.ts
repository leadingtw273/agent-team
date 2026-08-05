import { createHash } from "node:crypto";
import { join } from "node:path";

import { z } from "zod";

import type {
  WebhookReconcileCursor,
  WebhookReconcileCursorReceipt,
  WebhookReconcileCursorStorePort,
  WebhookReconcileProvider,
} from "../../application/reconcile/index.js";
import {
  canonicalInstantPattern,
  domainError,
  err,
  ok,
  parseInstant,
  scopedIdentifierPattern,
  type Identifier,
  type Instant,
} from "../../domain/foundation/index.js";
import { AtomicFileStore, readJsonWithSchema, writeJsonWithSchema } from "../files/index.js";
import { acquireRecoverableFileLock } from "./locking.js";

const instantSchema = z
  .string()
  .regex(canonicalInstantPattern)
  .refine((value) => parseInstant(value).ok) as unknown as z.ZodType<Instant>;
const projectIdSchema = z
  .string()
  .regex(scopedIdentifierPattern("project")) as unknown as z.ZodType<Identifier<"project">>;
const cursorSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: projectIdSchema,
    provider: z.enum(["github", "linear"]),
    highWatermark: instantSchema,
    updatedAt: instantSchema,
  })
  .strict() as unknown as z.ZodType<WebhookReconcileCursor>;

function cursorIdentity(projectId: string, provider: WebhookReconcileProvider): string {
  return createHash("sha256")
    .update(JSON.stringify([projectId, provider]), "utf8")
    .digest("hex");
}

export class DurableWebhookReconcileCursorStore implements WebhookReconcileCursorStorePort {
  readonly #directory: string;
  readonly #store: AtomicFileStore;

  constructor(directory: string, store = new AtomicFileStore()) {
    this.#directory = directory;
    this.#store = store;
  }

  #path(projectId: string, provider: WebhookReconcileProvider): string {
    return join(this.#directory, `${cursorIdentity(projectId, provider)}.json`);
  }

  async get(projectId: Identifier<"project">, provider: WebhookReconcileProvider) {
    const cursor = await readJsonWithSchema(this.#path(projectId, provider), cursorSchema);
    if (!cursor.ok && cursor.error.code === "not_found") return ok(undefined);
    if (!cursor.ok) return cursor;
    return cursor.value.projectId === projectId && cursor.value.provider === provider
      ? ok(cursor.value)
      : err(domainError("invariant_violation"));
  }

  async advance(
    cursor: WebhookReconcileCursor,
    expectedHighWatermark: Instant | undefined,
    options: Readonly<{ readonly idempotencyKey: string }>,
  ) {
    const parsed = cursorSchema.safeParse(cursor);
    if (!parsed.success || options.idempotencyKey.trim().length === 0) {
      return err(domainError("invariant_violation"));
    }
    const filePath = this.#path(parsed.data.projectId, parsed.data.provider);
    const acquired = await acquireRecoverableFileLock(
      `${filePath}.lock`,
      `webhook-cursor:${String(process.pid)}`,
    );
    if (!acquired.ok) return acquired;
    const operation = await this.#advanceLocked(filePath, parsed.data, expectedHighWatermark);
    const released = await acquired.value.release();
    if (!operation.ok || released.ok) return operation;
    return ok(Object.freeze({ ...operation.value, lockRelease: "unknown" as const }));
  }

  async #advanceLocked(
    filePath: string,
    cursor: WebhookReconcileCursor,
    expectedHighWatermark: Instant | undefined,
  ) {
    const existing = await readJsonWithSchema(filePath, cursorSchema);
    if (
      (existing.ok && existing.value.highWatermark !== expectedHighWatermark) ||
      (!existing.ok && existing.error.code === "not_found" && expectedHighWatermark !== undefined)
    ) {
      return err(domainError("conflict"));
    }
    if (!existing.ok && existing.error.code !== "not_found") return existing;
    if (existing.ok && cursor.highWatermark < existing.value.highWatermark) {
      return err(domainError("conflict"));
    }
    if (existing.ok && cursor.highWatermark === existing.value.highWatermark) {
      return ok(
        Object.freeze({
          classification: "unchanged" as const,
          durability: "confirmed" as const,
          lockRelease: "confirmed" as const,
        }),
      );
    }
    const written = await writeJsonWithSchema(this.#store, filePath, cursorSchema, cursor);
    if (!written.ok) return written;
    const confirmed = written.value.durability === "confirmed" && written.value.readBack.ok;
    return ok(
      Object.freeze({
        classification: confirmed ? ("advanced" as const) : ("stored_unconfirmed" as const),
        durability: written.value.durability,
        lockRelease: "confirmed" as const,
      }) satisfies WebhookReconcileCursorReceipt,
    );
  }
}
