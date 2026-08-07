import type { TrustedProjectConfig } from "../projects/index.js";
import type {
  ChangeRequestSnapshot,
  CommitChecksSnapshot,
  GitCommitReceipt,
  GitPort,
  GitPushReceipt,
  GitWorktree,
  GitWorkingTreeChange,
  ProviderEvent,
  ProviderPort,
  SourceControlPort,
} from "../ports/index.js";
import type { ReadOptions, MutationOptions, AsyncPortResult } from "../ports/common.js";
import type { DomainError } from "../../domain/foundation/index.js";
import type { Instant } from "../../domain/foundation/index.js";
import type { Job } from "../../domain/jobs/index.js";
import type { AgentRole, ChangeRegion, Project } from "../../domain/project/index.js";
import type { RequirementSnapshot } from "../../domain/review/index.js";
import type { ExternalDataBlock } from "../ports/provider.js";

export type ImplementerPreflightFinding =
  | Readonly<{ code: "outside_declared_region"; path: string }>
  | Readonly<{ code: "unexpected_untracked"; path: string }>
  | Readonly<{ code: "preexisting_staged_change"; path: string }>
  | Readonly<{ code: "unsafe_symlink"; path: string }>
  | Readonly<{ code: "suspected_secret"; path: string }>
  | Readonly<{ code: "unscannable_file"; path: string }>
  | Readonly<{ code: "overlapping_job_change"; path: string; otherJobId: string }>
  /** C015m: mirrors `GitPreflightFinding`'s own new code (src/adapters/git/preflight.ts) --
   * mechanical type-widening only. `ImplementerPipeline.run()`'s own decision logic already
   * treats *any* non-empty findings list as `allowed:false` / `scope_overrun` uniformly,
   * regardless of which specific codes appear, so this adds no new judgment/branching, only lets
   * this existing generic path carry the new adapter-level finding through the port contract. */
  | Readonly<{ code: "gitattributes_modified"; path: string }>;

export interface ImplementerPreflightReport {
  readonly headSha: string;
  readonly allowed: boolean;
  readonly scopeVerified: boolean;
  readonly changedPaths: readonly string[];
  readonly findings: readonly ImplementerPreflightFinding[];
}

export interface ImplementerPreflightPort {
  inspect(
    request: Readonly<{
      worktree: GitWorktree;
      declaredRegions?: readonly ChangeRegion[];
      expectedUntrackedPaths?: readonly string[];
      concurrentJobs?: readonly Readonly<{
        jobId: string;
        changes: readonly GitWorkingTreeChange[];
      }>[];
      knownSecrets?: readonly string[];
    }>,
    options?: ReadOptions,
  ): Promise<
    | Readonly<{ ok: true; value: ImplementerPreflightReport }>
    | Readonly<{ ok: false; error: DomainError }>
  >;
}

export interface ScopeOverrunCheckpointPort {
  preserve(
    request: Readonly<{
      job: Job;
      worktree: GitWorktree;
      requirementSnapshot: RequirementSnapshot;
      findings: readonly ImplementerPreflightFinding[];
      changedPaths: readonly string[];
    }>,
    options: MutationOptions,
  ): AsyncPortResult<Readonly<{ checkpointId: string }>>;
}

export interface ProviderToolDecisionPort {
  decide(
    event: Extract<ProviderEvent, { kind: "tool_request" }>,
    context: Readonly<{ job: Job; project: Project }>,
    options?: ReadOptions,
  ): AsyncPortResult<
    Readonly<{
      response: "approve" | "decline";
      pause: boolean;
      summary: string;
    }>
  >;
}

export interface ImplementerPipelinePorts {
  readonly git: Pick<
    GitPort,
    "createWorktree" | "stagePaths" | "commit" | "inspectWorkingTree" | "push"
  >;
  readonly preflight: ImplementerPreflightPort;
  readonly provider: ProviderPort;
  readonly sourceControl: Pick<SourceControlPort, "createDraftChangeRequest" | "getCommitChecks">;
  readonly scopeCheckpoint: ScopeOverrunCheckpointPort;
  readonly toolDecisions: ProviderToolDecisionPort;
}

export interface ImplementerPipelineRequest {
  readonly job: Job;
  readonly project: Project;
  readonly trustedConfig: TrustedProjectConfig;
  readonly requirementSnapshot: RequirementSnapshot;
  readonly role: Extract<AgentRole, "implementer">;
  readonly model: string;
  readonly repositoryRoot: string;
  readonly baseRevision: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly remote: string;
  readonly commitMessage: string;
  readonly pullRequest: Readonly<{ title: string; body: string }>;
  readonly controllerDirective: string;
  readonly externalData: readonly ExternalDataBlock[];
  readonly deadlineAt: Instant;
  readonly expectedUntrackedPaths?: readonly string[];
  readonly concurrentJobs?: Parameters<ImplementerPreflightPort["inspect"]>[0]["concurrentJobs"];
  readonly knownSecrets?: readonly string[];
  readonly idempotencyKeyPrefix: string;
  readonly signal?: AbortSignal;
}

export type ImplementerFailureStage =
  | "request"
  | "worktree"
  | "provider_start"
  | "provider_run"
  | "tool_decision"
  | "preflight"
  | "checkpoint"
  | "stage"
  | "commit"
  | "post_commit"
  | "push"
  | "draft_pull_request"
  | "checks";

export type ImplementerPipelineOutcome =
  | Readonly<{
      state: "ci_waiting";
      worktree: GitWorktree;
      commit: GitCommitReceipt;
      push: GitPushReceipt;
      changeRequest: ChangeRequestSnapshot;
      checks: CommitChecksSnapshot;
      providerSessionId?: string;
    }>
  | Readonly<{
      state: "paused";
      reason: "scope_overrun" | "safety_approval_required" | "provider_interrupted" | "no_changes";
      worktree: GitWorktree;
      checkpointId?: string;
      findings?: readonly ImplementerPreflightFinding[];
      toolSummary?: string;
    }>
  | Readonly<{
      state: "failed";
      stage: ImplementerFailureStage;
      error: DomainError;
      worktree?: GitWorktree;
    }>;
