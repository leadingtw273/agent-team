import type { DomainError } from "../../domain/foundation/index.js";
import type { Job } from "../../domain/jobs/index.js";
import type { Project } from "../../domain/project/index.js";
import type { AsyncPortResult, MutationOptions, ReadOptions } from "../ports/common.js";

export const reconcileProviderFindingKinds = [
  "work_status_changed",
  "agent_condition_changed",
  "issue_revision_changed",
  "head_changed",
  "draft_changed",
  "checks_changed",
  "change_request_closed",
  "change_request_reopened",
  "missed_merge_event",
  "out_of_process_merge",
] as const;

export type ReconcileProviderFindingKind = (typeof reconcileProviderFindingKinds)[number];

export interface ReconcileProviderFinding {
  readonly source: "linear" | "github";
  readonly kind: ReconcileProviderFindingKind;
  readonly fingerprint: string;
}

export interface ReconcileTarget {
  readonly project: Project;
  readonly externalIssueId: string;
  readonly job: Job;
  readonly checkpointId?: string;
}

export interface ReconcileJobPort {
  listActive(options?: ReadOptions): AsyncPortResult<readonly ReconcileTarget[]>;
  update(
    job: Job,
    options: MutationOptions,
  ): AsyncPortResult<Readonly<{ job: Job; durability: "confirmed" | "unknown" }>>;
}

export interface ReconcileLeasePort {
  reclaimExpired(
    controllerId: string,
    options: MutationOptions,
  ): AsyncPortResult<
    Readonly<{
      reclaimedLeaseIds: readonly string[];
      persistence: "unchanged" | "confirmed" | "unknown";
      lockRelease: "confirmed" | "unknown";
    }>
  >;
  prepareRecovery(
    target: ReconcileTarget,
    controllerId: string,
    options: MutationOptions,
  ): AsyncPortResult<
    Readonly<{
      ready: boolean;
      leaseId?: string;
      durability: "confirmed" | "unknown";
    }>
  >;
  releaseRecovery(
    leaseId: string,
    controllerId: string,
    options: MutationOptions,
  ): AsyncPortResult<Readonly<{ durability: "confirmed" | "unknown" }>>;
}

export interface ReconcileProviderPort {
  readBack(
    target: ReconcileTarget,
    options?: ReadOptions,
  ): AsyncPortResult<Readonly<{ findings: readonly ReconcileProviderFinding[] }>>;
}

export interface ReconcileEventPort {
  repairMissing(
    request: Readonly<{
      target: ReconcileTarget;
      providerFindings: readonly ReconcileProviderFinding[];
    }>,
    options: MutationOptions,
  ): AsyncPortResult<
    Readonly<{
      repairedEventIds: readonly string[];
      durability: "unchanged" | "confirmed" | "unknown";
    }>
  >;
}

export interface ReconcileProcessPort {
  inspect(
    job: Job,
    options?: ReadOptions,
  ): AsyncPortResult<Readonly<{ state: "running" | "exited" | "missing" }>>;
  resumeFromCheckpoint(
    request: Readonly<{
      job: Job;
      checkpointId: string;
      reason: "unexpected_process_exit";
    }>,
    options: MutationOptions,
  ): AsyncPortResult<Readonly<{ started: boolean; durability: "confirmed" | "unknown" }>>;
}

export type ReconcileBlockReason =
  | "source_unavailable"
  | "event_repair_unconfirmed"
  | "checkpoint_missing"
  | "lease_unavailable"
  | "recovery_limit_reached";

export interface ReconcileBlockPort {
  record(
    request: Readonly<{ target: ReconcileTarget; reason: ReconcileBlockReason }>,
    options: MutationOptions,
  ): AsyncPortResult<Readonly<{ durability: "confirmed" | "unknown" }>>;
}

export interface ReconcilePorts {
  readonly jobs: ReconcileJobPort;
  readonly leases: ReconcileLeasePort;
  readonly providers: ReconcileProviderPort;
  readonly events: ReconcileEventPort;
  readonly processes: ReconcileProcessPort;
  readonly blocks: ReconcileBlockPort;
}

export interface ReconcileAllRequest {
  readonly controllerId: string;
  readonly idempotencyKeyPrefix: string;
  readonly signal?: AbortSignal;
}

export type ReconcileTargetFailureStage =
  "provider" | "events" | "process" | "lease" | "job" | "recovery" | "block";

interface ReconcileTargetEvidence {
  readonly jobId: string;
  readonly providerFindings: readonly ReconcileProviderFinding[];
  readonly repairedEventIds: readonly string[];
}

export type ReconcileTargetOutcome =
  | (ReconcileTargetEvidence & Readonly<{ state: "healthy" }>)
  | (ReconcileTargetEvidence &
      Readonly<{
        state: "resumed";
        checkpointId: string;
        processRecoveries: number;
      }>)
  | (ReconcileTargetEvidence & Readonly<{ state: "blocked"; reason: ReconcileBlockReason }>)
  | Readonly<{
      state: "failed";
      jobId: string;
      stage: ReconcileTargetFailureStage;
      error: DomainError;
    }>;

export type ReconcileAllOutcome =
  | Readonly<{
      state: "completed" | "degraded";
      reclaimedLeaseIds: readonly string[];
      targets: readonly ReconcileTargetOutcome[];
      modelResumeAttempts: number;
    }>
  | Readonly<{
      state: "failed";
      stage: "request" | "jobs" | "leases";
      error: DomainError;
    }>;
