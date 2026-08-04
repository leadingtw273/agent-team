import { createHash } from "node:crypto";
import { join } from "node:path";

import { z } from "zod";

import {
  canonicalInstantPattern,
  domainError,
  err,
  ok,
  parseInstant,
  type DomainError,
  type Instant,
  type Result,
} from "../../domain/foundation/index.js";
import { AtomicFileStore, readJsonWithSchema, writeJsonWithSchema } from "../files/index.js";
import { acquireRecoverableFileLock } from "./locking.js";

const instantSchema = z
  .string()
  .regex(canonicalInstantPattern)
  .refine((value) => parseInstant(value).ok) as unknown as z.ZodType<Instant>;

const inboxRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/u),
    deliveryId: z.string().min(1).max(512),
    receivedAt: instantSchema,
    mediaType: z.string().min(1).max(255),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    bodyBase64: z.string().max(32 * 1024 * 1024),
  })
  .strict();

export type InboxRecord = z.infer<typeof inboxRecordSchema>;

export interface InboxMessage {
  readonly provider: string;
  readonly deliveryId: string;
  readonly receivedAt: Instant;
  readonly mediaType: string;
  readonly rawBody: Uint8Array;
}

export interface InboxReceipt {
  readonly classification: "stored" | "duplicate" | "stored_unconfirmed";
  readonly record: InboxRecord;
  readonly lockRelease: "confirmed" | "unknown";
}

function inboxIdentity(provider: string, deliveryId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([provider, deliveryId]), "utf8")
    .digest("hex");
}

export class DurableInbox {
  readonly #directory: string;
  readonly #store: AtomicFileStore;

  constructor(directory: string, store = new AtomicFileStore()) {
    this.#directory = directory;
    this.#store = store;
  }

  #path(provider: string, deliveryId: string): string {
    return join(this.#directory, `${inboxIdentity(provider, deliveryId)}.json`);
  }

  async store(message: InboxMessage): Promise<Result<InboxReceipt, DomainError>> {
    const record = inboxRecordSchema.safeParse({
      schemaVersion: 1,
      provider: message.provider,
      deliveryId: message.deliveryId,
      receivedAt: message.receivedAt,
      mediaType: message.mediaType,
      sha256: createHash("sha256").update(message.rawBody).digest("hex"),
      bodyBase64: Buffer.from(message.rawBody).toString("base64"),
    });
    if (!record.success) return err(domainError("invariant_violation"));

    const filePath = this.#path(record.data.provider, record.data.deliveryId);
    const acquired = await acquireRecoverableFileLock(
      `${filePath}.lock`,
      `inbox:${String(process.pid)}`,
    );
    if (!acquired.ok) return acquired;
    const operation = await this.#storeLocked(filePath, record.data);
    const released = await acquired.value.release();
    if (!operation.ok || released.ok) return operation;
    return ok(Object.freeze({ ...operation.value, lockRelease: "unknown" as const }));
  }

  async read(provider: string, deliveryId: string): Promise<Result<InboxRecord, DomainError>> {
    return readJsonWithSchema(this.#path(provider, deliveryId), inboxRecordSchema);
  }

  async #storeLocked(
    filePath: string,
    record: InboxRecord,
  ): Promise<Result<InboxReceipt, DomainError>> {
    const existing = await readJsonWithSchema(filePath, inboxRecordSchema);
    if (existing.ok) {
      if (
        existing.value.provider !== record.provider ||
        existing.value.deliveryId !== record.deliveryId ||
        existing.value.mediaType !== record.mediaType ||
        existing.value.sha256 !== record.sha256
      ) {
        return err(domainError("conflict"));
      }
      return ok(
        Object.freeze({
          classification: "duplicate" as const,
          record: existing.value,
          lockRelease: "confirmed" as const,
        }),
      );
    }
    if (existing.error.code !== "not_found") return existing;

    const written = await writeJsonWithSchema(this.#store, filePath, inboxRecordSchema, record);
    if (!written.ok) return written;
    const confirmed = written.value.durability === "confirmed" && written.value.readBack.ok;
    return ok(
      Object.freeze({
        classification: confirmed ? ("stored" as const) : ("stored_unconfirmed" as const),
        record: written.value.readBack.ok ? written.value.readBack.value : record,
        lockRelease: "confirmed" as const,
      }),
    );
  }
}
