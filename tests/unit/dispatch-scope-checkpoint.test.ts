/**
 * C015b unit tests: `ScopeOverrunCheckpointAdapter` (src/cli/dispatch/scope-checkpoint.ts) --
 * the narrow adapter synthesizing a domain `Checkpoint` from raw `ImplementerPipeline`
 * scope-overrun state and persisting it via a `CheckpointPersistencePort`. Covers: the synthesized
 * checkpoint passes the real `checkpointSchema` (proven indirectly -- the fake store parses the
 * argument with the real schema and would throw on a mismatch), `reason` is `human_handoff`,
 * `worktree.pushed` is always `false`, findings map into `remainingItems`, and a persistence
 * failure propagates rather than being swallowed.
 */
import { describe, expect, it } from "vitest";

import { ScopeOverrunCheckpointAdapter } from "../../src/cli/dispatch/scope-checkpoint.js";
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
    goal: "goal",
    background: "background",
    acceptanceCriteria: ["ac"],
    inScope: ["in"],
    outOfScope: ["out"],
    dependencies: { kind: "none" },
    priority: "high",
    agentRole: "implementer",
    reviewRequirement: "code_review",
    estimatedMinutes: 30,
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
    findings: [{ code: "outside_declared_region" as const, path: "src/unexpected.ts" }],
    changedPaths: ["src/unexpected.ts", "src/expected.ts"],
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

describe("ScopeOverrunCheckpointAdapter", () => {
  it("synthesizes a schema-valid Checkpoint with reason:human_handoff and pushed:false", async () => {
    const store = new FakeCheckpointStore();
    const adapter = new ScopeOverrunCheckpointAdapter({ store, clock: createFixedClock(now) });

    const result = await adapter.preserve(baseRequest(), { idempotencyKey: "test-key-1" });
    expect(result.ok).toBe(true);
    expect(store.received).toHaveLength(1);
    const persisted = store.received[0];
    expect(persisted).toBeDefined();
    if (persisted === undefined) return;

    // Genuinely re-validate with the real schema -- proves this is not merely "the fake accepted
    // it," but a real, schema-conformant Checkpoint.
    expect(checkpointSchema.safeParse(persisted).success).toBe(true);
    expect(persisted.reason).toBe("human_handoff");
    expect(persisted.worktree).toEqual({
      path: "/tmp/repo-worktree",
      branch: "agent-team/issue-1",
      commitSha: "a".repeat(40),
      pushed: false,
    });
    expect(persisted.remainingItems).toEqual(["outside_declared_region: src/unexpected.ts"]);
    expect(persisted.completedItems).toEqual(["src/unexpected.ts", "src/expected.ts"]);
    expect(persisted.tests).toEqual([]);
    expect(persisted.nextSteps.length).toBeGreaterThan(0);
    expect(persisted.projectId).toBe(projectId);
    expect(persisted.issueId).toBe(issueId);
    expect(persisted.jobId).toBe(jobId);

    if (result.ok) expect(result.value.checkpointId).toBe(persisted.id);
  });

  it("propagates a persistence failure rather than swallowing it", async () => {
    const store = new FakeCheckpointStore();
    store.failure = domainError("conflict");
    const adapter = new ScopeOverrunCheckpointAdapter({ store, clock: createFixedClock(now) });

    const result = await adapter.preserve(baseRequest(), { idempotencyKey: "test-key-2" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("conflict");
  });

  it("handles zero findings (headSha-mismatch-only overrun) without crashing", async () => {
    const store = new FakeCheckpointStore();
    const adapter = new ScopeOverrunCheckpointAdapter({ store, clock: createFixedClock(now) });

    const result = await adapter.preserve(
      { ...baseRequest(), findings: [] },
      { idempotencyKey: "test-key-3" },
    );
    expect(result.ok).toBe(true);
    const persisted = store.received[0];
    expect(persisted?.remainingItems).toEqual([]);
  });
});
