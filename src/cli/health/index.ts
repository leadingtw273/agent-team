import {
  evaluateRegistrationWakeupHealth,
  unknownRegistrationWakeupSources,
  type RegistrationWakeupSources,
} from "../../application/registration/index.js";
import type { CliCommandOutcome } from "../program.js";

export interface RegistrationWakeupSourceReader {
  readonly read: () => Promise<unknown>;
}

export interface CreateWakeupHealthHandlerOptions {
  readonly reader?: RegistrationWakeupSourceReader;
}

const unwiredRuntimeSources = Object.freeze({
  systemd: "runtime_unavailable",
  webhook: "unknown",
} as const satisfies RegistrationWakeupSources);

function outcome(payload: Readonly<Record<string, unknown>>): CliCommandOutcome {
  return Object.freeze({ state: "success", message: JSON.stringify(payload) });
}

/**
 * A source reader is injected by later Runtime composition. Until then the
 * compiled CLI knows that its own Reconcile Runtime is unwired, so the systemd
 * path is unavailable; the Webhook path remains unknown. This avoids calling
 * systemctl or a Webhook while still naming the real degraded condition.
 */
export function createWakeupHealthHandler(
  options: CreateWakeupHealthHandlerOptions = {},
): () => Promise<CliCommandOutcome> {
  return async () => {
    let sources: unknown = unwiredRuntimeSources;
    if (options.reader !== undefined) {
      try {
        sources = await options.reader.read();
      } catch {
        sources = unknownRegistrationWakeupSources();
      }
    }
    const health = evaluateRegistrationWakeupHealth(sources);
    return outcome({ operation: "reconcile_wakeup_status", ...health });
  };
}
