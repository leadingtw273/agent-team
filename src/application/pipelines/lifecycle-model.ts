import type { DomainError } from "../../domain/foundation/index.js";
import type { Project } from "../../domain/project/index.js";
import type { ChangeRequestSnapshot, SourceControlPort } from "../ports/source-control.js";
import type { AsyncPortResult, MutationOptions } from "../ports/common.js";
import type { WorkManagementPort } from "../ports/work-management.js";

export interface LifecyclePolicyPort {
  pauseAutoMerge(
    request: Readonly<{
      project: Project;
      reason: "out_of_process_merge";
      changeRequestId: string;
      mergedHeadSha: string;
    }>,
    options: MutationOptions,
  ): AsyncPortResult<Readonly<{ durability: "confirmed" | "unknown" }>>;
}

export interface LifecycleCancellationPort {
  prepare(
    request: Readonly<{
      project: Project;
      externalIssueId: string;
      changeRequest: ChangeRequestSnapshot;
      preserveBranchAndWorktree: true;
    }>,
    options: MutationOptions,
  ): AsyncPortResult<
    Readonly<{
      activeWorkStopped: boolean;
      checkpoint: "not_required" | "preserved";
      checkpointId?: string;
    }>
  >;
}

export interface LifecyclePipelinePorts {
  readonly sourceControl: Pick<SourceControlPort, "getChangeRequest" | "closeChangeRequest">;
  readonly workManagement: Pick<
    WorkManagementPort,
    "getIssue" | "setWorkStatus" | "setAgentCondition" | "appendComment"
  >;
  readonly policy: LifecyclePolicyPort;
  readonly cancellation: LifecycleCancellationPort;
}

export interface LifecyclePipelineRequest {
  readonly project: Project;
  readonly externalIssueId: string;
  readonly changeRequestId: string;
  readonly mergeAuthorizationHeadSha?: string;
  readonly idempotencyKeyPrefix: string;
  readonly signal?: AbortSignal;
}

export type LifecycleFailureStage =
  | "request"
  | "change_request"
  | "issue"
  | "policy"
  | "checkpoint"
  | "work_status"
  | "agent_condition"
  | "close_change_request"
  | "comment";

export type LifecyclePipelineOutcome =
  | Readonly<{
      state: "completed";
      merge: "authorized" | "out_of_process";
      headSha: string;
      autoMergePaused: boolean;
    }>
  | Readonly<{
      state: "canceled";
      changeRequest: "closed" | "already_closed";
      checkpoint: "not_required" | "preserved";
      checkpointId?: string;
    }>
  | Readonly<{
      state: "blocked";
      reason: "change_request_closed";
    }>
  | Readonly<{
      state: "unchanged";
      reason: "open" | "terminal_issue";
    }>
  | Readonly<{
      state: "failed";
      stage: LifecycleFailureStage;
      error: DomainError;
    }>;
