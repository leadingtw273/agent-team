import type { Instant } from "../foundation/index.js";
import type { EventEnvelopeV1 } from "./schema.js";

declare const deliveryDedupeKeyBrand: unique symbol;

export type DeliveryDedupeKey = string & { readonly [deliveryDedupeKeyBrand]: true };

export interface DeliveryCursor {
  readonly seenKeys: ReadonlySet<DeliveryDedupeKey>;
  readonly latestOccurredAt?: Instant;
}

export type DeliveryClassification = "accepted" | "accepted_out_of_order" | "duplicate";

export interface DeliveryDecision {
  readonly classification: DeliveryClassification;
  readonly dedupeKey: DeliveryDedupeKey;
  readonly persist: boolean;
  readonly projectionEligible: boolean;
}

export function deliveryDedupeKey(event: EventEnvelopeV1): DeliveryDedupeKey {
  if (event.source.kind === "internal") {
    return `internal:${event.eventId}` as DeliveryDedupeKey;
  }

  const encodedIdentity = JSON.stringify([event.source.provider, event.source.deliveryId]);
  return `external:${encodedIdentity}` as DeliveryDedupeKey;
}

export function classifyDelivery(event: EventEnvelopeV1, cursor: DeliveryCursor): DeliveryDecision {
  const dedupeKey = deliveryDedupeKey(event);

  if (cursor.seenKeys.has(dedupeKey)) {
    return Object.freeze({
      classification: "duplicate",
      dedupeKey,
      persist: false,
      projectionEligible: false,
    });
  }

  const outOfOrder =
    cursor.latestOccurredAt !== undefined && event.occurredAt < cursor.latestOccurredAt;

  return Object.freeze({
    classification: outOfOrder ? "accepted_out_of_order" : "accepted",
    dedupeKey,
    persist: true,
    projectionEligible: !outOfOrder,
  });
}
