import type {
  ReviewerInspectionOutcome,
  ReviewerPipeline,
  ReviewerPipelineRequest,
} from "../../application/pipelines/index.js";
import { domainError } from "../../domain/foundation/index.js";

export type ReviewerRuntime = Pick<ReviewerPipeline, "run"> &
  Partial<Pick<ReviewerPipeline, "inspect">>;

/** Invoke the class method through its owner so JavaScript preserves ReviewerPipeline's `this`.
 * A missing optional inspect capability is represented as a normal fail-closed pipeline outcome,
 * never an uncaught TypeError from a lazy composition wrapper. */
export function invokeReviewerReplayInspect(
  reviewer: ReviewerRuntime,
  request: ReviewerPipelineRequest,
): Promise<ReviewerInspectionOutcome> {
  if (reviewer.inspect === undefined) {
    return Promise.resolve({
      state: "failed",
      stage: "request",
      error: domainError("invariant_violation"),
      job: request.job,
    });
  }
  return reviewer.inspect(request);
}

/** Shared lazy facade for both the dedicated replay CLI and scheduler/resume composition roots. */
export function createLazyReviewerFacade(
  prepared: () => ReviewerRuntime,
): Pick<ReviewerPipeline, "run" | "inspect"> {
  return Object.freeze({
    run: (request) => prepared().run(request),
    inspect: (request) => invokeReviewerReplayInspect(prepared(), request),
  });
}
