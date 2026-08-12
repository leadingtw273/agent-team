/**
 * E116cap: `agent-team dispatch auto-merge-resume --project <id>` -- the human-issued escape hatch
 * out of a project-level auto-merge pause (`FileAutoMergePauseStore`,
 * src/adapters/dispatch/auto-merge-pause-store.ts). A pause is never auto-cleared -- once
 * `LifecyclePipeline` observes an out-of-process merge and `FileAutoMergePauseAdapter`
 * (lifecycle-policy-adapter.ts) durably writes the pause flag, every subsequent `AutoMergeGate.
 * enable()` call for that project fails closed with `not_ready:"auto_merge_paused"`
 * (merge-gate.ts) until a human runs this command -- mirrors `dispatch resolve`'s own fixed stdin
 * confirmation-phrase discipline (resolve-handlers.ts) exactly, for the same reason: this is a
 * deliberate, rare, operator-issued action, not something any automated path should ever be able
 * to trigger by accident. The same confirmation also CAS-recovers only Jobs whose exact manual
 * reason came from this pause; normal resume then revalidates every external merge prerequisite.
 *
 * Deliberately reports `already_active` (not an error) when the project was never paused, or was
 * already resolved by a concurrent invocation -- the handler still completes any pending Job CAS
 * from a prior interrupted call, then reports `already_active` in the same idempotent spirit
 * `FileAutoMergePauseStore.resolve` itself already has.
 */
import type { CliCommandOutcome } from "../program.js";
import { readStdinConfirmation } from "../registration/confirmation.js";
import type { FileAutoMergePauseStore } from "../../adapters/dispatch/auto-merge-pause-store.js";
import type {
  FileJobProgressStore,
  JobProgressRecord,
  JobProgressRecordMutation,
} from "../../adapters/dispatch/job-progress-store.js";

/** CLI-owned fixed phrase -- there is no engine concept of "resume auto-merge for a project" for
 * this to reuse, exactly like `dispatchResolveConfirmationPhrase`'s own rationale
 * (resolve-handlers.ts). */
export const dispatchAutoMergeResumeConfirmationPhrase = "RESUME AUTO MERGE" as const;

export interface DispatchAutoMergeResumeInput {
  readonly projectId: string;
}

export interface CreateDispatchAutoMergeResumeHandlerOptions {
  readonly store: FileAutoMergePauseStore;
  readonly progress: Pick<FileJobProgressStore, "compareAndSwap" | "listForProject">;
  /** Injectable for tests; production defaults to `process.stdin`. */
  readonly stdin?: AsyncIterable<Uint8Array | string>;
}

function mutationFrom(record: JobProgressRecord): JobProgressRecordMutation {
  const {
    schemaVersion: _schemaVersion,
    revision: _revision,
    updatedAt: _updatedAt,
    ...mutation
  } = record;
  void _schemaVersion;
  void _revision;
  void _updatedAt;
  return mutation;
}

function blockedByResolvedPause(record: JobProgressRecord): boolean {
  return (
    record.stage.kind === "requires_manual" &&
    record.stage.cause?.stage === "merge" &&
    record.stage.cause.reasonCode === "auto_merge_paused_out_of_process_merge"
  );
}

async function recoverPausedJobs(
  options: CreateDispatchAutoMergeResumeHandlerOptions,
  projectId: string,
): Promise<
  | Readonly<{ ok: true; recoveredJobCount: number }>
  | Readonly<{
      ok: false;
      reason: "job_progress_read_failed" | "job_progress_recovery_failed";
      errorCode: string;
    }>
> {
  const records = await options.progress.listForProject(projectId);
  if (!records.ok) {
    return { ok: false, reason: "job_progress_read_failed", errorCode: records.error.code };
  }

  let recoveredJobCount = 0;
  for (const record of records.value.filter(blockedByResolvedPause)) {
    const recovered = await options.progress.compareAndSwap(record.jobId, record.revision, {
      ...mutationFrom(record),
      stage: { kind: "awaiting_review" },
    });
    if (!recovered.ok) {
      return {
        ok: false,
        reason: "job_progress_recovery_failed",
        errorCode: recovered.error.code,
      };
    }
    recoveredJobCount += 1;
  }
  return { ok: true, recoveredJobCount };
}

function outcome(
  state: "success" | "failed" | "blocked" | "rejected",
  payload: unknown,
): CliCommandOutcome {
  return { state, message: JSON.stringify(payload) };
}

export function createDispatchAutoMergeResumeHandler(
  options: CreateDispatchAutoMergeResumeHandlerOptions,
): (input: DispatchAutoMergeResumeInput) => Promise<CliCommandOutcome> {
  const stdin = options.stdin ?? process.stdin;

  return async (input) => {
    if (input.projectId.trim().length === 0) {
      return outcome("rejected", {
        operation: "dispatch_auto_merge_resume",
        state: "rejected",
        reason: "project_id_required",
      });
    }

    const confirmation = await readStdinConfirmation(stdin);
    if (!confirmation.ok || confirmation.value !== dispatchAutoMergeResumeConfirmationPhrase) {
      return outcome("rejected", {
        operation: "dispatch_auto_merge_resume",
        state: "rejected",
        reason: "confirmation_mismatch",
      });
    }

    const before = await options.store.load(input.projectId);
    if (!before.ok) {
      return outcome("failed", {
        operation: "dispatch_auto_merge_resume",
        state: "blocked",
        reason: "auto_merge_pause_read_failed",
        errorCode: before.error.code,
      });
    }
    const pausedEvidence =
      before.value?.status.state === "paused" ? before.value.status.evidence : undefined;
    const wasPaused = pausedEvidence !== undefined;
    if (wasPaused) {
      const resolved = await options.store.resolve(input.projectId);
      if (!resolved.ok) {
        return outcome("failed", {
          operation: "dispatch_auto_merge_resume",
          state: "blocked",
          reason: "auto_merge_pause_write_failed",
          errorCode: resolved.error.code,
        });
      }
    }

    // The project pause is resolved before the CAS so a concurrent reconcile can never observe a
    // recovered Job while the project is still paused. If the process stops between these steps,
    // repeating this same confirmed command sees `already_active` and completes the pending CAS.
    const recovered = await recoverPausedJobs(options, input.projectId);
    if (!recovered.ok) {
      return outcome("failed", {
        operation: "dispatch_auto_merge_resume",
        state: "blocked",
        reason: recovered.reason,
        errorCode: recovered.errorCode,
      });
    }

    return outcome("success", {
      operation: "dispatch_auto_merge_resume",
      state: wasPaused ? "resumed" : "already_active",
      projectId: input.projectId,
      recoveredJobCount: recovered.recoveredJobCount,
      ...(pausedEvidence === undefined ? {} : { pausedEvidence }),
    });
  };
}
