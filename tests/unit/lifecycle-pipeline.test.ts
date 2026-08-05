import { describe, expect, it, vi } from "vitest";

import {
  LifecyclePipeline,
  type LifecyclePipelinePorts,
  type LifecyclePipelineRequest,
} from "../../src/application/pipelines/index.js";
import type {
  ChangeRequestSnapshot,
  WorkManagementIssueRef,
  WorkManagementIssueSnapshot,
} from "../../src/application/ports/index.js";
import { domainError, err, ok, parseInstant } from "../../src/domain/foundation/index.js";
import { issueSchema, projectSchema } from "../../src/domain/project/index.js";
import type { AgentCondition, WorkStatus } from "../../src/domain/workflow/index.js";

const headSha = "a".repeat(40);
const otherSha = "b".repeat(40);
const nowResult = parseInstant("2026-08-05T02:00:00.000Z");
if (!nowResult.ok) throw new Error(nowResult.error.code);
const now = nowResult.value;
const project = projectSchema.parse({
  schemaVersion: 1,
  id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  displayName: "Lifecycle fixture",
  localRepositoryPath: "/tmp/repository",
  defaultBranch: "main",
  workManagement: { provider: "linear", containerId: "workspace", projectId: "team" },
  sourceControl: { provider: "github", repository: "owner/repository" },
});
const issue = issueSchema.parse({
  schemaVersion: 1,
  id: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  projectId: project.id,
  externalId: "ENG-123",
  title: "Handle lifecycle events",
  goal: "Keep GitHub and Linear lifecycle state consistent.",
  acceptanceCriteria: ["Only a merged PR completes work."],
  inScope: ["src/application/pipelines"],
  outOfScope: ["Conflict resolution"],
  dependencies: { kind: "none" },
  priority: "high",
  agentRole: "team_lead",
  reviewRequirement: "code_review",
  estimatedMinutes: 30,
  changeRegions: [{ path: "src/application/pipelines", coverage: "subtree" }],
});

function changeRequest(
  state: ChangeRequestSnapshot["state"] = "open",
  overrides: Partial<ChangeRequestSnapshot> = {},
): ChangeRequestSnapshot {
  return {
    id: "PR_node_fixture",
    number: 42,
    url: "https://github.com/owner/repository/pull/42",
    state,
    draft: false,
    baseBranch: "main",
    headBranch: "task/ENG-123",
    headSha,
    mergeability: state === "open" ? "mergeable" : "unknown",
    autoMergeEnabled: false,
    updatedAt: now,
    ...overrides,
  };
}

function issueSnapshot(
  workStatus: WorkStatus = "in_review",
  agentCondition: AgentCondition = { status: "waiting", blockingReasons: [] },
): WorkManagementIssueSnapshot {
  return { issue, workStatus, agentCondition, updatedAt: now, revision: "revision-1" };
}

interface FixtureOptions {
  readonly changeRequest?: ChangeRequestSnapshot;
  readonly issue?: WorkManagementIssueSnapshot;
  readonly policyDurability?: "confirmed" | "unknown";
  readonly policyFailure?: boolean;
  readonly checkpoint?: "not_required" | "preserved";
  readonly activeWorkStopped?: boolean;
  readonly calls?: string[];
}

function ports(options: FixtureOptions = {}): LifecyclePipelinePorts {
  const calls = options.calls ?? [];
  const currentChangeRequest = options.changeRequest ?? changeRequest();
  const currentIssue = options.issue ?? issueSnapshot();
  return {
    sourceControl: {
      getChangeRequest: vi.fn(() => Promise.resolve(ok(currentChangeRequest))),
      closeChangeRequest: vi.fn(() => {
        calls.push("close_change_request");
        return Promise.resolve(ok({ ...currentChangeRequest, state: "closed" as const }));
      }),
    },
    workManagement: {
      getIssue: vi.fn(() => Promise.resolve(ok(currentIssue))),
      setWorkStatus: vi.fn((_reference: WorkManagementIssueRef, status: WorkStatus) => {
        calls.push(`work_status:${status}`);
        return Promise.resolve(ok({ ...currentIssue, workStatus: status }));
      }),
      setAgentCondition: vi.fn((_reference: WorkManagementIssueRef, condition: AgentCondition) => {
        calls.push(`agent_condition:${condition.status}`);
        return Promise.resolve(ok({ ...currentIssue, agentCondition: condition }));
      }),
      appendComment: vi.fn((_reference: WorkManagementIssueRef, body: string) => {
        calls.push(`comment:${body}`);
        return Promise.resolve(ok({ id: "comment-1", body, createdAt: now }));
      }),
    },
    policy: {
      pauseAutoMerge: vi.fn(() => {
        calls.push("pause_auto_merge");
        return options.policyFailure === true
          ? Promise.resolve(err(domainError("external_failure")))
          : Promise.resolve(ok({ durability: options.policyDurability ?? "confirmed" }));
      }),
    },
    cancellation: {
      prepare: vi.fn((prepareRequest: { readonly preserveBranchAndWorktree: true }) => {
        calls.push(`prepare_cancellation:${String(prepareRequest.preserveBranchAndWorktree)}`);
        const checkpoint = options.checkpoint ?? "preserved";
        return Promise.resolve(
          ok({
            activeWorkStopped: options.activeWorkStopped ?? true,
            checkpoint,
            ...(checkpoint === "preserved" ? { checkpointId: "checkpoint-1" } : {}),
          }),
        );
      }),
    },
  };
}

function request(overrides: Partial<LifecyclePipelineRequest> = {}): LifecyclePipelineRequest {
  return {
    project,
    externalIssueId: issue.externalId,
    changeRequestId: "42",
    idempotencyKeyPrefix: "job:ENG-123:lifecycle",
    ...overrides,
  };
}

function comments(calls: readonly string[]): readonly string[] {
  return calls.filter((call) => call.startsWith("comment:"));
}

describe("merged lifecycle", () => {
  it("marks Linear completed only for an authorized exact-Head GitHub merge", async () => {
    const calls: string[] = [];
    const fixture = ports({ changeRequest: changeRequest("merged"), calls });
    const outcome = await new LifecyclePipeline(fixture).run(
      request({ mergeAuthorizationHeadSha: headSha.toUpperCase() }),
    );

    expect(outcome).toEqual({
      state: "completed",
      merge: "authorized",
      headSha,
      autoMergePaused: false,
    });
    expect(calls[0]).toBe("work_status:completed");
    expect(comments(calls)[0]).toContain("精確 Head 合併授權相符");
    expect(calls).not.toContain("pause_auto_merge");
    expect(calls).not.toContain("close_change_request");
  });

  it("treats a matching missed webhook as idempotent when Linear is already completed", async () => {
    const calls: string[] = [];
    const fixture = ports({
      changeRequest: changeRequest("merged"),
      issue: issueSnapshot("completed"),
      calls,
    });
    const outcome = await new LifecyclePipeline(fixture).run(
      request({ mergeAuthorizationHeadSha: headSha }),
    );

    expect(outcome).toMatchObject({ state: "completed", merge: "authorized" });
    expect(fixture.workManagement.setWorkStatus).not.toHaveBeenCalled();
    expect(comments(calls)).toHaveLength(1);
  });

  it("completes but audits an out-of-process merge after durably pausing new auto-merge", async () => {
    const calls: string[] = [];
    const fixture = ports({ changeRequest: changeRequest("merged"), calls });
    const outcome = await new LifecyclePipeline(fixture).run(
      request({ mergeAuthorizationHeadSha: otherSha }),
    );

    expect(outcome).toEqual({
      state: "completed",
      merge: "out_of_process",
      headSha,
      autoMergePaused: true,
    });
    expect(calls[0]).toBe("pause_auto_merge");
    expect(calls[1]).toBe("work_status:completed");
    expect(comments(calls)[0]).toContain("流程外合併");
    expect(comments(calls)[0]).toContain("不自動 Revert");
  });

  it("fails closed before Done when the project auto-merge pause is not durable", async () => {
    const calls: string[] = [];
    const fixture = ports({
      changeRequest: changeRequest("merged"),
      policyDurability: "unknown",
      calls,
    });
    const outcome = await new LifecyclePipeline(fixture).run(request());

    expect(outcome).toMatchObject({ state: "failed", stage: "policy" });
    expect(calls).toEqual(["pause_auto_merge"]);
    expect(fixture.workManagement.setWorkStatus).not.toHaveBeenCalled();
  });
});

describe("closed and canceled lifecycle", () => {
  it("blocks a closed PR without canceling or changing the primary work status", async () => {
    const calls: string[] = [];
    const fixture = ports({ changeRequest: changeRequest("closed"), calls });
    const outcome = await new LifecyclePipeline(fixture).run(request());

    expect(outcome).toEqual({ state: "blocked", reason: "change_request_closed" });
    expect(calls[0]).toBe("agent_condition:blocked");
    expect(comments(calls)[0]).toContain("工單未取消");
    expect(fixture.workManagement.setWorkStatus).not.toHaveBeenCalled();
    expect(JSON.stringify(calls)).not.toContain("work_status:canceled");
  });

  it("stops and checkpoints before closing an open PR after explicit user cancellation", async () => {
    const calls: string[] = [];
    const fixture = ports({ issue: issueSnapshot("canceled"), calls });
    const outcome = await new LifecyclePipeline(fixture).run(request());

    expect(outcome).toEqual({
      state: "canceled",
      changeRequest: "closed",
      checkpoint: "preserved",
      checkpointId: "checkpoint-1",
    });
    expect(calls[0]).toBe("prepare_cancellation:true");
    expect(calls[1]).toBe("close_change_request");
    expect(comments(calls)[0]).toContain("Branch 與 Worktree 均未刪除");
  });

  it("still stops active work but does not close the PR twice when it is already closed", async () => {
    const calls: string[] = [];
    const fixture = ports({
      changeRequest: changeRequest("closed"),
      issue: issueSnapshot("canceled"),
      calls,
    });
    const outcome = await new LifecyclePipeline(fixture).run(request());

    expect(outcome).toEqual({
      state: "canceled",
      changeRequest: "already_closed",
      checkpoint: "preserved",
      checkpointId: "checkpoint-1",
    });
    expect(calls[0]).toBe("prepare_cancellation:true");
    expect(calls).not.toContain("close_change_request");
    expect(comments(calls)).toHaveLength(1);
  });

  it("does not close a PR when active work could not be stopped and checkpointed", async () => {
    const calls: string[] = [];
    const fixture = ports({
      issue: issueSnapshot("canceled"),
      activeWorkStopped: false,
      calls,
    });
    const outcome = await new LifecyclePipeline(fixture).run(request());

    expect(outcome).toMatchObject({ state: "failed", stage: "checkpoint" });
    expect(calls).toEqual(["prepare_cancellation:true"]);
  });

  it("does not mutate an already-completed issue when a stale closed PR is observed", async () => {
    const calls: string[] = [];
    const fixture = ports({
      changeRequest: changeRequest("closed"),
      issue: issueSnapshot("completed"),
      calls,
    });
    const outcome = await new LifecyclePipeline(fixture).run(request());

    expect(outcome).toEqual({ state: "unchanged", reason: "terminal_issue" });
    expect(calls).toEqual([]);
  });

  it("leaves an ordinary open PR unchanged", async () => {
    const fixture = ports();
    expect(await new LifecyclePipeline(fixture).run(request())).toEqual({
      state: "unchanged",
      reason: "open",
    });
    expect(fixture.workManagement.setWorkStatus).not.toHaveBeenCalled();
    expect(fixture.workManagement.setAgentCondition).not.toHaveBeenCalled();
    expect(fixture.sourceControl.closeChangeRequest).not.toHaveBeenCalled();
  });
});

describe("lifecycle authority boundaries", () => {
  it("rejects a mismatched Linear issue before any mutation", async () => {
    const calls: string[] = [];
    const mismatchedIssue = {
      ...issue,
      externalId: "ENG-999",
    };
    const fixture = ports({
      issue: { ...issueSnapshot(), issue: mismatchedIssue },
      changeRequest: changeRequest("merged"),
      calls,
    });
    const outcome = await new LifecyclePipeline(fixture).run(request());

    expect(outcome).toMatchObject({ state: "failed", stage: "request" });
    expect(calls).toEqual([]);
  });

  it("does not let an already-canceled terminal issue silently become completed", async () => {
    const calls: string[] = [];
    const fixture = ports({
      issue: issueSnapshot("canceled"),
      changeRequest: changeRequest("merged"),
      calls,
    });
    const outcome = await new LifecyclePipeline(fixture).run(
      request({ mergeAuthorizationHeadSha: headSha }),
    );

    expect(outcome).toMatchObject({ state: "failed", stage: "work_status" });
    expect(calls[0]).toBe("pause_auto_merge");
    expect(calls.some((call) => call.startsWith("work_status:"))).toBe(false);
    expect(calls).not.toContain("close_change_request");
  });
});
