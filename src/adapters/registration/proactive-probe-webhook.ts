import type {
  RegistrationWebhookProbeOutcome,
  RegistrationWebhookProbePort,
  RegistrationWebhookProbeRequest,
} from "../../application/ports/index.js";
import {
  NodeWebhookRuntimeTransport,
  WebhookRuntimeProbeClient,
  type WebhookRuntimeProbeInbox,
  type WebhookRuntimeProbeOutcome,
  type WebhookRuntimeTransport,
} from "../../cli/probe/index.js";
import type { Clock } from "../../domain/foundation/index.js";

export interface RegistrationProbeWebhookAdapterOptions {
  readonly transport?: WebhookRuntimeTransport;
  /** Must point at the same durable Inbox the running local Webhook Runtime writes into. */
  readonly inbox: WebhookRuntimeProbeInbox;
  readonly clock: Clock;
  readonly createDeliveryId: () => string;
}

function toRegistrationOutcome(
  outcome: WebhookRuntimeProbeOutcome,
): RegistrationWebhookProbeOutcome {
  if (outcome.state === "verified") {
    return Object.freeze({
      state: "verified" as const,
      provider: outcome.provider,
      deliveryId: outcome.deliveryId,
      latencyMs: outcome.latencyMs,
      inboxSha256: outcome.inboxSha256,
    });
  }
  return Object.freeze({ state: "failed" as const, reason: outcome.reason });
}

/**
 * The only bridge between application-facing O006 port types and W004's CLI probe client.
 * `WebhookRuntimeProbeClient` already implements every AC-3 invariant (raw-bytes HMAC signing,
 * unique Delivery ID, exact Inbox read-back, latency bound); this adapter only translates its
 * richer outcome shape (which also carries the resolved `endpoint`, useful for CLI diagnostics)
 * into the narrower, audit-safe `RegistrationWebhookProbeOutcome` union -- it never widens or
 * reinterprets a W004 rejection into a different reason code.
 */
export class RegistrationProbeWebhookAdapter implements RegistrationWebhookProbePort {
  readonly #client: Pick<WebhookRuntimeProbeClient, "run">;

  constructor(options: RegistrationProbeWebhookAdapterOptions) {
    this.#client = new WebhookRuntimeProbeClient(
      options.transport ?? new NodeWebhookRuntimeTransport(),
      options.inbox,
      options.clock,
      options.createDeliveryId,
    );
  }

  async runSyntheticProbe(
    request: RegistrationWebhookProbeRequest,
  ): Promise<RegistrationWebhookProbeOutcome> {
    const outcome = await this.#client.run({
      baseUrl: request.baseUrl,
      provider: request.provider,
      secret: request.secret,
    });
    return toRegistrationOutcome(outcome);
  }
}
