import type {
  JobProgressRecord,
  RequiresManualCause,
} from "../../adapters/dispatch/job-progress-store.js";
import type { BlockingReason } from "../../domain/workflow/index.js";

/**
 * A terminal handoff may overwrite Linear's main state only when this Job has a durable receipt
 * proving that the Controller previously moved the issue into an automation-owned work state.
 * The check intentionally ignores labels and claims: neither proves authority over main status.
 */
export function hasConfirmedWorkStart(record: JobProgressRecord): boolean {
  return (
    record.workStatusLifecycle?.admissionMode === "enforce" &&
    record.workStatusLifecycle.capabilityDigest !== undefined &&
    record.workStatusLifecycle.transitions.some(
      (transition) =>
        transition.step === "work_start" &&
        transition.mainTarget === "in_progress" &&
        transition.main.state === "confirmed",
    )
  );
}

/**
 * The latest confirmed Controller mutation is the only safe pre-state for a terminal projection.
 * Accepting both active states would overwrite a human move between them during the handoff race.
 */
export function latestConfirmedActiveWorkStatus(
  record: JobProgressRecord,
): "in_progress" | "in_review" | undefined {
  const target = [...(record.workStatusLifecycle?.transitions ?? [])]
    .reverse()
    .find((transition) => transition.main.state === "confirmed")?.mainTarget;
  return target === "in_progress" || target === "in_review" ? target : undefined;
}

/** Existing bounded auto-reentry owns these causes; projecting their main status would deadlock it. */
export function mayProjectRequiresManual(record: JobProgressRecord): boolean {
  if (record.stage.kind !== "requires_manual" || record.stage.cause === undefined) return false;
  const reason = record.stage.cause.reasonCode;
  if (
    reason === "auto_merge_not_enabled" ||
    reason === "lifecycle_not_completed" ||
    reason === "review_reuse_unimplemented"
  ) {
    return false;
  }
  return !(
    reason === "review_report_contract" && record.reviewerReplay?.state === "review_succeeded"
  );
}

/** Closed, public-safe mapping; raw provider text and dynamic failure details never reach Linear. */
export function requiresManualBlockingReason(
  cause: RequiresManualCause | undefined,
): BlockingReason {
  if (cause?.stage === "ci_recovery" || cause?.reasonCode === "ci_failed_after_ready") {
    return "integration_failure";
  }
  if (
    cause?.reasonCode === "change_request_behind_base" ||
    cause?.reasonCode === "auto_merge_stalled" ||
    cause?.reasonCode === "merge_state_unknown_timeout"
  ) {
    return "merge_conflict";
  }
  return "unknown_error";
}

export function requiresManualHandoffComment(record: JobProgressRecord): string {
  const cause = record.stage.kind === "requires_manual" ? record.stage.cause : undefined;
  const category =
    cause?.stage === "ci_recovery" || cause?.reasonCode === "ci_failed_after_ready"
      ? "CI／整合流程未能在安全界線內收斂"
      : "自動化流程遇到確定性阻擋";
  return `Agent Team 已停止自動執行：${category}。工單已移至「需人工」並標示阻塞；既有 Job 與變更請求均保留，且未繞過既有 review／merge gate。Job: ${record.jobId}`;
}
