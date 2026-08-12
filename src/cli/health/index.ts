import {
  evaluateRegistrationWakeupHealth,
  unknownRegistrationWakeupSources,
} from "../../application/registration/index.js";
import type { CliCommandOutcome } from "../program.js";
import type { RegistrationWakeupStateReader } from "../systemd/index.js";

export interface CreateWakeupHealthHandlerOptions {
  readonly reader?: RegistrationWakeupStateReader;
}

function outcome(payload: Readonly<Record<string, unknown>>): CliCommandOutcome {
  return Object.freeze({ state: "success", message: JSON.stringify(payload) });
}

/**
 * The systemd reader is the shared production manager; webhook Runtime remains
 * unknown until its own authoritative health reader exists. A failed or malformed
 * systemd read cannot establish a wakeup capability.
 */
export function createWakeupHealthHandler(
  options: CreateWakeupHealthHandlerOptions = {},
): () => Promise<CliCommandOutcome> {
  return async () => {
    let sources: unknown = unknownRegistrationWakeupSources();
    if (options.reader !== undefined) {
      try {
        sources = { systemd: await options.reader.readWakeupState(), webhook: "unknown" };
      } catch {
        sources = unknownRegistrationWakeupSources();
      }
    }
    const health = evaluateRegistrationWakeupHealth(sources);
    return outcome({ operation: "reconcile_wakeup_status", ...health });
  };
}
