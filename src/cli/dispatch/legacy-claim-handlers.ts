/**
 * C016: `agent-team dispatch resolve-legacy-claim --job <job-id> --project <project-id> --issue
 * <issue-id> --note <text>` -- the controlled repair path for an admission claim
 * (issue-admission-store.ts) that has **no** job-progress record to resolve against at all. This
 * is not a substitute for `dispatch resolve` (resolve-handlers.ts): that command remains the
 * *only* normal escape hatch, and it always operates against a real job-progress record. This
 * command exists solely for the one gap this ticket closes -- a `paused` pipeline outcome that
 * (before this ticket's fix, handlers.ts's `state === "paused"` branch) returned without ever
 * persisting one, leaving its claim durably active with nothing that could ever find it again
 * (the real incident this ticket closes, `issue_78bf4038`/LEA-16, `jobId:
 * job_5601c115-99ad-4f8b-a918-e7bb5b4c437e`).
 *
 * Codex's own explicit shape requirement (this ticket's packet): the subject of this repair is
 * the **jobId**, never the issue alone -- `--claim <issue-id>` (releasing by issue id with no
 * cross-check at all) was considered and rejected. The caller must already know which job they
 * believe owns the stuck claim (from the same `agent-team run` invocation's own stdout, or the
 * admission claim file's own `jobId` field, or -- as here -- an incident writeup); this handler's
 * whole job is to *verify* that belief against the real claim on disk before ever releasing
 * anything, not to trust it. Three checks, in order, every one of them zero-side-effect on
 * failure:
 *
 * 1. No job-progress record for `--job` exists. If one does, this is not the case this command
 *    exists for -- the operator wants plain `dispatch resolve` instead, which is strictly safer
 *    (it can see the job's own real stage, not just "a claim believed to be its").
 * 2. The claim at `(--project, --issue)` is `state:"active"` and `claim.jobId === --job` exactly
 *    -- never a jobless claim (that is a *different*, not-yet-handled gap this ticket does not
 *    claim to close -- see this file's own header on `IssueAdmissionRecord.jobId` for why one can
 *    exist), and never a claim now owned by some other job (the normal duplicate-dispatch
 *    scenario `dispatch resolve`'s own header already covers).
 * 3. The fixed stdin confirmation phrase `dispatchLegacyClaimConfirmationPhrase`, compared
 *    *exactly* -- deliberately a different phrase from `dispatchResolveConfirmationPhrase`, so a
 *    copy-pasted confirmation from the normal command can never accidentally authorize this one.
 *
 * Every successful release is written with `releaseReason: "legacy_recovered"` and the operator's
 * own `--note` verbatim as `releaseNote` -- a durable, on-disk audit trail (the claim file is
 * *rewritten*, never deleted) of exactly why this claim was recovered outside the normal
 * job-progress-record model. See issue-admission-store.ts's own schema comments for both fields.
 */
import type { CliCommandOutcome } from "../program.js";
import { readStdinConfirmation } from "../registration/confirmation.js";
import type { FileJobProgressStore } from "../../adapters/dispatch/job-progress-store.js";
import type { IssueAdmissionPort } from "../../adapters/dispatch/issue-admission-store.js";
import { jobIdSchema, projectIdSchema, issueIdSchema } from "../../domain/jobs/index.js";

/** Deliberately distinct from `dispatchResolveConfirmationPhrase` (resolve-handlers.ts) -- see
 * this file's own header, point 3. */
export const dispatchLegacyClaimConfirmationPhrase = "RELEASE LEGACY CLAIM" as const;

const releaseNoteInputSchema = { min: 1, max: 2000 } as const;

function isValidNote(note: string): boolean {
  const trimmed = note.trim();
  return (
    trimmed.length >= releaseNoteInputSchema.min && trimmed.length <= releaseNoteInputSchema.max
  );
}

export interface DispatchResolveLegacyClaimInput {
  readonly jobId: string;
  readonly projectId: string;
  readonly issueId: string;
  readonly note: string;
}

export interface CreateDispatchResolveLegacyClaimHandlerOptions {
  readonly progress: FileJobProgressStore;
  readonly admission: IssueAdmissionPort;
  /** Injectable for tests; production defaults to `process.stdin`. */
  readonly stdin?: AsyncIterable<Uint8Array | string>;
}

function outcome(
  state: "success" | "failed" | "blocked" | "rejected",
  payload: unknown,
): CliCommandOutcome {
  return { state, message: JSON.stringify(payload) };
}

/**
 * Builds the `dispatch resolve-legacy-claim` handler. Sequence: validate every id's shape and the
 * note's own bounds up front (before ever reading stdin, mirroring `dispatch resolve`'s own "fail
 * fast on a doomed invocation" discipline) -> require the exact, command-specific confirmation
 * phrase (zero side effects on mismatch) -> refuse if a job-progress record for `--job` already
 * exists (this is not the case this command is for) -> load the admission claim at
 * `(--project, --issue)`, requiring it to be `active` and `jobId`-matched exactly -> release it
 * with `releaseReason: "legacy_recovered"` and the operator's own audit note.
 */
export function createDispatchResolveLegacyClaimHandler(
  options: CreateDispatchResolveLegacyClaimHandlerOptions,
): (input: DispatchResolveLegacyClaimInput) => Promise<CliCommandOutcome> {
  const stdin = options.stdin ?? process.stdin;

  return async (input) => {
    const parsedJobId = jobIdSchema.safeParse(input.jobId);
    const parsedProjectId = projectIdSchema.safeParse(input.projectId);
    const parsedIssueId = issueIdSchema.safeParse(input.issueId);
    const noteValid = isValidNote(input.note);
    if (!parsedJobId.success || !parsedProjectId.success || !parsedIssueId.success || !noteValid) {
      return outcome("rejected", {
        operation: "dispatch_resolve_legacy_claim",
        state: "rejected",
        reason: "invalid_input",
      });
    }

    const confirmation = await readStdinConfirmation(stdin);
    if (!confirmation.ok || confirmation.value !== dispatchLegacyClaimConfirmationPhrase) {
      return outcome("rejected", {
        operation: "dispatch_resolve_legacy_claim",
        state: "rejected",
        reason: "confirmation_mismatch",
      });
    }

    // Point 1 (this file's own header): a real job-progress record means this is not the gap this
    // command exists to repair -- `dispatch resolve` is the strictly safer tool.
    const existingRecord = await options.progress.load(parsedJobId.data);
    if (!existingRecord.ok) {
      return outcome("failed", {
        operation: "dispatch_resolve_legacy_claim",
        state: "blocked",
        reason: "job_progress_read_failed",
        errorCode: existingRecord.error.code,
      });
    }
    if (existingRecord.value !== undefined) {
      return outcome("failed", {
        operation: "dispatch_resolve_legacy_claim",
        state: "blocked",
        reason: "job_progress_record_exists",
      });
    }

    const claim = await options.admission.load(parsedProjectId.data, parsedIssueId.data);
    if (!claim.ok) {
      return outcome("failed", {
        operation: "dispatch_resolve_legacy_claim",
        state: "blocked",
        reason: "admission_read_failed",
        errorCode: claim.error.code,
      });
    }
    if (claim.value === undefined) {
      return outcome("failed", {
        operation: "dispatch_resolve_legacy_claim",
        state: "blocked",
        reason: "claim_not_found",
      });
    }
    if (claim.value.state !== "active") {
      return outcome("failed", {
        operation: "dispatch_resolve_legacy_claim",
        state: "blocked",
        reason: "claim_not_active",
        currentState: claim.value.state,
      });
    }
    // Point 2 (this file's own header): the subject is the jobId -- a jobless claim, or one now
    // owned by a *different* job, is never released by this command. Neither case is silently
    // treated as a match.
    if (claim.value.jobId !== parsedJobId.data) {
      return outcome("failed", {
        operation: "dispatch_resolve_legacy_claim",
        state: "blocked",
        reason: "claim_job_mismatch",
      });
    }

    const released = await options.admission.release(
      parsedProjectId.data,
      parsedIssueId.data,
      claim.value.revision,
      "legacy_recovered",
      undefined,
      input.note,
    );
    if (!released.ok) {
      return outcome("failed", {
        operation: "dispatch_resolve_legacy_claim",
        state: "blocked",
        reason: "admission_release_failed",
        errorCode: released.error.code,
      });
    }

    return outcome("success", {
      operation: "dispatch_resolve_legacy_claim",
      state: "released",
      jobId: parsedJobId.data,
      projectId: parsedProjectId.data,
      issueId: parsedIssueId.data,
      note: input.note,
    });
  };
}
