import type { EventEnvelopeV1 } from "../../domain/events/index.js";
import type { DomainError, Identifier, Instant, Result } from "../../domain/foundation/index.js";
import type { AsyncPortResult, MutationOptions } from "../ports/index.js";

export interface InboxDelivery {
  readonly schemaVersion: 2;
  readonly provider: "github" | "linear";
  readonly deliveryId: string;
  readonly eventType: string;
  readonly streamKey: string;
  readonly sourceTimestampMs: number;
  readonly receivedAt: Instant;
  readonly mediaType: string;
  readonly sha256: string;
  readonly bodyBase64: string;
}

export interface InboxSourcePort {
  list(): AsyncPortResult<readonly InboxDelivery[]>;
}

export interface InboxEventAppendReceipt {
  readonly classification: "accepted" | "accepted_out_of_order" | "duplicate";
  readonly persistence: "duplicate" | "persisted_confirmed" | "persisted_unknown";
  readonly lockRelease: "confirmed" | "unknown";
}

export interface InboxEventStorePort {
  append(event: EventEnvelopeV1): AsyncPortResult<InboxEventAppendReceipt>;
}

export interface InboxUseCaseRouter {
  /**
   * Implementations must treat idempotencyKey as durable mutation identity. The Processor may
   * invoke the same event again when a crash happens after mutation but before completion write.
   */
  apply(
    event: EventEnvelopeV1,
    options: MutationOptions,
  ): AsyncPortResult<Readonly<{ outcome: "applied" | "ignored" }>>;
}

export interface InboxCompletion {
  readonly schemaVersion: 1;
  readonly provider: "github" | "linear";
  readonly deliveryId: string;
  readonly eventId: Identifier<"event">;
  readonly idempotencyKey: string;
  readonly outcome: "applied" | "ignored";
  readonly completedAt: Instant;
}

export interface InboxCompletionReceipt {
  readonly classification: "stored" | "duplicate" | "stored_unconfirmed";
  readonly durability: "confirmed" | "unknown";
  readonly lockRelease: "confirmed" | "unknown";
}

export interface InboxCompletionStorePort {
  get(
    provider: InboxDelivery["provider"],
    deliveryId: string,
  ): AsyncPortResult<InboxCompletion | undefined>;
  mark(
    completion: InboxCompletion,
    options: MutationOptions,
  ): AsyncPortResult<InboxCompletionReceipt>;
}

export interface InboxProcessorPorts {
  readonly source: InboxSourcePort;
  readonly events: InboxEventStorePort;
  readonly useCases: InboxUseCaseRouter;
  readonly completions: InboxCompletionStorePort;
}

export type InboxProcessingFailureStage =
  "projection" | "completion_read" | "event_append" | "use_case" | "completion_write";

export interface InboxProcessingFailure {
  readonly provider: InboxDelivery["provider"];
  readonly deliveryId: string;
  readonly stage: InboxProcessingFailureStage;
  readonly error: DomainError;
}

export type InboxProcessorOutcome =
  | Readonly<{
      state: "completed" | "partial";
      discovered: number;
      processed: number;
      alreadyCompleted: number;
      failures: readonly InboxProcessingFailure[];
    }>
  | Readonly<{
      state: "failed";
      stage: "source";
      error: DomainError;
    }>;

export type InboxProjectionResult = Result<EventEnvelopeV1, DomainError>;
