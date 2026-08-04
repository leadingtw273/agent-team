import type { GitWorkingTreeChange, GitWorktree } from "../ports/git.js";
import type {
  GitCommitCommand,
  GitCommitReceipt,
  GitPushReceipt,
  GitWorkingTreeSnapshot,
} from "../ports/git.js";
import type { MutationOptions, ReadOptions, AsyncPortResult } from "../ports/common.js";
import type { WorkManagementComment, WorkManagementIssueRef } from "../ports/work-management.js";
import type { Checkpoint } from "../../domain/checkpoint/index.js";
import type { DomainError } from "../../domain/foundation/index.js";
import type { ChangeRegion } from "../../domain/project/index.js";

export interface CheckpointPreflightFinding {
  readonly code: string;
  readonly path: string;
  readonly otherJobId?: string;
}

export interface CheckpointPreflightRequest {
  readonly worktree: GitWorktree;
  readonly declaredRegions: readonly ChangeRegion[];
  readonly expectedUntrackedPaths?: readonly string[];
  readonly concurrentJobs?: readonly Readonly<{
    jobId: string;
    changes: readonly GitWorkingTreeChange[];
  }>[];
  readonly knownSecrets?: readonly string[];
}

export interface CheckpointPreflightReport {
  readonly headSha: string;
  readonly allowed: boolean;
  readonly scopeVerified: boolean;
  readonly changedPaths: readonly string[];
  readonly findings: readonly CheckpointPreflightFinding[];
}

export interface CheckpointPreflightPort {
  inspect(
    request: CheckpointPreflightRequest,
    options?: ReadOptions,
  ): AsyncPortResult<CheckpointPreflightReport>;
}

export interface CheckpointGitPort {
  stagePaths(
    worktree: GitWorktree,
    paths: readonly string[],
    options: MutationOptions,
  ): AsyncPortResult<GitWorkingTreeSnapshot>;
  inspectWorkingTree(
    worktree: GitWorktree,
    options?: ReadOptions,
  ): AsyncPortResult<GitWorkingTreeSnapshot>;
  commit(command: GitCommitCommand, options: MutationOptions): AsyncPortResult<GitCommitReceipt>;
  push(
    worktree: GitWorktree,
    remote: string,
    options: MutationOptions,
  ): AsyncPortResult<GitPushReceipt>;
}

export interface CheckpointWorkManagementPort {
  appendComment(
    reference: WorkManagementIssueRef,
    body: string,
    options: MutationOptions,
  ): AsyncPortResult<WorkManagementComment>;
}

export interface CheckpointPersistenceReceipt {
  readonly path: string;
  readonly sha256: string;
  readonly durability: "confirmed" | "unknown";
}

export interface CheckpointPersistencePort {
  persist(
    checkpoint: Checkpoint,
    options: MutationOptions,
  ): AsyncPortResult<CheckpointPersistenceReceipt>;
}

export type CheckpointDraft = Omit<Checkpoint, "worktree">;

export interface CreateCheckpointRequest {
  readonly draft: CheckpointDraft;
  readonly worktree: GitWorktree;
  readonly declaredRegions: readonly ChangeRegion[];
  readonly expectedUntrackedPaths?: readonly string[];
  readonly concurrentJobs?: CheckpointPreflightRequest["concurrentJobs"];
  readonly knownSecrets?: readonly string[];
  readonly remote: string;
  readonly workManagementIssue: WorkManagementIssueRef;
  readonly draftPullRequestUrl?: string;
  readonly idempotencyKeyPrefix: string;
  readonly signal?: AbortSignal;
}

export type CheckpointCoordinatorFailureStage =
  "request" | "preflight" | "stage" | "commit" | "post_commit" | "persistence";

export type CheckpointCoordinatorOutcome =
  | Readonly<{
      state: "paused";
      reason: "preflight_rejected" | "secret_in_checkpoint_metadata";
      findings: readonly CheckpointPreflightFinding[];
    }>
  | Readonly<{
      state: "failed";
      stage: CheckpointCoordinatorFailureStage;
      error: DomainError;
      commitSha?: string;
    }>
  | Readonly<{
      state: "completed" | "degraded";
      checkpoint: Checkpoint;
      persistence: CheckpointPersistenceReceipt;
      linearCommentId?: string;
      degradations: readonly (
        | "push_failed"
        | "push_skipped_post_commit_unverified"
        | "checkpoint_durability_unknown"
        | "linear_sync_failed"
      )[];
    }>;
