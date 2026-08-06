export * from "./authority.js";
export * from "./confirmation.js";
export * from "./draft-store.js";
export * from "./probe-composition.js";
export * from "./probe-config-store.js";
export * from "./probe-handlers.js";
export * from "./secrets.js";
export * from "./setup-composition.js";
export * from "./setup-handlers.js";

import type { RegistrationCliHandlers } from "../program.js";
import { createRegistrationProbeHandlers } from "./probe-handlers.js";
import { createRegistrationSetupHandlers } from "./setup-handlers.js";

export interface CreateRegistrationCliHandlersOptions {
  readonly agentTeamHome: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/** O009 production composition root: the only place that wires up `agent-team registration`. */
export function createRegistrationCliHandlers(
  options: CreateRegistrationCliHandlersOptions,
): RegistrationCliHandlers {
  const setup = createRegistrationSetupHandlers(options);
  const probe = createRegistrationProbeHandlers(options);
  return Object.freeze({ ...setup, ...probe });
}
