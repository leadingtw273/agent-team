import { describe, expect, it } from "vitest";

import { domainError } from "../../src/domain/foundation/index.js";
import {
  agentStatuses,
  blockingReasons,
  canTransitionAgentStatus,
  createAgentCondition,
  transitionWorkStatus,
  workStatuses,
  type WorkStatus,
  type WorkTransitionCause,
} from "../../src/domain/workflow/index.js";

describe("workflow state", () => {
  it("keeps the v1 status and blocking-reason vocabulary closed", () => {
    expect(workStatuses).toEqual([
      "backlog",
      "ready",
      "in_progress",
      "in_review",
      "completed",
      "canceled",
    ]);
    expect(agentStatuses).toEqual(["queued", "executing", "waiting", "paused", "blocked"]);
    expect(blockingReasons).toHaveLength(9);
  });

  it.each([
    ["backlog", "ready", "ready_gate_passed"],
    ["ready", "in_progress", "work_started"],
    ["in_progress", "in_review", "review_started"],
    ["in_review", "in_progress", "changes_requested"],
    ["in_progress", "backlog", "requirements_changed"],
  ] as const)("allows %s → %s for %s", (current, target, cause) => {
    expect(transitionWorkStatus(current, { target, cause })).toEqual({ ok: true, value: target });
  });

  it.each(["backlog", "ready", "in_progress", "in_review"] as const)(
    "only a GitHub merge moves %s to completed",
    (current) => {
      expect(
        transitionWorkStatus(current, {
          target: "completed",
          cause: "github_merge_observed",
        }),
      ).toEqual({ ok: true, value: "completed" });

      for (const cause of [
        "ready_gate_passed",
        "work_started",
        "review_started",
        "changes_requested",
        "requirements_changed",
        "user_canceled",
        "automation_reconcile",
      ] as const) {
        expect(transitionWorkStatus(current, { target: "completed", cause })).toEqual({
          ok: false,
          error: domainError("conflict"),
        });
      }
    },
  );

  it("only a user cancellation can enter canceled", () => {
    expect(
      transitionWorkStatus("in_progress", { target: "canceled", cause: "user_canceled" }),
    ).toEqual({ ok: true, value: "canceled" });
    expect(
      transitionWorkStatus("in_progress", {
        target: "canceled",
        cause: "automation_reconcile",
      }),
    ).toEqual({ ok: false, error: domainError("conflict") });
  });

  it.each(["completed", "canceled"] as const)("keeps terminal state %s terminal", (current) => {
    const targets = workStatuses.filter((target) => target !== current);
    for (const target of targets) {
      expect(
        transitionWorkStatus(current, {
          target,
          cause: "automation_reconcile",
        }),
      ).toEqual({ ok: false, error: domainError("conflict") });
    }
  });

  it("does not let a valid terminal cause switch one terminal state into another", () => {
    expect(
      transitionWorkStatus("canceled", {
        target: "completed",
        cause: "github_merge_observed",
      }),
    ).toEqual({ ok: false, error: domainError("conflict") });
    expect(
      transitionWorkStatus("completed", { target: "canceled", cause: "user_canceled" }),
    ).toEqual({ ok: false, error: domainError("conflict") });
  });

  it.each(workStatuses)("replays current state %s idempotently", (current) => {
    expect(
      transitionWorkStatus(current, { target: current, cause: "automation_reconcile" }),
    ).toEqual({ ok: true, value: current });
  });

  it("rejects illegal forward jumps and mismatched causes", () => {
    const cases: [WorkStatus, WorkStatus, WorkTransitionCause][] = [
      ["backlog", "in_progress", "work_started"],
      ["ready", "in_review", "review_started"],
      ["in_progress", "ready", "automation_reconcile"],
      ["in_review", "backlog", "changes_requested"],
    ];

    for (const [current, target, cause] of cases) {
      expect(transitionWorkStatus(current, { target, cause })).toEqual({
        ok: false,
        error: domainError("conflict"),
      });
    }
  });

  it("validates Agent status transitions separately from work status", () => {
    expect(canTransitionAgentStatus("queued", "executing")).toBe(true);
    expect(canTransitionAgentStatus("executing", "blocked")).toBe(true);
    expect(canTransitionAgentStatus("blocked", "queued")).toBe(true);
    expect(canTransitionAgentStatus("blocked", "executing")).toBe(false);
    expect(canTransitionAgentStatus("paused", "executing")).toBe(false);
  });

  it("allows reasons for waiting or blocked Agents and deduplicates them", () => {
    expect(
      createAgentCondition("blocked", ["merge_conflict", "merge_conflict", "quota_unknown"]),
    ).toEqual({
      status: "blocked",
      blockingReasons: ["merge_conflict", "quota_unknown"],
    });
    expect(createAgentCondition("waiting", ["waiting_dependency"])).toEqual({
      status: "waiting",
      blockingReasons: ["waiting_dependency"],
    });
    expect(() => createAgentCondition("blocked")).toThrow("blocked_agent_requires_reason");
    expect(() => createAgentCondition("executing", ["waiting_dependency"])).toThrow(
      "active_agent_cannot_have_blocking_reasons",
    );
  });
});
