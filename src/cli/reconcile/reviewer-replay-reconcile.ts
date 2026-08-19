import type { FileJobProgressStore } from "../../adapters/dispatch/job-progress-store.js";
import { isReviewerReplayCheckpointReconcilable } from "../dispatch/resume-composition.js";
import type { CliCommandOutcome } from "../program.js";
import type { ManualReconcileInput } from "./index.js";

export interface CreateReviewerReplayReconcileHandlerOptions {
  readonly base: (input: ManualReconcileInput) => Promise<CliCommandOutcome>;
  readonly progress: Pick<FileJobProgressStore, "listAll">;
  readonly replay: (input: Readonly<{ jobId: string }>) => Promise<CliCommandOutcome>;
}

/** Exact bridge only: it never calls discovery/generic dispatch and never admits a bare
 * requires_manual record. A successful replay checkpoint is the only additional inventory item. */
export function createReviewerReplayReconcileHandler(
  options: CreateReviewerReplayReconcileHandlerOptions,
): (input: ManualReconcileInput) => Promise<CliCommandOutcome> {
  return async (input) => {
    const base = await options.base(input);
    if ("jobId" in input) return base;
    if (base.state !== "success") return base;
    const records = await options.progress.listAll();
    if (!records.ok) {
      return {
        state: "failed",
        message: JSON.stringify({
          operation: "reconcile_reviewer_replay",
          state: "blocked",
          reason: "job_progress_read_failed",
          errorCode: records.error.code,
        }),
      };
    }
    const candidates = records.value.filter(isReviewerReplayCheckpointReconcilable);
    if (candidates.length === 0) return base;
    const outcomes: unknown[] = [];
    for (const record of candidates) {
      const replay = await options.replay({ jobId: record.jobId });
      let parsed: unknown = replay.message;
      try {
        parsed = replay.message === undefined ? undefined : JSON.parse(replay.message);
      } catch {
        // Keep bounded handler output rather than failing open on an unexpected presentation shape.
      }
      outcomes.push({ jobId: record.jobId, state: replay.state, result: parsed });
      if (replay.state !== "success") {
        return {
          state: replay.state,
          message: JSON.stringify({
            operation: "reconcile_reviewer_replay",
            state: "blocked",
            outcomes,
          }),
        };
      }
    }
    return {
      state: "success",
      message: JSON.stringify({
        operation: "reconcile_reviewer_replay",
        state: "completed",
        checkpointCount: candidates.length,
        outcomes,
      }),
    };
  };
}
