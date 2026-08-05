import { domainError, type Clock, type DomainError } from "../../domain/foundation/index.js";
import type {
  InboxCompletion,
  InboxProcessingFailure,
  InboxProcessingFailureStage,
  InboxProcessorOutcome,
  InboxProcessorPorts,
} from "./model.js";
import { projectInboxDelivery } from "./projector.js";

function failure(
  provider: "github" | "linear",
  deliveryId: string,
  stage: InboxProcessingFailureStage,
  error: DomainError = domainError("external_failure"),
): InboxProcessingFailure {
  return Object.freeze({ provider, deliveryId, stage, error });
}

export class InboxProcessor {
  constructor(
    readonly ports: InboxProcessorPorts,
    readonly clock: Clock,
  ) {}

  async run(): Promise<InboxProcessorOutcome> {
    const listed = await this.ports.source.list();
    if (!listed.ok) return Object.freeze({ state: "failed", stage: "source", error: listed.error });

    let processed = 0;
    let alreadyCompleted = 0;
    const failures: InboxProcessingFailure[] = [];
    for (const delivery of listed.value) {
      const projected = projectInboxDelivery(delivery);
      if (!projected.ok) {
        failures.push(
          failure(delivery.provider, delivery.deliveryId, "projection", projected.error),
        );
        continue;
      }
      const idempotencyKey = `inbox:${projected.value.eventId}`;
      const existing = await this.ports.completions.get(delivery.provider, delivery.deliveryId);
      if (!existing.ok) {
        failures.push(
          failure(delivery.provider, delivery.deliveryId, "completion_read", existing.error),
        );
        continue;
      }
      if (existing.value !== undefined) {
        if (
          existing.value.eventId !== projected.value.eventId ||
          existing.value.idempotencyKey !== idempotencyKey
        ) {
          failures.push(
            failure(
              delivery.provider,
              delivery.deliveryId,
              "completion_read",
              domainError("conflict"),
            ),
          );
        } else {
          alreadyCompleted += 1;
        }
        continue;
      }

      const appended = await this.ports.events.append(projected.value);
      if (
        !appended.ok ||
        appended.value.persistence === "persisted_unknown" ||
        appended.value.lockRelease !== "confirmed"
      ) {
        failures.push(
          failure(
            delivery.provider,
            delivery.deliveryId,
            "event_append",
            appended.ok ? domainError("external_failure") : appended.error,
          ),
        );
        continue;
      }
      const options = Object.freeze({ idempotencyKey });
      const applied = await this.ports.useCases.apply(projected.value, options);
      if (!applied.ok) {
        failures.push(failure(delivery.provider, delivery.deliveryId, "use_case", applied.error));
        continue;
      }
      const completion: InboxCompletion = Object.freeze({
        schemaVersion: 1,
        provider: delivery.provider,
        deliveryId: delivery.deliveryId,
        eventId: projected.value.eventId,
        idempotencyKey,
        outcome: applied.value.outcome,
        completedAt: this.clock.now(),
      });
      const marked = await this.ports.completions.mark(completion, options);
      if (
        !marked.ok ||
        marked.value.classification === "stored_unconfirmed" ||
        marked.value.durability !== "confirmed" ||
        marked.value.lockRelease !== "confirmed"
      ) {
        failures.push(
          failure(
            delivery.provider,
            delivery.deliveryId,
            "completion_write",
            marked.ok ? domainError("external_failure") : marked.error,
          ),
        );
        continue;
      }
      processed += 1;
    }

    return Object.freeze({
      state: failures.length === 0 ? ("completed" as const) : ("partial" as const),
      discovered: listed.value.length,
      processed,
      alreadyCompleted,
      failures: Object.freeze(failures),
    });
  }
}
