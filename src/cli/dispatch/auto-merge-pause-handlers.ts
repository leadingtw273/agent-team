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
 * to trigger by accident.
 *
 * Deliberately reports `already_active` (not an error) when the project was never paused, or was
 * already resolved by a concurrent invocation -- resuming an already-unpaused project is not a
 * mistake worth failing loudly over, the same idempotent spirit `FileAutoMergePauseStore.resolve`
 * itself already has.
 */
import type { CliCommandOutcome } from "../program.js";
import { readStdinConfirmation } from "../registration/confirmation.js";
import type { FileAutoMergePauseStore } from "../../adapters/dispatch/auto-merge-pause-store.js";

/** CLI-owned fixed phrase -- there is no engine concept of "resume auto-merge for a project" for
 * this to reuse, exactly like `dispatchResolveConfirmationPhrase`'s own rationale
 * (resolve-handlers.ts). */
export const dispatchAutoMergeResumeConfirmationPhrase = "RESUME AUTO MERGE" as const;

export interface DispatchAutoMergeResumeInput {
  readonly projectId: string;
}

export interface CreateDispatchAutoMergeResumeHandlerOptions {
  readonly store: FileAutoMergePauseStore;
  /** Injectable for tests; production defaults to `process.stdin`. */
  readonly stdin?: AsyncIterable<Uint8Array | string>;
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
    if (before.value === undefined || before.value.status.state === "active") {
      return outcome("success", {
        operation: "dispatch_auto_merge_resume",
        state: "already_active",
        projectId: input.projectId,
      });
    }

    const resolved = await options.store.resolve(input.projectId);
    if (!resolved.ok) {
      return outcome("failed", {
        operation: "dispatch_auto_merge_resume",
        state: "blocked",
        reason: "auto_merge_pause_write_failed",
        errorCode: resolved.error.code,
      });
    }

    return outcome("success", {
      operation: "dispatch_auto_merge_resume",
      state: "resumed",
      projectId: input.projectId,
      pausedEvidence: before.value.status.evidence,
    });
  };
}
