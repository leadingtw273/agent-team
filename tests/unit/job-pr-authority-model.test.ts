import { describe, expect, it } from "vitest";

import {
  appendPullRequestBackPointer,
  createJobPrLifecycleEvent,
  createPullRequestBackPointer,
  formatJobPrLifecycleComment,
  parseJobPrLifecycleComment,
  parsePullRequestBackPointer,
  projectPullRequestAuthority,
} from "../../src/application/pipelines/job-pr-authority-model.js";
import { JobPrLifecyclePublisher } from "../../src/application/pipelines/job-pr-authority.js";
import {
  parseIdentifier,
  parseInstant,
  type Identifier,
} from "../../src/domain/foundation/index.js";

function id<Scope extends string>(scope: Scope, value: string): Identifier<Scope> {
  const parsed = parseIdentifier(scope, value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const projectId = id("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const issueId = id("issue", "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const jobId = id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const nextJobId = id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ac");
const branch = `agent-team/${projectId}/${issueId}/${jobId}`;
const headSha = "a".repeat(40);

describe("job/PR public authority contracts", () => {
  it("creates stable canonical event ids and rejects a substituted id", () => {
    const first = createJobPrLifecycleEvent({
      schemaVersion: 1,
      kind: "pr_handoff",
      projectId,
      issueId,
      prNumber: 42,
      oldJobId: jobId,
      newJobId: nextJobId,
      priorOwnershipEpoch: 1,
      ownershipEpoch: 2,
      handoffHeadSha: headSha,
    });
    const repeated = createJobPrLifecycleEvent({
      schemaVersion: 1,
      kind: "pr_handoff",
      projectId,
      issueId,
      prNumber: 42,
      oldJobId: jobId,
      newJobId: nextJobId,
      priorOwnershipEpoch: 1,
      ownershipEpoch: 2,
      handoffHeadSha: headSha,
    });
    expect(first).toEqual(repeated);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const comment = formatJobPrLifecycleComment("LEA-136 已交接至新的 Job。", first.value);
    expect(comment.ok).toBe(true);
    if (!comment.ok) return;
    expect(parseJobPrLifecycleComment(comment.value)).toEqual(first.value);

    const substituted = comment.value.replace(first.value.eventId, `lifecycle_${"0".repeat(64)}`);
    expect(parseJobPrLifecycleComment(substituted)).toBeUndefined();
  });

  it("ignores human comments, unknown kinds, malformed JSON, and multiple markers", () => {
    expect(parseJobPrLifecycleComment("一般人工留言，不是自動化授權。 ")).toBeUndefined();
    expect(
      parseJobPrLifecycleComment(
        '摘要\n\n<!-- agent-team-lifecycle:v1\n{"schemaVersion":1,"kind":"future_kind"}\n-->',
      ),
    ).toBeUndefined();
    expect(
      parseJobPrLifecycleComment("摘要\n\n<!-- agent-team-lifecycle:v1\n{invalid}\n-->"),
    ).toBeUndefined();
    const duplicate =
      "<!-- agent-team-lifecycle:v1\n{}\n-->\n<!-- agent-team-lifecycle:v1\n{}\n-->";
    expect(parseJobPrLifecycleComment(duplicate)).toBeUndefined();
  });

  it("keeps the PR back-pointer immutable across handoff and round-trips canonical JSON", () => {
    const pointer = createPullRequestBackPointer({
      schemaVersion: 1,
      projectId,
      issueId,
      jobId,
      branch,
    });
    expect(pointer.ok).toBe(true);
    if (!pointer.ok) return;
    const body = appendPullRequestBackPointer("人類可讀的需求摘要。", pointer.value);
    expect(body.ok).toBe(true);
    if (!body.ok) return;

    expect(parsePullRequestBackPointer(body.value)).toEqual({ ok: true, value: pointer.value });
    expect(body.value).not.toContain("ownershipEpoch");
    expect(body.value).not.toContain(nextJobId);
  });

  it("fails closed when a marked PR body is malformed or contains unknown fields", () => {
    const malformed = "<!-- agent-team-pr:v1\n{invalid}\n-->";
    expect(parsePullRequestBackPointer(malformed)).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    const unknown = `<!-- agent-team-pr:v1\n${JSON.stringify({
      schemaVersion: 1,
      projectId,
      issueId,
      jobId,
      branch,
      ownershipEpoch: 1,
    })}\n-->`;
    expect(parsePullRequestBackPointer(unknown)).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
  });

  it("projects one owner per epoch and treats a terminal owner without handoff as unsettled", () => {
    const bound = createJobPrLifecycleEvent({
      schemaVersion: 1,
      kind: "pr_bound",
      projectId,
      issueId,
      jobId,
      prNumber: 42,
      branch,
      initialHeadSha: headSha,
      ownershipEpoch: 1,
    });
    const superseded = createJobPrLifecycleEvent({
      schemaVersion: 1,
      kind: "job_superseded",
      projectId,
      issueId,
      oldJobId: jobId,
      newJobId: nextJobId,
    });
    const handoff = createJobPrLifecycleEvent({
      schemaVersion: 1,
      kind: "pr_handoff",
      projectId,
      issueId,
      prNumber: 42,
      oldJobId: jobId,
      newJobId: nextJobId,
      priorOwnershipEpoch: 1,
      ownershipEpoch: 2,
      handoffHeadSha: headSha,
    });
    const wrongEpochHandoff = createJobPrLifecycleEvent({
      schemaVersion: 1,
      kind: "pr_handoff",
      projectId,
      issueId,
      prNumber: 42,
      oldJobId: jobId,
      newJobId: nextJobId,
      priorOwnershipEpoch: 9,
      ownershipEpoch: 10,
      handoffHeadSha: headSha,
    });
    if (!bound.ok || !superseded.ok || !handoff.ok || !wrongEpochHandoff.ok) {
      throw new Error("invalid fixture");
    }

    expect(projectPullRequestAuthority([bound.value, superseded.value], 42)).toMatchObject({
      state: "unsettled",
      ownerJobId: jobId,
    });
    expect(
      projectPullRequestAuthority([bound.value, handoff.value, superseded.value], 42),
    ).toEqual({ state: "owned", prNumber: 42, ownerJobId: nextJobId, ownershipEpoch: 2 });
    expect(
      projectPullRequestAuthority([bound.value, wrongEpochHandoff.value], 42),
    ).toEqual({ state: "conflict", prNumber: 42 });
  });

  it("publishes once and recovers a sent-unknown append by provider read-back", async () => {
    const event = createJobPrLifecycleEvent({
      schemaVersion: 1,
      kind: "job_started",
      projectId,
      issueId,
      jobId,
    });
    if (!event.ok) throw new Error("invalid fixture");
    const createdAt = parseInstant("2026-08-26T12:00:00.000Z");
    if (!createdAt.ok) throw new Error("invalid instant fixture");
    const comments: { id: string; body: string; createdAt: typeof createdAt.value }[] = [];
    let reads = 0;
    let appends = 0;
    const publisher = new JobPrLifecyclePublisher({
      listComments: () => {
        reads += 1;
        return Promise.resolve({ ok: true as const, value: comments });
      },
      appendComment: (_issue, body) => {
        appends += 1;
        comments.push({ id: "comment-1", body, createdAt: createdAt.value });
        return Promise.resolve({
          ok: false as const,
          error: {
            kind: "domain_error" as const,
            code: "timeout" as const,
            category: "external" as const,
            message: "The operation timed out." as const,
            retryable: true as const,
          },
        });
      },
    });
    const issue = {
      project: {
        schemaVersion: 1 as const,
        id: projectId,
        displayName: "Fixture",
        localRepositoryPath: "/tmp/fixture",
        defaultBranch: "main",
        workManagement: { provider: "linear" as const, containerId: "team", projectId: "project" },
        sourceControl: { provider: "github" as const, repository: "owner/repo" },
      },
      externalIssueId: "linear-id",
    };

    await expect(
      publisher.publish({ issue, humanSummary: "工作已開始。", event: event.value }),
    ).resolves.toMatchObject({ ok: true, value: { state: "published" } });
    await expect(
      publisher.publish({ issue, humanSummary: "工作已開始。", event: event.value }),
    ).resolves.toMatchObject({ ok: true, value: { state: "reused" } });
    expect(appends).toBe(1);
    expect(reads).toBe(3);
  });
});
