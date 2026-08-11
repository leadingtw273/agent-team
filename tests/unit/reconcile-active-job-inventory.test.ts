import { describe, expect, it } from "vitest";

import {
  jobProgressRecordSchema,
  type JobProgressRecord,
  type JobProgressStage,
} from "../../src/adapters/dispatch/job-progress-store.js";
import { domainError, err, ok, parseIdentifier } from "../../src/domain/foundation/index.js";
import {
  classifyJobProgressRecord,
  countJobProgressInventory,
  readJobProgressInventory,
} from "../../src/cli/reconcile/active-job-inventory.js";

function record(stage: JobProgressStage, suffix = "0"): JobProgressRecord {
  return jobProgressRecordSchema.parse({
    schemaVersion: 1,
    revision: 0,
    jobId: `job_018f47d2-77a4-7cc1-8ef2-${suffix.padStart(12, "0")}`,
    projectId: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    issueId: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    externalIssueId: `ENG-${suffix}`,
    model: "test-model",
    stage,
    branch: `agent-team/job-${suffix}`,
    worktreePath: `/tmp/job-${suffix}`,
    updatedAt: "2026-08-11T12:00:00.000Z",
  });
}

function jobIdentifier(value: string) {
  const parsed = parseIdentifier("job", value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

describe("durable job-progress inventory", () => {
  it("classifies normal resume stages and the two narrow merge read-back cases as resumable", () => {
    const stages: JobProgressStage[] = [
      { kind: "ci_waiting" },
      { kind: "awaiting_review" },
      { kind: "fix_round" },
      { kind: "merging" },
      { kind: "review_pending_retry", retries: 1, lastErrorCode: "timeout" },
      { kind: "ci_pending_retry", retries: 1, lastErrorCode: "unavailable" },
      {
        kind: "review_report_pending_retry",
        retries: 1,
        lastCategory: "enum_mismatch",
      },
      {
        kind: "requires_manual",
        cause: {
          stage: "merge",
          reasonCode: "auto_merge_not_enabled",
          attempts: { count: 1 },
        },
      },
      {
        kind: "requires_manual",
        cause: {
          stage: "merge",
          reasonCode: "lifecycle_not_completed",
          attempts: { count: 1 },
        },
      },
    ];
    expect(
      stages.map((stage, index) => classifyJobProgressRecord(record(stage, String(index)))),
    ).toEqual(Array.from({ length: stages.length }, () => "resumable"));
  });

  it("fails closed for implementing, paused and general requires_manual records", () => {
    const stages: JobProgressStage[] = [
      { kind: "implementing" },
      { kind: "paused", pauseReason: "provider_interrupted" },
      {
        kind: "requires_manual",
        cause: {
          stage: "review",
          reasonCode: "review_not_approved",
          attempts: { count: 1 },
        },
      },
    ];
    expect(
      stages.map((stage, index) => classifyJobProgressRecord(record(stage, String(index)))),
    ).toEqual(["blocked", "blocked", "blocked"]);
  });

  it("classifies completed, failed, superseded and cancelled as terminal", () => {
    const stages: JobProgressStage[] = [
      { kind: "completed" },
      { kind: "failed" },
      {
        kind: "superseded",
        supersededByJobId: jobIdentifier("job_018f47d2-77a4-7cc1-8ef2-1123456789ab"),
      },
      { kind: "cancelled" },
    ];
    expect(
      stages.map((stage, index) => classifyJobProgressRecord(record(stage, String(index)))),
    ).toEqual(["terminal", "terminal", "terminal", "terminal"]);
  });

  it("reads the store once and returns exhaustive mutually-exclusive buckets", async () => {
    const records = [
      record({ kind: "ci_waiting" }, "1"),
      record({ kind: "implementing" }, "2"),
      record({ kind: "completed" }, "3"),
    ];
    let calls = 0;
    const result = await readJobProgressInventory({
      listAll: () => {
        calls += 1;
        return Promise.resolve(ok(records));
      },
    });

    expect(calls).toBe(1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resumable.map((item) => item.jobId)).toEqual([records[0]?.jobId]);
    expect(result.value.blocked.map((item) => item.jobId)).toEqual([records[1]?.jobId]);
    expect(result.value.terminal.map((item) => item.jobId)).toEqual([records[2]?.jobId]);
    expect(countJobProgressInventory(result.value)).toEqual({
      resumable: 1,
      blocked: 1,
      terminal: 1,
      total: 3,
    });
  });

  it("propagates a durable inventory read failure instead of pretending the set is empty", async () => {
    const result = await readJobProgressInventory({
      listAll: () => Promise.resolve(err(domainError("external_failure"))),
    });
    expect(result).toEqual(err(domainError("external_failure")));
  });
});
