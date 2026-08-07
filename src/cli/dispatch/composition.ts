/**
 * C015a: the dispatch composition root -- the first production wiring for the C001-C014 dispatch
 * engine (src/application/dispatch|leases|projects), mirroring the exact conventions
 * `src/cli/registration/probe-composition.ts` already established: a strictly sequential,
 * fail-closed prerequisite chain (each step returns `{state:"blocked", reason}` immediately on
 * failure, before any subsequent step -- including any real Linear network call -- ever runs),
 * host paths rooted at `${AGENT_TEAM_HOME}`, and a single `{state:"ready"|"blocked"}` result.
 *
 * Scope (C015a is the "接單" half only): this wires discovery -> eligibility -> lease -> job
 * creation. It deliberately does NOT stand up model provider factories, quota tracking, or
 * pipeline execution -- `routeObservations` is therefore always the empty set here (see
 * `runDispatchOnce` in handlers.ts for the load-bearing consequence: with zero observations,
 * model-work candidates can never reach `kind:"selected"`, so a real (non-dry-run) invocation
 * against typical Linear-discovered work will currently always end in
 * `kind:"waiting", reason:"no_dispatchable_candidate"` -- an honest reflection of "we have not
 * wired up model availability yet," not a bug in this composition). C015b owns wiring a genuine
 * `routeObservations` source.
 */
import { join } from "node:path";

import {
  discoverReadyDispatchCandidates,
  type LinearDiscoverySkippedIssue,
} from "../../adapters/dispatch/index.js";
import { LinearGraphqlTransport } from "../../adapters/linear/index.js";
import { LinearReadModel } from "../../adapters/linear/read.js";
import { LocalGitAdapter } from "../../adapters/git/index.js";
import { FileRegistrationSetupActivationRegistry } from "../../adapters/registration/index.js";
import {
  Dispatcher,
  type DispatcherCandidate,
  type DispatcherResult,
} from "../../application/dispatch/index.js";
import { LeaseCoordinator, type LeaseRepository } from "../../application/leases/index.js";
import {
  ProjectRegistry,
  TrustedProjectConfigLoader,
  type ProjectRegistrySnapshot,
  type TrustedProjectActivationPort,
  type TrustedProjectGitPort,
  type TrustedProjectRejectionReason,
} from "../../application/projects/index.js";
import type { ModelRoutingConfig } from "../../application/routing/index.js";
import type { JobRepository } from "../../application/dispatch/index.js";
import { FileLeaseRepository } from "../../infrastructure/leases/index.js";
import { FileJobRepository } from "../../infrastructure/jobs/index.js";
import {
  defaultRegistrationDraftPath,
  loadHostRegistrationSetupDraft,
} from "../registration/draft-store.js";
import { readLinearApiKey } from "../registration/secrets.js";
import {
  defaultDispatchRoutingConfigPath,
  loadHostDispatchRoutingConfig,
} from "./routing-config-store.js";

export type DispatchCompositionBlockedReason =
  | "draft_unavailable"
  | "linear_api_key_missing"
  | "routing_config_unavailable"
  | TrustedProjectRejectionReason;

export interface DispatchCompositionReady {
  readonly leases: LeaseRepository;
  readonly jobs: JobRepository;
  readonly registry: ProjectRegistrySnapshot;
  readonly routingConfig: ModelRoutingConfig;
  readonly discovery: {
    readonly teamId: string;
    readonly linearProjectId: string;
    readonly readModel: LinearReadModel;
  };
  readonly project: ProjectRegistrySnapshot["ready"][number]["project"];
}

export type BuildDispatchCompositionResult =
  | Readonly<{ state: "ready"; value: DispatchCompositionReady }>
  | Readonly<{ state: "blocked"; reason: DispatchCompositionBlockedReason }>;

export interface BuildDispatchCompositionOptions {
  readonly agentTeamHome: string;
  readonly projectId: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly linearFetch?: typeof fetch;
  /** Injectable for tests (same convention as `probe-composition.ts`'s `githubTransport`);
   * production defaults to a real `LocalGitAdapter`/`FileRegistrationSetupActivationRegistry`. */
  readonly gitPort?: TrustedProjectGitPort;
  readonly activationPort?: TrustedProjectActivationPort;
}

export interface DispatchOncePorts {
  readonly leases: LeaseCoordinator;
  readonly jobs: JobRepository;
}

/**
 * Runs the real discovery -> `Dispatcher.dispatch()` path exactly once, against whichever ports
 * are supplied -- the real file-backed ones for a genuine run, or the ephemeral in-memory ones
 * (ephemeral-ports.ts) for `--dry-run`. Factoring this out means both CLI modes exercise the
 * identical engine call, so a dry-run's prediction can never drift from what a real run does.
 */
export async function dispatchOnce(
  ready: DispatchCompositionReady,
  ports: DispatchOncePorts,
  holderId: string,
): Promise<
  Readonly<{
    result: DispatcherResult;
    candidates: readonly DispatcherCandidate[];
    discoverySkipped: readonly LinearDiscoverySkippedIssue[];
  }>
> {
  const discovered = await discoverReadyDispatchCandidates({
    project: ready.project,
    teamId: ready.discovery.teamId,
    linearProjectId: ready.discovery.linearProjectId,
    readModel: ready.discovery.readModel,
  });
  if (!discovered.ok) {
    return Object.freeze({
      result: Object.freeze({ kind: "blocked", reason: "invalid_runtime_input", skipped: [] }),
      candidates: [],
      discoverySkipped: [],
    });
  }
  const dispatcher = new Dispatcher(ports);
  const result = await dispatcher.dispatch({
    holderId,
    candidates: discovered.value.candidates,
    registry: ready.registry,
    active: [],
    routingConfig: ready.routingConfig,
    routeObservations: [],
  });
  return Object.freeze({
    result,
    candidates: discovered.value.candidates,
    discoverySkipped: discovered.value.skipped,
  });
}

export async function buildDispatchComposition(
  options: BuildDispatchCompositionOptions,
): Promise<BuildDispatchCompositionResult> {
  const agentTeamHome = options.agentTeamHome;
  const draftPath = defaultRegistrationDraftPath(agentTeamHome, options.projectId);
  const draft = await loadHostRegistrationSetupDraft(draftPath, options.projectId);
  if (!draft.ok) {
    return Object.freeze({ state: "blocked", reason: "draft_unavailable" });
  }

  const linearApiKey = readLinearApiKey(options.environment);
  if (!linearApiKey.ok) {
    return Object.freeze({ state: "blocked", reason: "linear_api_key_missing" });
  }

  const routingConfigPath = defaultDispatchRoutingConfigPath(agentTeamHome);
  const routingConfig = await loadHostDispatchRoutingConfig(routingConfigPath);
  if (!routingConfig.ok) {
    return Object.freeze({ state: "blocked", reason: "routing_config_unavailable" });
  }

  const stateRoot = join(agentTeamHome, "state");
  const activationRegistry =
    options.activationPort ?? new FileRegistrationSetupActivationRegistry(stateRoot);
  const loader = new TrustedProjectConfigLoader(
    options.gitPort ?? new LocalGitAdapter(),
    activationRegistry,
  );
  const projectRegistry = new ProjectRegistry(loader);
  const registry = await projectRegistry.load([draft.value.project]);
  const readyEntry = registry.ready.find((entry) => entry.project.id === draft.value.project.id);
  if (readyEntry === undefined) {
    const rejection = registry.rejected.find(
      (entry) => entry.project === undefined || entry.project.id === draft.value.project.id,
    );
    return Object.freeze({
      state: "blocked",
      reason: rejection?.reason ?? "trusted_config_missing",
    });
  }

  const linearTransport = new LinearGraphqlTransport({
    apiKey: linearApiKey.value,
    ...(options.linearFetch === undefined ? {} : { fetch: options.linearFetch }),
  });
  const readModel = new LinearReadModel(linearTransport);

  const leases = new FileLeaseRepository(
    join(stateRoot, "leases.json"),
    join(stateRoot, "leases.lock"),
  );
  const jobs = new FileJobRepository(join(stateRoot, "jobs.json"), join(stateRoot, "jobs.lock"));

  return Object.freeze({
    state: "ready",
    value: Object.freeze({
      leases,
      jobs,
      registry,
      routingConfig: routingConfig.value,
      discovery: Object.freeze({
        teamId: readyEntry.project.workManagement.containerId,
        linearProjectId: readyEntry.project.workManagement.projectId,
        readModel,
      }),
      project: readyEntry.project,
    }),
  });
}
