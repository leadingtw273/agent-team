/**
 * C015a: the dispatch composition root -- the first production wiring for the C001-C014 dispatch
 * engine (src/application/dispatch|leases|projects), mirroring the exact conventions
 * `src/cli/registration/probe-composition.ts` already established: a strictly sequential,
 * fail-closed prerequisite chain (each step returns `{state:"blocked", reason}` immediately on
 * failure, before any subsequent step -- including any real Linear network call -- ever runs),
 * host paths rooted at `${AGENT_TEAM_HOME}`, and a single `{state:"ready"|"blocked"}` result.
 *
 * Scope: this wires discovery -> eligibility -> quota admission -> provider liveness -> issue
 * admission -> lease -> job creation. T03A adds a fail-closed quota boundary before every durable
 * claim. QP02 supplies the Claude-only production collector when the private host config is
 * trusted; absent/invalid/stale evidence remains `quota_unknown`. Tests may still inject a
 * controlled policy-backed port.
 *
 * A real invocation against typical Linear-discovered work can still end in `kind:"waiting"` for
 * independent reasons -- do not assume fixing one fixes the others:
 *
 * 1. (Earlier, and blocking on its own) The Linear discovery bridge's `toDomainIssue`
 *    (src/adapters/dispatch/linear-discovery.ts) does not populate `goal`/`acceptanceCriteria`/
 *    `inScope`/`outOfScope`/`estimatedMinutes` on the `Issue` it produces -- `LinearIssueSnapshot`
 *    has no such fields at all. `evaluateEligibility` runs *before* routing ever sees a
 *    candidate, so every real candidate fails eligibility (`reason:"no_eligible_candidates"`) and
 *    is filtered out before quota or model routing is consulted.
 * 2. A candidate that clears eligibility still requires a trusted, fresh quota observation. Until
 *    a real collector is wired, the production default intentionally reports `quota_unknown` and
 *    performs no provider process probe or durable write.
 * 3. Quota-ready candidates also require a live execution-provider route. Claude has a liveness
 *    probe; other providers remain unavailable until their runner wiring exists.
 *
 * Wiring a collector alone is therefore **not sufficient** to make a real `run` dispatch: the
 * Linear projection and provider runner/liveness boundaries must also be complete.
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
  type IssueAdmissionPort,
  type LinearDiscoverySkippedIssue,
} from "../../adapters/dispatch/index.js";
import { FileOperatorCanaryAttestationStore } from "../../adapters/dispatch/operator-canary-attestation-store.js";
import type {
  ClaudeQuotaCollector,
  ClaudeQuotaRefresher,
} from "../../adapters/providers/claude/index.js";
import { LinearGraphqlTransport } from "../../adapters/linear/index.js";
import { LinearReadModel } from "../../adapters/linear/read.js";
import { LinearMutationClient } from "../../adapters/linear/write.js";
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
import type { NewJobQuotaAdmissionPort } from "../../application/quota/index.js";
import {
  ProjectRegistry,
  TrustedProjectConfigLoader,
  type ProjectRegistrySnapshot,
  type TrustedProjectActivationPort,
  type TrustedProjectConfig,
  type TrustedProjectGitPort,
  type TrustedProjectRejectionReason,
} from "../../application/projects/index.js";
import {
  selectModelRoute,
  type CandidateObservation,
  type ModelRouteDecision,
  type ModelRoutingConfig,
} from "../../application/routing/index.js";
import type { JobRepository } from "../../application/dispatch/index.js";
import type { Clock, DomainError } from "../../domain/foundation/index.js";
import { FileLeaseRepository } from "../../infrastructure/leases/index.js";
import { FileJobRepository } from "../../infrastructure/jobs/index.js";
import {
  defaultRegistrationDraftPath,
  loadHostRegistrationSetupDraft,
} from "../registration/draft-store.js";
import { readLinearApiKeyWithFileFallback } from "../registration/secrets.js";
import { observeClaudeRouteCandidates } from "./claude-observation.js";
import {
  consumeExactOperatorCanaryCandidate,
  hasNormalModelAdmissionCandidate,
} from "./operator-canary-attestation.js";
import { applyProviderLiveness, observeQuotaRouteCandidates } from "./quota-admission.js";
import { createProductionQuotaAdmission } from "./quota-composition.js";
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
  /** C015c item 2: the engine's own `JobRepository` interface only declares `create` --
   * `runResumeCycle` (resume-composition.ts) also needs `readAll`/`update` (C015c item 1's
   * addition to `FileJobRepository`, deliberately not added to the engine interface). `Pick<...>`
   * here (rather than the concrete class) keeps this purely structural, so every existing fake
   * that only ever implemented plain `JobRepository` needs nothing more than adding those two
   * extra methods, not becoming a real `FileJobRepository` instance (which is impossible for an
   * external class anyway -- it has a private field). */
  readonly jobs: JobRepository & Pick<FileJobRepository, "readAll" | "update">;
  readonly registry: ProjectRegistrySnapshot;
  readonly routingConfig: ModelRoutingConfig;
  readonly discovery: {
    readonly teamId: string;
    readonly linearProjectId: string;
    readonly readModel: LinearReadModel;
    /** C015c item 5: shares the same `LinearGraphqlTransport`/`readModel` pair as `readModel`
     * above -- `LinearMutationClient`'s own constructor requires a `LinearIssueReader`, and
     * `LinearReadModel` already satisfies that shape (`readIssue`), so this is not a second
     * connection, just a second, narrower view over the same transport. Needed by
     * `LifecyclePipeline`'s production composition (lifecycle-composition.ts) to mark a merged
     * issue's Linear work status completed. Narrowed to the three methods
     * `LinearWorkManagementAdapter` actually calls -- the same `Pick<...>`-over-a-concrete-class
     * convention `LinearDiscoveryReadModel` (linear-discovery.ts) already established, so tests
     * can fake this with a plain object instead of a real `LinearMutationClient` instance. */
    readonly mutationClient: Pick<
      LinearMutationClient,
      "observeGithubMerge" | "requireManualIntervention" | "setAgentCondition" | "appendComment"
    >;
    /** E102-5: the same transport `readModel`/`mutationClient` above already share -- threaded
     * through `handlers.ts` to `buildResumeComposition` so it can construct a real
     * `LinearUploadClient` (upload.ts) for `LinearVisualPublicationCoordinator`, never a second,
     * independently-configured transport. */
    readonly linearTransport: LinearGraphqlTransport;
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
  /** T03A: required new-Job quota boundary. Production is fail-closed until a trusted collector
   * supplies Provider-owned identity and both required windows. Tests may inject a controlled
   * policy-backed port; config.account is never used as identity. */
  readonly quotaAdmission: NewJobQuotaAdmissionPort;
  /** Q01's private, issue-scoped canary store. It is not a quota port and is only consulted by a
   * non-dry dispatch after ordinary quota observations leave all model routes unavailable. */
  readonly operatorCanary?: {
    readonly store: FileOperatorCanaryAttestationStore;
  };
  /** E102-2: the same host provider config file's optional `gemini` key, read alongside `claude`
   * above -- `undefined`/absent when this host has no real visual-review provider configured.
   * Optional here (not merely a possibly-`undefined`-valued required field) so every pre-existing
   * fake `DispatchCompositionReady` in this repo's tests -- built before Gemini config existed --
   * keeps type-checking unchanged. Threaded by the CLI (`handlers.ts`) into
   * `buildResumeComposition` -> `buildReviewerPipeline` (reviewer-composition.ts); see that file's
   * own header for why an absent `gemini` key fails closed per-job rather than blocking this
   * composition. */
  readonly gemini?: DispatchProviderConfig["gemini"];
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
  /** Test/canary seam only. Production deliberately defaults to collector_unavailable. */
  readonly quotaAdmissionPort?: NewJobQuotaAdmissionPort;
  /** QP02 test seams; production always uses the real Claude collector and wall clock. */
  readonly quotaCollector?: ClaudeQuotaCollector;
  readonly quotaRefresher?: ClaudeQuotaRefresher;
  readonly quotaClock?: Clock;
  /** Test seam for Q01's independent, project-and-opaque-issue scoped attestation store. */
  readonly operatorCanaryStore?: FileOperatorCanaryAttestationStore;
}

export interface DispatchOncePorts {
  readonly leases: LeaseCoordinator;
  readonly jobs: JobRepository;
  /** C015o decision 3: the durable, atomically-CAS-guarded per-issue admission claim
   * (src/adapters/dispatch/issue-admission-store.ts) -- production defaults to a real
   * `FileIssueAdmissionStore`; `--dry-run` uses the ephemeral `InMemoryIssueAdmissionStore`
   * (ephemeral-ports.ts), the same "throwaway in-memory" convention `leases`/`jobs` already use. */
  readonly admission: IssueAdmissionPort;
}

/** C015o decision 3: an issue whose admission claim was already `state:"active"` when this
 * candidate was considered -- a *different*, still-unresolved job already owns it. Visible,
 * distinct from `LinearDiscoverySkippedIssue` (which is discovery's own, engine-independent skip
 * taxonomy) -- this reason only exists past discovery, at the composition root. */
export type DispatchOnceAdmissionSkippedIssue =
  | Readonly<{ issueId: string; reason: "issue_claim_active" }>
  | Readonly<{
      issueId: string;
      reason: "quota_unknown" | "quota_blocked" | "provider_route_unavailable";
    }>;

function routeAdmissionSkipReason(
  decision: Extract<ModelRouteDecision, { kind: "waiting" }>,
): Exclude<DispatchOnceAdmissionSkippedIssue["reason"], "issue_claim_active"> {
  const states = new Set(decision.skipped.map((candidate) => candidate.state));
  if (states.has("quota_unknown")) return "quota_unknown";
  if (states.has("quota_blocked")) return "quota_blocked";
  return "provider_route_unavailable";
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
      /** C015o decision 3: candidates discovery/eligibility would otherwise have handed to
       * `Dispatcher.dispatch()`, but whose issue already had an unresolved admission claim from a
       * different, still-open job -- see `dispatchOnce`'s own comment for the exact claim/
       * reconcile sequence this guards. */
      admissionSkipped: readonly DispatchOnceAdmissionSkippedIssue[];
    }>
  | Readonly<{ outcome: "discovery_failed"; error: DomainError }>;

/**
 * Runs the real discovery -> `Dispatcher.dispatch()` path exactly once, against whichever ports
 * are supplied -- the real file-backed ones for a genuine run, or the ephemeral in-memory ones
 * (ephemeral-ports.ts) for `--dry-run`. Factoring this out means both CLI modes exercise the
 * identical engine call, so a dry-run's prediction can never drift from what a real run does.
 *
 * C015o decision 3: closes the duplicate-dispatch gap this file's own header already disclosed
 * (`active:[]`'s "one residual gap" paragraph) -- a lease only guards *this* dispatch attempt's
 * own execution window, and once a job reaches `requires_manual` (still genuinely unresolved) the
 * lease has long since been released, leaving nothing durable blocking a second dispatch for the
 * same still-`ready` Linear issue. The sequence, matching the decision's own literal ordering
 * ("先 claim...才呼叫 dispatch"):
 *
 * 1. Claim admission for *every* candidate discovery/eligibility produced, before
 *    `Dispatcher.dispatch()` (the unmodified engine call) ever runs -- this is what makes the fix
 *    crash-safe at "job created" (`Dispatcher.dispatch()` generates the job id internally and only
 *    once it has already selected a candidate, so the claim necessarily happens first and is
 *    updated with the real id afterward, never the reverse); a crash between claiming and
 *    `dispatch()` returning still leaves a durable claim blocking a future duplicate.
 * 2. A candidate whose issue already has an active claim (a *different*, still-unresolved job)
 *    never reaches `Dispatcher.dispatch()` at all -- reported via `admissionSkipped`, distinct
 *    from `discoverySkipped`.
 * 3. After `dispatch()` returns, reconcile: the one candidate it actually dispatched (if any) gets
 *    its claim updated with the real job id (`attachJob`); every other claimed-but-not-selected
 *    candidate has its claim released with reason `"not_dispatched"` (never `"completed"`/
 *    `"cancelled"`/`"superseded"` -- those are reserved for a job's own real lifecycle ending, see
 *    issue-admission-store.ts's own header).
 *
 * Disclosed residual gap (a deliberate, minimal-scope choice, not an oversight): `Dispatcher.
 * dispatch()` itself can retry across *multiple* candidates within one call (a lease conflict on
 * its first choice makes it try the next), and this composition cannot observe that internal
 * retry loop without modifying `Dispatcher.dispatch()` itself (`src/application`, out of this
 * ticket's authority). Claiming every candidate up front and reconciling by matching
 * `result.job.issueId` against the claims already made handles this correctly regardless of which
 * candidate `dispatch()` internally ends up selecting -- the reconcile step is keyed off the
 * actual result, never an assumption about which candidate would win.
 */
export async function dispatchOnce(
  ready: DispatchCompositionReady,
  ports: DispatchOncePorts,
  holderId: string,
  options: Readonly<{ allowOperatorCanary?: boolean }> = {},
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
  // T03A: quota resolves before provider liveness. Unknown quota therefore performs no CLI probe,
  // creates no admission claim, and cannot reach lease/Job/provider pipeline creation.
  const quotaObservations = await observeQuotaRouteCandidates({
    routingConfig: ready.routingConfig,
    candidates: discovered.value.candidates,
    quota: ready.quotaAdmission,
  });
  const claudeQuotaReady = quotaObservations.some(
    (observation) => observation.provider === "claude" && observation.state === "ready",
  );
  const livenessObservations = claudeQuotaReady
    ? await observeClaudeRouteCandidates({
        process: ready.claude.process,
        config: ready.claude.config,
        workingDirectory: ready.project.localRepositoryPath,
      })
    : Object.freeze([]);
  const routeObservations = applyProviderLiveness(quotaObservations, livenessObservations);

  /* Q01 is deliberately downstream of ordinary quota observation and upstream of the first
   * durable issue-admission claim. A normal ready route always wins: no canary read, version
   * probe, or consume occurs in that case. For the exceptional route, `consume...` returns one
   * exact candidate only after a matching, live CLI version has atomically consumed its private
   * attestation; every other candidate remains outside the admission loop. */
  let candidatesForAdmission: readonly DispatcherCandidate[] = discovered.value.candidates;
  let routeObservationsForAdmission: readonly CandidateObservation[] = routeObservations;
  if (
    options.allowOperatorCanary === true &&
    ready.operatorCanary !== undefined &&
    !hasNormalModelAdmissionCandidate(
      discovered.value.candidates,
      ready.routingConfig,
      routeObservations,
    )
  ) {
    const canary = await consumeExactOperatorCanaryCandidate({
      store: ready.operatorCanary.store,
      projectId: ready.project.id,
      candidates: discovered.value.candidates,
      routingConfig: ready.routingConfig,
      claude: {
        config: ready.claude.config,
        process: ready.claude.process,
        workingDirectory: ready.project.localRepositoryPath,
      },
    });
    if (canary.state === "consumed") {
      candidatesForAdmission = Object.freeze([canary.candidate]);
      routeObservationsForAdmission = canary.routeObservations;
    }
  }

  const admissionSkipped: DispatchOnceAdmissionSkippedIssue[] = [];
  const claimedRevisions = new Map<string, number>();
  const claimedCandidates: DispatcherCandidate[] = [];
  for (const candidate of candidatesForAdmission) {
    if (candidate.workKind === "model") {
      const route = selectModelRoute(
        ready.routingConfig,
        candidate.issue.agentRole,
        routeObservationsForAdmission,
      );
      if (route.kind === "waiting") {
        admissionSkipped.push(
          Object.freeze({
            issueId: candidate.issue.id,
            reason: routeAdmissionSkipReason(route),
          }),
        );
        continue;
      }
    }
    const claimed = await ports.admission.claim(ready.project.id, candidate.issue.id);
    if (!claimed.ok) {
      admissionSkipped.push(
        Object.freeze({ issueId: candidate.issue.id, reason: "issue_claim_active" as const }),
      );
      continue;
    }
    claimedRevisions.set(candidate.issue.id, claimed.value.revision);
    claimedCandidates.push(candidate);
  }

  const quotaPreventedAllClaims =
    claimedCandidates.length === 0 &&
    admissionSkipped.some((candidate) => candidate.reason !== "issue_claim_active");
  const result: DispatcherResult = quotaPreventedAllClaims
    ? Object.freeze({
        kind: "waiting" as const,
        reason: "no_dispatchable_candidate" as const,
        skipped: Object.freeze([]),
      })
    : await new Dispatcher(ports).dispatch({
        holderId,
        candidates: claimedCandidates,
        registry: ready.registry,
        active: [],
        routingConfig: ready.routingConfig,
        routeObservations: routeObservationsForAdmission,
      });

  const dispatchedIssueId = result.kind === "dispatched" ? result.job.issueId : undefined;
  for (const [issueId, revision] of claimedRevisions) {
    if (issueId === dispatchedIssueId && result.kind === "dispatched") {
      // Best-effort: if this fails, the claim stays active but jobless -- still safe (it still
      // blocks a future duplicate dispatch for this issue), just missing the job id for
      // observability until `dispatch resolve` or a future retry fixes it up.
      await ports.admission.attachJob(ready.project.id, issueId, revision, result.job.id);
    } else {
      // Best-effort release: if this fails, the claim stays active and simply blocks this one
      // issue from being claimed again until it is retried or manually resolved -- safe
      // (conservative), never a duplicate-dispatch risk.
      await ports.admission.release(ready.project.id, issueId, revision, "not_dispatched");
    }
  }

  return Object.freeze({
    outcome: "ran" as const,
    result,
    candidates: discovered.value.candidates,
    discoverySkipped: discovered.value.skipped,
    admissionSkipped: Object.freeze(admissionSkipped),
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

  const linearApiKey = await readLinearApiKeyWithFileFallback(agentTeamHome, options.environment);
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
  const mutationClient = new LinearMutationClient(linearTransport, readModel);

  const leases = new FileLeaseRepository(
    join(stateRoot, "leases.json"),
    join(stateRoot, "leases.lock"),
  );
  const jobs = new FileJobRepository(join(stateRoot, "jobs.json"), join(stateRoot, "jobs.lock"));
  const claudeProcess = options.claudeProcessPort ?? new ChildProcessRunner();
  const quotaAdmission =
    options.quotaAdmissionPort ??
    (await createProductionQuotaAdmission({
      agentTeamHome,
      claudeProcess,
      claudeExecutable: providerConfig.value.claude.executable,
      workingDirectory: readyEntry.project.localRepositoryPath,
      ...(options.quotaCollector === undefined ? {} : { collector: options.quotaCollector }),
      ...(options.quotaRefresher === undefined ? {} : { refresher: options.quotaRefresher }),
      ...(options.quotaClock === undefined ? {} : { clock: options.quotaClock }),
    }));

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
        mutationClient,
        // E102-5: threaded through to `buildResumeComposition` so it can construct a real
        // `LinearUploadClient` (upload.ts) for `LinearVisualPublicationCoordinator` -- the same
        // transport `readModel`/`mutationClient` right above already share, never a second,
        // independently-configured instance.
        linearTransport,
      }),
      project: readyEntry.project,
      trustedConfig: readyEntry.config,
      claude: Object.freeze({
        config: providerConfig.value.claude,
        process: claudeProcess,
      }),
      quotaAdmission,
      operatorCanary: Object.freeze({
        store: options.operatorCanaryStore ?? new FileOperatorCanaryAttestationStore(agentTeamHome),
      }),
      gemini: providerConfig.value.gemini,
    }),
  });
}
