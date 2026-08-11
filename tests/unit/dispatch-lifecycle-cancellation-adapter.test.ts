/**
 * E115cap unit test: `JobProgressLifecycleCancellationAdapter` and
 * `LeaseCoordinatorLifecycleLeaseReleaseAdapter` (src/cli/dispatch/lifecycle-cancellation-adapter.ts)
 * -- against a real `FileJobProgressStore`, a real `LocalYamlCheckpointStore` (real disk, no mocks),
 * and a real `LeaseCoordinator` over an in-memory `LeaseRepository`.
 *
 * Covers: a non-terminal progress record belonging to the cancelled issue gets
 * CAS-transitioned to `requires_manual` *and* a real F008 `Checkpoint` is written to disk and
 * read back (this is the C015c-era adapter's own disclosed limitation this ticket closes -- it used
 * to always report `checkpoint:"not_required"`); an already-terminal record is left untouched and
 * produces no checkpoint; records belonging to a different issue or project are never touched;
 * `checkpoint` is `"not_required"` (never fabricated) when there is nothing active to checkpoint;
 * checkpoint persistence failures fail this whole call closed, never falsely reporting
 * `"preserved"`; more than one active job for the same issue fails closed before mutating anything;
 * and lease release finds/releases the matching lease, is idempotent when already released, and is
 * an honest no-op (`released:false`) when none exists.
 */
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  JobProgressLifecycleCancellationAdapter,
  LeaseCoordinatorLifecycleLeaseReleaseAdapter,
} from "../../src/cli/dispatch/lifecycle-cancellation-adapter.js";
import { FileJobProgressStore } from "../../src/adapters/dispatch/index.js";
import { LocalYamlCheckpointStore } from "../../src/adapters/checkpoint/index.js";
import { LeaseCoordinator } from "../../src/application/leases/index.js";
import type { CheckpointPersistencePort } from "../../src/application/checkpoint/index.js";
import {
  domainError,
  err,
  generateDeterministicIdentifier,
  parseIdentifier,
  parseInstant,
  type Identifier,
} from "../../src/domain/foundation/index.js";
import { issueSchema, projectSchema, type Project } from "../../src/domain/project/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-lifecycle-cancel-"));
  temporaryDirectories.push(directory);
  return directory;
}

function id<Scope extends string>(scope: Scope, value: string): Identifier<Scope> {
  const parsed = parseIdentifier(scope, value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const projectId = id("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const project: Project = projectSchema.parse({
  schemaVersion: 1,
  id: projectId,
  displayName: "Sandbox",
  localRepositoryPath: "/tmp/sandbox",
  defaultBranch: "main",
  workManagement: { provider: "linear", containerId: "team-1", projectId: "proj-1" },
  sourceControl: { provider: "github", repository: "owner/sandbox" },
});

const externalIssueId = "linear-issue-1";
const issueId = (() => {
  const parsed = generateDeterministicIdentifier("issue", externalIssueId);
  if (!parsed.ok) throw new Error("fixture invariant violated");
  return parsed.value;
})();

const issue = issueSchema.parse({
  schemaVersion: 1,
  id: issueId,
  projectId,
  externalId: externalIssueId,
  title: "Ship the thing",
});

function changeRequest(state: "closed" | "merged" = "closed") {
  return {
    id: "PR_kwDOTvUUF877drQL",
    number: 42,
    url: "https://example.test/pr/42",
    state,
    draft: false,
    baseBranch: "main",
    headBranch: "agent-team/job-1",
    headSha: "a".repeat(40),
    mergeability: "mergeable" as const,
    autoMergeEnabled: false,
    updatedAt: "2026-08-07T00:00:00.000Z" as never,
  };
}

function prepareRequest(state: "closed" | "merged" = "closed") {
  return {
    project,
    externalIssueId,
    changeRequest: changeRequest(state),
    issue,
    preserveBranchAndWorktree: true as const,
  };
}

function checkpointStore(directory: string): LocalYamlCheckpointStore {
  return new LocalYamlCheckpointStore(join(directory, "checkpoints"));
}

describe("JobProgressLifecycleCancellationAdapter", () => {
  it("reports activeWorkStopped and not_required when there is no progress record at all, and writes no checkpoint file", async () => {
    const directory = await temporaryDirectory();
    const store = new FileJobProgressStore(directory);
    const checkpoints = checkpointStore(directory);
    const adapter = new JobProgressLifecycleCancellationAdapter({
      progress: store,
      store: checkpoints,
    });

    const result = await adapter.prepare(prepareRequest(), { idempotencyKey: "cancel-1" });
    expect(result).toEqual({
      ok: true,
      value: { activeWorkStopped: true, checkpoint: "not_required" },
    });
    await expect(readdir(join(directory, "checkpoints")).catch(() => [])).resolves.toEqual([]);
  });

  it("C035: persists a distinct cancellation_after_merge cause for a merged race", async () => {
    const directory = await temporaryDirectory();
    const store = new FileJobProgressStore(directory);
    const jobId = id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab");
    await store.compareAndSwap(jobId, null, {
      jobId,
      projectId,
      issueId,
      externalIssueId,
      model: "claude-opus",
      stage: { kind: "merging" },
      branch: "agent-team/job-1",
      worktreePath: "/tmp/sandbox-worktree",
    });
    const adapter = new JobProgressLifecycleCancellationAdapter({
      progress: store,
      store: checkpointStore(directory),
    });

    const result = await adapter.prepare(prepareRequest("merged"), {
      idempotencyKey: "cancel-after-merge-1",
    });

    expect(result.ok).toBe(true);
    const reloaded = await store.load(jobId);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toMatchObject({
        kind: "requires_manual",
        cause: { stage: "merge", reasonCode: "cancellation_after_merge" },
      });
    }
  });

  it("CAS-transitions a non-terminal record for this issue to requires_manual and preserves a real, disk-readable F008 checkpoint", async () => {
    const directory = await temporaryDirectory();
    const store = new FileJobProgressStore(directory);
    const checkpoints = checkpointStore(directory);
    const jobId = id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab");
    await store.compareAndSwap(jobId, null, {
      jobId,
      projectId,
      issueId,
      externalIssueId,
      model: "claude-opus",
      stage: { kind: "ci_waiting" },
      branch: "agent-team/job-1",
      worktreePath: "/tmp/sandbox-worktree",
    });

    const adapter = new JobProgressLifecycleCancellationAdapter({
      progress: store,
      store: checkpoints,
    });
    const result = await adapter.prepare(prepareRequest(), { idempotencyKey: "cancel-1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.activeWorkStopped).toBe(true);
    expect(result.value.checkpoint).toBe("preserved");
    const checkpointId = result.value.checkpointId;
    if (checkpointId === undefined) throw new Error("checkpointId missing");
    expect(checkpointId).toMatch(/^checkpoint_/u);

    const reloaded = await store.load(jobId);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toEqual({
        kind: "requires_manual",
        cause: {
          stage: "merge",
          reasonCode: "work_item_canceled",
          attempts: { count: 1 },
        },
      });
      expect(reloaded.value?.revision).toBe(1);
    }

    // Real disk read-back -- never trust the in-memory return value alone.
    const raw = await readFile(join(directory, "checkpoints", `${checkpointId}.yaml`), "utf8");
    expect(raw).toContain(`id: "${checkpointId}"`);
    expect(raw).toContain(`jobId: "${jobId}"`);
    expect(raw).toContain(`issueId: "${issueId}"`);
    expect(raw).toContain('reason: "manual"');
    expect(raw).toContain('path: "/tmp/sandbox-worktree"');
    expect(raw).toContain('branch: "agent-team/job-1"');
    expect(raw).toContain(`commitSha: "${"a".repeat(40)}"`);
    expect(raw).toContain("pushed: true");
  });

  it("leaves an already-terminal record untouched and writes no checkpoint", async () => {
    const directory = await temporaryDirectory();
    const store = new FileJobProgressStore(directory);
    const checkpoints = checkpointStore(directory);
    const jobId = id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab");
    await store.compareAndSwap(jobId, null, {
      jobId,
      projectId,
      issueId,
      externalIssueId,
      model: "claude-opus",
      stage: { kind: "completed" },
      branch: "agent-team/job-1",
      worktreePath: "/tmp/sandbox-worktree",
    });

    const adapter = new JobProgressLifecycleCancellationAdapter({
      progress: store,
      store: checkpoints,
    });
    const result = await adapter.prepare(prepareRequest(), { idempotencyKey: "cancel-1" });
    expect(result).toEqual({
      ok: true,
      value: { activeWorkStopped: true, checkpoint: "not_required" },
    });

    const reloaded = await store.load(jobId);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toEqual({ kind: "completed" });
      expect(reloaded.value?.revision).toBe(0);
    }
    await expect(readdir(join(directory, "checkpoints")).catch(() => [])).resolves.toEqual([]);
  });

  it("never touches a record belonging to a different issue in the same project", async () => {
    const directory = await temporaryDirectory();
    const store = new FileJobProgressStore(directory);
    const checkpoints = checkpointStore(directory);
    const otherIssueId = id("issue", "issue_018f47d2-77a4-7cc1-8ef2-9123456789ab");
    const otherJobId = id("job", "job_018f47d2-77a4-7cc1-8ef2-9123456789ab");
    await store.compareAndSwap(otherJobId, null, {
      jobId: otherJobId,
      projectId,
      issueId: otherIssueId,
      externalIssueId: "linear-issue-2",
      model: "claude-opus",
      stage: { kind: "ci_waiting" },
      branch: "agent-team/job-2",
      worktreePath: "/tmp/sandbox-worktree-2",
    });

    const adapter = new JobProgressLifecycleCancellationAdapter({
      progress: store,
      store: checkpoints,
    });
    const result = await adapter.prepare(prepareRequest(), { idempotencyKey: "cancel-1" });
    expect(result).toEqual({
      ok: true,
      value: { activeWorkStopped: true, checkpoint: "not_required" },
    });

    const reloaded = await store.load(otherJobId);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toEqual({ kind: "ci_waiting" });
      expect(reloaded.value?.revision).toBe(0);
    }
  });

  it("fails closed (never reports preserved) when checkpoint persistence fails, and still leaves the job requires_manual", async () => {
    const directory = await temporaryDirectory();
    const store = new FileJobProgressStore(directory);
    const jobId = id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab");
    await store.compareAndSwap(jobId, null, {
      jobId,
      projectId,
      issueId,
      externalIssueId,
      model: "claude-opus",
      stage: { kind: "ci_waiting" },
      branch: "agent-team/job-1",
      worktreePath: "/tmp/sandbox-worktree",
    });

    const failingStore: CheckpointPersistencePort = {
      persist: () => Promise.resolve(err(domainError("external_failure"))),
    };
    const adapter = new JobProgressLifecycleCancellationAdapter({
      progress: store,
      store: failingStore,
    });
    const result = await adapter.prepare(prepareRequest(), { idempotencyKey: "cancel-1" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("external_failure");

    // The job was already, correctly, stopped before the checkpoint write was ever attempted --
    // that half of "prepare" is not undone by a downstream persistence failure.
    const reloaded = await store.load(jobId);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toEqual({
        kind: "requires_manual",
        cause: {
          stage: "merge",
          reasonCode: "work_item_canceled",
          attempts: { count: 1 },
        },
      });
    }
  });

  it("fails closed before mutating anything when more than one active job-progress record exists for the same issue (ambiguous, never guessed)", async () => {
    const directory = await temporaryDirectory();
    const store = new FileJobProgressStore(directory);
    const checkpoints = checkpointStore(directory);
    const firstJobId = id("job", "job_018f47d2-77a4-7cc1-8ef2-1123456789ab");
    const secondJobId = id("job", "job_018f47d2-77a4-7cc1-8ef2-2123456789ab");
    for (const jobId of [firstJobId, secondJobId]) {
      await store.compareAndSwap(jobId, null, {
        jobId,
        projectId,
        issueId,
        externalIssueId,
        model: "claude-opus",
        stage: { kind: "ci_waiting" },
        branch: "agent-team/job-1",
        worktreePath: "/tmp/sandbox-worktree",
      });
    }

    const adapter = new JobProgressLifecycleCancellationAdapter({
      progress: store,
      store: checkpoints,
    });
    const result = await adapter.prepare(prepareRequest(), { idempotencyKey: "cancel-1" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invariant_violation");

    for (const jobId of [firstJobId, secondJobId]) {
      const reloaded = await store.load(jobId);
      expect(reloaded.ok).toBe(true);
      if (reloaded.ok) {
        expect(reloaded.value?.stage).toEqual({ kind: "ci_waiting" });
        expect(reloaded.value?.revision).toBe(0);
      }
    }
    await expect(readdir(join(directory, "checkpoints")).catch(() => [])).resolves.toEqual([]);
  });
});

describe("LeaseCoordinatorLifecycleLeaseReleaseAdapter", () => {
  const now = (() => {
    const parsed = parseInstant("2026-08-08T00:00:00.000Z");
    if (!parsed.ok) throw new Error(parsed.error.code);
    return parsed.value;
  })();
  const expiresAt = (() => {
    const parsed = parseInstant("2026-08-08T01:00:00.000Z");
    if (!parsed.ok) throw new Error(parsed.error.code);
    return parsed.value;
  })();

  function inMemoryLeaseRepository(seed: readonly Record<string, unknown>[] = []) {
    let leases = [...seed] as never[];
    return {
      readAll: () => Promise.resolve({ ok: true as const, value: leases }),
      transact: (
        _holderId: string,
        mutate: (current: never[]) => { ok: boolean; value?: unknown; error?: unknown },
      ) => {
        const mutation = mutate(leases) as {
          ok: boolean;
          value?: { leases: never[]; value: unknown; changed: boolean };
          error?: unknown;
        };
        if (!mutation.ok) return Promise.resolve({ ok: false, error: mutation.error });
        leases = mutation.value?.leases ?? leases;
        return Promise.resolve({
          ok: true as const,
          value: {
            value: mutation.value?.value,
            persistence: mutation.value?.changed ? ("confirmed" as const) : ("unchanged" as const),
            lockRelease: "confirmed" as const,
          },
        });
      },
    };
  }

  it("releases the one lease held for the cancelled issue, reading leaseId/holderId off the lease itself", async () => {
    const leaseId = id("lease", "lease_018f47d2-77a4-7cc1-8ef2-0123456789ab");
    const jobId = id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab");
    const repository = inMemoryLeaseRepository([
      {
        schemaVersion: 1,
        id: leaseId,
        jobId,
        issueId,
        holderId: "holder-1",
        acquiredAt: now,
        expiresAt,
      },
    ]);
    const coordinator = new LeaseCoordinator(repository as never, { clock: { now: () => now } });
    const adapter = new LeaseCoordinatorLifecycleLeaseReleaseAdapter({ leases: coordinator });

    const result = await adapter.release(
      { project, externalIssueId },
      { idempotencyKey: "release-1" },
    );
    expect(result).toEqual({ ok: true, value: { released: true } });

    const all = await repository.readAll();
    expect(all.value[0]).toMatchObject({ id: leaseId, releasedAt: now });
  });

  it("reports released:false (an honest no-op, not an error) when no lease exists for the issue", async () => {
    const repository = inMemoryLeaseRepository([]);
    const coordinator = new LeaseCoordinator(repository as never);
    const adapter = new LeaseCoordinatorLifecycleLeaseReleaseAdapter({ leases: coordinator });

    const result = await adapter.release(
      { project, externalIssueId },
      { idempotencyKey: "release-1" },
    );
    expect(result).toEqual({ ok: true, value: { released: false } });
  });

  it("is idempotent: releasing an already-released lease reports released:false, never an error", async () => {
    const leaseId = id("lease", "lease_018f47d2-77a4-7cc1-8ef2-0123456789ab");
    const jobId = id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab");
    const repository = inMemoryLeaseRepository([
      {
        schemaVersion: 1,
        id: leaseId,
        jobId,
        issueId,
        holderId: "holder-1",
        acquiredAt: now,
        expiresAt,
        releasedAt: now,
      },
    ]);
    const coordinator = new LeaseCoordinator(repository as never);
    const adapter = new LeaseCoordinatorLifecycleLeaseReleaseAdapter({ leases: coordinator });

    const result = await adapter.release(
      { project, externalIssueId },
      { idempotencyKey: "release-1" },
    );
    expect(result).toEqual({ ok: true, value: { released: false } });
  });

  it("never touches a lease belonging to a different issue", async () => {
    const leaseId = id("lease", "lease_018f47d2-77a4-7cc1-8ef2-9123456789ab");
    const jobId = id("job", "job_018f47d2-77a4-7cc1-8ef2-9123456789ab");
    const otherIssueId = id("issue", "issue_018f47d2-77a4-7cc1-8ef2-9123456789ab");
    const repository = inMemoryLeaseRepository([
      {
        schemaVersion: 1,
        id: leaseId,
        jobId,
        issueId: otherIssueId,
        holderId: "holder-1",
        acquiredAt: now,
        expiresAt,
      },
    ]);
    const coordinator = new LeaseCoordinator(repository as never);
    const adapter = new LeaseCoordinatorLifecycleLeaseReleaseAdapter({ leases: coordinator });

    const result = await adapter.release(
      { project, externalIssueId },
      { idempotencyKey: "release-1" },
    );
    expect(result).toEqual({ ok: true, value: { released: false } });

    const all = await repository.readAll();
    const [firstLease] = all.value;
    expect(firstLease).toMatchObject({ id: leaseId });
    expect((firstLease as { releasedAt?: string } | undefined)?.releasedAt).toBeUndefined();
  });
});
