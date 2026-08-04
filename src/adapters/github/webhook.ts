import type { RawWebhookRequest, WebhookInbox, WebhookIngestResult } from "../webhook/index.js";
import { githubWebhookContract, RawWebhookAdapter } from "../webhook/index.js";

export class GitHubWebhookAdapter {
  readonly #adapter: RawWebhookAdapter;

  constructor(inbox: WebhookInbox, secret: Uint8Array) {
    this.#adapter = new RawWebhookAdapter(githubWebhookContract, inbox, secret);
  }

  ingest(request: RawWebhookRequest): Promise<WebhookIngestResult> {
    return this.#adapter.ingest(request);
  }
}
