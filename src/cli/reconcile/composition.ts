/**
 * E010b: the first production composition root for `ReconcileCoordinator`
 * (src/application/reconcile/coordinator.ts, built by C013) -- replaces
 * `createUnwiredManualReconcileHandler()`'s permanent `blocked` stub with a real wiring so
 * `agent-team reconcile --all` genuinely runs the engine against durable, file-backed state.
 *
 * Scope, disclosed rather than hidden: the generic `ReconcileCoordinator` still has only two real
 * mutation ports, while the CLI also owns one read-only durable progress inventory:
 *
 * - `leases.reclaimExpired` wraps the existing, already-tested `LeaseCoordinator.reclaimExpired`
 *   (src/application/leases/coordinator.ts) over the same `FileLeaseRepository` production
 *   composition already uses for dispatch (composition.ts) -- genuine zombie-lease reclamation,
 *   the exact mechanism E110 ("殭屍租約") needs, against the one shared, global lease store.
 * - `jobs.update` wraps the existing, already-tested `FileJobRepository.update`.
 * - `readJobProgressInventory` scans `FileJobProgressStore` once and classifies every record as
 *   resumable, blocked or terminal. It does not invoke a model or any external provider.
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
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  FileJobProgressStore,
  JobProgressWorkStatusLifecycleLedger,
} from "../../adapters/dispatch/index.js";
import { FileIssueScopeLock } from "../../adapters/dispatch/issue-scope-lock.js";
import { LeaseCoordinator } from "../../application/leases/index.js";
import { WorkStatusLifecycleCoordinator } from "../../application/pipelines/index.js";
import {
  ReconcileCoordinator,
  type ReconcileBlockPort,
  type ReconcileEventPort,
  type ReconcileJobPort,
  type ReconcileLeasePort,
  type ReconcilePorts,
  type ReconcileProcessPort,
  type ReconcileProviderPort,
  type ReconcileTarget,
} from "../../application/reconcile/index.js";
import {
  createClock,
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import { FileJobRepository } from "../../infrastructure/jobs/index.js";
import { FileLeaseRepository } from "../../infrastructure/leases/index.js";
import {
  buildDispatchComposition,
  type BuildDispatchCompositionResult,
} from "../dispatch/composition.js";
import {
  resumeExistingProjectJobs,
  type ResumeExistingProjectJobsResult,
} from "../dispatch/resume-existing.js";
import {
  buildIssueAdmissionStore,
  defaultJobProgressDirectory,
  type ResumeJobOutcome,
} from "../dispatch/resume-composition.js";
import { WorkStatusOrphanCoordinator } from "../dispatch/work-status-orphan-coordinator.js";
import { LinearWorkManagementAdapter } from "../dispatch/work-management-adapter.js";
import { resolveWorkStatusLifecycleMode } from "../../application/projects/index.js";
import { listHostRegistrationSetupDrafts } from "../registration/draft-store.js";
import { readJobProgressInventory } from "./active-job-inventory.js";
import type {
  ManualReconcileUseCase,
  JobProgressResumeBatch,
  ReconcileCapabilityId,
  ReconcileDisclosedScope,
} from "./index.js";

export interface BuildManualReconcileCompositionOptions {
  readonly agentTeamHome: string;
  readonly buildDispatchComposition?: (
    options: Parameters<typeof buildDispatchComposition>[0],
  ) => Promise<BuildDispatchCompositionResult>;
  readonly resumeExistingProjectJobs?: typeof resumeExistingProjectJobs;
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
 *
 * E010c: this exact function reference (not a fresh `() => unavailable()` wrapper per call site)
 * is assigned directly as the port method below, and `describeDisclosedScope` (this file, further
 * down) later checks each built port method's identity against it. That is the whole disclosed-scope
 * mechanism for these five ports: "unwired" is derived from "is this literally the stub function",
 * not from a second, hand-maintained true/false list that could drift out of sync with the wiring
 * above it.
 */
function unavailable<Value>(): Promise<Result<Value, DomainError>> {
  return Promise.resolve(err(domainError("unavailable")));
}

/**
 * E010c: same disclosure mechanism as `unavailable` above, for the one gap that isn't an error --
 * `jobs.listActive` fails *open* to an honest empty set (see this file's own module header for why)
 * rather than failing closed, so it needs its own identity-checked sentinel.
 */
function noActiveJobs(): Promise<Result<readonly ReconcileTarget[], DomainError>> {
  return Promise.resolve(ok(Object.freeze([])));
}

function buildJobsPort(jobRepository: FileJobRepository): ReconcileJobPort {
  return {
    // Disclosed, structural gap -- see this file's own module header.
    listActive: noActiveJobs,
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
    prepareRecovery: unavailable,
    releaseRecovery: unavailable,
  };
}

function buildProvidersPort(): ReconcileProviderPort {
  return { readBack: unavailable };
}

function buildEventsPort(): ReconcileEventPort {
  return { repairMissing: unavailable };
}

function buildProcessesPort(): ReconcileProcessPort {
  return {
    inspect: unavailable,
    resumeFromCheckpoint: unavailable,
  };
}

function buildBlocksPort(): ReconcileBlockPort {
  return { record: unavailable };
}

/**
 * E010c: one accessor per `ReconcileCapabilityId` (src/cli/reconcile/index.ts) -- the only
 * hand-maintained list this mechanism needs, and it carries no wired/unwired judgment of its own,
 * only "where does this capability's implementation live". `describeDisclosedScope` below decides
 * wired vs. unwired from the built runtime wiring. `active_job_snapshot` deliberately points at the
 * generic coordinator's structurally incompatible `ReconcileTarget` snapshot stays separately
 * disclosed as unwired; T03B will consume the durable inventory through a resume-only bridge.
 *
 * Every accessor below reads (never calls) a `ReconcilePorts` method declared with TypeScript's
 * method-shorthand syntax (src/application/reconcile/model.ts, out of this ticket's scope), which
 * `@typescript-eslint/unbound-method` always flags as potentially `this`-sensitive -- the same
 * false positive already documented at src/application/pipelines/merge-gate-model.ts:61-65. None
 * of these methods use `this` (the sentinels are plain functions; the two real ones close over
 * repository/coordinator instances by closure, not `this`), so the read is safe.
 */
interface ReconcileRuntimeWiring {
  readonly ports: ReconcilePorts;
  readonly readJobProgressInventory: ManualReconcileUseCase["readJobProgressInventory"];
  readonly resumeJobProgress: ManualReconcileUseCase["resumeJobProgress"];
}

const reconcileCapabilityAccessors: readonly Readonly<{
  id: ReconcileCapabilityId;
  get: (wiring: ReconcileRuntimeWiring) => unknown;
}>[] = Object.freeze([
  // eslint-disable-next-line @typescript-eslint/unbound-method -- see comment above; read-only reference.
  { id: "lease_reclaim", get: ({ ports }) => ports.leases.reclaimExpired },
  // eslint-disable-next-line @typescript-eslint/unbound-method -- see comment above; read-only reference.
  { id: "job_update", get: ({ ports }) => ports.jobs.update },
  // eslint-disable-next-line @typescript-eslint/unbound-method -- see comment above; read-only reference.
  { id: "active_job_snapshot", get: ({ ports }) => ports.jobs.listActive },
  { id: "durable_progress_inventory", get: (wiring) => wiring.readJobProgressInventory },
  { id: "durable_progress_resume", get: (wiring) => wiring.resumeJobProgress },
  // eslint-disable-next-line @typescript-eslint/unbound-method -- see comment above; read-only reference.
  { id: "provider_readback", get: ({ ports }) => ports.providers.readBack },
  // eslint-disable-next-line @typescript-eslint/unbound-method -- see comment above; read-only reference.
  { id: "event_repair", get: ({ ports }) => ports.events.repairMissing },
  // eslint-disable-next-line @typescript-eslint/unbound-method -- see comment above; read-only reference.
  { id: "process_inspect", get: ({ ports }) => ports.processes.inspect },
  // eslint-disable-next-line @typescript-eslint/unbound-method -- see comment above; read-only reference.
  { id: "process_resume", get: ({ ports }) => ports.processes.resumeFromCheckpoint },
  // eslint-disable-next-line @typescript-eslint/unbound-method -- see comment above; read-only reference.
  { id: "block_record", get: ({ ports }) => ports.blocks.record },
  // eslint-disable-next-line @typescript-eslint/unbound-method -- see comment above; read-only reference.
  { id: "lease_recovery_prepare", get: ({ ports }) => ports.leases.prepareRecovery },
  // eslint-disable-next-line @typescript-eslint/unbound-method -- see comment above; read-only reference.
  { id: "lease_recovery_release", get: ({ ports }) => ports.leases.releaseRecovery },
]);

const unwiredSentinels: ReadonlySet<unknown> = new Set([unavailable, noActiveJobs]);

/**
 * E010c: derives disclosed scope from the actual `ReconcilePorts` this composition built, rather
 * than from a parallel hardcoded "here's what's wired" list -- see `reconcileCapabilityAccessors`'s
 * own comment for why that avoids drift.
 */
function describeDisclosedScope(wiring: ReconcileRuntimeWiring): ReconcileDisclosedScope {
  const wired: ReconcileCapabilityId[] = [];
  const unwired: ReconcileCapabilityId[] = [];
  for (const capability of reconcileCapabilityAccessors) {
    const target = unwiredSentinels.has(capability.get(wiring)) ? unwired : wired;
    target.push(capability.id);
  }
  return Object.freeze({
    wiredCapabilities: Object.freeze(wired),
    unwiredCapabilities: Object.freeze(unwired),
  });
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
  const ports = buildManualReconcilePorts(options);
  const coordinator = new ReconcileCoordinator(ports);
  const progressStore = new FileJobProgressStore(
    defaultJobProgressDirectory(options.agentTeamHome),
  );
  const readInventory = () => readJobProgressInventory(progressStore);
  const admission = buildIssueAdmissionStore(options.agentTeamHome);
  const resumeJobProgress: ManualReconcileUseCase["resumeJobProgress"] = async (records) => {
    if (records.length === 0) {
      return Object.freeze({ outcomes: Object.freeze([]), blocked: Object.freeze([]) });
    }
    const identities = new Set(records.map((record) => record.jobId));
    if (identities.size !== records.length) {
      return Object.freeze({
        outcomes: Object.freeze([]),
        blocked: Object.freeze(
          records.map((record) => ({
            projectId: record.projectId,
            jobId: record.jobId,
            reason: "duplicate_resume_selection",
          })),
        ),
      });
    }

    const projects = new Map<string, (typeof records)[number][]>();
    for (const record of records) {
      const existing = projects.get(record.projectId) ?? [];
      projects.set(record.projectId, [...existing, record]);
    }
    const outcomes: ResumeJobOutcome[] = [];
    const blocked: JobProgressResumeBatch["blocked"][number][] = [];
    for (const [projectId, projectRecords] of projects) {
      const built = await (options.buildDispatchComposition ?? buildDispatchComposition)({
        agentTeamHome: options.agentTeamHome,
        projectId,
      });
      if (built.state !== "ready") {
        blocked.push(
          ...projectRecords.map((record) => ({
            projectId,
            jobId: record.jobId,
            reason: `dispatch_composition:${built.reason}`,
          })),
        );
        continue;
      }
      const resumed: ResumeExistingProjectJobsResult = await (
        options.resumeExistingProjectJobs ?? resumeExistingProjectJobs
      )({
        agentTeamHome: options.agentTeamHome,
        ready: built.value,
        holderId: `reconcile-resume:${randomUUID()}`,
        clock: createClock(),
        selections: projectRecords.map((record) => ({
          jobId: record.jobId,
          expectedRevision: record.revision,
        })),
      });
      if (resumed.state === "resumed") {
        outcomes.push(...resumed.outcomes);
      } else if (resumed.state === "none") {
        blocked.push(
          ...projectRecords.map((record) => ({
            projectId,
            jobId: record.jobId,
            reason: "resume_candidate_disappeared",
          })),
        );
      } else {
        const reason =
          resumed.reason === "resume_composition_blocked"
            ? `${resumed.reason}:${resumed.compositionReason}`
            : resumed.reason;
        blocked.push(
          ...projectRecords.map((record) => ({ projectId, jobId: record.jobId, reason })),
        );
      }
    }
    return Object.freeze({ outcomes: Object.freeze(outcomes), blocked: Object.freeze(blocked) });
  };
  const wiring = Object.freeze({
    ports,
    readJobProgressInventory: readInventory,
    resumeJobProgress,
  });
  return {
    reconcileAll: (request) => coordinator.reconcileAll(request),
    readJobProgressInventory: readInventory,
    resumeJobProgress,
    reconcileJob: async (jobId) => {
      const loaded = await progressStore.load(jobId);
      if (!loaded.ok || loaded.value === undefined) {
        return Object.freeze({
          state: "blocked" as const,
          projectId: "unknown",
          jobId,
          reason: "job_not_reconcilable" as const,
        });
      }
      const record = loaded.value;
      const built = await (options.buildDispatchComposition ?? buildDispatchComposition)({
        agentTeamHome: options.agentTeamHome,
        projectId: record.projectId,
      });
      if (
        built.state !== "ready" ||
        resolveWorkStatusLifecycleMode(built.value.trustedConfig) !== "enforce"
      ) {
        return Object.freeze({
          state: "blocked" as const,
          projectId: record.projectId,
          jobId,
          reason: "job_not_reconcilable" as const,
        });
      }
      const workManagement = new LinearWorkManagementAdapter({
        readModel: built.value.discovery.readModel,
        mutationClient: built.value.discovery.mutationClient,
        teamId: built.value.discovery.teamId,
        linearProjectId: built.value.discovery.linearProjectId,
      });
      const locks = new FileIssueScopeLock(
        join(options.agentTeamHome, "state", "dispatch", "issue-scope-locks"),
      );
      return new WorkStatusOrphanCoordinator({
        project: built.value.project,
        workManagement,
        progress: progressStore,
        admission,
        locks,
        lifecycle: new WorkStatusLifecycleCoordinator({
          workManagement,
          history: workManagement,
          ledger: new JobProgressWorkStatusLifecycleLedger(progressStore),
          locks,
        }),
      }).reconcileJob(record);
    },
    quarantineWorkStatusOrphans: async () => {
      const drafts = await listHostRegistrationSetupDrafts(options.agentTeamHome);
      if (drafts.state !== "available") return Object.freeze([]);
      const projectIds = [...new Set(drafts.drafts.map((draft) => draft.project.id))].sort();
      const scans = [];
      for (const projectId of projectIds) {
        const built = await (options.buildDispatchComposition ?? buildDispatchComposition)({
          agentTeamHome: options.agentTeamHome,
          projectId,
        });
        if (
          built.state !== "ready" ||
          resolveWorkStatusLifecycleMode(built.value.trustedConfig) !== "enforce"
        ) {
          continue;
        }
        const workManagement = new LinearWorkManagementAdapter({
          readModel: built.value.discovery.readModel,
          mutationClient: built.value.discovery.mutationClient,
          teamId: built.value.discovery.teamId,
          linearProjectId: built.value.discovery.linearProjectId,
        });
        const locks = new FileIssueScopeLock(
          join(options.agentTeamHome, "state", "dispatch", "issue-scope-locks"),
        );
        scans.push(
          await new WorkStatusOrphanCoordinator({
            project: built.value.project,
            workManagement,
            progress: progressStore,
            admission,
            locks,
            lifecycle: new WorkStatusLifecycleCoordinator({
              workManagement,
              history: workManagement,
              ledger: new JobProgressWorkStatusLifecycleLedger(progressStore),
              locks,
            }),
          }).scan(),
        );
      }
      return Object.freeze(scans);
    },
    disclosedScope: describeDisclosedScope(wiring),
  };
}
