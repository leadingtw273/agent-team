/**
 * C015o decision 4: `agent-team dispatch resolve --job <id> --as superseded|cancelled
 * [--superseded-by <job-id>]` -- the human-issued escape hatch out of `requires_manual` (or any
 * other genuinely stuck, non-terminal job-progress stage) that decision 3's admission claim
 * deliberately never releases on its own (see issue-admission-store.ts's own header: `completed`,
 * `cancelled`, or `superseded` are the only valid release reasons -- `requires_manual` is *not* a
 * terminal state, and letting a fresh dispatch attempt run again while the original job is still
 * stuck is exactly the duplicate-dispatch bug this whole ticket closes). This is also the tool
 * this ticket's own PR #4/#5 duplicate-dispatch incident is meant to be resolved with, once this
 * fix is live: keep #4 (or #5) as the surviving job, mark the other `superseded` naming the
 * survivor as `supersededByJobId`.
 *
 * Requires the fixed stdin confirmation phrase `dispatchResolveConfirmationPhrase`, compared
 * *exactly* (same `readStdinConfirmation` discipline `setup start`/`setup approve`/`probe run`
 * already use) -- a typo must be zero side effect, verified by this file's own test suite.
 */
import type { CliCommandOutcome } from "../program.js";
import { readStdinConfirmation } from "../registration/confirmation.js";
import type {
  FileJobProgressStore,
  JobProgressRecord,
  JobProgressRecordMutation,
} from "../../adapters/dispatch/job-progress-store.js";
import type { IssueAdmissionPort } from "../../adapters/dispatch/issue-admission-store.js";
import { jobIdSchema } from "../../domain/jobs/index.js";

/** O009-style fixed CLI-owned phrase (see confirmation.ts's own header on why this command has no
 * engine-defined phrase to reuse -- there is no engine concept of "resolve a stuck dispatch job"
 * at all, this is a purely CLI/adapter-layer escape hatch). */
export const dispatchResolveConfirmationPhrase = "RESOLVE DISPATCH JOB" as const;

export interface DispatchResolveInput {
  readonly jobId: string;
  readonly as: "superseded" | "cancelled";
  readonly supersededByJobId?: string;
}

export interface CreateDispatchResolveHandlerOptions {
  readonly progress: FileJobProgressStore;
  readonly admission: IssueAdmissionPort;
  /** Injectable for tests; production defaults to `process.stdin`. */
  readonly stdin?: AsyncIterable<Uint8Array | string>;
}

const terminalStageKinds: ReadonlySet<string> = new Set(["completed", "superseded", "cancelled"]);

function outcome(
  state: "success" | "failed" | "blocked" | "rejected",
  payload: unknown,
): CliCommandOutcome {
  return { state, message: JSON.stringify(payload) };
}

function mutationFrom(record: JobProgressRecord): JobProgressRecordMutation {
  const {
    schemaVersion: _schemaVersion,
    revision: _revision,
    updatedAt: _updatedAt,
    ...rest
  } = record;
  void _schemaVersion;
  void _revision;
  void _updatedAt;
  return rest;
}

/**
 * Builds the `dispatch resolve` handler. Sequence: validate the `--as`/`--superseded-by`
 * combination up front (before ever reading stdin, so a doomed-to-fail invocation fails fast) ->
 * require the exact confirmation phrase (zero side effects on mismatch) -> load the job-progress
 * record (fails closed if missing or already terminal) -> write the requested terminal stage via
 * CAS -> release the corresponding admission claim, defensively (only if it is still active and
 * either jobless or owned by exactly this job -- never blindly overwrites a *different* job's
 * claim, e.g. if a second `dispatch resolve` raced this one, or the issue was already reclaimed by
 * a newer job since this one's claim was released).
 */
export function createDispatchResolveHandler(
  options: CreateDispatchResolveHandlerOptions,
): (input: DispatchResolveInput) => Promise<CliCommandOutcome> {
  const stdin = options.stdin ?? process.stdin;

  return async (input) => {
    if (
      input.as === "superseded" &&
      (input.supersededByJobId === undefined || input.supersededByJobId.trim().length === 0)
    ) {
      return outcome("rejected", {
        operation: "dispatch_resolve",
        state: "rejected",
        reason: "superseded_requires_superseded_by",
      });
    }
    if (input.as === "cancelled" && input.supersededByJobId !== undefined) {
      return outcome("rejected", {
        operation: "dispatch_resolve",
        state: "rejected",
        reason: "cancelled_must_not_carry_superseded_by",
      });
    }

    const confirmation = await readStdinConfirmation(stdin);
    if (!confirmation.ok || confirmation.value !== dispatchResolveConfirmationPhrase) {
      return outcome("rejected", {
        operation: "dispatch_resolve",
        state: "rejected",
        reason: "confirmation_mismatch",
      });
    }

    const record = await options.progress.load(input.jobId);
    if (!record.ok) {
      return outcome("failed", {
        operation: "dispatch_resolve",
        state: "blocked",
        reason: "job_progress_read_failed",
        error: record.error,
      });
    }
    if (record.value === undefined) {
      return outcome("failed", {
        operation: "dispatch_resolve",
        state: "blocked",
        reason: "job_not_found",
      });
    }
    if (terminalStageKinds.has(record.value.stage.kind)) {
      return outcome("failed", {
        operation: "dispatch_resolve",
        state: "blocked",
        reason: "already_terminal",
        currentStage: record.value.stage,
      });
    }

    let nextStage: JobProgressRecord["stage"];
    if (input.as === "superseded") {
      const parsedSupersededBy = jobIdSchema.safeParse(input.supersededByJobId);
      if (!parsedSupersededBy.success) {
        return outcome("rejected", {
          operation: "dispatch_resolve",
          state: "rejected",
          reason: "superseded_by_job_id_invalid",
        });
      }
      nextStage = { kind: "superseded", supersededByJobId: parsedSupersededBy.data };
    } else {
      nextStage = { kind: "cancelled" };
    }
    const written = await options.progress.compareAndSwap(input.jobId, record.value.revision, {
      ...mutationFrom(record.value),
      stage: nextStage,
    });
    if (!written.ok) {
      return outcome("failed", {
        operation: "dispatch_resolve",
        state: "blocked",
        reason: "progress_write_failed",
        error: written.error,
      });
    }

    const claim = await options.admission.load(record.value.projectId, record.value.issueId);
    let admissionReleased: "released" | "not_found" | "owned_by_other_job" | "release_failed" =
      "not_found";
    if (claim.ok && claim.value?.state === "active") {
      if (claim.value.jobId === undefined || claim.value.jobId === input.jobId) {
        const released = await options.admission.release(
          record.value.projectId,
          record.value.issueId,
          claim.value.revision,
          input.as,
          input.supersededByJobId,
        );
        admissionReleased = released.ok ? "released" : "release_failed";
      } else {
        admissionReleased = "owned_by_other_job";
      }
    }

    return outcome("success", {
      operation: "dispatch_resolve",
      state: "resolved",
      jobId: input.jobId,
      as: input.as,
      ...(input.supersededByJobId === undefined
        ? {}
        : { supersededByJobId: input.supersededByJobId }),
      admissionReleased,
    });
  };
}
