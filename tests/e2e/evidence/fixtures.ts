/**
 * E007 test-only fixtures: one internally-consistent, fully-green `EvidenceBundle` +
 * `EvidenceValidationExpectation` pair, built through the real zod schemas (so a typo in a
 * fixture itself throws at test-setup time rather than silently producing a wrong-but-parseable
 * bundle). Every unit test in validator.test.ts starts from `buildGreenBundle()` /
 * `buildGreenExpectation()` via `structuredClone` and mutates exactly the one field its scenario
 * cares about -- this file only owns the shared, known-good baseline.
 */
import { evidenceBundleSchema, type EvidenceBundle } from "../harness/schema.js";
import {
  evidenceValidationExpectationSchema,
  type EvidenceValidationExpectation,
} from "./expectation.js";

export const fixtureCaseId = "E101";
export const fixtureRunId = "run-e101-001";
export const fixtureIssueId = "issue-e101";
export const fixturePullRequestNumber = 42;
export const fixtureHeadSha = "a".repeat(40);
export const fixtureJobId = "job-1";
export const fixtureTimeWindow = Object.freeze({
  from: "2026-08-06T00:00:00.000Z",
  to: "2026-08-06T23:59:59.999Z",
});

export function buildGreenBundle(): EvidenceBundle {
  return evidenceBundleSchema.parse({
    schemaVersion: 1,
    caseId: fixtureCaseId,
    runId: fixtureRunId,
    assembledAt: "2026-08-06T12:00:00.000Z",
    linear: {
      status: "present",
      collectedAt: "2026-08-06T11:59:00.000Z",
      data: {
        issueId: fixtureIssueId,
        identifier: "AGT-101",
        title: "Sample issue",
        workStatus: "in_review",
        updatedAt: "2026-08-06T10:00:00.000Z",
        comments: [
          { id: "comment-1", body: "Looks good", createdAt: "2026-08-06T10:05:00.000Z" },
          { id: "comment-2", body: "LGTM", createdAt: "2026-08-06T10:10:00.000Z" },
        ],
      },
    },
    github: {
      status: "present",
      collectedAt: "2026-08-06T11:59:00.000Z",
      data: {
        pullRequest: {
          number: fixturePullRequestNumber,
          state: "open",
          draft: false,
          headSha: fixtureHeadSha,
          baseBranch: "main",
          headBranch: "task/agt-101",
          url: "https://github.test/owner/sandbox/pull/42",
          mergeability: "mergeable",
          autoMergeEnabled: false,
        },
        checks: {
          headSha: fixtureHeadSha,
          aggregate: "success",
          checks: [{ name: "CI", status: "completed", conclusion: "success" }],
        },
        statuses: {
          headSha: fixtureHeadSha,
          statuses: [{ context: "agent-team/review", state: "success" }],
        },
      },
    },
    localEvents: {
      status: "present",
      collectedAt: "2026-08-06T11:59:00.000Z",
      data: {
        events: [
          {
            eventId: "event-1",
            eventType: "job.started",
            occurredAt: "2026-08-06T08:30:00.000Z",
            correlationId: fixtureRunId,
            subjectKind: "job",
            subjectId: fixtureJobId,
          },
          {
            eventId: "event-2",
            eventType: "job.completed",
            occurredAt: "2026-08-06T11:00:00.000Z",
            correlationId: fixtureRunId,
            subjectKind: "job",
            subjectId: fixtureJobId,
          },
        ],
        inboxRecords: [
          {
            provider: "github",
            deliveryId: "delivery-1",
            eventType: "pull_request",
            receivedAt: "2026-08-06T09:00:00.000Z",
          },
          {
            provider: "linear",
            deliveryId: "delivery-2",
            eventType: "comment",
            receivedAt: "2026-08-06T09:30:00.000Z",
          },
        ],
      },
    },
    checkpoints: {
      status: "present",
      collectedAt: "2026-08-06T11:59:00.000Z",
      data: {
        checkpoints: [
          {
            id: "checkpoint-1",
            projectId: "project-1",
            issueId: fixtureIssueId,
            jobId: fixtureJobId,
            createdAt: "2026-08-06T08:00:00.000Z",
            reason: "manual",
          },
        ],
      },
    },
  });
}

export function buildGreenExpectation(): EvidenceValidationExpectation {
  return evidenceValidationExpectationSchema.parse({
    caseId: fixtureCaseId,
    runId: fixtureRunId,
    timeWindow: fixtureTimeWindow,
    linear: { issueId: fixtureIssueId },
    github: { pullRequestNumber: fixturePullRequestNumber, headSha: fixtureHeadSha },
    checkpoint: { issueId: fixtureIssueId, jobId: fixtureJobId },
    requiredEventTypes: ["job.started", "job.completed"],
  });
}
