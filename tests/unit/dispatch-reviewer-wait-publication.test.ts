import { describe, expect, it, vi } from "vitest";

import { ReviewerWaitPublicationCoordinator } from "../../src/cli/dispatch/reviewer-wait-publication.js";
import { ok } from "../../src/domain/foundation/index.js";
import { projectSchema } from "../../src/domain/project/index.js";
import type { AgentCondition } from "../../src/domain/workflow/index.js";

const project = projectSchema.parse({
  schemaVersion: 1,
  id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  displayName: "Sandbox",
  localRepositoryPath: "/tmp/sandbox",
  defaultBranch: "main",
  workManagement: { provider: "linear", containerId: "team-1", projectId: "project-1" },
  sourceControl: { provider: "github", repository: "owner/sandbox" },
});
const headSha = "a".repeat(40);
const issue = {
  schemaVersion: 1,
  id: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  projectId: project.id,
  externalId: "ENG-123",
  title: "Review quota wait",
} as const;

function harness(initialStatus: "pending" | "success" = "success") {
  let reviewStatus = initialStatus;
  const comments: string[] = [];
  const setWorkStatus = vi.fn((...arguments_: [unknown, string, { idempotencyKey: string }]) => {
    void arguments_;
    return Promise.resolve(
      ok({
        issue,
        workStatus: "in_review" as const,
        updatedAt: "2026-08-14T12:00:00.000Z",
        revision: "1",
      }),
    );
  });
  const setAgentCondition = vi.fn((_reference: unknown, condition: AgentCondition) =>
    Promise.resolve(
      ok({
        issue,
        workStatus: "in_review" as const,
        agentCondition: condition,
        updatedAt: "2026-08-14T12:00:00.000Z",
        revision: "2",
      }),
    ),
  );
  const appendComment = vi.fn((_reference: unknown, body: string) => {
    comments.push(body);
    return Promise.resolve(ok({ id: "comment-1", body, createdAt: "2026-08-14T12:00:00.000Z" }));
  });
  const setCommitStatus = vi.fn(() => {
    reviewStatus = "pending";
    return Promise.resolve(ok(undefined));
  });
  const coordinator = new ReviewerWaitPublicationCoordinator(
    { setWorkStatus, setAgentCondition, appendComment } as never,
    {
      getChangeRequest: () =>
        Promise.resolve(
          ok({
            id: "PR_1",
            number: 1,
            url: "https://example.invalid/pr/1",
            state: "open" as const,
            draft: false,
            baseBranch: "main",
            headBranch: "agent-team/ENG-123",
            headSha,
            mergeability: "unknown" as const,
            autoMergeEnabled: false,
            updatedAt: "2026-08-14T12:00:00.000Z",
          }),
        ),
      getCommitStatuses: () =>
        Promise.resolve(
          ok({
            headSha,
            statuses: [{ context: "agent-team/review", state: reviewStatus }],
          }),
        ),
      setCommitStatus,
    } as never,
  );
  return {
    coordinator,
    comments,
    setWorkStatus,
    setAgentCondition,
    appendComment,
    setCommitStatus,
  };
}

function request(
  overrides: Partial<Parameters<ReviewerWaitPublicationCoordinator["publish"]>[0]> = {},
) {
  return {
    project,
    externalIssueId: "ENG-123",
    changeRequestId: "1",
    headSha,
    confidence: "confirmed" as const,
    bucket: "five_hour" as const,
    resetAt: "2026-08-14T13:00:00.000Z" as never,
    idempotencyKeyPrefix: "reviewer-wait:job-1:head",
    ...overrides,
  };
}

describe("ReviewerWaitPublicationCoordinator", () => {
  it("publishes the Linear waiting state/comment and restores exact-head review status to pending", async () => {
    const fixture = harness("success");
    await expect(fixture.coordinator.publish(request())).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(fixture.setWorkStatus).toHaveBeenCalledWith(
      expect.anything(),
      "in_review",
      expect.anything(),
    );
    expect(fixture.setWorkStatus.mock.calls[0]?.[2].idempotencyKey).toContain("linear-work-status");
    expect(fixture.setAgentCondition).toHaveBeenCalledWith(
      expect.anything(),
      { status: "waiting", blockingReasons: ["five_hour_limit"] },
      expect.anything(),
    );
    expect(fixture.comments[0]).toContain("已確認的額度牆（五小時窗口）");
    expect(fixture.comments[0]).toContain("agent-team/review 維持 pending");
    expect(fixture.setCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({ headSha, context: "agent-team/review", state: "pending" }),
      expect.anything(),
    );
  });

  it("uses the fixed unconfirmed wording and quota_unknown agent reason for a bare 429", async () => {
    const fixture = harness("pending");
    await fixture.coordinator.publish({
      project,
      externalIssueId: "ENG-123",
      changeRequestId: "1",
      headSha,
      confidence: "unconfirmed",
      idempotencyKeyPrefix: "reviewer-wait:job-1:head",
    });
    expect(fixture.setAgentCondition).toHaveBeenCalledWith(
      expect.anything(),
      { status: "waiting", blockingReasons: ["quota_unknown"] },
      expect.anything(),
    );
    expect(fixture.comments[0]).toContain("未確認限流");
    expect(fixture.comments[0]).toContain("受控 reviewer resume 命令");
    expect(fixture.setCommitStatus).not.toHaveBeenCalled();
  });

  it("observe mode leaves Linear unchanged while preserving GitHub pending publication", async () => {
    const fixture = harness("success");
    await fixture.coordinator.publish(request({ lifecycleMode: "observe" }));
    expect(fixture.setWorkStatus).not.toHaveBeenCalled();
    expect(fixture.setAgentCondition).not.toHaveBeenCalled();
    expect(fixture.appendComment).not.toHaveBeenCalled();
    expect(fixture.setCommitStatus).toHaveBeenCalledOnce();
  });

  it("enforce mode leaves the main status to lifecycle ownership and publishes only wait details", async () => {
    const fixture = harness("success");
    await fixture.coordinator.publish(request({ lifecycleMode: "enforce" }));
    expect(fixture.setWorkStatus).not.toHaveBeenCalled();
    expect(fixture.setAgentCondition).toHaveBeenCalledOnce();
    expect(fixture.appendComment).toHaveBeenCalledOnce();
    expect(fixture.setCommitStatus).toHaveBeenCalledOnce();
  });
});
