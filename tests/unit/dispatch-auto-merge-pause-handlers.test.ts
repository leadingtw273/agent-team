/**
 * E116cap unit tests: `createDispatchAutoMergeResumeHandler`
 * (src/cli/dispatch/auto-merge-pause-handlers.ts) -- the human-issued escape hatch out of a
 * project-level auto-merge pause. Mirrors dispatch-resolve-handlers.test.ts's own confirmation-
 * phrase discipline: a wrong/mismatched phrase must be zero side effect (no store write at all).
 * Also covers the idempotent "never paused"/"already resolved" case reporting `already_active`
 * rather than an error, and the real end-to-end round trip against a disk-backed
 * `FileAutoMergePauseStore`.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDispatchAutoMergeResumeHandler,
  dispatchAutoMergeResumeConfirmationPhrase,
} from "../../src/cli/dispatch/auto-merge-pause-handlers.js";
import { FileAutoMergePauseStore } from "../../src/adapters/dispatch/auto-merge-pause-store.js";
import {
  FileJobProgressStore,
  type JobProgressRecord,
  type JobProgressRecordMutation,
} from "../../src/adapters/dispatch/job-progress-store.js";
import {
  createFixedClock,
  domainError,
  parseIdentifier,
  type Identifier,
} from "../../src/domain/foundation/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-auto-merge-resume-"));
  temporaryDirectories.push(directory);
  return directory;
}

function id<Scope extends string>(scope: Scope, value: string): Identifier<Scope> {
  const parsed = parseIdentifier(scope, value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const projectId = id("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const headSha = "a".repeat(40);
const now = "2026-08-08T00:00:00.000Z" as never;

async function temporaryStore(): Promise<FileAutoMergePauseStore> {
  return new FileAutoMergePauseStore(await temporaryDirectory(), undefined, createFixedClock(now));
}

async function* stdinOf(phrase: string): AsyncIterable<string> {
  await Promise.resolve();
  yield phrase;
}

function payload(outcome: { message?: string }): unknown {
  return outcome.message === undefined ? undefined : JSON.parse(outcome.message);
}

async function* neverRead(): AsyncIterable<string> {
  await Promise.resolve();
  throw new Error("must never be read");
}

function progressPort(records: readonly JobProgressRecord[] = []): {
  port: Pick<FileJobProgressStore, "compareAndSwap" | "listForProject">;
  writes: JobProgressRecordMutation[];
} {
  const writes: JobProgressRecordMutation[] = [];
  return {
    writes,
    port: {
      listForProject: () => Promise.resolve({ ok: true, value: records }),
      compareAndSwap: (_jobId, _revision, next) => {
        writes.push(next);
        return Promise.resolve({
          ok: true,
          value: { ...next, schemaVersion: 1, revision: 1, updatedAt: now },
        } as never);
      },
    },
  };
}

function blockedRecord(reasonCode = "auto_merge_paused_out_of_process_merge"): JobProgressRecord {
  return {
    schemaVersion: 1,
    revision: 0,
    updatedAt: now,
    jobId: id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab"),
    projectId,
    issueId: id("issue", "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab"),
    externalIssueId: "linear-issue-1",
    model: "claude-opus",
    branch: "agent-team/job-1",
    worktreePath: "/tmp/job-1",
    changeRequestId: "47",
    headSha,
    baseRevision: "b".repeat(40),
    stage: {
      kind: "requires_manual",
      cause: { stage: "merge", reasonCode, attempts: { count: 1 } },
    },
  } as unknown as JobProgressRecord;
}

function recordMutation(record: JobProgressRecord): JobProgressRecordMutation {
  const {
    schemaVersion: _schemaVersion,
    revision: _revision,
    updatedAt: _updatedAt,
    ...mutation
  } = record;
  void _schemaVersion;
  void _revision;
  void _updatedAt;
  return mutation;
}

describe("createDispatchAutoMergeResumeHandler", () => {
  it("rejects a wrong confirmation phrase with zero side effects -- the pause flag is left untouched", async () => {
    const store = await temporaryStore();
    await store.pause(projectId, { changeRequestId: "1", mergedHeadSha: headSha });
    const handler = createDispatchAutoMergeResumeHandler({
      store,
      progress: progressPort().port,
      stdin: stdinOf("wrong phrase"),
    });

    const outcome = await handler({ projectId });

    expect(outcome.state).toBe("rejected");
    const loaded = await store.load(projectId);
    expect(loaded.ok && loaded.value?.status.state).toBe("paused");
  });

  it("resolves a genuinely paused project when the exact confirmation phrase is given", async () => {
    const store = await temporaryStore();
    await store.pause(projectId, { changeRequestId: "7", mergedHeadSha: headSha });
    const handler = createDispatchAutoMergeResumeHandler({
      store,
      progress: progressPort().port,
      stdin: stdinOf(dispatchAutoMergeResumeConfirmationPhrase),
    });

    const outcome = await handler({ projectId });

    expect(outcome.state).toBe("success");
    expect(payload(outcome)).toMatchObject({
      operation: "dispatch_auto_merge_resume",
      state: "resumed",
      projectId,
      pausedEvidence: { changeRequestId: "7", mergedHeadSha: headSha },
      recoveredJobCount: 0,
    });
    const loaded = await store.load(projectId);
    expect(loaded).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        revision: 1,
        projectId,
        status: { state: "active" },
        updatedAt: now,
      },
    });
  });

  it("reports already_active (not an error) when the project was never paused", async () => {
    const store = await temporaryStore();
    const handler = createDispatchAutoMergeResumeHandler({
      store,
      progress: progressPort().port,
      stdin: stdinOf(dispatchAutoMergeResumeConfirmationPhrase),
    });

    const outcome = await handler({ projectId });

    expect(outcome.state).toBe("success");
    expect(payload(outcome)).toMatchObject({
      operation: "dispatch_auto_merge_resume",
      state: "already_active",
      projectId,
    });
  });

  it("reports already_active when a concurrent resume already cleared the pause", async () => {
    const store = await temporaryStore();
    await store.pause(projectId, { changeRequestId: "1", mergedHeadSha: headSha });
    await store.resolve(projectId);
    const handler = createDispatchAutoMergeResumeHandler({
      store,
      progress: progressPort().port,
      stdin: stdinOf(dispatchAutoMergeResumeConfirmationPhrase),
    });

    const outcome = await handler({ projectId });

    expect(payload(outcome)).toMatchObject({ state: "already_active" });
  });

  it("rejects an empty --project before ever reading stdin", async () => {
    const store = await temporaryStore();
    const handler = createDispatchAutoMergeResumeHandler({
      store,
      progress: progressPort().port,
      stdin: neverRead(),
    });

    const outcome = await handler({ projectId: "" });

    expect(outcome.state).toBe("rejected");
    expect(payload(outcome)).toMatchObject({ reason: "project_id_required" });
  });

  it("recovers only the exact project-pause reason after resolving the durable pause", async () => {
    const store = await temporaryStore();
    await store.pause(projectId, { changeRequestId: "7", mergedHeadSha: headSha });
    const matching = blockedRecord();
    const unrelated = blockedRecord("review_not_approved");
    const progress = progressPort([matching, unrelated]);
    const handler = createDispatchAutoMergeResumeHandler({
      store,
      progress: progress.port,
      stdin: stdinOf(dispatchAutoMergeResumeConfirmationPhrase),
    });

    const result = await handler({ projectId });

    expect(payload(result)).toMatchObject({ state: "resumed", recoveredJobCount: 1 });
    expect(progress.writes).toHaveLength(1);
    expect(progress.writes[0]).toMatchObject({
      jobId: matching.jobId,
      projectId,
      stage: { kind: "awaiting_review" },
      changeRequestId: "47",
      headSha,
    });
  });

  it("finishes the pending Job CAS when a retry finds the project already active", async () => {
    const store = await temporaryStore();
    await store.pause(projectId, { changeRequestId: "7", mergedHeadSha: headSha });
    await store.resolve(projectId);
    const progress = progressPort([blockedRecord()]);
    const handler = createDispatchAutoMergeResumeHandler({
      store,
      progress: progress.port,
      stdin: stdinOf(dispatchAutoMergeResumeConfirmationPhrase),
    });

    const result = await handler({ projectId });

    expect(payload(result)).toMatchObject({ state: "already_active", recoveredJobCount: 1 });
    expect(progress.writes).toHaveLength(1);
  });

  it("round-trips the recovery through the real durable progress schema and CAS", async () => {
    const root = await temporaryDirectory();
    const progressDirectory = join(root, "state", "dispatch", "progress");
    await mkdir(progressDirectory, { recursive: true, mode: 0o700 });
    const store = new FileAutoMergePauseStore(root, undefined, createFixedClock(now));
    const progress = new FileJobProgressStore(progressDirectory, undefined, createFixedClock(now));
    const record = blockedRecord();
    const seeded = await progress.compareAndSwap(record.jobId, null, recordMutation(record));
    expect(seeded.ok, JSON.stringify(seeded)).toBe(true);
    await store.pause(projectId, { changeRequestId: "7", mergedHeadSha: headSha });
    const handler = createDispatchAutoMergeResumeHandler({
      store,
      progress,
      stdin: stdinOf(dispatchAutoMergeResumeConfirmationPhrase),
    });

    const result = await handler({ projectId });
    const loaded = await progress.load(record.jobId);

    expect(payload(result)).toMatchObject({ state: "resumed", recoveredJobCount: 1 });
    expect(loaded.ok && loaded.value?.stage).toEqual({ kind: "awaiting_review" });
    expect(loaded.ok && loaded.value?.revision).toBe(1);
  });

  it("fails closed after resolving the pause when progress cannot be read, so a retry can repair it", async () => {
    const store = await temporaryStore();
    await store.pause(projectId, { changeRequestId: "7", mergedHeadSha: headSha });
    const handler = createDispatchAutoMergeResumeHandler({
      store,
      progress: {
        listForProject: () =>
          Promise.resolve({ ok: false, error: domainError("external_failure") }),
        compareAndSwap: () => {
          throw new Error("must not write");
        },
      },
      stdin: stdinOf(dispatchAutoMergeResumeConfirmationPhrase),
    });

    const result = await handler({ projectId });
    const pause = await store.load(projectId);

    expect(result.state).toBe("failed");
    expect(payload(result)).toMatchObject({
      state: "blocked",
      reason: "job_progress_read_failed",
      errorCode: "external_failure",
    });
    expect(pause.ok && pause.value?.status.state).toBe("active");
  });
});
