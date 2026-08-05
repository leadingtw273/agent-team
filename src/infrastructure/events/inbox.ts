import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
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

const inboxRecordV1Schema = z
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

const inboxRecordV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    provider: z.enum(["github", "linear"]),
    deliveryId: z.string().min(1).max(512),
    eventType: z.string().min(1).max(128),
    streamKey: z.string().min(1).max(512),
    sourceTimestampMs: z.number().int(),
    receivedAt: instantSchema,
    mediaType: z.string().min(1).max(255),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    bodyBase64: z.string().max(32 * 1024 * 1024),
  })
  .strict();

const inboxRecordSchema = z.discriminatedUnion("schemaVersion", [
  inboxRecordV1Schema,
  inboxRecordV2Schema,
]);

export type InboxRecordV1 = z.infer<typeof inboxRecordV1Schema>;
export type InboxRecordV2 = z.infer<typeof inboxRecordV2Schema>;
export type InboxRecord = z.infer<typeof inboxRecordSchema>;

export interface InboxMessage {
  readonly provider: "github" | "linear";
  readonly deliveryId: string;
  readonly eventType: string;
  readonly streamKey: string;
  readonly sourceTimestampMs: number;
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

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function recordHasValidBody(record: InboxRecord): boolean {
  const body = Buffer.from(record.bodyBase64, "base64");
  return (
    body.toString("base64") === record.bodyBase64 &&
    createHash("sha256").update(body).digest("hex") === record.sha256
  );
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
    const record = inboxRecordV2Schema.safeParse({
      schemaVersion: 2,
      provider: message.provider,
      deliveryId: message.deliveryId,
      eventType: message.eventType,
      streamKey: message.streamKey,
      sourceTimestampMs: message.sourceTimestampMs,
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
    const record = await readJsonWithSchema(this.#path(provider, deliveryId), inboxRecordSchema);
    if (!record.ok) return record;
    if (
      record.value.provider !== provider ||
      record.value.deliveryId !== deliveryId ||
      !recordHasValidBody(record.value)
    ) {
      return err(domainError("invariant_violation"));
    }
    return record;
  }

  async list(): Promise<Result<readonly InboxRecordV2[], DomainError>> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.#directory, { withFileTypes: true });
    } catch (error) {
      return hasNodeErrorCode(error, "ENOENT")
        ? ok(Object.freeze([]))
        : err(domainError("external_failure"));
    }

    const records: InboxRecordV2[] = [];
    const candidates = entries
      .filter((entry) => entry.name.endsWith(".json"))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of candidates) {
      if (!entry.isFile()) return err(domainError("invariant_violation"));
      const record = await readJsonWithSchema(join(this.#directory, entry.name), inboxRecordSchema);
      if (
        !record.ok ||
        record.value.schemaVersion !== 2 ||
        entry.name !== `${inboxIdentity(record.value.provider, record.value.deliveryId)}.json` ||
        !recordHasValidBody(record.value)
      ) {
        return err(domainError("invariant_violation"));
      }
      records.push(record.value);
    }
    records.sort(
      (left, right) =>
        left.receivedAt.localeCompare(right.receivedAt) ||
        left.provider.localeCompare(right.provider) ||
        left.deliveryId.localeCompare(right.deliveryId),
    );
    return ok(Object.freeze(records));
  }

  async #storeLocked(
    filePath: string,
    record: InboxRecordV2,
  ): Promise<Result<InboxReceipt, DomainError>> {
    const existing = await readJsonWithSchema(filePath, inboxRecordSchema);
    if (existing.ok) {
      if (
        existing.value.provider !== record.provider ||
        existing.value.deliveryId !== record.deliveryId ||
        existing.value.mediaType !== record.mediaType ||
        existing.value.sha256 !== record.sha256 ||
        (existing.value.schemaVersion === 2 &&
          (existing.value.eventType !== record.eventType ||
            existing.value.streamKey !== record.streamKey))
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
