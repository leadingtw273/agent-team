import {
  domainError,
  err,
  ok,
  type DomainError,
  type Instant,
  type Result,
} from "../foundation/index.js";
import type { Job } from "./schema.js";

export const watchdogInspectionMs = 45 * 60 * 1000;
export const watchdogHardStopMs = 60 * 60 * 1000;

export const progressEvidenceKinds = [
  "controlled_git_diff",
  "test_or_build_milestone",
  "checkpoint_created",
  "narrowing_error_evidence",
  "distinct_solution_experiment",
] as const;

export type ProgressEvidenceKind = (typeof progressEvidenceKinds)[number];

const progressEvidenceKindSet: ReadonlySet<string> = new Set(progressEvidenceKinds);

export interface WatchdogInput {
  readonly startedAt: Instant;
  readonly now: Instant;
  readonly extensionGranted: boolean;
  readonly inspection?: Readonly<{
    effectiveProgress: readonly ProgressEvidenceKind[];
    originalAgentCompletionCheaper: boolean;
  }>;
}

export type WatchdogDecision =
  | "continue"
  | "inspection_required"
  | "continue_once_extended"
  | "checkpoint_and_replan"
  | "checkpoint_hard_stop";

export function evaluateWatchdog(
  input: WatchdogInput,
): Result<WatchdogDecision, DomainError<"conflict">> {
  const startedAt = Date.parse(input.startedAt);
  const now = Date.parse(input.now);
  if (now < startedAt) return err(domainError("conflict"));

  const elapsed = now - startedAt;
  if (elapsed >= watchdogHardStopMs) return ok("checkpoint_hard_stop");
  if (elapsed < watchdogInspectionMs) return ok("continue");
  if (input.extensionGranted) return ok("continue_once_extended");
  if (input.inspection === undefined) return ok("inspection_required");

  if (!input.inspection.effectiveProgress.every((kind) => progressEvidenceKindSet.has(kind))) {
    return err(domainError("conflict"));
  }

  const shouldExtend =
    input.inspection.effectiveProgress.length > 0 &&
    input.inspection.originalAgentCompletionCheaper;
  return ok(shouldExtend ? "continue_once_extended" : "checkpoint_and_replan");
}

export function grantWatchdogExtension(
  job: Job,
  decision: WatchdogDecision,
): Result<Job, DomainError<"conflict">> {
  if (job.watchdogExtensionGranted || decision !== "continue_once_extended") {
    return err(domainError("conflict"));
  }

  return ok(Object.freeze({ ...job, watchdogExtensionGranted: true }));
}
