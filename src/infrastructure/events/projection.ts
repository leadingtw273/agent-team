import {
  deliveryDedupeKey,
  type DeliveryDedupeKey,
  type EventEnvelopeV1,
} from "../../domain/events/index.js";
import { ok, type DomainError, type Result } from "../../domain/foundation/index.js";
import { semanticProviderRevisionKey } from "../../application/reconcile/provider-revision.js";
import { readEventLog } from "./log.js";

export type ProjectionReducer<State> = (
  state: State,
  event: EventEnvelopeV1,
) => Result<State, DomainError>;

export interface ProjectionReplay<State> {
  readonly state: State;
  readonly appliedEventIds: readonly string[];
  readonly duplicatesSkipped: number;
  readonly partialTailIgnored: boolean;
}

function compareEvents(left: EventEnvelopeV1, right: EventEnvelopeV1): number {
  for (const [leftValue, rightValue] of [
    [left.occurredAt, right.occurredAt],
    [left.recordedAt, right.recordedAt],
    [left.eventId, right.eventId],
  ] as const) {
    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
  }
  return 0;
}

export async function replayProjection<State>(
  filePath: string,
  initialState: State,
  reducer: ProjectionReducer<State>,
): Promise<Result<ProjectionReplay<State>, DomainError>> {
  const log = await readEventLog(filePath);
  if (!log.ok) return log;

  const seen = new Set<DeliveryDedupeKey>();
  const seenSemanticRevisions = new Set<string>();
  const events: EventEnvelopeV1[] = [];
  let duplicatesSkipped = 0;
  for (const event of log.value.events) {
    const key = deliveryDedupeKey(event);
    if (seen.has(key)) {
      duplicatesSkipped += 1;
      continue;
    }
    seen.add(key);
    const semanticKey = semanticProviderRevisionKey(event);
    if (semanticKey !== undefined && seenSemanticRevisions.has(semanticKey)) {
      duplicatesSkipped += 1;
      continue;
    }
    if (semanticKey !== undefined) seenSemanticRevisions.add(semanticKey);
    events.push(event);
  }
  events.sort(compareEvents);

  let state = initialState;
  const appliedEventIds: string[] = [];
  for (const event of events) {
    const reduced = reducer(state, event);
    if (!reduced.ok) return reduced;
    state = reduced.value;
    appliedEventIds.push(event.eventId);
  }

  return ok(
    Object.freeze({
      state,
      appliedEventIds: Object.freeze(appliedEventIds),
      duplicatesSkipped,
      partialTailIgnored: log.value.partialTailIgnored,
    }),
  );
}
