import { createHmac, timingSafeEqual } from "node:crypto";

import type { InboxMessage, InboxReceipt } from "../../infrastructure/events/index.js";
import type { DomainError, Instant, Result } from "../../domain/foundation/index.js";

const maximumRawBodyBytes = 16 * 1024 * 1024;
const headerValuePattern = /^(?:[^\u0000-\u001f\u007f]|[\t ])+$/u;
const deliveryPattern = /^(?:\S|\S[\s\S]*\S)$/u;
const eventTypePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;

export type WebhookHeaderValue = string | readonly string[] | undefined;

export interface RawWebhookRequest {
  readonly rawBody: Uint8Array;
  readonly headers: Readonly<Record<string, WebhookHeaderValue>>;
  readonly receivedAt: Instant;
}

export interface WebhookInbox {
  store(message: InboxMessage): Promise<Result<InboxReceipt, DomainError>>;
}

export type WebhookRejectionReason =
  | "invalid_signature"
  | "missing_required_header"
  | "invalid_json"
  | "stale_timestamp"
  | "payload_too_large"
  | "inbox_unavailable";

export type WebhookIngestResult =
  | {
      readonly accepted: true;
      readonly statusCode: 200;
      readonly classification: "accepted" | "duplicate";
      readonly provider: "github" | "linear";
      readonly deliveryId: string;
      readonly eventType: string;
      readonly streamKey: string;
      readonly sourceTimestampMs: number;
      readonly inboxSha256: string;
    }
  | {
      readonly accepted: false;
      readonly statusCode: 400 | 401 | 500;
      readonly reason: WebhookRejectionReason;
    };

interface PayloadMetadata {
  readonly streamKey: string;
  readonly sourceTimestampMs: number;
}

interface WebhookProviderContract {
  readonly provider: "github" | "linear";
  readonly signatureHeader: string;
  readonly deliveryHeader: string;
  readonly eventHeader: string;
  signatureDigest(value: string): string | undefined;
  payloadMetadata(
    payload: Readonly<Record<string, unknown>>,
    receivedAtMs: number,
  ): PayloadMetadata | "stale_timestamp";
}

function normalizedHeaders(
  headers: Readonly<Record<string, WebhookHeaderValue>>,
  allowedNames: ReadonlySet<string>,
): ReadonlyMap<string, string | undefined> {
  const normalized = new Map<string, string | undefined>();
  for (const [name, rawValue] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (!allowedNames.has(key)) continue;
    const values = typeof rawValue === "string" ? [rawValue] : rawValue;
    if (values?.length !== 1) {
      normalized.set(key, undefined);
      continue;
    }
    const value = values[0];
    if (
      value === undefined ||
      value.length === 0 ||
      value.length > 4_096 ||
      !headerValuePattern.test(value)
    ) {
      normalized.set(key, undefined);
      continue;
    }
    if (normalized.has(key)) {
      normalized.set(key, undefined);
      continue;
    }
    normalized.set(key, value);
  }
  return normalized;
}

function decodeJsonObject(rawBody: Uint8Array): Readonly<Record<string, unknown>> | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : undefined;
  } catch {
    return undefined;
  }
}

function hmacMatches(secret: Uint8Array, rawBody: Uint8Array, receivedHex: string): boolean {
  if (!/^[0-9a-f]{64}$/iu.test(receivedHex)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const received = Buffer.from(receivedHex, "hex");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function receivedAtMilliseconds(receivedAt: Instant): number | undefined {
  const milliseconds = Date.parse(receivedAt);
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

function mediaType(headers: ReadonlyMap<string, string | undefined>): string {
  const value = headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return value !== undefined && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(value)
    ? value
    : "application/json";
}

function rejected(
  reason: WebhookRejectionReason,
  statusCode: 400 | 401 | 500,
): WebhookIngestResult {
  return Object.freeze({ accepted: false, statusCode, reason });
}

export class RawWebhookAdapter {
  readonly #contract: WebhookProviderContract;
  readonly #inbox: WebhookInbox;
  readonly #secret: Uint8Array;

  constructor(contract: WebhookProviderContract, inbox: WebhookInbox, secret: Uint8Array) {
    this.#contract = contract;
    this.#inbox = inbox;
    this.#secret = Uint8Array.from(secret);
  }

  async ingest(request: RawWebhookRequest): Promise<WebhookIngestResult> {
    if (request.rawBody.byteLength === 0 || request.rawBody.byteLength > maximumRawBodyBytes) {
      return rejected("payload_too_large", 400);
    }
    if (this.#secret.byteLength === 0 || this.#secret.byteLength > 65_536) {
      return rejected("invalid_signature", 401);
    }
    const allowedHeaders = new Set([
      this.#contract.signatureHeader,
      this.#contract.deliveryHeader,
      this.#contract.eventHeader,
      "content-type",
    ]);
    const headers = normalizedHeaders(request.headers, allowedHeaders);
    const signature = headers.get(this.#contract.signatureHeader);
    const digest = signature === undefined ? undefined : this.#contract.signatureDigest(signature);
    if (digest === undefined || !hmacMatches(this.#secret, request.rawBody, digest)) {
      return rejected("invalid_signature", 401);
    }
    const deliveryId = headers.get(this.#contract.deliveryHeader);
    const eventType = headers.get(this.#contract.eventHeader);
    if (
      deliveryId === undefined ||
      deliveryId.length > 512 ||
      !deliveryPattern.test(deliveryId) ||
      eventType === undefined ||
      !eventTypePattern.test(eventType)
    ) {
      return rejected("missing_required_header", 400);
    }
    const payload = decodeJsonObject(request.rawBody);
    if (payload === undefined) return rejected("invalid_json", 400);
    const receivedAtMs = receivedAtMilliseconds(request.receivedAt);
    if (receivedAtMs === undefined) return rejected("invalid_json", 400);
    const metadata = this.#contract.payloadMetadata(payload, receivedAtMs);
    if (metadata === "stale_timestamp") return rejected("stale_timestamp", 401);

    const stored = await this.#inbox.store({
      provider: this.#contract.provider,
      deliveryId,
      receivedAt: request.receivedAt,
      mediaType: mediaType(headers),
      rawBody: request.rawBody,
    });
    if (
      !stored.ok ||
      stored.value.classification === "stored_unconfirmed" ||
      stored.value.lockRelease !== "confirmed"
    ) {
      return rejected("inbox_unavailable", 500);
    }
    return Object.freeze({
      accepted: true,
      statusCode: 200,
      classification:
        stored.value.classification === "duplicate"
          ? ("duplicate" as const)
          : ("accepted" as const),
      provider: this.#contract.provider,
      deliveryId,
      eventType,
      streamKey: metadata.streamKey,
      sourceTimestampMs: metadata.sourceTimestampMs,
      inboxSha256: stored.value.record.sha256,
    });
  }
}

function nestedValue(payload: Readonly<Record<string, unknown>>, key: string): unknown {
  const value = payload[key];
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function nestedProperty(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)[key]
    : undefined;
}

function metadataKey(...candidates: readonly unknown[]): string {
  const value = candidates.find(
    (candidate) =>
      (typeof candidate === "string" && candidate.length > 0 && candidate.length <= 512) ||
      (typeof candidate === "number" && Number.isSafeInteger(candidate)),
  );
  if (typeof value === "string") return value;
  return typeof value === "number" ? value.toString() : "unknown";
}

export const githubWebhookContract: WebhookProviderContract = Object.freeze({
  provider: "github",
  signatureHeader: "x-hub-signature-256",
  deliveryHeader: "x-github-delivery",
  eventHeader: "x-github-event",
  signatureDigest(value: string): string | undefined {
    return value.startsWith("sha256=") ? value.slice("sha256=".length) : undefined;
  },
  payloadMetadata(
    payload: Readonly<Record<string, unknown>>,
    receivedAtMs: number,
  ): PayloadMetadata {
    const pullRequest = nestedValue(payload, "pull_request");
    const issue = nestedValue(payload, "issue");
    const repository = nestedValue(payload, "repository");
    const timestamp = metadataKey(
      nestedProperty(pullRequest, "updated_at"),
      nestedProperty(issue, "updated_at"),
      nestedProperty(repository, "updated_at"),
    );
    const parsedTimestamp = Date.parse(timestamp);
    return {
      streamKey: metadataKey(
        nestedProperty(pullRequest, "id"),
        nestedProperty(issue, "id"),
        nestedProperty(repository, "id"),
      ),
      sourceTimestampMs: Number.isFinite(parsedTimestamp) ? parsedTimestamp : receivedAtMs,
    };
  },
});

export const linearWebhookContract: WebhookProviderContract = Object.freeze({
  provider: "linear",
  signatureHeader: "linear-signature",
  deliveryHeader: "linear-delivery",
  eventHeader: "linear-event",
  signatureDigest(value: string): string {
    return value;
  },
  payloadMetadata(
    payload: Readonly<Record<string, unknown>>,
    receivedAtMs: number,
  ): PayloadMetadata | "stale_timestamp" {
    const timestamp = nestedProperty(payload, "webhookTimestamp");
    if (
      typeof timestamp !== "number" ||
      !Number.isSafeInteger(timestamp) ||
      Math.abs(receivedAtMs - timestamp) > 60_000
    ) {
      return "stale_timestamp";
    }
    return {
      streamKey: metadataKey(
        nestedProperty(nestedProperty(payload, "data"), "id"),
        nestedProperty(payload, "webhookId"),
      ),
      sourceTimestampMs: timestamp,
    };
  },
});
