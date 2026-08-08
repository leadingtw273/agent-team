/**
 * E116cap unit tests: `createDispatchAutoMergeResumeHandler`
 * (src/cli/dispatch/auto-merge-pause-handlers.ts) -- the human-issued escape hatch out of a
 * project-level auto-merge pause. Mirrors dispatch-resolve-handlers.test.ts's own confirmation-
 * phrase discipline: a wrong/mismatched phrase must be zero side effect (no store write at all).
 * Also covers the idempotent "never paused"/"already resolved" case reporting `already_active`
 * rather than an error, and the real end-to-end round trip against a disk-backed
 * `FileAutoMergePauseStore`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDispatchAutoMergeResumeHandler,
  dispatchAutoMergeResumeConfirmationPhrase,
} from "../../src/cli/dispatch/auto-merge-pause-handlers.js";
import { FileAutoMergePauseStore } from "../../src/adapters/dispatch/auto-merge-pause-store.js";
import {
  createFixedClock,
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

describe("createDispatchAutoMergeResumeHandler", () => {
  it("rejects a wrong confirmation phrase with zero side effects -- the pause flag is left untouched", async () => {
    const store = await temporaryStore();
    await store.pause(projectId, { changeRequestId: "1", mergedHeadSha: headSha });
    const handler = createDispatchAutoMergeResumeHandler({
      store,
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
      stdin: stdinOf(dispatchAutoMergeResumeConfirmationPhrase),
    });

    const outcome = await handler({ projectId });

    expect(outcome.state).toBe("success");
    expect(payload(outcome)).toMatchObject({
      operation: "dispatch_auto_merge_resume",
      state: "resumed",
      projectId,
      pausedEvidence: { changeRequestId: "7", mergedHeadSha: headSha },
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
      stdin: stdinOf(dispatchAutoMergeResumeConfirmationPhrase),
    });

    const outcome = await handler({ projectId });

    expect(payload(outcome)).toMatchObject({ state: "already_active" });
  });

  it("rejects an empty --project before ever reading stdin", async () => {
    const store = await temporaryStore();
    const handler = createDispatchAutoMergeResumeHandler({ store, stdin: neverRead() });

    const outcome = await handler({ projectId: "" });

    expect(outcome.state).toBe("rejected");
    expect(payload(outcome)).toMatchObject({ reason: "project_id_required" });
  });
});
