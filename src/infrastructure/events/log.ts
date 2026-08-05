import { constants } from "node:fs";
import { chmod, mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import {
  classifyDelivery,
  deliveryDedupeKey,
  upgradeEventEnvelope,
  type DeliveryClassification,
  type DeliveryDedupeKey,
  type EventEnvelopeV1,
} from "../../domain/events/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Instant,
  type Result,
} from "../../domain/foundation/index.js";
import { sha256Digest } from "../../domain/review/index.js";
import { privateDirectoryMode, privateFileMode, syncDirectory } from "../files/index.js";
import { acquireRecoverableFileLock } from "./locking.js";
import { semanticProviderRevisionKey } from "../../application/reconcile/provider-revision.js";

export interface EventLogRead {
  readonly events: readonly EventEnvelopeV1[];
  readonly completeByteLength: number;
  readonly partialTailIgnored: boolean;
}

export interface AppendEventReceipt {
  readonly classification: DeliveryClassification;
  readonly persistence: "duplicate" | "persisted_confirmed" | "persisted_unknown";
  readonly partialTailRecovered: boolean;
  readonly lockRelease: "confirmed" | "unknown";
}

async function acquireEventStoreLock(lockPath: string) {
  const maximumAttempts = 500;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const acquired = await acquireRecoverableFileLock(
      lockPath,
      `event-store:${String(process.pid)}`,
    );
    if (
      acquired.ok ||
      (acquired.error.code !== "conflict" && acquired.error.code !== "not_found")
    ) {
      return acquired;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  return acquireRecoverableFileLock(lockPath, `event-store:${String(process.pid)}`);
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

export async function readEventLog(filePath: string): Promise<Result<EventLogRead, DomainError>> {
  if (!isAbsolute(filePath)) return err(domainError("invariant_violation"));

  let bytes: Buffer;
  try {
    const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return ok(Object.freeze({ events: [], completeByteLength: 0, partialTailIgnored: false }));
    }
    return err(domainError("external_failure"));
  }

  const lastNewline = bytes.lastIndexOf(0x0a);
  const completeByteLength = lastNewline + 1;
  const partialTailIgnored = completeByteLength < bytes.length;
  let completeText: string;
  try {
    completeText = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, completeByteLength),
    );
  } catch {
    return err(domainError("invariant_violation"));
  }

  const lines = completeText.length === 0 ? [] : completeText.slice(0, -1).split("\n");
  const events: EventEnvelopeV1[] = [];
  for (const line of lines) {
    if (line.trim().length === 0) return err(domainError("invariant_violation"));
    try {
      const upgraded = upgradeEventEnvelope(JSON.parse(line) as unknown);
      if (!upgraded.ok) return upgraded;
      events.push(upgraded.value);
    } catch {
      return err(domainError("invariant_violation"));
    }
  }

  return ok(Object.freeze({ events, completeByteLength, partialTailIgnored }));
}

async function truncatePartialTail(
  filePath: string,
  completeByteLength: number,
): Promise<Result<void, DomainError>> {
  try {
    const handle = await open(filePath, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      await handle.truncate(completeByteLength);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(dirname(filePath));
    return ok(undefined);
  } catch {
    return err(domainError("external_failure"));
  }
}

async function appendLine(
  filePath: string,
  line: Uint8Array,
): Promise<Result<"persisted_confirmed" | "persisted_unknown", DomainError>> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let writeAttempted = false;
  try {
    const directory = dirname(filePath);
    await mkdir(directory, { recursive: true, mode: privateDirectoryMode });
    await chmod(directory, privateDirectoryMode);
    handle = await open(
      filePath,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
      privateFileMode,
    );
    await handle.chmod(privateFileMode);
    writeAttempted = true;
    const written = await handle.write(line, 0, line.length);
    if (written.bytesWritten !== line.length) throw new Error("partial_event_append");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await syncDirectory(directory);
    return ok("persisted_confirmed");
  } catch {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // The append outcome remains authoritative.
      }
    }
    return writeAttempted ? ok("persisted_unknown") : err(domainError("external_failure"));
  }
}

function latestOccurredAt(events: readonly EventEnvelopeV1[]): Instant | undefined {
  let latest: Instant | undefined;
  for (const event of events) {
    if (latest === undefined || event.occurredAt > latest) latest = event.occurredAt;
  }
  return latest;
}

function deliveryContentDigest(event: EventEnvelopeV1): Result<string, DomainError> {
  const source = event.source.kind === "external" ? event.source : { kind: event.source.kind };
  const digest = sha256Digest({
    schemaVersion: event.schemaVersion,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    source,
    subject: event.subject,
    correlationId: event.correlationId,
    ...(event.causationEventId === undefined ? {} : { causationEventId: event.causationEventId }),
    payload: event.payload,
  });
  return digest.ok ? ok(digest.value) : digest;
}

export class JsonlEventStore {
  readonly #filePath: string;
  readonly #lockPath: string;

  constructor(filePath: string, lockPath = `${filePath}.lock`) {
    this.#filePath = filePath;
    this.#lockPath = lockPath;
  }

  async append(input: unknown): Promise<Result<AppendEventReceipt, DomainError>> {
    const event = upgradeEventEnvelope(input);
    if (!event.ok) return event;
    const acquired = await acquireEventStoreLock(this.#lockPath);
    if (!acquired.ok) return acquired;

    const operation = await this.#appendLocked(event.value);
    const released = await acquired.value.release();
    if (!operation.ok || released.ok) return operation;
    return ok(Object.freeze({ ...operation.value, lockRelease: "unknown" as const }));
  }

  async #appendLocked(event: EventEnvelopeV1): Promise<Result<AppendEventReceipt, DomainError>> {
    const current = await readEventLog(this.#filePath);
    if (!current.ok) return current;
    let partialTailRecovered = false;
    if (current.value.partialTailIgnored) {
      const repaired = await truncatePartialTail(this.#filePath, current.value.completeByteLength);
      if (!repaired.ok) return repaired;
      partialTailRecovered = true;
    }

    const seenKeys = new Set<DeliveryDedupeKey>(
      current.value.events.map((persisted) => deliveryDedupeKey(persisted)),
    );
    const candidateKey = deliveryDedupeKey(event);
    const existing = current.value.events.find(
      (persisted) => deliveryDedupeKey(persisted) === candidateKey,
    );
    if (existing !== undefined) {
      const existingDigest = deliveryContentDigest(existing);
      const candidateDigest = deliveryContentDigest(event);
      if (!existingDigest.ok) return existingDigest;
      if (!candidateDigest.ok) return candidateDigest;
      if (existingDigest.value !== candidateDigest.value) {
        return err(domainError("conflict"));
      }
    }
    const semanticKey = semanticProviderRevisionKey(event);
    if (
      semanticKey !== undefined &&
      current.value.events.some(
        (persisted) => semanticProviderRevisionKey(persisted) === semanticKey,
      )
    ) {
      return ok(
        Object.freeze({
          classification: "duplicate" as const,
          persistence: "duplicate" as const,
          partialTailRecovered,
          lockRelease: "confirmed" as const,
        }),
      );
    }
    const latest = latestOccurredAt(current.value.events);
    const decision = classifyDelivery(
      event,
      latest === undefined ? { seenKeys } : { seenKeys, latestOccurredAt: latest },
    );
    if (!decision.persist) {
      return ok(
        Object.freeze({
          classification: decision.classification,
          persistence: "duplicate" as const,
          partialTailRecovered,
          lockRelease: "confirmed" as const,
        }),
      );
    }

    const line = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
    const persisted = await appendLine(this.#filePath, line);
    if (!persisted.ok) return persisted;
    return ok(
      Object.freeze({
        classification: decision.classification,
        persistence: persisted.value,
        partialTailRecovered,
        lockRelease: "confirmed" as const,
      }),
    );
  }
}
