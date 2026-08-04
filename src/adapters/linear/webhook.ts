import type { RawWebhookRequest, WebhookInbox, WebhookIngestResult } from "../webhook/index.js";
import { linearWebhookContract, RawWebhookAdapter } from "../webhook/index.js";

export class LinearWebhookAdapter {
  readonly #adapter: RawWebhookAdapter;

  constructor(inbox: WebhookInbox, secret: Uint8Array) {
    this.#adapter = new RawWebhookAdapter(linearWebhookContract, inbox, secret);
  }

  ingest(request: RawWebhookRequest): Promise<WebhookIngestResult> {
    return this.#adapter.ingest(request);
  }
}
