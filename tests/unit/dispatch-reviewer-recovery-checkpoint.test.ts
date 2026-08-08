import { describe, expect, it } from "vitest";

import { ReviewerRecoveryCheckpointAdapter } from "../../src/cli/dispatch/reviewer-recovery-checkpoint.js";
import type { CheckpointPersistencePort } from "../../src/application/checkpoint/index.js";
import { checkpointSchema, type Checkpoint } from "../../src/domain/checkpoint/index.js";
import {
  createFixedClock,
  ok,
  parseInstant,
  type Instant,
} from "../../src/domain/foundation/index.js";
import { emptyAttemptCounters, jobSchema } from "../../src/domain/jobs/index.js";
import { issueSchema } from "../../src/domain/project/index.js";
import { createRequirementSnapshot } from "../../src/domain/review/index.js";

function instant(value: string): Instant {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const now = instant("2026-08-08T00:00:00.000Z");
const projectId = "project_018f47d2-77a4-7cc1-8ef2-0123456789ab" as never;
const issueId = "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab" as never;
const job = jobSchema.parse({
  schemaVersion: 1,
  id: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  projectId,
  issueId,
  createdAt: now,
  watchdogExtensionGranted: false,
  attempts: emptyAttemptCounters(),
});
const issue = issueSchema.parse({
  schemaVersion: 1,
  id: issueId,
  projectId,
  externalId: "ENG-104",
  title: "Reviewer recovery",
  dependencies: { kind: "none" },
});
const snapshotResult = createRequirementSnapshot(issue, now);
if (!snapshotResult.ok) throw new Error(snapshotResult.error.code);
const worktree = {
  repositoryRoot: "/tmp/repo",
  path: "/tmp/worktree",
  branch: "feature/ENG-104",
  headSha: "a".repeat(40),
};

class Store implements CheckpointPersistencePort {
  received: Checkpoint[] = [];
  persist(checkpoint: Checkpoint) {
    this.received.push(checkpoint);
    return Promise.resolve(
      ok({
        path: "/tmp/checkpoint.yaml",
        sha256: "f".repeat(64),
        durability: "confirmed" as const,
      }),
    );
  }
}

describe("ReviewerRecoveryCheckpointAdapter", () => {
  it("maps attempt limit to retry_exhausted with no synthetic test results", async () => {
    const store = new Store();
    const adapter = new ReviewerRecoveryCheckpointAdapter({ store, clock: createFixedClock(now) });
    const result = await adapter.preserve(
      { job, worktree, requirementSnapshot: snapshotResult.value, reason: "attempt_limit_reached" },
      { idempotencyKey: "reviewer-recovery-attempt-limit" },
    );

    expect(result.ok).toBe(true);
    const checkpoint = store.received[0];
    expect(checkpointSchema.safeParse(checkpoint).success).toBe(true);
    expect(checkpoint).toMatchObject({
      reason: "retry_exhausted",
      tests: [],
      worktree: { pushed: true },
    });
  });

  it("maps scope overrun to human_handoff and preserves scope evidence", async () => {
    const store = new Store();
    const adapter = new ReviewerRecoveryCheckpointAdapter({ store, clock: createFixedClock(now) });
    const result = await adapter.preserve(
      {
        job,
        worktree,
        requirementSnapshot: snapshotResult.value,
        reason: "scope_overrun",
        findings: [{ code: "outside_declared_region", path: "src/outside.ts" }],
        changedPaths: ["src/outside.ts"],
      },
      { idempotencyKey: "reviewer-recovery-scope-overrun" },
    );

    expect(result.ok).toBe(true);
    const checkpoint = store.received[0];
    expect(checkpoint).toMatchObject({
      reason: "human_handoff",
      tests: [],
      completedItems: ["src/outside.ts"],
      remainingItems: ["outside_declared_region: src/outside.ts"],
      worktree: { pushed: false },
    });
  });
});
