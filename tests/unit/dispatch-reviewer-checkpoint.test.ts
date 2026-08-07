/**
 * C015c item 3 unit tests: `ReviewerCheckpointAdapter` (src/cli/dispatch/reviewer-checkpoint.ts) --
 * mirrors tests/unit/dispatch-scope-checkpoint.test.ts's own technique (a `FakeCheckpointStore`
 * that re-validates with the real `checkpointSchema`). Covers: `reason` maps to
 * `"retry_exhausted"`; `worktree.pushed` is always `true`; `tests` is derived from the
 * `CommitChecksSnapshot` (success/failure/cancelled/other -> passed/failed/failed/not_run); a
 * persistence failure propagates.
 */
import { describe, expect, it } from "vitest";

import { ReviewerCheckpointAdapter } from "../../src/cli/dispatch/reviewer-checkpoint.js";
import { checkpointSchema } from "../../src/domain/checkpoint/index.js";
import type { CheckpointPersistencePort } from "../../src/application/checkpoint/index.js";
import type { Checkpoint } from "../../src/domain/checkpoint/index.js";
import {
  createFixedClock,
  domainError,
  err,
  ok,
  parseIdentifier,
  parseInstant,
  type Identifier,
  type Instant,
} from "../../src/domain/foundation/index.js";
import { issueSchema, type Issue } from "../../src/domain/project/index.js";
import {
  createRequirementSnapshot,
  type RequirementSnapshot,
} from "../../src/domain/review/index.js";
import { emptyAttemptCounters, jobSchema, type Job } from "../../src/domain/jobs/index.js";

function id<Scope extends string>(scope: Scope, value: string): Identifier<Scope> {
  const parsed = parseIdentifier(scope, value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function instant(value: string): Instant {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const now = instant("2026-08-07T12:00:00.000Z");
const projectId = id("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const issueId = id("issue", "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const jobId = id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab");

function job(): Job {
  return jobSchema.parse({
    schemaVersion: 1,
    id: jobId,
    projectId,
    issueId,
    createdAt: now,
    watchdogExtensionGranted: false,
    attempts: emptyAttemptCounters(),
  });
}

function issue(): Issue {
  return issueSchema.parse({
    schemaVersion: 1,
    id: issueId,
    projectId,
    externalId: "linear-issue-1",
    title: "Ship the thing",
    dependencies: { kind: "none" },
  });
}

function requirementSnapshot(): RequirementSnapshot {
  const snapshot = createRequirementSnapshot(issue(), now);
  if (!snapshot.ok) throw new Error(snapshot.error.code);
  return snapshot.value;
}

function baseRequest() {
  return {
    job: job(),
    worktree: {
      repositoryRoot: "/tmp/repo",
      path: "/tmp/repo-worktree",
      branch: "agent-team/issue-1",
      headSha: "a".repeat(40),
    },
    requirementSnapshot: requirementSnapshot(),
    reason: "attempt_limit_reached" as const,
    checks: {
      headSha: "a".repeat(40),
      aggregate: "success" as const,
      checks: [
        { name: "build", status: "completed" as const, conclusion: "success" as const },
        { name: "test", status: "completed" as const, conclusion: "failure" as const },
        { name: "lint", status: "queued" as const, conclusion: null },
      ],
    },
  };
}

class FakeCheckpointStore implements CheckpointPersistencePort {
  received: Checkpoint[] = [];
  failure: ReturnType<typeof domainError> | undefined;

  persist(checkpoint: Checkpoint) {
    this.received.push(checkpoint);
    if (this.failure !== undefined) return Promise.resolve(err(this.failure));
    return Promise.resolve(
      ok({
        path: "/tmp/checkpoint.yaml",
        sha256: "f".repeat(64),
        durability: "confirmed" as const,
      }),
    );
  }
}

describe("ReviewerCheckpointAdapter", () => {
  it("synthesizes a schema-valid Checkpoint with reason:retry_exhausted, pushed:true, and tests derived from checks", async () => {
    const store = new FakeCheckpointStore();
    const adapter = new ReviewerCheckpointAdapter({ store, clock: createFixedClock(now) });

    const result = await adapter.preserve(baseRequest(), { idempotencyKey: "test-key-1" });
    expect(result.ok).toBe(true);
    const persisted = store.received[0];
    expect(persisted).toBeDefined();
    if (persisted === undefined) return;

    expect(checkpointSchema.safeParse(persisted).success).toBe(true);
    expect(persisted.reason).toBe("retry_exhausted");
    expect(persisted.worktree).toEqual({
      path: "/tmp/repo-worktree",
      branch: "agent-team/issue-1",
      commitSha: "a".repeat(40),
      pushed: true,
    });
    expect(persisted.completedItems).toEqual([]);
    expect(persisted.remainingItems).toEqual([]);
    expect(persisted.tests).toEqual([
      { commandSummary: "build", status: "passed" },
      { commandSummary: "test", status: "failed" },
      { commandSummary: "lint", status: "not_run" },
    ]);
    expect(persisted.nextSteps.length).toBeGreaterThan(0);
    if (result.ok) expect(result.value.checkpointId).toBe(persisted.id);
  });

  it("propagates a persistence failure rather than swallowing it", async () => {
    const store = new FakeCheckpointStore();
    store.failure = domainError("conflict");
    const adapter = new ReviewerCheckpointAdapter({ store, clock: createFixedClock(now) });

    const result = await adapter.preserve(baseRequest(), { idempotencyKey: "test-key-2" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("conflict");
  });
});
