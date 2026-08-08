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
  SourceControlRepositoryRef,
} from "../ports/index.js";
import type { AsyncPortResult, MutationOptions, ReadOptions } from "../ports/common.js";
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

/**
 * C017: closes the "recovery flies blind" gap -- before this ticket, the repair prompt carried
 * only the check name/status/conclusion/URL (`CommitCheck`, source-control.ts), never a single
 * line of *why* the check failed. This is the narrow, adapter-provided capability
 * `CiRecoveryPipeline.run()` uses right before starting a repair attempt to attach a bounded,
 * boundary-wrapped log excerpt as `externalData` (see that file's own module header). Adapter-only
 * precedent (never added to the shared `SourceControlPort`) mirrors `GitHubAdapter`'s existing
 * `getRepositoryMetadata`/`squashMergeChangeRequest` -- a capability specific to what GitHub
 * Actions exposes, not something every source-control provider can equally offer.
 */
export interface CiFailureLogExcerpt {
  readonly checkName: string;
  readonly text: string;
  readonly truncated: boolean;
  /** C017b: byte length of the *raw* job log fetched for this check, before extraction --
   * carried alongside the already-extracted `text` purely so a best-effort observability signal
   * (see `CiRecoveryObservabilityPort` below) can report "how much source log did we actually get"
   * without ever needing to re-read or retain the raw log itself. */
  readonly sourceBytes: number;
}

/**
 * Deliberately never a hard port failure for anything the pipeline must survive: a missing
 * `requestText` capability, an unauthenticated/rate-limited/404 log endpoint, or simply no
 * Actions-backed failing check at all, all collapse to `available: false` with a `reason` string
 * for the repair prompt to state plainly ("log unavailable, diagnose from check metadata only") --
 * never to a pipeline-level `failed()`. See `CiRecoveryPipeline.run()`'s own call site.
 */
export type CiFailureLogOutcome =
  | Readonly<{ available: true; excerpts: readonly CiFailureLogExcerpt[] }>
  | Readonly<{ available: false; reason: string }>;

export interface CiRecoveryCiLogPort {
  getFailedCheckLogExcerpts(
    repository: SourceControlRepositoryRef,
    headSha: string,
    options?: ReadOptions,
  ): AsyncPortResult<CiFailureLogOutcome>;
}

/**
 * C017b (D2): the minimal, non-backlog observability signal the coordinator's decision required --
 * before this, `CiFailureLogOutcome`'s `available: false`/`reason` never left the pipeline, so a
 * repair that failed *again* gave no way to tell "the log was never attached" (a port/adapter
 * problem) apart from "the log was attached and the model still couldn't fix it" (a model/prompt
 * problem) -- the same "one signal cannot distinguish two different situations" failure mode this
 * codebase's own diagnostic discipline elsewhere already treats as a defect, not a nuance.
 *
 * Deliberately **synchronous and void**: this is a fire-and-forget diagnostic, not a mutation with
 * a durability contract -- `CiRecoveryPipeline.run()` calls it wrapped in its own `try`/`catch` (see
 * that file) so a throwing implementation can never turn a diagnostic into a repair-blocking
 * failure. Ports elsewhere in this codebase return `AsyncPortResult` because their failure is part
 * of the caller's own control flow; this one's failure, by design, is not.
 *
 * **Never given the log's own text or content** -- only closed-shape metadata (`available`,
 * `reason`, byte counts). See `ciFailureLogExternalData` (ci-recovery.ts) for the one place actual
 * log content is handled, which is a completely separate code path from this port.
 */
export interface CiRecoveryObservabilityPort {
  recordCiLogExcerpt(
    record: Readonly<{
      jobId: string;
      available: boolean;
      reason?: string;
      sourceBytes?: number;
      excerptBytes?: number;
    }>,
  ): void;
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
  readonly ciLog: CiRecoveryCiLogPort;
  readonly jobs: CiRecoveryJobPort;
  readonly checkpoint: CiRecoveryCheckpointPort;
  readonly toolDecisions: ProviderToolDecisionPort;
  /** C017b (D2): optional so every pre-existing test double across this codebase that already
   * constructs `CiRecoveryPipelinePorts` keeps compiling unchanged -- production composition
   * (ci-recovery-composition.ts) always wires a real one. */
  readonly observability?: CiRecoveryObservabilityPort;
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
