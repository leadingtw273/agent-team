import type { RegistrationReadOnlyScanPorts } from "../../application/ports/index.js";

import type { GitHubRegistrationReadOnlyProbes } from "./github.js";
import type { LinearRegistrationReadOnlyProbeAdapter } from "./linear.js";
import type { LocalRegistrationReadOnlyProbes } from "./local.js";
import type { WebhookRuntimeConfigurationProbeAdapter } from "./webhook.js";

/**
 * The Runtime composition point for O002's seven observational ports. Keeping
 * this assembly explicit prevents the UI fixture from becoming the production
 * scan implementation and prevents later flows from widening this boundary.
 */
export interface RegistrationReadOnlyProbeAdapters {
  readonly local: LocalRegistrationReadOnlyProbes;
  readonly github: GitHubRegistrationReadOnlyProbes;
  readonly linear: LinearRegistrationReadOnlyProbeAdapter;
  readonly webhook: WebhookRuntimeConfigurationProbeAdapter;
}

export function createRegistrationReadOnlyScanPorts(
  adapters: RegistrationReadOnlyProbeAdapters,
): RegistrationReadOnlyScanPorts {
  return Object.freeze({
    localRepository: adapters.local.localRepository,
    nodeRuntime: adapters.local.nodeRuntime,
    compiledCli: adapters.local.compiledCli,
    github: adapters.github.github,
    linear: adapters.linear,
    continuousIntegration: adapters.github.continuousIntegration,
    webhookRuntime: adapters.webhook,
  });
}
