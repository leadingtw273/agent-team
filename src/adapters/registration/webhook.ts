import type {
  AsyncPortResult,
  RegistrationWebhookRuntimeReadOnlyProbePort,
  ReadOptions,
} from "../../application/ports/index.js";
import { domainError, err, ok } from "../../domain/foundation/index.js";

export interface WebhookRuntimeConfigurationReader {
  readonly readRuntimeBaseUrl: (options?: ReadOptions) => AsyncPortResult<string | null>;
}

export interface WebhookRuntimeConfigurationProbeOptions {
  readonly reader?: WebhookRuntimeConfigurationReader;
  readonly now?: () => string;
}

function observedAt(clock: () => string): string {
  const candidate = clock();
  return Number.isFinite(Date.parse(candidate)) ? candidate : new Date().toISOString();
}

function safeRuntimeBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.search.length === 0 &&
      url.hash.length === 0 &&
      (url.pathname === "/" || url.pathname.length === 0)
    );
  } catch {
    return false;
  }
}

/**
 * O002 reads only the local Runtime URL configuration. It intentionally never
 * sends a signed delivery; active delivery and inbox read-back belong to O006.
 */
export class WebhookRuntimeConfigurationProbeAdapter implements RegistrationWebhookRuntimeReadOnlyProbePort {
  readonly #reader: WebhookRuntimeConfigurationReader | undefined;
  readonly #now: () => string;

  constructor(options: WebhookRuntimeConfigurationProbeOptions = {}) {
    this.#reader = options.reader;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async inspect(
    options: ReadOptions = {},
  ): ReturnType<RegistrationWebhookRuntimeReadOnlyProbePort["inspect"]> {
    const at = observedAt(this.#now);
    if (this.#reader === undefined) {
      return ok({
        state: "unknown",
        evidence: Object.freeze(["尚未設定 Webhook Runtime 設定讀取器，因此未發出網路請求。"]),
        provenance: "webhook_configuration",
        observedAt: at,
      });
    }
    if (options.signal?.aborted === true) return err(domainError("interrupted"));
    const configured = await this.#reader.readRuntimeBaseUrl(options);
    if (!configured.ok) return configured;
    if (configured.value === null) {
      return ok({
        state: "unknown",
        evidence: Object.freeze(["Webhook Runtime URL 尚未設定。"]),
        provenance: "webhook_configuration",
        observedAt: at,
      });
    }
    if (!safeRuntimeBaseUrl(configured.value)) {
      return ok({
        state: "failed",
        evidence: Object.freeze([
          "Webhook Runtime URL 格式不符合 HTTPS 與無帳密／Query／Fragment 的安全條件。",
        ]),
        provenance: "webhook_configuration",
        observedAt: at,
      });
    }
    return ok({
      state: "unknown",
      evidence: Object.freeze([
        "Webhook Runtime URL 格式已確認；O002 未送出 delivery，因此可達性與簽章仍無法確認。",
      ]),
      provenance: "webhook_configuration",
      observedAt: at,
    });
  }
}
