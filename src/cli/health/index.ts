import { evaluateRegistrationWakeupHealth } from "../../application/registration/index.js";
import type { CliCommandOutcome } from "../program.js";
import type { RegistrationWakeupStateReader } from "../systemd/index.js";

import {
  webhookAttestationVerificationScope,
  type GlobalWebhookWakeupStateReader,
} from "./webhook-attestation.js";

export interface CreateWakeupHealthHandlerOptions {
  readonly systemdReader?: RegistrationWakeupStateReader;
  readonly webhookReader?: GlobalWebhookWakeupStateReader;
}

function outcome(payload: Readonly<Record<string, unknown>>): CliCommandOutcome {
  return Object.freeze({ state: "success", message: JSON.stringify(payload) });
}

/**
 * Readers remain separate because the timer and webhook transports are independently
 * authoritative. A failed or malformed read cannot establish its own capability.
 */
export function createWakeupHealthHandler(
  options: CreateWakeupHealthHandlerOptions = {},
): () => Promise<CliCommandOutcome> {
  return async () => {
    let systemd: unknown = "unknown";
    let webhook: unknown = "unknown";
    if (options.systemdReader !== undefined) {
      try {
        systemd = await options.systemdReader.readWakeupState();
      } catch {
        systemd = "unknown";
      }
    }
    if (options.webhookReader !== undefined) {
      try {
        webhook = await options.webhookReader.readGlobalWebhookWakeupState();
      } catch {
        webhook = "unknown";
      }
    }
    const health = evaluateRegistrationWakeupHealth({ systemd, webhook });
    return outcome({
      operation: "reconcile_wakeup_status",
      webhookVerificationScope: webhookAttestationVerificationScope,
      ...health,
    });
  };
}
