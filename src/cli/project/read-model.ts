import type {
  FileJobProgressStore,
  JobProgressRecord,
} from "../../adapters/dispatch/job-progress-store.js";
import {
  type ProjectRegistry,
  type ProjectRegistrySnapshot,
  type TrustedProjectLoadResult,
} from "../../application/projects/index.js";
import {
  evaluateRegistrationWakeupHealth,
  type RegistrationSetupDraft,
  unknownRegistrationWakeupSources,
} from "../../application/registration/index.js";
import type { Clock, Result } from "../../domain/foundation/index.js";
import { leaseState, type Job, type Lease } from "../../domain/jobs/index.js";
import type { Project } from "../../domain/project/index.js";
import { containsSensitiveValue, redactedValue } from "../../infrastructure/redaction/index.js";
import type { FileJobRepository } from "../../infrastructure/jobs/index.js";
import type { FileLeaseRepository } from "../../infrastructure/leases/index.js";
import type { ListHostRegistrationSetupDraftsResult } from "../registration/draft-store.js";
import type { RegistrationWakeupStateReader } from "../systemd/index.js";
import {
  classifyJobProgressRecord,
  type JobProgressDisposition,
} from "../reconcile/active-job-inventory.js";

import { type ProjectRegistrationReasonCode, type ProjectRegistrationState } from "./schema.js";

export interface ProjectReadModelOptions {
  readonly discoverDrafts: () => Promise<ListHostRegistrationSetupDraftsResult>;
  readonly registry: Pick<ProjectRegistry, "load">;
  readonly progress: Pick<FileJobProgressStore, "listAll">;
  readonly jobs: Pick<FileJobRepository, "readAll">;
  readonly leases: Pick<FileLeaseRepository, "readAll">;
  readonly clock: Clock;
  readonly wakeupReader?: RegistrationWakeupStateReader;
}

export type ProjectReadResult =
  | Readonly<{ state: "success"; payload: Readonly<Record<string, unknown>> }>
  | Readonly<{ state: "failed"; payload: Readonly<Record<string, unknown>> }>;

interface DraftGroup {
  readonly id: Project["id"];
  readonly drafts: readonly RegistrationSetupDraft[];
}

interface RegistrationProjection {
  readonly state: ProjectRegistrationState;
  readonly reason: ProjectRegistrationReasonCode;
  readonly trustedConfigRevision?: string;
}

type ProgressProjection =
  | Readonly<{
      state: "available";
      counts: Readonly<{ resumable: number; blocked: number; terminal: number; total: number }>;
      nonTerminal: readonly Readonly<{
        jobId: string;
        stage: JobProgressRecord["stage"]["kind"];
        updatedAt: string;
        reasonCode?: string;
      }>[];
    }>
  | Readonly<{ state: "unavailable"; reason: "durable_progress_unavailable" }>;

type LeaseProjection =
  | Readonly<{
      state: "available";
      observedAt: string;
      counts: Readonly<{ active: number; expired: number }>;
    }>
  | Readonly<{ state: "unavailable"; reason: "lease_inventory_unavailable" }>
  | Readonly<{
      state: "unknown";
      reason: "lease_unassigned";
    }>;

const secretLikeDisplayNameAssignment =
  /\b(?:api[\s_-]*key|token|cookie|signature)\b[\s_-]*[:=]\s*\S/iu;

function groupDrafts(drafts: readonly RegistrationSetupDraft[]): readonly DraftGroup[] {
  const byId = new Map<Project["id"], RegistrationSetupDraft[]>();
  for (const draft of drafts) {
    const existing = byId.get(draft.project.id) ?? [];
    existing.push(draft);
    byId.set(draft.project.id, existing);
  }
  return Object.freeze(
    [...byId.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, grouped]) => Object.freeze({ id, drafts: Object.freeze(grouped) })),
  );
}

function safeDisplayName(group: DraftGroup): string {
  if (group.drafts.length !== 1) return redactedValue;
  const displayName = group.drafts[0]?.project.displayName;
  return displayName === undefined ||
    containsSensitiveValue(displayName) ||
    secretLikeDisplayNameAssignment.test(displayName)
    ? redactedValue
    : displayName;
}

function registrationForRejection(
  reason: Extract<TrustedProjectLoadResult, { state: "rejected" }>["reason"],
): RegistrationProjection {
  switch (reason) {
    case "trusted_config_unavailable":
      return Object.freeze({ state: "unknown", reason: "trusted_config_unavailable" });
    case "activation_unavailable":
      return Object.freeze({ state: "unknown", reason: "activation_unavailable" });
    case "trusted_config_missing":
      return Object.freeze({ state: "configuration_incomplete", reason: "trusted_config_missing" });
    case "activation_missing":
      return Object.freeze({ state: "configuration_incomplete", reason: "activation_missing" });
    case "activation_invalid":
      return Object.freeze({ state: "configuration_incomplete", reason: "activation_invalid" });
    case "project_id_mismatch":
    case "default_branch_mismatch":
    case "platform_mismatch":
      return Object.freeze({
        state: "configuration_incomplete",
        reason: "trusted_config_mismatch",
      });
    case "invalid_registry_entry":
    case "trusted_config_invalid":
    case "secret_in_trusted_config":
      return Object.freeze({ state: "configuration_incomplete", reason: "trusted_config_invalid" });
    case "registry_conflict":
      return Object.freeze({
        state: "configuration_incomplete",
        reason: "registration_draft_conflict",
      });
  }
  return Object.freeze({ state: "unknown", reason: "trusted_config_unavailable" });
}

function registrationFor(
  group: DraftGroup,
  snapshot: ProjectRegistrySnapshot | undefined,
): RegistrationProjection {
  if (group.drafts.length !== 1) {
    return Object.freeze({
      state: "configuration_incomplete",
      reason: "registration_draft_conflict",
    });
  }
  if (snapshot === undefined) {
    return Object.freeze({ state: "unknown", reason: "trusted_config_unavailable" });
  }
  const ready = snapshot.ready.filter((entry) => entry.project.id === group.id);
  const readyEntry = ready[0];
  if (ready.length === 1 && readyEntry !== undefined) {
    return Object.freeze({
      state: "registered",
      reason: "trusted_config_verified",
      trustedConfigRevision: readyEntry.revisionSha,
    });
  }
  const rejected = snapshot.rejected.filter((entry) => entry.project?.id === group.id);
  const rejectedEntry = rejected[0];
  if (rejected.length === 1 && rejectedEntry !== undefined) {
    return registrationForRejection(rejectedEntry.reason);
  }
  return Object.freeze({ state: "unknown", reason: "trusted_config_unavailable" });
}

function dispositionCounts(records: readonly JobProgressRecord[]): Readonly<{
  resumable: number;
  blocked: number;
  terminal: number;
}> {
  let resumable = 0;
  let blocked = 0;
  let terminal = 0;
  for (const record of records) {
    const disposition: JobProgressDisposition = classifyJobProgressRecord(record);
    if (disposition === "resumable") resumable += 1;
    else if (disposition === "blocked") blocked += 1;
    else terminal += 1;
  }
  return Object.freeze({ resumable, blocked, terminal });
}

function projectProgress(
  projectId: string,
  records: readonly JobProgressRecord[] | undefined,
): ProgressProjection {
  if (records === undefined) {
    return Object.freeze({ state: "unavailable", reason: "durable_progress_unavailable" });
  }
  const projectRecords = records.filter((record) => record.projectId === projectId);
  const counts = dispositionCounts(projectRecords);
  const nonTerminal = projectRecords
    .filter((record) => classifyJobProgressRecord(record) !== "terminal")
    .sort((left, right) => left.jobId.localeCompare(right.jobId))
    .map((record) =>
      Object.freeze({
        jobId: record.jobId,
        stage: record.stage.kind,
        updatedAt: record.updatedAt,
        ...(record.stage.kind === "requires_manual" && record.stage.cause !== undefined
          ? { reasonCode: record.stage.cause.reasonCode }
          : {}),
      }),
    );
  return Object.freeze({
    state: "available",
    counts: Object.freeze({
      ...counts,
      total: counts.resumable + counts.blocked + counts.terminal,
    }),
    nonTerminal: Object.freeze(nonTerminal),
  });
}

function projectLeases(
  projectId: string,
  jobs: readonly Job[] | undefined,
  leases: readonly Lease[] | undefined,
  observedAt: ReturnType<Clock["now"]>,
): LeaseProjection {
  const availability = leaseAvailability(jobs, leases, observedAt);
  if (availability.state !== "available") return availability;
  const projectByJobId = new Map((jobs ?? []).map((job) => [job.id, job.projectId]));
  let active = 0;
  let expired = 0;
  for (const lease of leases ?? []) {
    if (projectByJobId.get(lease.jobId) !== projectId) continue;
    const state = leaseState(lease, observedAt);
    if (state === "active") active += 1;
    else if (state === "expired") expired += 1;
  }
  return Object.freeze({
    state: "available",
    observedAt,
    counts: Object.freeze({ active, expired }),
  });
}

function leaseAvailability(
  jobs: readonly Job[] | undefined,
  leases: readonly Lease[] | undefined,
  observedAt: ReturnType<Clock["now"]>,
): LeaseProjection {
  if (jobs === undefined || leases === undefined) {
    return Object.freeze({ state: "unavailable", reason: "lease_inventory_unavailable" });
  }
  const projectByJobId = new Map(jobs.map((job) => [job.id, job.projectId]));
  if (leases.some((lease) => !projectByJobId.has(lease.jobId))) {
    return Object.freeze({ state: "unknown", reason: "lease_unassigned" });
  }
  return Object.freeze({
    state: "available",
    observedAt,
    counts: Object.freeze({ active: 0, expired: 0 }),
  });
}

async function safelyRead<Value>(
  read: () => Promise<Result<Value, unknown>>,
): Promise<Value | undefined> {
  try {
    const result = await read();
    return result.ok ? result.value : undefined;
  } catch {
    return undefined;
  }
}

function quotaProjection(): Readonly<Record<string, unknown>> {
  return Object.freeze({ state: "unknown", reason: "collector_unavailable" });
}

function isDegraded(
  discovery: ListHostRegistrationSetupDraftsResult,
  registrations: readonly RegistrationProjection[],
  progressAvailable: boolean,
  leasesAvailable: boolean,
  wakeup: Readonly<{ state: string }>,
): boolean {
  return (
    discovery.state !== "available" ||
    discovery.rejectedDraftCount > 0 ||
    registrations.some((registration) => registration.state !== "registered") ||
    !progressAvailable ||
    !leasesAvailable ||
    wakeup.state !== "healthy"
  );
}

export class ProjectReadModel {
  readonly #discoverDrafts: () => Promise<ListHostRegistrationSetupDraftsResult>;

  constructor(readonly options: ProjectReadModelOptions) {
    this.#discoverDrafts = options.discoverDrafts;
  }

  async read(input: Readonly<{ projectId?: string }>): Promise<ProjectReadResult> {
    try {
      const discovery = await this.#discoverDrafts();
      if (discovery.state !== "available") {
        if (input.projectId === undefined) {
          return Object.freeze({
            state: "success",
            payload: Object.freeze({
              operation: "project_list",
              schemaVersion: 1,
              state: "degraded",
              inventory: Object.freeze({
                state: "unavailable",
                rejectedDraftCount: 0,
                reason: "registration_drafts_unavailable",
              }),
              projects: Object.freeze([]),
            }),
          });
        }
        return Object.freeze({
          state: "failed",
          payload: Object.freeze({
            operation: "project_detail",
            schemaVersion: 1,
            state: "failed",
            reason: "project_inventory_unavailable",
          }),
        });
      }

      const groups = groupDrafts(discovery.drafts);
      const requested =
        input.projectId === undefined
          ? undefined
          : groups.find((group) => group.id === input.projectId);
      if (input.projectId !== undefined && requested === undefined) {
        return Object.freeze({
          state: "failed",
          payload: Object.freeze({
            operation: "project_detail",
            schemaVersion: 1,
            state: "failed",
            reason: "project_not_found",
          }),
        });
      }

      const registry = await this.#readRegistry(discovery.drafts);
      const [records, jobs, leases] = await Promise.all([
        safelyRead(() => this.options.progress.listAll()),
        safelyRead(() => this.options.jobs.readAll()),
        safelyRead(() => this.options.leases.readAll()),
      ]);
      const observedAt = this.options.clock.now();
      const wakeup = await this.#wakeupProjection();

      if (requested === undefined) {
        const registrations = groups.map((group) => registrationFor(group, registry));
        const projects = groups.map((group, index) => {
          const progress = projectProgress(group.id, records);
          const lease = projectLeases(group.id, jobs, leases, observedAt);
          return Object.freeze({
            id: group.id,
            displayName: safeDisplayName(group),
            registration: registrations[index],
            nonTerminalProgressCount:
              progress.state === "available" ? progress.nonTerminal.length : null,
            activeLeaseCount: lease.state === "available" ? lease.counts.active : null,
          });
        });
        const listLeases = leaseAvailability(jobs, leases, observedAt);
        return Object.freeze({
          state: "success",
          payload: Object.freeze({
            operation: "project_list",
            schemaVersion: 1,
            state: isDegraded(
              discovery,
              registrations,
              records !== undefined,
              listLeases.state === "available",
              wakeup,
            )
              ? "degraded"
              : "completed",
            inventory: Object.freeze({
              state: "available",
              rejectedDraftCount: discovery.rejectedDraftCount,
            }),
            projects: Object.freeze(projects),
          }),
        });
      }

      const registration = registrationFor(requested, registry);
      const progress = projectProgress(requested.id, records);
      const lease = projectLeases(requested.id, jobs, leases, observedAt);
      return Object.freeze({
        state: "success",
        payload: Object.freeze({
          operation: "project_detail",
          schemaVersion: 1,
          state: isDegraded(
            discovery,
            [registration],
            progress.state === "available",
            lease.state === "available",
            wakeup,
          )
            ? "degraded"
            : "completed",
          project: Object.freeze({
            id: requested.id,
            displayName: safeDisplayName(requested),
            registration,
            progress,
            leases: lease,
            quota: quotaProjection(),
            wakeup,
          }),
        }),
      });
    } catch {
      return Object.freeze({
        state: "failed",
        payload: Object.freeze({
          operation: "project_detail",
          schemaVersion: 1,
          state: "failed",
          reason: "project_read_failed",
        }),
      });
    }
  }

  async #readRegistry(
    drafts: readonly RegistrationSetupDraft[],
  ): Promise<ProjectRegistrySnapshot | undefined> {
    try {
      return await this.options.registry.load(drafts.map((draft) => draft.project));
    } catch {
      return undefined;
    }
  }

  async #wakeupProjection() {
    let sources: unknown = unknownRegistrationWakeupSources();
    if (this.options.wakeupReader !== undefined) {
      try {
        sources = {
          systemd: await this.options.wakeupReader.readWakeupState(),
          webhook: "unknown",
        };
      } catch {
        sources = unknownRegistrationWakeupSources();
      }
    }
    return evaluateRegistrationWakeupHealth(sources);
  }
}
