import type { AsyncPortResult, ReadOptions } from "../ports/index.js";
import type {
  WebhookReadBackChange,
  WebhookReadBackPort,
  WebhookReadBackRequest,
} from "./webhook-model.js";

/**
 * Provider-neutral application bridge for authoritative webhook recovery reads.
 * Both provider ports are required so a reconcile tick cannot silently omit one.
 */
export interface WebhookReadBackRouterPorts {
  readonly github: WebhookReadBackPort;
  readonly linear: WebhookReadBackPort;
}

export class WebhookReadBackRouter implements WebhookReadBackPort {
  constructor(readonly providers: WebhookReadBackRouterPorts) {}

  readChanges(
    request: WebhookReadBackRequest,
    options?: ReadOptions,
  ): AsyncPortResult<readonly WebhookReadBackChange[]> {
    return this.providers[request.provider].readChanges(request, options);
  }
}
