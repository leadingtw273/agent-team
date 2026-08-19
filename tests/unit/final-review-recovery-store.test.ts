import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileFinalReviewRecoveryStore,
  type FinalReviewRecoveryIdentity,
  type FinalReviewRecoveryRecordMutation,
} from "../../src/adapters/dispatch/final-review-recovery-store.js";
import { currentReviewerReportContractBinding } from "../../src/application/pipelines/reviewer-policy.js";
import {
  createFixedClock,
  parseIdentifier,
  parseInstant,
} from "../../src/domain/foundation/index.js";
import { headShaSchema, sha256Digest } from "../../src/domain/review/index.js";

const roots: string[] = [];
const timestamp = "2026-08-19T10:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function identity(): FinalReviewRecoveryIdentity {
  const jobId = parseIdentifier("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab");
  const projectId = parseIdentifier("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab");
  const issueId = parseIdentifier("issue", "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab");
  if (!jobId.ok || !projectId.ok || !issueId.ok) throw new Error("invalid test identity");
  return {
    schemaVersion: 1,
    operation: "reviewer-final-replay",
    jobId: jobId.value,
    projectId: projectId.value,
    issueId: issueId.value,
    externalIssueId: "linear-issue",
    changeRequestId: "24",
    sourceCheckpointId: "checkpoint_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    sourceCheckpointDigest: "a".repeat(64),
    baseRevision: headShaSchema.parse("b".repeat(40)),
    requirementsDigest: "c".repeat(64),
    headSha: headShaSchema.parse("d".repeat(40)),
    diffDigest: "e".repeat(64),
    reviewContractBinding: currentReviewerReportContractBinding,
  };
}

function ready(): Extract<FinalReviewRecoveryRecordMutation, { state: "ready" }> {
  const digest = sha256Digest(identity());
  if (!digest.ok) throw new Error(digest.error.code);
  return {
    state: "ready",
    jobId: identity().jobId,
    identity: identity(),
    identityDigest: digest.value,
    preProviderFailures: 0,
  };
}

async function store(): Promise<FileFinalReviewRecoveryStore> {
  const root = await mkdtemp(join(tmpdir(), "final-review-recovery-"));
  roots.push(root);
  const instant = parseInstant(timestamp);
  if (!instant.ok) throw new Error(instant.error.code);
  return new FileFinalReviewRecoveryStore(root, undefined, createFixedClock(instant.value));
}

describe("FileFinalReviewRecoveryStore", () => {
  it("persists the one-way ready -> reserved -> success protocol", async () => {
    const subject = await store();
    const initialized = await subject.compareAndSwap(identity().jobId, null, ready());
    expect(initialized.ok).toBe(true);
    if (!initialized.ok) return;

    const reserved = await subject.compareAndSwap(identity().jobId, initialized.value.revision, {
      ...ready(),
      state: "provider_reserved",
      reservedAt: timestamp as never,
    });
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;

    const report = {
      schemaVersion: 1 as const,
      role: "code_reviewer" as const,
      verdict: "passed" as const,
      requirementsDigest: identity().requirementsDigest,
      headSha: identity().headSha,
      diffDigest: identity().diffDigest,
      summary: "Passed.",
      acceptanceCriteria: [
        { criterion: "AC", status: "passed" as const, summary: "Passed.", evidenceSources: [] },
      ],
      qualityChecks: [
        {
          dimension: "correctness" as const,
          status: "passed" as const,
          summary: "Passed.",
          evidenceSources: [],
        },
      ],
      findings: [],
    };
    const succeeded = await subject.compareAndSwap(identity().jobId, reserved.value.revision, {
      ...ready(),
      state: "review_succeeded",
      providerRuns: 1,
      reviewStatusRetries: 0,
      reviewCommentCanonicalizationRetries: 0,
      completedAt: timestamp as never,
      reports: [report],
      reportDigests: ["1".repeat(64)],
      reviewerReplayCheckpointDigest: "2".repeat(64),
    });
    expect(succeeded.ok).toBe(true);
    await expect(subject.load(identity().jobId)).resolves.toMatchObject({
      ok: true,
      value: {
        state: "review_succeeded",
        providerRuns: 1,
        reviewStatusRetries: 0,
        reviewCommentCanonicalizationRetries: 0,
      },
    });

    if (succeeded.ok && succeeded.value.state === "review_succeeded") {
      const {
        schemaVersion: _schemaVersion,
        revision: _revision,
        updatedAt: _updatedAt,
        ...next
      } = succeeded.value;
      void _schemaVersion;
      void _revision;
      void _updatedAt;
      const retried = await subject.compareAndSwap(identity().jobId, succeeded.value.revision, {
        ...next,
        reviewStatusRetries: 1,
      });
      expect(retried.ok).toBe(true);
      if (retried.ok) {
        const canonicalized = await subject.compareAndSwap(
          identity().jobId,
          retried.value.revision,
          {
            ...next,
            reviewStatusRetries: 1,
            reviewCommentCanonicalizationRetries: 1,
          },
        );
        expect(canonicalized.ok).toBe(true);
        if (canonicalized.ok) {
          await expect(
            subject.compareAndSwap(identity().jobId, canonicalized.value.revision, {
              ...next,
              reviewStatusRetries: 0,
            }),
          ).resolves.toMatchObject({ ok: false, error: { code: "invariant_violation" } });
        }
      }
    }
  });

  it("allows only a proven pre-provider failure to return to ready", async () => {
    const subject = await store();
    const initialized = await subject.compareAndSwap(identity().jobId, null, ready());
    if (!initialized.ok) throw new Error("setup failed");
    const reserved = await subject.compareAndSwap(identity().jobId, initialized.value.revision, {
      ...ready(),
      state: "provider_reserved",
      reservedAt: timestamp as never,
    });
    if (!reserved.ok) throw new Error("setup failed");

    const retriable = await subject.compareAndSwap(identity().jobId, reserved.value.revision, {
      ...ready(),
      preProviderFailures: 1,
      lastPreProviderFailure: { kind: "failed", stage: "checks", errorCode: "conflict" },
    });
    expect(retriable.ok).toBe(true);
    if (!retriable.ok) return;
    await expect(
      subject.compareAndSwap(identity().jobId, retriable.value.revision, {
        ...ready(),
        state: "provider_outcome_unknown",
        providerRuns: 1,
        completedAt: timestamp as never,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invariant_violation" } });
  });

  it("rejects identity drift and any terminal rewrite", async () => {
    const subject = await store();
    const initialized = await subject.compareAndSwap(identity().jobId, null, ready());
    if (!initialized.ok) throw new Error("setup failed");
    await expect(
      subject.compareAndSwap(identity().jobId, initialized.value.revision, {
        ...ready(),
        identityDigest: "0".repeat(64),
        state: "provider_reserved",
        reservedAt: timestamp as never,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invariant_violation" } });
  });
});
