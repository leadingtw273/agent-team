/**
 * C016 acceptance criterion 4: a `paused` job-progress record (this ticket's own fix -- see
 * handlers.ts's `state === "paused"` write and dispatch-run-pipeline.test.ts's coverage of it),
 * and a `cancelled` record (what `dispatch resolve --as cancelled` turns a `paused` record into,
 * per resolve-handlers.ts), must never be picked up by a fresh `agent-team run`'s resume scan as
 * "existing work to continue" -- the stale worktree/checkpoint a `paused` outcome left behind must
 * stay exactly that: paused, waiting for a human, never silently resurrected as active work
 * running in parallel with whatever superseded it.
 *
 * `isResumeCandidate` (resume-composition.ts) is the single predicate every outer gate
 * (`handlers.ts`'s own pre-flight check before `agent-team run` even considers resuming) asks --
 * this file verifies its documented exclusion list (`"paused"`/`"requires_manual"`/every terminal
 * stage) actually holds for the two stages this ticket's own fix and escape hatch produce,
 * against a real `FileJobProgressStore` round-trip (not merely `resumableStageKinds.has(...)`
 * read in isolation -- `isResumeCandidate` also has the separate `isMergeReconcilable` branch,
 * so this exercises the real exported function, not a hand-rolled stand-in for it).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  isResumeCandidate,
  resumableStageKinds,
} from "../../src/cli/dispatch/resume-composition.js";
import { FileJobProgressStore } from "../../src/adapters/dispatch/job-progress-store.js";
import { parseIdentifier, type Identifier } from "../../src/domain/foundation/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-resume-candidate-gate-"));
  temporaryDirectories.push(directory);
  return directory;
}

function id<Scope extends string>(scope: Scope, value: string): Identifier<Scope> {
  const parsed = parseIdentifier(scope, value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const jobId = id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const projectId = id("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const issueId = id("issue", "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const checkpointId = id("checkpoint", "checkpoint_018f47d2-77a4-7cc1-8ef2-0123456789ab");

describe("C016: isResumeCandidate excludes paused and cancelled -- a stale worktree/checkpoint is never treated as active work", () => {
  it("resumableStageKinds itself never lists paused or cancelled (the documented exclusion this ticket's fix depends on)", () => {
    expect(resumableStageKinds.has("paused")).toBe(false);
    expect(resumableStageKinds.has("cancelled")).toBe(false);
    expect(resumableStageKinds.has("requires_manual")).toBe(false);
  });

  it("a real paused record (this ticket's own handlers.ts write, with checkpointId+pauseReason) is not a resume candidate", async () => {
    const store = new FileJobProgressStore(await temporaryDirectory());
    await store.compareAndSwap(jobId, null, {
      jobId,
      projectId,
      issueId,
      externalIssueId: "linear-issue-1",
      model: "claude-opus",
      stage: { kind: "paused", checkpointId, pauseReason: "scope_overrun" },
      branch: "agent-team/job-018f47d2",
      worktreePath: "/tmp/sandbox-worktree",
    });
    const loaded = await store.load(jobId);
    expect(loaded.ok).toBe(true);
    if (loaded.ok && loaded.value !== undefined) {
      expect(isResumeCandidate(loaded.value)).toBe(false);
    } else {
      throw new Error("expected a record to have been written");
    }
  });

  it("a real paused record with no checkpointId at all is still not a resume candidate", async () => {
    const store = new FileJobProgressStore(await temporaryDirectory());
    await store.compareAndSwap(jobId, null, {
      jobId,
      projectId,
      issueId,
      externalIssueId: "linear-issue-1",
      model: "claude-opus",
      stage: { kind: "paused", pauseReason: "provider_interrupted" },
      branch: "agent-team/job-018f47d2",
      worktreePath: "/tmp/sandbox-worktree",
    });
    const loaded = await store.load(jobId);
    expect(loaded.ok).toBe(true);
    if (loaded.ok && loaded.value !== undefined) {
      expect(isResumeCandidate(loaded.value)).toBe(false);
    } else {
      throw new Error("expected a record to have been written");
    }
  });

  /** What `dispatch resolve --as cancelled` (resolve-handlers.ts) turns a `paused` record into --
   * the legacy-recovery/resolve end state this ticket's escape hatch produces must also never be
   * resurrected as active work. */
  it("a real cancelled record (what dispatch resolve turns a paused record into) is not a resume candidate", async () => {
    const store = new FileJobProgressStore(await temporaryDirectory());
    await store.compareAndSwap(jobId, null, {
      jobId,
      projectId,
      issueId,
      externalIssueId: "linear-issue-1",
      model: "claude-opus",
      stage: { kind: "cancelled" },
      branch: "agent-team/job-018f47d2",
      worktreePath: "/tmp/sandbox-worktree",
    });
    const loaded = await store.load(jobId);
    expect(loaded.ok).toBe(true);
    if (loaded.ok && loaded.value !== undefined) {
      expect(isResumeCandidate(loaded.value)).toBe(false);
    } else {
      throw new Error("expected a record to have been written");
    }
  });
});
