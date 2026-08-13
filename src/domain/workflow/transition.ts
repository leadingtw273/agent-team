import { domainError, err, ok, type DomainError, type Result } from "../foundation/index.js";
import type { AgentStatus, WorkStatus } from "./state.js";

export type WorkTransitionCause =
  | "ready_gate_passed"
  | "work_started"
  | "review_started"
  | "changes_requested"
  | "requirements_changed"
  | "policy_requires_manual"
  | "github_merge_observed"
  | "user_canceled"
  | "automation_reconcile";

export interface WorkTransitionRequest {
  readonly target: WorkStatus;
  readonly cause: WorkTransitionCause;
}

const standardWorkTransitions = new Set([
  "backlog>ready:ready_gate_passed",
  "ready>in_progress:work_started",
  "ready>requires_manual:policy_requires_manual",
  "requires_manual>ready:ready_gate_passed",
  "in_progress>in_review:review_started",
  "in_review>in_progress:changes_requested",
  "ready>backlog:requirements_changed",
  "in_progress>backlog:requirements_changed",
  "in_review>backlog:requirements_changed",
]);

export function transitionWorkStatus(
  current: WorkStatus,
  request: WorkTransitionRequest,
): Result<WorkStatus, DomainError<"conflict">> {
  if (current === request.target) return ok(current);
  if (current === "completed" || current === "canceled") return err(domainError("conflict"));

  if (request.target === "completed") {
    return request.cause === "github_merge_observed"
      ? ok("completed")
      : err(domainError("conflict"));
  }
  if (request.target === "canceled") {
    return request.cause === "user_canceled" ? ok("canceled") : err(domainError("conflict"));
  }

  const transition = `${current}>${request.target}:${request.cause}`;
  return standardWorkTransitions.has(transition)
    ? ok(request.target)
    : err(domainError("conflict"));
}

const agentTransitions: Readonly<Record<AgentStatus, ReadonlySet<AgentStatus>>> = {
  queued: new Set(["executing", "waiting", "paused", "blocked"]),
  executing: new Set(["queued", "waiting", "paused", "blocked"]),
  waiting: new Set(["queued", "paused", "blocked"]),
  paused: new Set(["queued"]),
  blocked: new Set(["queued"]),
};

export function canTransitionAgentStatus(current: AgentStatus, target: AgentStatus): boolean {
  return current === target || agentTransitions[current].has(target);
}
