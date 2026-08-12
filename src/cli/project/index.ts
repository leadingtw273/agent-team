import { join } from "node:path";

import { FileJobProgressStore } from "../../adapters/dispatch/job-progress-store.js";
import { LocalGitAdapter } from "../../adapters/git/index.js";
import { FileRegistrationSetupActivationRegistry } from "../../adapters/registration/index.js";
import { ProjectRegistry, TrustedProjectConfigLoader } from "../../application/projects/index.js";
import { createClock } from "../../domain/foundation/index.js";
import { FileJobRepository } from "../../infrastructure/jobs/index.js";
import { FileLeaseRepository } from "../../infrastructure/leases/index.js";
import type { CliCommandOutcome, CliHandlers } from "../program.js";
import { listHostRegistrationSetupDrafts } from "../registration/draft-store.js";
import type { RegistrationWakeupStateReader } from "../systemd/index.js";

import { ProjectReadModel, type ProjectReadResult } from "./read-model.js";
import { serializeProjectPayload } from "./schema.js";

export * from "./read-model.js";
export * from "./schema.js";

export interface CreateProjectCliHandlersOptions {
  readonly agentTeamHome: string;
  readonly wakeupReader?: RegistrationWakeupStateReader;
}

function render(result: ProjectReadResult): CliCommandOutcome {
  try {
    return Object.freeze({
      state: result.state === "success" ? "success" : "failed",
      message: serializeProjectPayload(result.payload),
    });
  } catch {
    return Object.freeze({
      state: "failed",
      message: serializeProjectPayload({
        operation: "project_detail",
        schemaVersion: 1,
        state: "failed",
        reason: "project_read_failed",
      }),
    });
  }
}

export function createProjectHandler(
  model: Pick<ProjectReadModel, "read">,
): CliHandlers["project"] {
  return async (input) => render(await model.read(input));
}

/**
 * Production composition for the `project` read model. Every port is local and read-only: draft
 * discovery, trusted default-branch config/activation read-back, durable progress, Jobs, and
 * Leases. In particular, this deliberately has no Linear, GitHub, provider, or systemd adapter.
 */
export function createProjectReadModel(options: CreateProjectCliHandlersOptions): ProjectReadModel {
  const stateRoot = join(options.agentTeamHome, "state");
  const activation = new FileRegistrationSetupActivationRegistry(stateRoot);
  const loader = new TrustedProjectConfigLoader(new LocalGitAdapter(), activation);
  return new ProjectReadModel({
    discoverDrafts: () => listHostRegistrationSetupDrafts(options.agentTeamHome),
    registry: new ProjectRegistry(loader),
    progress: new FileJobProgressStore(join(stateRoot, "dispatch", "progress")),
    jobs: new FileJobRepository(join(stateRoot, "jobs.json"), join(stateRoot, "jobs.lock")),
    leases: new FileLeaseRepository(join(stateRoot, "leases.json"), join(stateRoot, "leases.lock")),
    clock: createClock(),
    ...(options.wakeupReader === undefined ? {} : { wakeupReader: options.wakeupReader }),
  });
}

export function createProjectCliHandlers(
  options: CreateProjectCliHandlersOptions,
): Pick<CliHandlers, "project"> {
  const model = createProjectReadModel(options);
  return Object.freeze({ project: createProjectHandler(model) });
}
