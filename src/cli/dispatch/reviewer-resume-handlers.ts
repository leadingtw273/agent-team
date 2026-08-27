import type { CliCommandOutcome } from "../program.js";
import { readStdinConfirmation } from "../registration/confirmation.js";
import type {
  FileJobProgressStore,
  JobProgressRecord,
  JobProgressRecordMutation,
} from "../../adapters/dispatch/job-progress-store.js";
import { createClock, type Clock } from "../../domain/foundation/index.js";
import { jobIdSchema } from "../../domain/jobs/index.js";

export const reviewerResumeConfirmationPhrase = "RESUME CLAUDE REVIEW" as const;

export interface CreateReviewerResumeHandlerOptions {
  readonly progress: FileJobProgressStore;
  readonly clock?: Clock;
  readonly stdin?: AsyncIterable<Uint8Array | string>;
}

export interface ReviewerResumeInput {
  readonly jobId: string;
  readonly recoverReadyIdempotency?: boolean;
}

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

export function createReviewerResumeHandler(
  options: CreateReviewerResumeHandlerOptions,
): (input: ReviewerResumeInput) => Promise<CliCommandOutcome> {
  const stdin = options.stdin ?? process.stdin;
  const clock = options.clock ?? createClock();
  return async (input) => {
    if (!jobIdSchema.safeParse(input.jobId).success) {
      return outcome("rejected", {
        operation: "dispatch_reviewer_resume",
        state: "rejected",
        reason: "job_id_invalid",
      });
    }
    const confirmation = await readStdinConfirmation(stdin);
    if (!confirmation.ok || confirmation.value !== reviewerResumeConfirmationPhrase) {
      return outcome("rejected", {
        operation: "dispatch_reviewer_resume",
        state: "rejected",
        reason: "confirmation_mismatch",
      });
    }
    const loaded = await options.progress.load(input.jobId);
    if (!loaded.ok || loaded.value === undefined) {
      return outcome("failed", {
        operation: "dispatch_reviewer_resume",
        state: "blocked",
        reason: loaded.ok ? "job_not_found" : "job_progress_read_failed",
        ...(!loaded.ok ? { errorCode: loaded.error.code } : {}),
      });
    }
    const stage = loaded.value.stage;
    const recoverableBeginFailure =
      stage.kind === "requires_manual" &&
      stage.cause?.stage === "review" &&
      stage.cause.reasonCode === "review_begin_failed";
    const confirmedReadyMutation = loaded.value.mutationAttempts?.some(
      (entry) => entry.intent === "pr_ready" && entry.attempts.at(-1)?.outcome === "confirmed",
    );
    const recoverableReadyFailure =
      input.recoverReadyIdempotency === true &&
      stage.kind === "requires_manual" &&
      stage.cause?.stage === "review" &&
      stage.cause.reasonCode === "review_provider_failed" &&
      confirmedReadyMutation === true &&
      loaded.value.changeRequestId !== undefined &&
      loaded.value.headSha !== undefined;
    if (stage.kind !== "reviewer_waiting" && !recoverableBeginFailure && !recoverableReadyFailure) {
      return outcome("failed", {
        operation: "dispatch_reviewer_resume",
        state: "blocked",
        reason: "job_not_waiting_for_reviewer",
        currentStage: loaded.value.stage.kind,
      });
    }
    if (
      stage.kind === "reviewer_waiting" &&
      stage.retryNotBefore !== undefined &&
      Date.parse(clock.now()) < Date.parse(stage.retryNotBefore)
    ) {
      return outcome("failed", {
        operation: "dispatch_reviewer_resume",
        state: "blocked",
        reason: "reset_not_reached",
        retryNotBefore: stage.retryNotBefore,
      });
    }
    const written = await options.progress.compareAndSwap(input.jobId, loaded.value.revision, {
      ...mutationFrom(loaded.value),
      stage: { kind: "awaiting_review" },
    });
    if (!written.ok) {
      return outcome("failed", {
        operation: "dispatch_reviewer_resume",
        state: "blocked",
        reason: "progress_write_failed",
        errorCode: written.error.code,
      });
    }
    const recovery = recoverableReadyFailure
      ? "review_ready_idempotency"
      : recoverableBeginFailure
        ? "review_begin_failed"
        : "reviewer_waiting";
    return outcome("success", {
      operation: "dispatch_reviewer_resume",
      state: "resumed",
      jobId: input.jobId,
      nextStage: "awaiting_review",
      admissionReleased: false,
      implementerRerun: false,
      recovery,
    });
  };
}
