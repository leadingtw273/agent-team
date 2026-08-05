import type { TrustedProjectConfig } from "../projects/index.js";
import type {
  ChangeRequestSnapshot,
  CommitChecksSnapshot,
  GitCommitReceipt,
  GitPort,
  GitPushReceipt,
  GitWorktree,
  ProviderPort,
  SourceControlPort,
} from "../ports/index.js";
import type { AsyncPortResult, MutationOptions } from "../ports/common.js";
import type { DomainError, Instant } from "../../domain/foundation/index.js";
import type { Job } from "../../domain/jobs/index.js";
import type { Project } from "../../domain/project/index.js";
import type { RequirementSnapshot } from "../../domain/review/index.js";
import type { ExternalDataBlock } from "../ports/provider.js";
import type {
  ImplementerPreflightFinding,
  ImplementerPreflightPort,
  ProviderToolDecisionPort,
} from "./implementer-model.js";

export interface CiRecoveryJobWriteReceipt {
  readonly durability: "confirmed" | "unknown";
}

export interface CiRecoveryJobPort {
  update(job: Job, options: MutationOptions): AsyncPortResult<CiRecoveryJobWriteReceipt>;
}

export type CiRecoveryCheckpointReason = "attempt_limit_reached" | "scope_overrun";

export interface CiRecoveryCheckpointPort {
  preserve(
    request: Readonly<{
      job: Job;
      worktree: GitWorktree;
      requirementSnapshot: RequirementSnapshot;
      reason: CiRecoveryCheckpointReason;
      checks: CommitChecksSnapshot;
      findings?: readonly ImplementerPreflightFinding[];
      changedPaths?: readonly string[];
    }>,
    options: MutationOptions,
  ): AsyncPortResult<Readonly<{ checkpointId: string }>>;
}

export interface CiRecoveryPipelinePorts {
  readonly git: Pick<GitPort, "stagePaths" | "commit" | "inspectWorkingTree" | "push">;
  readonly preflight: ImplementerPreflightPort;
  readonly provider: ProviderPort;
  readonly sourceControl: Pick<SourceControlPort, "getCommitChecks">;
  readonly jobs: CiRecoveryJobPort;
  readonly checkpoint: CiRecoveryCheckpointPort;
  readonly toolDecisions: ProviderToolDecisionPort;
}

export interface CiRecoveryPipelineRequest {
  readonly trigger:
    | Readonly<{ kind: "webhook"; observedChecks: CommitChecksSnapshot }>
    | Readonly<{ kind: "polling" }>;
  readonly job: Job;
  readonly project: Project;
  readonly trustedConfig: TrustedProjectConfig;
  readonly requirementSnapshot: RequirementSnapshot;
  readonly worktree: GitWorktree;
  readonly changeRequest: ChangeRequestSnapshot;
  readonly model: string;
  readonly remote: string;
  readonly commitMessage: string;
  readonly controllerDirective: string;
  readonly externalData: readonly ExternalDataBlock[];
  readonly deadlineAt: Instant;
  readonly expectedUntrackedPaths?: Parameters<
    ImplementerPreflightPort["inspect"]
  >[0]["expectedUntrackedPaths"];
  readonly concurrentJobs?: Parameters<ImplementerPreflightPort["inspect"]>[0]["concurrentJobs"];
  readonly knownSecrets?: readonly string[];
  readonly idempotencyKeyPrefix: string;
  readonly signal?: AbortSignal;
}

export type CiRecoveryFailureStage =
  | "request"
  | "checks"
  | "checkpoint"
  | "attempt_persistence"
  | "provider_start"
  | "provider_run"
  | "tool_decision"
  | "preflight"
  | "stage"
  | "commit"
  | "post_commit"
  | "push"
  | "new_checks";

export type CiRecoveryPipelineOutcome =
  | Readonly<{
      state: "ci_waiting";
      source: "webhook" | "polling";
      job: Job;
      checks: CommitChecksSnapshot;
    }>
  | Readonly<{
      state: "ready_for_review";
      source: "webhook" | "polling";
      job: Job;
      checks: CommitChecksSnapshot;
    }>
  | Readonly<{
      state: "repair_pushed";
      job: Job;
      commit: GitCommitReceipt;
      push: GitPushReceipt;
      checks: CommitChecksSnapshot;
      providerSessionId?: string;
    }>
  | Readonly<{
      state: "checkpointed";
      reason: CiRecoveryCheckpointReason;
      job: Job;
      checkpointId: string;
      checks: CommitChecksSnapshot;
      findings?: readonly ImplementerPreflightFinding[];
    }>
  | Readonly<{
      state: "paused";
      reason: "safety_approval_required" | "provider_interrupted" | "no_changes";
      job: Job;
      toolSummary?: string;
    }>
  | Readonly<{
      state: "failed";
      stage: CiRecoveryFailureStage;
      error: DomainError;
      job: Job;
    }>;
