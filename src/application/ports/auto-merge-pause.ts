import type { Project } from "../../domain/project/index.js";
import type { AsyncPortResult, ReadOptions } from "./common.js";

/**
 * E116cap: read-only query over the project-level auto-merge pause flag (the durable state
 * `FileAutoMergePauseStore`, src/adapters/dispatch/auto-merge-pause-store.ts, persists). This is
 * deliberately its own tiny port -- not folded into `SourceControlPort` or `LifecyclePolicyPort` --
 * because it has exactly two independent readers with no other ports in common:
 * `MergeGatePorts` (`AutoMergeGate.enable()`, merge-gate.ts, checked before ever attempting to arm
 * auto-merge on GitHub) and, structurally, any future caller that needs the same fact without
 * needing anything else `MergeGatePorts`/`LifecyclePolicyPort` bundle. `paused: boolean` is
 * intentionally the only field: the gate that consumes this never needs the pause reason/evidence
 * to make its own binary "may I arm auto-merge" decision -- that richer detail lives entirely in
 * the persisted `AutoMergePauseRecord`, for a human resolving the pause (or a future `dispatch
 * status`-style read) to inspect directly.
 */
export interface AutoMergePauseStatus {
  readonly paused: boolean;
}

export interface AutoMergePauseQueryPort {
  isPaused(
    request: Readonly<{ project: Project }>,
    options?: ReadOptions,
  ): AsyncPortResult<AutoMergePauseStatus>;
}
