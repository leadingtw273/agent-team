import type { EventEnvelopeV1 } from "../../domain/events/index.js";
import type { DomainError, Identifier, Instant } from "../../domain/foundation/index.js";
import type { Project } from "../../domain/project/index.js";
import type { AsyncPortResult, MutationOptions, ReadOptions } from "../ports/index.js";

export type WebhookReconcileProvider = "github" | "linear";

export interface WebhookReadBackChange {
  /** Stable, revision-specific identity. The same authoritative change must reuse this value. */
  readonly providerEventId: string;
  readonly eventType: string;
  readonly occurredAt: Instant;
  readonly streamKey: string;
  readonly payload: EventEnvelopeV1["payload"];
}

export interface WebhookReadBackRequest {
  readonly project: Project;
  readonly provider: WebhookReconcileProvider;
  readonly fromInclusive: Instant;
  readonly throughInclusive: Instant;
}

export interface WebhookReadBackPort {
  /** Returns authoritative provider changes inside the inclusive time window. */
  readChanges(
    request: WebhookReadBackRequest,
    options?: ReadOptions,
  ): AsyncPortResult<readonly WebhookReadBackChange[]>;
}

export interface WebhookReconcileEventReceipt {
  readonly persistence: "duplicate" | "persisted_confirmed" | "persisted_unknown";
  readonly lockRelease: "confirmed" | "unknown";
}

export interface WebhookReconcileEventPort {
  append(event: EventEnvelopeV1): AsyncPortResult<WebhookReconcileEventReceipt>;
}

export interface WebhookReconcileCursor {
  readonly schemaVersion: 1;
  readonly projectId: Identifier<"project">;
  readonly provider: WebhookReconcileProvider;
  readonly highWatermark: Instant;
  readonly updatedAt: Instant;
}

export interface WebhookReconcileCursorReceipt {
  readonly classification: "advanced" | "unchanged" | "stored_unconfirmed";
  readonly durability: "confirmed" | "unknown";
  readonly lockRelease: "confirmed" | "unknown";
}

export interface WebhookReconcileCursorStorePort {
  get(
    projectId: Identifier<"project">,
    provider: WebhookReconcileProvider,
    options?: ReadOptions,
  ): AsyncPortResult<WebhookReconcileCursor | undefined>;
  advance(
    cursor: WebhookReconcileCursor,
    expectedHighWatermark: Instant | undefined,
    options: MutationOptions,
  ): AsyncPortResult<WebhookReconcileCursorReceipt>;
}

export interface WebhookReconcilePorts {
  readonly readBack: WebhookReadBackPort;
  readonly events: WebhookReconcileEventPort;
  readonly cursors: WebhookReconcileCursorStorePort;
}

export interface WebhookReconcileRequest {
  readonly project: Project;
  readonly idempotencyKeyPrefix: string;
  readonly initialLookbackMs?: number;
  readonly overlapMs?: number;
  readonly signal?: AbortSignal;
}

export type WebhookProviderReconcileOutcome =
  | Readonly<{
      state: "synchronized";
      provider: WebhookReconcileProvider;
      fromInclusive: Instant;
      throughInclusive: Instant;
      observed: number;
      appendedEventIds: readonly Identifier<"event">[];
      duplicates: number;
    }>
  | Readonly<{
      state: "failed";
      provider: WebhookReconcileProvider;
      stage: "cursor_read" | "read_back" | "event_append" | "cursor_write";
      error: DomainError;
    }>;

export type WebhookReconcileOutcome =
  | Readonly<{
      state: "completed" | "degraded";
      providers: readonly WebhookProviderReconcileOutcome[];
    }>
  | Readonly<{
      state: "failed";
      stage: "request";
      error: DomainError;
    }>;
