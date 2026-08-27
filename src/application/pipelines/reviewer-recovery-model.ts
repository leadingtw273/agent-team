import type { TrustedProjectConfig } from "../projects/index.js";
import type {
  GitCommitReceipt,
  GitPort,
  GitPushReceipt,
  GitWorktree,
  ProviderPort,
} from "../ports/index.js";
import type { AsyncPortResult, MutationOptions } from "../ports/common.js";
import type { ExternalDataBlock } from "../ports/provider.js";
import type { DomainError, Instant } from "../../domain/foundation/index.js";
import type { Job } from "../../domain/jobs/index.js";
import type { Project } from "../../domain/project/index.js";
import type { RequirementSnapshot } from "../../domain/review/index.js";
import type { ReviewFinding } from "./reviewer-model.js";
import type {
  ImplementerPreflightFinding,
  ImplementerPreflightPort,
  ProviderToolDecisionPort,
} from "./implementer-model.js";

export interface ReviewerRecoveryJobWriteReceipt {
  readonly durability: "confirmed" | "unknown";
}

export interface ReviewerRecoveryJobPort {
  update(job: Job, options: MutationOptions): AsyncPortResult<ReviewerRecoveryJobWriteReceipt>;
}

export type ReviewerRecoveryCheckpointReason = "attempt_limit_reached" | "scope_overrun";

export interface ReviewerRecoveryCheckpointPort {
  preserve(
    request: Readonly<{
      job: Job;
      worktree: GitWorktree;
      requirementSnapshot: RequirementSnapshot;
      reason: ReviewerRecoveryCheckpointReason;
      findings?: readonly ImplementerPreflightFinding[];
      changedPaths?: readonly string[];
    }>,
    options: MutationOptions,
  ): AsyncPortResult<Readonly<{ checkpointId: string }>>;
}

export interface ReviewerRecoveryPipelinePorts {
  readonly git: Pick<GitPort, "stagePaths" | "commit" | "inspectWorkingTree" | "push">;
  readonly preflight: ImplementerPreflightPort;
  readonly provider: ProviderPort;
  readonly jobs: ReviewerRecoveryJobPort;
  readonly checkpoint: ReviewerRecoveryCheckpointPort;
  readonly toolDecisions: ProviderToolDecisionPort;
}

export interface ReviewerRecoveryPipelineRequest {
  readonly job: Job;
  readonly project: Project;
  readonly trustedConfig: TrustedProjectConfig;
  readonly requirementSnapshot: RequirementSnapshot;
  readonly worktree: GitWorktree;
  readonly model: string;
  readonly remote: string;
  readonly commitMessage: string;
  readonly controllerDirective: string;
  readonly findings: readonly ReviewFinding[];
  readonly externalData: readonly ExternalDataBlock[];
  readonly deadlineAt: Instant;
  readonly idempotencyKeyPrefix: string;
  /** Narrow operator recovery for a published `changes_requested` result. It still consumes the
   * ordinary one-round fixer budget; it only prevents an already-full review counter from
   * suppressing that fixer. */
  readonly allowExhaustedReviewRuns?: boolean;
  readonly signal?: AbortSignal;
}

export type ReviewerRecoveryFailureStage =
  | "request"
  | "checkpoint"
  | "attempt_persistence"
  | "provider_start"
  | "provider_run"
  | "tool_decision"
  | "preflight"
  | "stage"
  | "commit"
  | "post_commit"
  | "push";

export type ReviewerRecoveryPipelineOutcome =
  | Readonly<{
      state: "repair_pushed";
      job: Job;
      commit: GitCommitReceipt;
      push: GitPushReceipt;
      providerSessionId?: string;
    }>
  | Readonly<{
      state: "checkpointed";
      reason: ReviewerRecoveryCheckpointReason;
      job: Job;
      checkpointId: string;
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
      stage: ReviewerRecoveryFailureStage;
      error: DomainError;
      job: Job;
    }>;
