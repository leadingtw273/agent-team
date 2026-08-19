import { describe, expect, it, vi } from "vitest";

import { createJobResumeHandler } from "../../src/cli/dispatch/job-resume-handlers.js";
import { parseIdentifier, type Identifier } from "../../src/domain/foundation/index.js";
import { headShaSchema } from "../../src/domain/review/index.js";

function id<Scope extends string>(scope: Scope, value: string): Identifier<Scope> {
  const parsed = parseIdentifier(scope, value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const jobId = id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const projectId = id("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const issueId = id("issue", "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const headSha = headShaSchema.parse("a".repeat(40));

function record() {
  return {
    jobId,
    projectId,
    issueId,
    externalIssueId: "linear-82",
    revision: 21,
    stage: { kind: "review_pending_retry" as const, retries: 1, lastErrorCode: "unavailable" },
    headSha,
  };
}

function payload(message: string | undefined): Record<string, unknown> {
  return JSON.parse(message ?? "null") as Record<string, unknown>;
}

describe("exact-job resume handler", () => {
  it("rejects an invalid Job id before constructing runtime", async () => {
    const runtimeFactory = vi.fn();
    const handler = createJobResumeHandler({ agentTeamHome: "/tmp/unused", runtimeFactory });

    await expect(handler({ jobId: "not-a-job" })).resolves.toMatchObject({ state: "rejected" });
    expect(runtimeFactory).not.toHaveBeenCalled();
  });

  it("dry-run reports the exact revision with zero resume call", async () => {
    const continueExistingJob = vi.fn();
    const runtimeFactory = vi.fn(() => Promise.resolve({ record: record(), continueExistingJob }));
    const handler = createJobResumeHandler({
      agentTeamHome: "/tmp/unused",
      generateHolderId: () => "job-resume:test",
      runtimeFactory,
    });

    const outcome = await handler({ jobId, dryRun: true });

    expect(runtimeFactory).toHaveBeenCalledWith(jobId, "job-resume:test");
    expect(continueExistingJob).not.toHaveBeenCalled();
    expect(outcome.state).toBe("success");
    expect(payload(outcome.message)).toMatchObject({
      operation: "job-resume",
      state: "ready",
      dryRun: true,
      jobId,
      stage: "review_pending_retry",
      expectedRevision: 21,
      headSha,
      plannedMutation: "existing-job-resume",
    });
  });

  it("live mode invokes only the admitted exact resume bridge", async () => {
    const continueExistingJob = vi.fn(() =>
      Promise.resolve({
        state: "resumed" as const,
        outcomes: [{ jobId, outcome: "completed" as const }],
      }),
    );
    const handler = createJobResumeHandler({
      agentTeamHome: "/tmp/unused",
      runtimeFactory: () => Promise.resolve({ record: record(), continueExistingJob }),
    });

    const outcome = await handler({ jobId });

    expect(continueExistingJob).toHaveBeenCalledOnce();
    expect(outcome.state).toBe("success");
    expect(payload(outcome.message)).toMatchObject({
      operation: "job-resume",
      state: "continued",
      jobId,
      expectedRevision: 21,
      resume: { state: "resumed", outcomes: [{ jobId, outcome: "completed" }] },
    });
  });

  it("keeps a bounded provider retry blocked and omits raw adapter errors", async () => {
    const continueExistingJob = vi.fn(() =>
      Promise.resolve({
        state: "resumed" as const,
        outcomes: [
          {
            jobId,
            outcome: "pending_retry" as const,
            stage: "provider_start",
            retries: 2,
            error: new Error("private provider detail"),
          },
        ],
      } as never),
    );
    const handler = createJobResumeHandler({
      agentTeamHome: "/tmp/unused",
      runtimeFactory: () => Promise.resolve({ record: record(), continueExistingJob }),
    });

    const outcome = await handler({ jobId });
    const result = payload(outcome.message);

    expect(outcome.state).toBe("blocked");
    expect(JSON.stringify(result)).not.toContain("private provider detail");
    expect(result).toMatchObject({
      resume: {
        state: "resumed",
        outcomes: [{ jobId, outcome: "pending_retry", stage: "provider_start", retries: 2 }],
      },
    });
  });
});
