/**
 * C015c item 5 unit test: `NoOpAutoMergePauseAdapter`
 * (src/cli/dispatch/lifecycle-policy-adapter.ts) -- the disclosed, deliberately no-op
 * `LifecyclePolicyPort.pauseAutoMerge` implementation (see that file's header for why: no adapter
 * anywhere exposes a real "disable auto-merge" host capability).
 *
 * C015c acceptance review (round 1, observation 1): this pins down the *honest* runtime signal --
 * `{durability:"unknown"}`, not `{durability:"confirmed"}`. `LifecyclePipeline` itself treats
 * anything other than `"confirmed"` as a policy failure (`lifecycle.ts`'s own fail-closed branch),
 * so this test also proves that consequence end to end against the real `LifecyclePipeline`,
 * not just the adapter's own return value in isolation.
 */
import { describe, expect, it } from "vitest";

import { NoOpAutoMergePauseAdapter } from "../../src/cli/dispatch/lifecycle-policy-adapter.js";
import { LifecyclePipeline } from "../../src/application/pipelines/index.js";
import { ok } from "../../src/domain/foundation/index.js";
import { projectSchema, type Project } from "../../src/domain/project/index.js";

function project(): Project {
  return projectSchema.parse({
    schemaVersion: 1,
    id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    displayName: "Sandbox",
    localRepositoryPath: "/tmp/sandbox",
    defaultBranch: "main",
    workManagement: { provider: "linear", containerId: "team-1", projectId: "proj-1" },
    sourceControl: { provider: "github", repository: "owner/sandbox" },
  });
}

describe("NoOpAutoMergePauseAdapter", () => {
  it('reports durability "unknown" (never "confirmed") -- an honest non-success, regardless of request contents', async () => {
    const adapter = new NoOpAutoMergePauseAdapter();

    const result = await adapter.pauseAutoMerge(
      {
        project: project(),
        reason: "out_of_process_merge",
        changeRequestId: "42",
        mergedHeadSha: "a".repeat(40),
      },
      { idempotencyKey: "pause-1" },
    );
    expect(result).toEqual({ ok: true, value: { durability: "unknown" } });
  });

  it('makes a real LifecyclePipeline out-of-process-merge outcome fail closed (policy/external_failure), never a false "completed"', async () => {
    const headSha = "a".repeat(40);
    const pipeline = new LifecyclePipeline({
      sourceControl: {
        getChangeRequest: () =>
          Promise.resolve(
            ok({
              id: "PR_fixture",
              number: 1,
              url: "https://example.test/pull/1",
              state: "merged" as const,
              draft: false,
              baseBranch: "main",
              headBranch: "agent-team/job-1",
              headSha,
              mergeability: "mergeable" as const,
              autoMergeEnabled: false,
              updatedAt: "2026-08-07T00:00:00.000Z" as never,
            }),
          ),
        closeChangeRequest: () => Promise.reject(new Error("must never be called")),
      },
      workManagement: {
        getIssue: () =>
          Promise.resolve(
            ok({
              issue: {
                schemaVersion: 1,
                id: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab" as never,
                projectId: project().id,
                externalId: "linear-issue-1",
                title: "Ship it",
              },
              workStatus: "in_review" as const,
              updatedAt: "2026-08-07T00:00:00.000Z" as never,
              revision: "1",
            }),
          ),
        setWorkStatus: () => Promise.reject(new Error("must never be called")),
        setAgentCondition: () => Promise.reject(new Error("must never be called")),
        appendComment: () => Promise.reject(new Error("must never be called: policy failed first")),
      },
      policy: new NoOpAutoMergePauseAdapter(),
      cancellation: {
        prepare: () => Promise.reject(new Error("must never be called")),
      },
    });

    // No `mergeAuthorizationHeadSha` -> `authorized` is false -> the out-of-process-merge branch,
    // which is the only branch that ever calls `pauseAutoMerge`.
    const outcome = await pipeline.run({
      project: project(),
      externalIssueId: "linear-issue-1",
      changeRequestId: "1",
      idempotencyKeyPrefix: "test-1",
    });

    expect(outcome.state).toBe("failed");
    if (outcome.state === "failed") {
      expect(outcome.stage).toBe("policy");
      expect(outcome.error.code).toBe("external_failure");
    }
  });
});
