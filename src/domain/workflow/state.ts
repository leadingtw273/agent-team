export const workStatuses = [
  "backlog",
  "ready",
  "in_progress",
  "in_review",
  "completed",
  "canceled",
] as const;

export type WorkStatus = (typeof workStatuses)[number];

export const agentStatuses = ["queued", "executing", "waiting", "paused", "blocked"] as const;
export type AgentStatus = (typeof agentStatuses)[number];

export const blockingReasons = [
  "waiting_dependency",
  "weekly_quota_exhausted",
  "five_hour_limit",
  "quota_unknown",
  "dangerous_operation_approval",
  "integration_failure",
  "merge_conflict",
  "change_request_closed",
  "unknown_error",
] as const;

export type BlockingReason = (typeof blockingReasons)[number];

export interface AgentCondition {
  readonly status: AgentStatus;
  readonly blockingReasons: readonly BlockingReason[];
}

export function createAgentCondition(
  status: AgentStatus,
  reasons: readonly BlockingReason[] = [],
): AgentCondition {
  const uniqueReasons = [...new Set(reasons)];
  if (status === "blocked" && uniqueReasons.length === 0) {
    throw new Error("blocked_agent_requires_reason");
  }
  if (status !== "blocked" && status !== "waiting" && uniqueReasons.length > 0) {
    throw new Error("active_agent_cannot_have_blocking_reasons");
  }
  return Object.freeze({ status, blockingReasons: Object.freeze(uniqueReasons) });
}
