import type { DomainError } from "../../domain/foundation/index.js";
import type { Project } from "../../domain/project/index.js";
import type { ChangeRequestSnapshot, SourceControlPort } from "../ports/source-control.js";
import type { AsyncPortResult, MutationOptions } from "../ports/common.js";
import type { WorkManagementPort } from "../ports/work-management.js";

/**
 * C015v decision 1: replaces the old bare `{durability: "confirmed" | "unknown"}` receipt, which
 * could not distinguish "a real pause genuinely happened" from "there was nothing to pause" --
 * C015c's `NoOpAutoMergePauseAdapter` (the only production implementation; `SourceControlPort` has
 * no `disableAutoMerge` method at all, confirmed by direct inspection) always returned
 * `{durability:"unknown"}`, which `LifecyclePipeline.#handleMerge` correctly treated as fail-closed
 * -- but that fail-closed branch fires on *every* out-of-process merge, including the overwhelming
 * common case where the change request is already `merged` and there is structurally nothing left
 * to pause. That interaction (two independently-correct C015c/C015t decisions) is exactly what
 * deadlocked a real E101 job: Linear could never reach Done, local progress could never reach
 * `completed`, and the admission claim could never release, for a PR that had genuinely, safely
 * already merged.
 *
 * - `"paused"`: a real pause action was durably confirmed (no production adapter can produce this
 *   today -- reserved for a future, real capability; E116's "future auto-merge isolation" scope,
 *   deliberately **not** implemented by this ticket, see this file's own header).
 * - `"not_applicable"`: pausing is structurally meaningless because the target change request is
 *   already `merged` -- there is no pending auto-merge left on *this* change request to cancel.
 *   Never invented by the policy adapter guessing at PR state it cannot itself observe; it is only
 *   ever correct because `LifecyclePipeline.#handleMerge` (the only caller) has *just* performed
 *   the authoritative readback that proves it, and only ever calls this port from that exact,
 *   already-merged context (`reason: "out_of_process_merge"`) -- see `#handleMerge`'s own comment.
 * - `"unknown"`: pause was attempted (or was expected to be possible) but could not be confirmed --
 *   still fail-closed, exactly as before this ticket. Never conflated with `"not_applicable"`: an
 *   adapter that genuinely doesn't know must keep saying so, not be nudged toward a false-positive
 *   "nothing to do here" just because that is the more convenient outcome.
 */
export type PauseAutoMergeOutcome =
  | Readonly<{ state: "paused"; durability: "confirmed" }>
  | Readonly<{
      state: "not_applicable";
      reason: "change_request_already_merged";
      observedState: "merged";
    }>
  | Readonly<{ state: "unknown"; durability: "unknown" }>;

export interface LifecyclePolicyPort {
  pauseAutoMerge(
    request: Readonly<{
      project: Project;
      reason: "out_of_process_merge";
      changeRequestId: string;
      mergedHeadSha: string;
    }>,
    options: MutationOptions,
  ): AsyncPortResult<PauseAutoMergeOutcome>;
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
      // C015v decision 2: replaces `autoMergePaused: boolean` -- codex's review named the exact
      // confusion that boolean caused: `false` meant both "authorized merge, no pause ever needed"
      // and "out-of-process merge, pause not applicable", making it impossible for any downstream
      // reader (audit trail, future tooling) to tell "nothing to do" apart from "something went
      // wrong and got silently swallowed". `"not_required"` (authorized, in-process merges only),
      // `"paused"`, and `"not_applicable"` are now mutually exclusive and each individually
      // meaningful.
      autoMergeDisposition: "not_required" | "paused" | "not_applicable";
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
