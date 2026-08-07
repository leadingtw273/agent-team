/**
 * C015c item 5 unit test: `JobProgressLifecycleCancellationAdapter`
 * (src/cli/dispatch/lifecycle-cancellation-adapter.ts) -- against a real
 * `FileJobProgressStore` (temp directory, no mocks). Covers: a non-terminal progress record
 * belonging to the cancelled issue gets CAS-transitioned to `requires_manual`; an already-
 * terminal record (`completed`) is left untouched; records belonging to a different issue or
 * project are never touched; `checkpoint` is always reported `"not_required"` (this adapter never
 * fabricates a domain Checkpoint -- see the file's own header for why), and `activeWorkStopped`
 * is `true` even when there was nothing to stop.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { JobProgressLifecycleCancellationAdapter } from "../../src/cli/dispatch/lifecycle-cancellation-adapter.js";
import { FileJobProgressStore } from "../../src/adapters/dispatch/index.js";
import {
  generateDeterministicIdentifier,
  parseIdentifier,
  type Identifier,
} from "../../src/domain/foundation/index.js";
import { projectSchema, type Project } from "../../src/domain/project/index.js";

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

function changeRequest() {
  return {
    id: "PR_kwDOTvUUF877drQL",
    number: 42,
    url: "https://example.test/pr/42",
    state: "closed" as const,
    draft: false,
    baseBranch: "main",
    headBranch: "agent-team/job-1",
    headSha: "a".repeat(40),
    mergeability: "mergeable" as const,
    autoMergeEnabled: false,
    updatedAt: "2026-08-07T00:00:00.000Z" as never,
  };
}

function prepareRequest() {
  return {
    project,
    externalIssueId,
    changeRequest: changeRequest(),
    preserveBranchAndWorktree: true as const,
  };
}

describe("JobProgressLifecycleCancellationAdapter", () => {
  it("reports activeWorkStopped and not_required when there is no progress record at all", async () => {
    const directory = await temporaryDirectory();
    const store = new FileJobProgressStore(directory);
    const adapter = new JobProgressLifecycleCancellationAdapter({ progress: store });

    const result = await adapter.prepare(prepareRequest(), { idempotencyKey: "cancel-1" });
    expect(result).toEqual({
      ok: true,
      value: { activeWorkStopped: true, checkpoint: "not_required" },
    });
  });

  it("CAS-transitions a non-terminal record for this issue to requires_manual", async () => {
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

    const adapter = new JobProgressLifecycleCancellationAdapter({ progress: store });
    const result = await adapter.prepare(prepareRequest(), { idempotencyKey: "cancel-1" });
    expect(result).toEqual({
      ok: true,
      value: { activeWorkStopped: true, checkpoint: "not_required" },
    });

    const reloaded = await store.load(jobId);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toEqual({ kind: "requires_manual" });
      expect(reloaded.value?.revision).toBe(1);
    }
  });

  it("leaves an already-terminal record untouched", async () => {
    const directory = await temporaryDirectory();
    const store = new FileJobProgressStore(directory);
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

    const adapter = new JobProgressLifecycleCancellationAdapter({ progress: store });
    await adapter.prepare(prepareRequest(), { idempotencyKey: "cancel-1" });

    const reloaded = await store.load(jobId);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toEqual({ kind: "completed" });
      expect(reloaded.value?.revision).toBe(0);
    }
  });

  it("never touches a record belonging to a different issue in the same project", async () => {
    const directory = await temporaryDirectory();
    const store = new FileJobProgressStore(directory);
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

    const adapter = new JobProgressLifecycleCancellationAdapter({ progress: store });
    await adapter.prepare(prepareRequest(), { idempotencyKey: "cancel-1" });

    const reloaded = await store.load(otherJobId);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toEqual({ kind: "ci_waiting" });
      expect(reloaded.value?.revision).toBe(0);
    }
  });
});
