/**
 * E010b: the first production composition root for `ReconcileCoordinator`
 * (src/application/reconcile/coordinator.ts, built by C013) -- replaces
 * `createUnwiredManualReconcileHandler()`'s permanent `blocked` stub with a real wiring so
 * `agent-team reconcile --all` genuinely runs the engine against durable, file-backed state.
 *
 * Scope, disclosed rather than hidden: of `ReconcilePorts`' six ports, only two have a real
 * production backing today:
 *
 * - `leases.reclaimExpired` wraps the existing, already-tested `LeaseCoordinator.reclaimExpired`
 *   (src/application/leases/coordinator.ts) over the same `FileLeaseRepository` production
 *   composition already uses for dispatch (composition.ts) -- genuine zombie-lease reclamation,
 *   the exact mechanism E110 ("殭屍租約") needs, against the one shared, global lease store.
 * - `jobs.update` wraps the existing, already-tested `FileJobRepository.update`.
 *
 * `jobs.listActive` always resolves to the empty set. This mirrors an already-disclosed pattern in
 * this exact codebase (`dispatch/composition.ts`'s own `dispatchOnce` passing `active: []` to
 * `Dispatcher.dispatch()`, "this composition has no source of 'jobs currently in flight'") -- not a
 * new simplification invented for this ticket. The reason is structural, not a shortcut: turning a
 * `Job` (which carries no phase of its own -- see resume-composition.ts's own header) plus its
 * `FileJobProgressStore` record into a `ReconcileTarget` needs a `checkpointId` and an
 * `externalIssueId` **and** a durable "last observed provider/local state" to diff against
 * (`GitHubReconcileAdapter`/`LinearReconcileAdapter`, src/adapters/{github,linear}/reconcile.ts,
 * both require a `local` observation snapshot as their second argument) -- no such snapshot store
 * exists anywhere in this codebase yet, and inventing one is a pipeline-level design decision (what
 * gets snapshotted, when, keyed by what), not CLI wiring. Building it is explicitly out of this
 * ticket's authority (see this ticket's own instructions: "若引擎本身有缺口...不自行造引擎").
 *
 * Because `jobs.listActive` always returns `[]`, `ReconcileCoordinator#reconcileTarget` (the loop
 * body that would call `providers`/`events`/`processes`/`blocks`) is structurally unreachable in
 * production today -- not merely untested, genuinely never invoked, so real reconcile runs can
 * never spawn a model process through this path (0 model calls is a property of the composition's
 * shape, not an incidental fact about today's data). Those four ports still need *some*
 * implementation to satisfy `ReconcilePorts`' type; each one here fails closed with an honest
 * `"unavailable"` `DomainError` (never a fabricated success) so that the day a future ticket wires a
 * real `jobs.listActive`, any target that reaches these ports degrades visibly (`blocked`/`failed`,
 * per the coordinator's own fail-closed rules) instead of silently reporting the wrong thing.
 *
 * `leases.prepareRecovery`/`releaseRecovery` are likewise unreachable while `jobs.listActive`
 * returns `[]` (the coordinator only calls them from inside `#reconcileTarget`) -- kept as the same
 * honest `"unavailable"` failure rather than a real `LeaseCoordinator.acquire`/`release` wrapper,
 * because "recovery lease" is a distinct semantic (an implementing-stage crash-resume claim) this
 * ticket has no requirement to invent, and a real-looking implementation that is never exercised in
 * production would be untested engine behavior wearing a composition-layer disguise.
 */
import { join } from "node:path";

import { LeaseCoordinator } from "../../application/leases/index.js";
import {
  ReconcileCoordinator,
  type ReconcileBlockPort,
  type ReconcileEventPort,
  type ReconcileJobPort,
  type ReconcileLeasePort,
  type ReconcilePorts,
  type ReconcileProcessPort,
  type ReconcileProviderPort,
} from "../../application/reconcile/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import { FileJobRepository } from "../../infrastructure/jobs/index.js";
import { FileLeaseRepository } from "../../infrastructure/leases/index.js";
import type { ManualReconcileUseCase } from "./index.js";

export interface BuildManualReconcileCompositionOptions {
  readonly agentTeamHome: string;
}

function reconcileStateDirectory(agentTeamHome: string): string {
  return join(agentTeamHome, "state");
}

/**
 * Every port below that has no real production backing yet (see this file's own header) resolves
 * to the identical, honest `"unavailable"` failure -- never a fabricated `ok(...)`. Structurally
 * unreachable today because `jobs.listActive` always returns `[]`; kept fail-closed (not omitted)
 * so that changes elsewhere in `ReconcileCoordinator` still type-check against the real
 * `ReconcilePorts` contract, and so a future caller that *does* reach one of these gets a visible,
 * correctly-classified-retryable error instead of a silent lie.
 */
function unavailable<Value>(): Promise<Result<Value, DomainError>> {
  return Promise.resolve(err(domainError("unavailable")));
}

function buildJobsPort(jobRepository: FileJobRepository): ReconcileJobPort {
  return {
    // Disclosed, structural gap -- see this file's own module header.
    listActive: () => Promise.resolve(ok(Object.freeze([]))),
    async update(job, options) {
      const updated = await jobRepository.update(job, options);
      if (!updated.ok) return updated;
      return ok(Object.freeze({ job, durability: updated.value.durability }));
    },
  };
}

function buildLeasesPort(leaseCoordinator: LeaseCoordinator): ReconcileLeasePort {
  return {
    // The one genuinely real port this composition wires: real zombie-lease reclamation against
    // the same production `FileLeaseRepository` dispatch composition already uses.
    async reclaimExpired(controllerId) {
      const reclaimed = await leaseCoordinator.reclaimExpired(controllerId);
      if (!reclaimed.ok) return reclaimed;
      return ok(
        Object.freeze({
          reclaimedLeaseIds: Object.freeze([...reclaimed.value.value]),
          persistence: reclaimed.value.persistence,
          lockRelease: reclaimed.value.lockRelease,
        }),
      );
    },
    // Unreachable while `jobs.listActive` returns `[]` -- see this file's own module header.
    prepareRecovery: () => unavailable(),
    releaseRecovery: () => unavailable(),
  };
}

function buildProvidersPort(): ReconcileProviderPort {
  return { readBack: () => unavailable() };
}

function buildEventsPort(): ReconcileEventPort {
  return { repairMissing: () => unavailable() };
}

function buildProcessesPort(): ReconcileProcessPort {
  return {
    inspect: () => unavailable(),
    resumeFromCheckpoint: () => unavailable(),
  };
}

function buildBlocksPort(): ReconcileBlockPort {
  return { record: () => unavailable() };
}

export function buildManualReconcilePorts(
  options: BuildManualReconcileCompositionOptions,
): ReconcilePorts {
  const stateDirectory = reconcileStateDirectory(options.agentTeamHome);
  const leaseRepository = new FileLeaseRepository(
    join(stateDirectory, "leases.json"),
    join(stateDirectory, "leases.lock"),
  );
  const jobRepository = new FileJobRepository(
    join(stateDirectory, "jobs.json"),
    join(stateDirectory, "jobs.lock"),
  );
  const leaseCoordinator = new LeaseCoordinator(leaseRepository);

  return Object.freeze({
    jobs: buildJobsPort(jobRepository),
    leases: buildLeasesPort(leaseCoordinator),
    providers: buildProvidersPort(),
    events: buildEventsPort(),
    processes: buildProcessesPort(),
    blocks: buildBlocksPort(),
  });
}

/** Production composition root: a real `ManualReconcileUseCase` backed by `ReconcileCoordinator`
 * over `buildManualReconcilePorts`' ports -- what `src/cli/index.ts` wires `reconcile` to instead of
 * `createUnwiredManualReconcileHandler()`. */
export function buildManualReconcileUseCase(
  options: BuildManualReconcileCompositionOptions,
): ManualReconcileUseCase {
  const coordinator = new ReconcileCoordinator(buildManualReconcilePorts(options));
  return { reconcileAll: (request) => coordinator.reconcileAll(request) };
}
