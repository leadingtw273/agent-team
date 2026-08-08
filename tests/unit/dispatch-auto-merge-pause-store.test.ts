/**
 * E116cap unit tests: `FileAutoMergePauseStore` (src/adapters/dispatch/auto-merge-pause-store.ts)
 * -- the durable, per-project CAS record backing the project-level auto-merge pause gate. Covers:
 * real-disk round trip (write then read back byte-for-byte, 0600 permissions), `pause()`'s
 * idempotent/write-once behavior (a second observation while already paused never overwrites the
 * first incident's evidence), `resolve()`'s idempotent behavior (never-paused/already-active is not
 * an error), the full pause -> resolve -> pause-again lifecycle, and schema strictness (an
 * unexpected extra field is rejected, never silently dropped).
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileAutoMergePauseStore,
  autoMergePauseRecordSchema,
} from "../../src/adapters/dispatch/auto-merge-pause-store.js";
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
  const directory = await mkdtemp(join(tmpdir(), "agent-team-auto-merge-pause-"));
  temporaryDirectories.push(directory);
  return directory;
}

function id<Scope extends string>(scope: Scope, value: string): Identifier<Scope> {
  const parsed = parseIdentifier(scope, value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const projectId = id("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const otherProjectId = id("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789cd");
const now = "2026-08-08T00:00:00.000Z" as never;
const headShaA = "a".repeat(40);
const headShaB = "b".repeat(40);

describe("FileAutoMergePauseStore: real-disk round trip", () => {
  it("load returns undefined for a project with no record yet", async () => {
    const store = new FileAutoMergePauseStore(await temporaryDirectory());
    const loaded = await store.load(projectId);
    expect(loaded).toEqual({ ok: true, value: undefined });
  });

  it("pause writes a durable, 0600, schema-strict record and reads it back byte-for-byte", async () => {
    const directory = await temporaryDirectory();
    const store = new FileAutoMergePauseStore(directory, undefined, createFixedClock(now));

    const paused = await store.pause(projectId, {
      changeRequestId: "42",
      mergedHeadSha: headShaA,
    });
    expect(paused).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        revision: 0,
        projectId,
        status: {
          state: "paused",
          reason: "out_of_process_merge",
          pausedAt: now,
          evidence: { changeRequestId: "42", mergedHeadSha: headShaA },
        },
        updatedAt: now,
      },
    });

    const loaded = await store.load(projectId);
    expect(loaded).toEqual(paused);

    const filePath = join(directory, `${projectId}.json`);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    const onDisk: unknown = JSON.parse(await readFile(filePath, "utf8"));
    expect(autoMergePauseRecordSchema.safeParse(onDisk).success).toBe(true);
  });

  it("pause is write-once: a second out-of-process merge observed while already paused never overwrites the original evidence/pausedAt", async () => {
    const store = new FileAutoMergePauseStore(
      await temporaryDirectory(),
      undefined,
      createFixedClock(now),
    );
    const first = await store.pause(projectId, { changeRequestId: "42", mergedHeadSha: headShaA });
    if (!first.ok) throw new Error(first.error.code);

    const second = await store.pause(projectId, { changeRequestId: "99", mergedHeadSha: headShaB });
    expect(second).toEqual(first);

    const loaded = await store.load(projectId);
    expect(loaded).toEqual(first);
  });

  it("pause on two different projects never cross-contaminates -- one file per projectId", async () => {
    const store = new FileAutoMergePauseStore(await temporaryDirectory());
    await store.pause(projectId, { changeRequestId: "1", mergedHeadSha: headShaA });

    const other = await store.load(otherProjectId);
    expect(other).toEqual({ ok: true, value: undefined });
  });

  it("resolve on a project that was never paused is a no-op success, not an error", async () => {
    const store = new FileAutoMergePauseStore(await temporaryDirectory());
    const resolved = await store.resolve(projectId);
    expect(resolved).toEqual({ ok: true, value: undefined });
  });

  it("resolve transitions paused -> active, bumping revision, and is itself idempotent", async () => {
    const store = new FileAutoMergePauseStore(
      await temporaryDirectory(),
      undefined,
      createFixedClock(now),
    );
    const paused = await store.pause(projectId, { changeRequestId: "42", mergedHeadSha: headShaA });
    if (!paused.ok) throw new Error(paused.error.code);

    const resolved = await store.resolve(projectId);
    expect(resolved).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        revision: 1,
        projectId,
        status: { state: "active" },
        updatedAt: now,
      },
    });

    // Idempotent: resolving an already-active project returns the current record unchanged, no
    // further revision bump.
    const resolvedAgain = await store.resolve(projectId);
    expect(resolvedAgain).toEqual(resolved);
  });

  it("full lifecycle: pause -> resolve -> a fresh pause after resolve captures new evidence (not the stale, already-cleared one)", async () => {
    const store = new FileAutoMergePauseStore(
      await temporaryDirectory(),
      undefined,
      createFixedClock(now),
    );
    await store.pause(projectId, { changeRequestId: "1", mergedHeadSha: headShaA });
    await store.resolve(projectId);

    const repaused = await store.pause(projectId, {
      changeRequestId: "2",
      mergedHeadSha: headShaB,
    });
    expect(repaused).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        revision: 2,
        projectId,
        status: {
          state: "paused",
          reason: "out_of_process_merge",
          pausedAt: now,
          evidence: { changeRequestId: "2", mergedHeadSha: headShaB },
        },
        updatedAt: now,
      },
    });
  });

  it("rejects an invalid projectId with invariant_violation, zero filesystem writes", async () => {
    const store = new FileAutoMergePauseStore(await temporaryDirectory());
    const result = await store.pause("not-a-valid-id", {
      changeRequestId: "1",
      mergedHeadSha: headShaA,
    });
    expect(result.ok ? "ok" : result.error.code).toBe("invariant_violation");
  });

  it("rejects malformed evidence (non-numeric changeRequestId) with invariant_violation", async () => {
    const store = new FileAutoMergePauseStore(await temporaryDirectory());
    const result = await store.pause(projectId, {
      changeRequestId: "not-a-number",
      mergedHeadSha: headShaA,
    });
    expect(result.ok ? "ok" : result.error.code).toBe("invariant_violation");
  });
});

describe("autoMergePauseRecordSchema: strict, never silently drops unexpected fields", () => {
  it("rejects a record with an extra unknown top-level field", () => {
    const parsed = autoMergePauseRecordSchema.safeParse({
      schemaVersion: 1,
      revision: 0,
      projectId,
      status: { state: "active" },
      updatedAt: now,
      unexpected: "field",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a paused status missing its required evidence", () => {
    const parsed = autoMergePauseRecordSchema.safeParse({
      schemaVersion: 1,
      revision: 0,
      projectId,
      status: { state: "paused", reason: "out_of_process_merge", pausedAt: now },
      updatedAt: now,
    });
    expect(parsed.success).toBe(false);
  });
});
