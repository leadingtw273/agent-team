import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileJobProgressStore,
  type JobProgressRecordMutation,
} from "../../src/adapters/dispatch/job-progress-store.js";
import {
  createReviewerResumeHandler,
  reviewerResumeConfirmationPhrase,
} from "../../src/cli/dispatch/reviewer-resume-handlers.js";
import { createFixedClock, parseInstant } from "../../src/domain/foundation/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const nowParsed = parseInstant("2026-08-14T12:00:00.000Z");
if (!nowParsed.ok) throw new Error(nowParsed.error.code);
const now = nowParsed.value;
const jobId = "job_018f47d2-77a4-7cc1-8ef2-0123456789ab";

async function store(): Promise<FileJobProgressStore> {
  const root = await mkdtemp(join(tmpdir(), "agent-team-reviewer-resume-"));
  roots.push(root);
  return new FileJobProgressStore(root, undefined, createFixedClock(now));
}

function record(
  overrides: Partial<JobProgressRecordMutation["stage"]> = {},
): JobProgressRecordMutation {
  return {
    jobId: jobId as never,
    projectId: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab" as never,
    issueId: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab" as never,
    externalIssueId: "ENG-123",
    model: "gpt-5.6-terra",
    providerAssignments: {
      execution: { provider: "codex", model: "gpt-5.6-terra" },
      codeReview: { provider: "claude", model: "claude-opus" },
    },
    stage: {
      kind: "reviewer_waiting",
      reason: "unconfirmed_throttling",
      confidence: "unconfirmed",
      binding: {
        requirementsDigest: "a".repeat(64),
        headSha: "b".repeat(40),
        diffDigest: "c".repeat(64),
      },
      publication: "confirmed",
      ...overrides,
    } as JobProgressRecordMutation["stage"],
    branch: "agent-team/ENG-123",
    worktreePath: "/tmp/worktree",
    changeRequestId: "42",
    headSha: "b".repeat(40) as never,
    baseRevision: "d".repeat(40) as never,
  };
}

function stdin(value: string): AsyncIterable<string> {
  return (async function* () {
    await Promise.resolve();
    yield `${value}\n`;
  })();
}

describe("dispatch reviewer-resume", () => {
  it("requires the exact confirmation phrase with zero mutation on mismatch", async () => {
    const progress = await store();
    const seeded = await progress.compareAndSwap(jobId, null, record());
    if (!seeded.ok) throw new Error(seeded.error.code);
    const handler = createReviewerResumeHandler({ progress, stdin: stdin("WRONG") });

    const result = await handler({ jobId });
    expect(result.state).toBe("rejected");
    await expect(progress.load(jobId)).resolves.toMatchObject({
      ok: true,
      value: { revision: seeded.value.revision, stage: { kind: "reviewer_waiting" } },
    });
  });

  it("does not let an operator bypass a known reset that has not arrived", async () => {
    const progress = await store();
    await progress.compareAndSwap(
      jobId,
      null,
      record({
        reason: "confirmed_quota_wall",
        confidence: "confirmed",
        resetAt: "2026-08-14T13:00:00.000Z" as never,
        retryNotBefore: "2026-08-14T13:00:00.000Z" as never,
      }),
    );
    const handler = createReviewerResumeHandler({
      progress,
      clock: createFixedClock(now),
      stdin: stdin(reviewerResumeConfirmationPhrase),
    });

    const result = await handler({ jobId });
    expect(result).toMatchObject({ state: "failed" });
    expect(JSON.parse(result.message ?? "{}")).toMatchObject({ reason: "reset_not_reached" });
    await expect(progress.load(jobId)).resolves.toMatchObject({
      ok: true,
      value: { stage: { kind: "reviewer_waiting" } },
    });
  });

  it("moves only the same job back to awaiting_review without releasing admission or rerunning implementation", async () => {
    const progress = await store();
    await progress.compareAndSwap(jobId, null, record());
    const handler = createReviewerResumeHandler({
      progress,
      stdin: stdin(reviewerResumeConfirmationPhrase),
    });

    const result = await handler({ jobId });
    expect(result.state).toBe("success");
    expect(JSON.parse(result.message ?? "{}")).toMatchObject({
      state: "resumed",
      nextStage: "awaiting_review",
      admissionReleased: false,
      implementerRerun: false,
    });
    await expect(progress.load(jobId)).resolves.toMatchObject({
      ok: true,
      value: {
        providerAssignments: {
          execution: { provider: "codex", model: "gpt-5.6-terra" },
          codeReview: { provider: "claude", model: "claude-opus" },
        },
        stage: { kind: "awaiting_review" },
      },
    });
  });

  it("narrowly recovers requires_manual(review_begin_failed) without accepting other manual causes", async () => {
    const progress = await store();
    await progress.compareAndSwap(jobId, null, {
      ...record(),
      stage: {
        kind: "requires_manual",
        cause: {
          stage: "review",
          reasonCode: "review_begin_failed",
          attempts: { count: 1 },
        },
      },
    });
    const handler = createReviewerResumeHandler({
      progress,
      stdin: stdin(reviewerResumeConfirmationPhrase),
    });

    const result = await handler({ jobId });
    expect(result.state).toBe("success");
    expect(JSON.parse(result.message ?? "{}")).toMatchObject({
      nextStage: "awaiting_review",
      recovery: "review_begin_failed",
      admissionReleased: false,
      implementerRerun: false,
    });
    await expect(progress.load(jobId)).resolves.toMatchObject({
      ok: true,
      value: { stage: { kind: "awaiting_review" } },
    });
  });

  it("does not recover a different requires_manual review cause", async () => {
    const progress = await store();
    await progress.compareAndSwap(jobId, null, {
      ...record(),
      stage: {
        kind: "requires_manual",
        cause: {
          stage: "review",
          reasonCode: "review_provider_failed",
          attempts: { count: 1 },
        },
      },
    });
    const handler = createReviewerResumeHandler({
      progress,
      stdin: stdin(reviewerResumeConfirmationPhrase),
    });

    const result = await handler({ jobId });
    expect(result.state).toBe("failed");
    expect(JSON.parse(result.message ?? "{}")).toMatchObject({
      reason: "job_not_waiting_for_reviewer",
      currentStage: "requires_manual",
    });
    await expect(progress.load(jobId)).resolves.toMatchObject({
      ok: true,
      value: {
        stage: {
          kind: "requires_manual",
          cause: { reasonCode: "review_provider_failed" },
        },
      },
    });
  });

  it("recovers review_provider_failed only with the explicit flag and confirmed pr_ready evidence", async () => {
    const progress = await store();
    const mutation = {
      ...record(),
      stage: {
        kind: "requires_manual",
        cause: {
          stage: "review",
          reasonCode: "review_provider_failed",
          attempts: { count: 1 },
        },
      },
      controlFence: {
        leaseId: "lease_018f47d2-77a4-7cc1-8ef2-0123456789ab" as never,
        holderId: "reviewer-resume-test",
        leaseEpoch: 1,
        ownershipEpoch: 1,
        state: "active",
      },
      mutationAttempts: [
        {
          operationKey: "managed:job:pr_ready:digest",
          intent: "pr_ready",
          identityDigest: "a".repeat(64),
          attempts: [
            {
              ordinal: 1,
              preparedAt: now,
              outcome: "prepared" as const,
            },
          ],
        },
      ],
    } satisfies JobProgressRecordMutation;
    const seeded = await progress.compareAndSwap(jobId, null, mutation);
    if (!seeded.ok) throw new Error(seeded.error.code);
    const confirmed = await progress.compareAndSwap(jobId, seeded.value.revision, {
      ...mutation,
      mutationAttempts: mutation.mutationAttempts.map((entry) => ({
        ...entry,
        attempts: entry.attempts.map((attempt) => ({ ...attempt, outcome: "confirmed" as const })),
      })),
    });
    if (!confirmed.ok) throw new Error(confirmed.error.code);
    const handler = createReviewerResumeHandler({
      progress,
      stdin: stdin(reviewerResumeConfirmationPhrase),
    });

    await expect(handler({ jobId })).resolves.toMatchObject({ state: "failed" });
    const result = await createReviewerResumeHandler({
      progress,
      stdin: stdin(reviewerResumeConfirmationPhrase),
    })({ jobId, recoverReadyIdempotency: true });
    expect(result.state).toBe("success");
    expect(JSON.parse(result.message ?? "{}")).toMatchObject({
      nextStage: "awaiting_review",
      recovery: "review_ready_idempotency",
    });
  });

  it("rejects ready-idempotency recovery when the confirmed pr_ready evidence is absent", async () => {
    const progress = await store();
    await progress.compareAndSwap(jobId, null, {
      ...record(),
      stage: {
        kind: "requires_manual",
        cause: {
          stage: "review",
          reasonCode: "review_provider_failed",
          attempts: { count: 1 },
        },
      },
    });
    const handler = createReviewerResumeHandler({
      progress,
      stdin: stdin(reviewerResumeConfirmationPhrase),
    });

    const result = await handler({ jobId, recoverReadyIdempotency: true });
    expect(result.state).toBe("failed");
    expect(JSON.parse(result.message ?? "{}")).toMatchObject({
      reason: "job_not_waiting_for_reviewer",
    });
  });

  it("recovers review_record_failed only before any review publication attempt", async () => {
    const progress = await store();
    await progress.compareAndSwap(jobId, null, {
      ...record(),
      stage: {
        kind: "requires_manual",
        cause: {
          stage: "review",
          reasonCode: "review_record_failed",
          attempts: { count: 1 },
        },
      },
    });

    await expect(
      createReviewerResumeHandler({
        progress,
        stdin: stdin(reviewerResumeConfirmationPhrase),
      })({ jobId }),
    ).resolves.toMatchObject({ state: "failed" });
    const result = await createReviewerResumeHandler({
      progress,
      stdin: stdin(reviewerResumeConfirmationPhrase),
    })({ jobId, recoverRecordPrepublication: true });

    expect(result.state).toBe("success");
    expect(JSON.parse(result.message ?? "{}")).toMatchObject({
      nextStage: "awaiting_review",
      recovery: "review_record_prepublication",
      admissionReleased: false,
      implementerRerun: false,
    });
  });

  it("rejects record recovery after any review publication attempt", async () => {
    const progress = await store();
    const mutation = {
      ...record(),
      stage: {
        kind: "requires_manual",
        cause: {
          stage: "review",
          reasonCode: "review_record_failed",
          attempts: { count: 1 },
        },
      },
      controlFence: {
        leaseId: "lease_018f47d2-77a4-7cc1-8ef2-0123456789ab" as never,
        holderId: "reviewer-resume-test",
        leaseEpoch: 1,
        ownershipEpoch: 1,
        state: "active",
      },
      mutationAttempts: [
        {
          operationKey: "managed:job:pr_comment:digest",
          intent: "pr_comment",
          identityDigest: "a".repeat(64),
          attempts: [{ ordinal: 1, preparedAt: now, outcome: "prepared" as const }],
        },
      ],
    } satisfies JobProgressRecordMutation;
    const seeded = await progress.compareAndSwap(jobId, null, mutation);
    if (!seeded.ok) throw new Error(seeded.error.code);
    const confirmed = await progress.compareAndSwap(jobId, seeded.value.revision, {
      ...mutation,
      mutationAttempts: mutation.mutationAttempts.map((entry) => ({
        ...entry,
        attempts: entry.attempts.map((attempt) => ({ ...attempt, outcome: "confirmed" as const })),
      })),
    });
    if (!confirmed.ok) throw new Error(confirmed.error.code);

    const result = await createReviewerResumeHandler({
      progress,
      stdin: stdin(reviewerResumeConfirmationPhrase),
    })({ jobId, recoverRecordPrepublication: true });

    expect(result.state).toBe("failed");
    expect(JSON.parse(result.message ?? "{}")).toMatchObject({
      reason: "job_not_waiting_for_reviewer",
    });
    await expect(progress.load(jobId)).resolves.toMatchObject({
      ok: true,
      value: { stage: { kind: "requires_manual" } },
    });
  });
});
