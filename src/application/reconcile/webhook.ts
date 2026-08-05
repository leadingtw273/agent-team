import { eventEnvelopeV1Schema, type EventEnvelopeV1 } from "../../domain/events/index.js";
import {
  domainError,
  generateDeterministicIdentifier,
  instantFromDate,
  type Clock,
  type DomainError,
  type Instant,
} from "../../domain/foundation/index.js";
import { projectSchema } from "../../domain/project/index.js";
import type { MutationOptions, ReadOptions } from "../ports/index.js";
import type {
  WebhookProviderReconcileOutcome,
  WebhookReadBackChange,
  WebhookReconcileOutcome,
  WebhookReconcilePorts,
  WebhookReconcileProvider,
  WebhookReconcileRequest,
} from "./webhook-model.js";
import { parseProviderRevisionIdentity } from "./provider-revision.js";

const providers = ["github", "linear"] as const;
const defaultInitialLookbackMs = 5 * 60_000;
const defaultOverlapMs = 60_000;
const maximumLookbackMs = 7 * 24 * 60 * 60_000;
const idempotencyPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@+-]{0,127}$/u;
const boundedIdentifierPattern = /^(?:\S|\S[\s\S]*\S)$/u;
const eventTypePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;

function readOptions(request: WebhookReconcileRequest): ReadOptions {
  return request.signal === undefined ? {} : { signal: request.signal };
}

function mutation(
  request: WebhookReconcileRequest,
  provider: WebhookReconcileProvider,
): MutationOptions {
  return {
    idempotencyKey: `${request.idempotencyKeyPrefix}:cursor:${provider}`,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  };
}

function instantAt(milliseconds: number): Instant | undefined {
  const parsed = instantFromDate(new Date(milliseconds));
  return parsed.ok ? parsed.value : undefined;
}

function providerFailure(
  provider: WebhookReconcileProvider,
  stage: Extract<WebhookProviderReconcileOutcome, { state: "failed" }>["stage"],
  error: DomainError,
): WebhookProviderReconcileOutcome {
  return Object.freeze({ state: "failed", provider, stage, error });
}

function validChange(
  provider: WebhookReconcileProvider,
  change: WebhookReadBackChange,
  fromInclusive: Instant,
  throughInclusive: Instant,
): boolean {
  return (
    parseProviderRevisionIdentity(change.providerEventId)?.provider === provider &&
    eventTypePattern.test(change.eventType) &&
    change.streamKey.length > 0 &&
    change.streamKey.length <= 512 &&
    boundedIdentifierPattern.test(change.streamKey) &&
    change.occurredAt >= fromInclusive &&
    change.occurredAt <= throughInclusive
  );
}

function eventFromChange(
  provider: WebhookReconcileProvider,
  change: WebhookReadBackChange,
  recordedAt: Instant,
): EventEnvelopeV1 | undefined {
  const eventId = generateDeterministicIdentifier(
    "event",
    JSON.stringify(["readback", provider, change.providerEventId]),
  );
  if (!eventId.ok) return undefined;
  if (
    typeof change.payload !== "object" ||
    change.payload === null ||
    Array.isArray(change.payload)
  ) {
    return undefined;
  }
  const event = eventEnvelopeV1Schema.safeParse({
    schemaVersion: 1,
    eventId: eventId.value,
    eventType: `${provider}.${change.eventType.toLowerCase()}`,
    occurredAt: change.occurredAt,
    recordedAt,
    source: {
      kind: "external",
      provider,
      deliveryId: `readback:${change.providerEventId}`,
    },
    subject: { kind: "webhook", id: change.streamKey },
    correlationId: change.streamKey,
    payload: { ...change.payload, providerEventId: change.providerEventId },
  });
  return event.success ? event.data : undefined;
}

export class WebhookReconcileCoordinator {
  constructor(
    readonly ports: WebhookReconcilePorts,
    readonly clock: Clock,
  ) {}

  async reconcile(request: WebhookReconcileRequest): Promise<WebhookReconcileOutcome> {
    const initialLookbackMs = request.initialLookbackMs ?? defaultInitialLookbackMs;
    const overlapMs = request.overlapMs ?? defaultOverlapMs;
    if (
      !projectSchema.safeParse(request.project).success ||
      !idempotencyPattern.test(request.idempotencyKeyPrefix) ||
      !Number.isSafeInteger(initialLookbackMs) ||
      initialLookbackMs <= 0 ||
      initialLookbackMs > maximumLookbackMs ||
      !Number.isSafeInteger(overlapMs) ||
      overlapMs < 0 ||
      overlapMs > initialLookbackMs ||
      request.signal?.aborted === true
    ) {
      return Object.freeze({
        state: "failed",
        stage: "request",
        error: domainError(
          request.signal?.aborted === true ? "interrupted" : "invariant_violation",
        ),
      });
    }
    const throughInclusive = this.clock.now();
    const outcomes: WebhookProviderReconcileOutcome[] = [];
    for (const provider of providers) {
      outcomes.push(
        await this.#reconcileProvider(
          provider,
          request,
          throughInclusive,
          initialLookbackMs,
          overlapMs,
        ),
      );
    }
    return Object.freeze({
      state: outcomes.some((outcome) => outcome.state === "failed")
        ? ("degraded" as const)
        : ("completed" as const),
      providers: Object.freeze(outcomes),
    });
  }

  async #reconcileProvider(
    provider: WebhookReconcileProvider,
    request: WebhookReconcileRequest,
    throughInclusive: Instant,
    initialLookbackMs: number,
    overlapMs: number,
  ): Promise<WebhookProviderReconcileOutcome> {
    const cursor = await this.ports.cursors.get(request.project.id, provider, readOptions(request));
    if (!cursor.ok) return providerFailure(provider, "cursor_read", cursor.error);
    const throughMs = Date.parse(throughInclusive);
    const fromInclusive = instantAt(
      cursor.value === undefined
        ? throughMs - initialLookbackMs
        : Date.parse(cursor.value.highWatermark) - overlapMs,
    );
    if (fromInclusive === undefined || fromInclusive > throughInclusive) {
      return providerFailure(provider, "cursor_read", domainError("conflict"));
    }
    const changes = await this.ports.readBack.readChanges(
      { project: request.project, provider, fromInclusive, throughInclusive },
      readOptions(request),
    );
    if (!changes.ok) return providerFailure(provider, "read_back", changes.error);
    const identities = new Set<string>();
    if (
      changes.value.some((change) => {
        const identity = change.providerEventId;
        if (
          !validChange(provider, change, fromInclusive, throughInclusive) ||
          identities.has(identity)
        ) {
          return true;
        }
        identities.add(identity);
        return false;
      })
    ) {
      return providerFailure(provider, "read_back", domainError("conflict"));
    }
    const sorted = [...changes.value].sort(
      (left, right) =>
        left.occurredAt.localeCompare(right.occurredAt) ||
        left.providerEventId.localeCompare(right.providerEventId),
    );
    const appendedEventIds: EventEnvelopeV1["eventId"][] = [];
    let duplicates = 0;
    for (const change of sorted) {
      const event = eventFromChange(provider, change, throughInclusive);
      if (event === undefined) {
        return providerFailure(provider, "read_back", domainError("invariant_violation"));
      }
      const appended = await this.ports.events.append(event);
      if (
        !appended.ok ||
        appended.value.persistence === "persisted_unknown" ||
        appended.value.lockRelease !== "confirmed"
      ) {
        return providerFailure(
          provider,
          "event_append",
          appended.ok ? domainError("external_failure") : appended.error,
        );
      }
      if (appended.value.persistence === "duplicate") duplicates += 1;
      else appendedEventIds.push(event.eventId);
    }
    const advanced = await this.ports.cursors.advance(
      {
        schemaVersion: 1,
        projectId: request.project.id,
        provider,
        highWatermark: throughInclusive,
        updatedAt: throughInclusive,
      },
      cursor.value?.highWatermark,
      mutation(request, provider),
    );
    if (
      !advanced.ok ||
      advanced.value.classification === "stored_unconfirmed" ||
      advanced.value.durability !== "confirmed" ||
      advanced.value.lockRelease !== "confirmed"
    ) {
      return providerFailure(
        provider,
        "cursor_write",
        advanced.ok ? domainError("external_failure") : advanced.error,
      );
    }
    return Object.freeze({
      state: "synchronized",
      provider,
      fromInclusive,
      throughInclusive,
      observed: sorted.length,
      appendedEventIds: Object.freeze(appendedEventIds),
      duplicates,
    });
  }
}
