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
 * pipeline execution -- `routeObservations` is therefore always the empty set here.
 *
 * A real (non-dry-run) invocation against typical Linear-discovered work will currently always
 * end in `kind:"waiting"`, for **two independent reasons** -- do not assume fixing one fixes the
 * other:
 *
 * 1. (Earlier, and blocking on its own) The Linear discovery bridge's `toDomainIssue`
 *    (src/adapters/dispatch/linear-discovery.ts) does not populate `goal`/`acceptanceCriteria`/
 *    `inScope`/`outOfScope`/`estimatedMinutes` on the `Issue` it produces -- `LinearIssueSnapshot`
 *    has no such fields at all. `evaluateEligibility` runs *before* routing ever sees a
 *    candidate, so every real candidate fails eligibility (`reason:"no_eligible_candidates"`) and
 *    is filtered out long before `routeObservations` is ever consulted.
 * 2. (Only reachable once #1 is fixed) With zero `routeObservations`, model-work candidates that
 *    *do* clear eligibility can still never reach `kind:"selected"` (`reason:
 *    "no_dispatchable_candidate"`) -- an honest reflection of "we have not wired up model
 *    availability yet," not a bug in this composition.
 *
 * Wiring a genuine `routeObservations` source is **not sufficient** to make a real `run` produce
 * a dispatched job -- #1 has to be closed first, and closing it is not this composition's job
 * (see linear-discovery.ts's own comment on `toDomainIssue` for why). C015b owns #2;
 * #1 is presently unowned and should be raised as its own ticket rather than assumed folded into
 * C015b's scope.
 *
 * `active` is likewise always the empty set here -- this composition has no source of "jobs
 * currently in flight" (that is `pipeline` state, and C015a stands up no pipeline). This is safe
 * against duplicate dispatch of the *same* issue because the real guard against that is not
 * `active`, it is the per-issue `Lease`: `canAcquireLease` (src/domain/jobs/lease.ts) treats an
 * active lease with a matching `issueId` (not just `jobId`) as a conflict, and `dispatchOnce`
 * always constructs a real `LeaseCoordinator` over the ports it is given (a real
 * `FileLeaseRepository` for a genuine run, an ephemeral in-memory one for `--dry-run` --
 * see `tests/unit/dispatch-once-lease-conflict.test.ts` for a real-file-backed proof of this).
 * The one residual gap `active:[]` leaves open: once a lease *expires* (its holder is presumed
 * dead), and the underlying Linear issue is still `ready` (C015a runs no pipeline, so nothing
 * ever moves it out of ready), a later `run` will create a *second* `Job` record for the same
 * issue -- this is judged acceptable, not a defect, because lease expiry's whole semantic is "the
 * previous attempt is presumed dead, retry", and C015b's own execution is itself lease-gated so
 * the two job records can never run concurrently.
 *
 * `dependencyContexts` is never passed to `Dispatcher.dispatch()` here (C015a has no source of
 * cross-issue completion state). This is fail-closed, not fail-open: `evaluateEligibility`
 * (src/domain/eligibility/decision.ts) defaults an unresolvable dependency to `"unknown"` state
 * when no context entry exists, which is never treated as `"completed"` -- so any issue declaring
 * `dependencies: { kind: "issues" }` is unconditionally ineligible until C015b wires a real
 * dependency-state source, never silently dispatched early.
 */
import { join } from "node:path";

import {
  discoverReadyDispatchCandidates,
  type LinearDiscoverySkippedIssue,
} from "../../adapters/dispatch/index.js";
import { LinearGraphqlTransport } from "../../adapters/linear/index.js";
import { LinearReadModel } from "../../adapters/linear/read.js";
import { LocalGitAdapter } from "../../adapters/git/index.js";
import { ChildProcessRunner } from "../../adapters/process/index.js";
import { FileRegistrationSetupActivationRegistry } from "../../adapters/registration/index.js";
import {
  Dispatcher,
  type DispatcherCandidate,
  type DispatcherResult,
} from "../../application/dispatch/index.js";
import { LeaseCoordinator, type LeaseRepository } from "../../application/leases/index.js";
import type { ProcessPort } from "../../application/ports/index.js";
import {
  ProjectRegistry,
  TrustedProjectConfigLoader,
  type ProjectRegistrySnapshot,
  type TrustedProjectActivationPort,
  type TrustedProjectConfig,
  type TrustedProjectGitPort,
  type TrustedProjectRejectionReason,
} from "../../application/projects/index.js";
import type { ModelRoutingConfig } from "../../application/routing/index.js";
import type { JobRepository } from "../../application/dispatch/index.js";
import type { DomainError } from "../../domain/foundation/index.js";
import { FileLeaseRepository } from "../../infrastructure/leases/index.js";
import { FileJobRepository } from "../../infrastructure/jobs/index.js";
import {
  defaultRegistrationDraftPath,
  loadHostRegistrationSetupDraft,
} from "../registration/draft-store.js";
import { readLinearApiKey } from "../registration/secrets.js";
import { observeClaudeRouteCandidates } from "./claude-observation.js";
import {
  defaultDispatchProviderConfigPath,
  loadHostDispatchProviderConfig,
  type DispatchProviderConfig,
} from "./provider-config-store.js";
import {
  defaultDispatchRoutingConfigPath,
  loadHostDispatchRoutingConfig,
} from "./routing-config-store.js";

export type DispatchCompositionBlockedReason =
  | "draft_unavailable"
  | "linear_api_key_missing"
  | "routing_config_unavailable"
  | "provider_config_unavailable"
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
  /** The same entry's trusted config (src/application/projects/loader.ts) -- C015b's run-flow
   * needs this to build an `ImplementerPipelineRequest`; C015a never needed it because it never
   * ran a pipeline. */
  readonly trustedConfig: TrustedProjectConfig;
  readonly claude: {
    readonly config: DispatchProviderConfig["claude"];
    /** Injectable for tests; production defaults to a real `ChildProcessRunner` (R001). */
    readonly process: ProcessPort;
  };
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
  /** Injectable for tests; production defaults to a real `ChildProcessRunner`. */
  readonly claudeProcessPort?: ProcessPort;
}

export interface DispatchOncePorts {
  readonly leases: LeaseCoordinator;
  readonly jobs: JobRepository;
}

/**
 * `dispatchOnce`'s result. Deliberately a discriminated union distinct from `DispatcherResult`
 * (the engine's own type, src/application/dispatch/dispatcher.ts) rather than reusing the
 * engine's `kind:"blocked", reason:"invalid_runtime_input"` shape for a discovery failure: a
 * Linear read failure is an *external call fault* upstream of the engine ever running, not the
 * engine rejecting malformed input it was handed. Collapsing the two under one reason code would
 * mislead whoever reads the CLI's JSON output into debugging the wrong layer (see the C015a
 * acceptance review's observation on this exact point). This type is additive to, and never
 * modifies, the engine's own `DispatcherResult`.
 */
export type DispatchOnceOutcome =
  | Readonly<{
      outcome: "ran";
      result: DispatcherResult;
      candidates: readonly DispatcherCandidate[];
      discoverySkipped: readonly LinearDiscoverySkippedIssue[];
    }>
  | Readonly<{ outcome: "discovery_failed"; error: DomainError }>;

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
): Promise<DispatchOnceOutcome> {
  const discovered = await discoverReadyDispatchCandidates({
    project: ready.project,
    teamId: ready.discovery.teamId,
    linearProjectId: ready.discovery.linearProjectId,
    readModel: ready.discovery.readModel,
  });
  if (!discovered.ok) {
    return Object.freeze({ outcome: "discovery_failed" as const, error: discovered.error });
  }
  // C015b item 2: a real (not hard-coded-empty) observation -- see claude-observation.ts's own
  // header for exactly what "real" means here (a live `--version` probe, not a static echo) and
  // what it deliberately does not attempt (quota tracking; no adapter for that exists yet).
  const routeObservations = await observeClaudeRouteCandidates({
    process: ready.claude.process,
    config: ready.claude.config,
    workingDirectory: ready.project.localRepositoryPath,
  });
  const dispatcher = new Dispatcher(ports);
  const result = await dispatcher.dispatch({
    holderId,
    candidates: discovered.value.candidates,
    registry: ready.registry,
    active: [],
    routingConfig: ready.routingConfig,
    routeObservations,
  });
  return Object.freeze({
    outcome: "ran" as const,
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

  const providerConfigPath = defaultDispatchProviderConfigPath(agentTeamHome);
  const providerConfig = await loadHostDispatchProviderConfig(providerConfigPath);
  if (!providerConfig.ok) {
    return Object.freeze({ state: "blocked", reason: "provider_config_unavailable" });
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
      trustedConfig: readyEntry.config,
      claude: Object.freeze({
        config: providerConfig.value.claude,
        process: options.claudeProcessPort ?? new ChildProcessRunner(),
      }),
    }),
  });
}
