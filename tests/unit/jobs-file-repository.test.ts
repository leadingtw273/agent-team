/**
 * C015a unit tests: `FileJobRepository` (src/infrastructure/jobs/file-repository.ts) -- the
 * first production implementation of `JobRepository` (src/application/dispatch/dispatcher.ts).
 * Mirrors the existing `FileLeaseRepository` test conventions (tests/integration/file-lease-
 * repository.test.ts): real temp directory, atomic write, 0600 file mode, schema round-trip.
 */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseIdentifier,
  parseInstant,
  type Identifier,
  type Instant,
} from "../../src/domain/foundation/index.js";
import { emptyAttemptCounters, type Job } from "../../src/domain/jobs/index.js";
import { FileJobRepository } from "../../src/infrastructure/jobs/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-jobs-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

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

function job(overrides: Partial<Job> = {}): Job {
  return {
    schemaVersion: 1,
    id: id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab"),
    projectId: id("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab"),
    issueId: id("issue", "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab"),
    createdAt: now,
    watchdogExtensionGranted: false,
    attempts: emptyAttemptCounters(),
    ...overrides,
  };
}

function paths(root: string): { file: string; lock: string } {
  return { file: join(root, "jobs.json"), lock: join(root, "jobs.lock") };
}

describe("FileJobRepository", () => {
  it("creates a job, writes it 0600, and reads it back schema-valid", async () => {
    const root = await temporaryDirectory();
    const location = paths(root);
    const repository = new FileJobRepository(location.file, location.lock);

    const created = await repository.create(job());
    expect(created).toEqual({ ok: true, value: { durability: "confirmed" } });

    const all = await repository.readAll();
    expect(all).toEqual({ ok: true, value: [job()] });
    expect((await stat(location.file)).mode & 0o777).toBe(0o600);
  });

  it("rejects a duplicate job id as a conflict, never silently overwriting", async () => {
    const root = await temporaryDirectory();
    const location = paths(root);
    const repository = new FileJobRepository(location.file, location.lock);

    const first = await repository.create(job());
    expect(first.ok).toBe(true);
    const duplicate = await repository.create(
      job({ issueId: id("issue", "issue_018f47d2-77a4-7cc1-8ef2-9123456789ab") }),
    );
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.code).toBe("conflict");

    const all = await repository.readAll();
    expect(all.ok).toBe(true);
    if (all.ok) expect(all.value).toHaveLength(1);
  });

  it("accumulates multiple jobs across repeated creates", async () => {
    const root = await temporaryDirectory();
    const location = paths(root);
    const repository = new FileJobRepository(location.file, location.lock);

    await repository.create(job());
    await repository.create(
      job({
        id: id("job", "job_018f47d2-77a4-7cc1-8ef2-1123456789ab"),
        issueId: id("issue", "issue_018f47d2-77a4-7cc1-8ef2-1123456789ab"),
      }),
    );

    const all = await repository.readAll();
    expect(all.ok).toBe(true);
    if (all.ok) expect(all.value.map((entry) => entry.id)).toHaveLength(2);
  });

  it("serializes four sibling creates against the shared file without false lock conflicts", async () => {
    const root = await temporaryDirectory();
    const location = paths(root);
    const jobs = [1, 2, 3, 4].map((index) =>
      job({
        id: id("job", `job_018f47d2-77a4-7cc1-8ef2-${String(index).padStart(12, "0")}`),
        issueId: id("issue", `issue_018f47d2-77a4-7cc1-8ef2-${String(index).padStart(12, "0")}`),
      }),
    );

    const results = await Promise.all(
      jobs.map((entry) => new FileJobRepository(location.file, location.lock).create(entry)),
    );

    expect(results.every((result) => result.ok)).toBe(true);
    const updates = await Promise.all(
      jobs.map((entry, index) =>
        new FileJobRepository(location.file, location.lock).update(
          { ...entry, attempts: { ...entry.attempts, reviewRuns: 1 } },
          { idempotencyKey: `parallel-update-${String(index + 1)}` },
        ),
      ),
    );
    expect(updates.every((result) => result.ok)).toBe(true);
    const persisted = await new FileJobRepository(location.file, location.lock).readAll();
    expect(persisted.ok).toBe(true);
    if (persisted.ok) {
      expect(new Set(persisted.value.map((entry) => entry.id))).toEqual(
        new Set(jobs.map((entry) => entry.id)),
      );
      expect(persisted.value.every((entry) => entry.attempts.reviewRuns === 1)).toBe(true);
    }
  });

  it("returns an empty list, not an error, when the file has never been written", async () => {
    const root = await temporaryDirectory();
    const location = paths(root);
    const repository = new FileJobRepository(location.file, location.lock);

    await expect(repository.readAll()).resolves.toEqual({ ok: true, value: [] });
  });

  it("fails closed on a relative file path rather than resolving against cwd", async () => {
    const repository = new FileJobRepository("jobs.json", "jobs.lock");
    const result = await repository.create(job());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invariant_violation");
  });

  it("fails closed on a schema-invalid job object instead of writing it", async () => {
    const root = await temporaryDirectory();
    const location = paths(root);
    const repository = new FileJobRepository(location.file, location.lock);

    const malformed = { ...job(), watchdogExtensionGranted: "not-a-boolean" } as unknown as Job;
    const result = await repository.create(malformed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invariant_violation");
    await expect(repository.readAll()).resolves.toEqual({ ok: true, value: [] });
  });

  describe("update (C015c item 1: read-modify-write-under-lock, for pipelines that own a job's lifecycle after create)", () => {
    it("replaces the matching job in place, leaving other jobs untouched", async () => {
      const root = await temporaryDirectory();
      const location = paths(root);
      const repository = new FileJobRepository(location.file, location.lock);
      const otherJob = job({
        id: id("job", "job_018f47d2-77a4-7cc1-8ef2-1123456789ab"),
        issueId: id("issue", "issue_018f47d2-77a4-7cc1-8ef2-1123456789ab"),
      });
      await repository.create(job());
      await repository.create(otherJob);

      const updated = job({
        attempts: { ...emptyAttemptCounters(), reviewRuns: 1 },
        startedAt: now,
      });
      const result = await repository.update(updated, { idempotencyKey: "update-1" });
      expect(result).toEqual({ ok: true, value: { durability: "confirmed" } });

      const all = await repository.readAll();
      expect(all.ok).toBe(true);
      if (all.ok) {
        expect(all.value).toHaveLength(2);
        const persisted = all.value.find((entry) => entry.id === updated.id);
        expect(persisted?.attempts.reviewRuns).toBe(1);
        expect(persisted?.startedAt).toBe(now);
        expect(all.value.find((entry) => entry.id === otherJob.id)).toEqual(otherJob);
      }
    });

    it("fails closed with not_found when the job does not exist yet -- update never creates", async () => {
      const root = await temporaryDirectory();
      const location = paths(root);
      const repository = new FileJobRepository(location.file, location.lock);

      const result = await repository.update(job(), { idempotencyKey: "update-missing" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("not_found");
    });

    it("fails closed on an empty idempotencyKey", async () => {
      const root = await temporaryDirectory();
      const location = paths(root);
      const repository = new FileJobRepository(location.file, location.lock);
      await repository.create(job());

      const result = await repository.update(job(), { idempotencyKey: "" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("invariant_violation");
    });

    it("fails closed on a relative file path", async () => {
      const repository = new FileJobRepository("jobs.json", "jobs.lock");
      const result = await repository.update(job(), { idempotencyKey: "update-relative" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("invariant_violation");
    });

    it("fails closed on a schema-invalid job object instead of writing it", async () => {
      const root = await temporaryDirectory();
      const location = paths(root);
      const repository = new FileJobRepository(location.file, location.lock);
      await repository.create(job());

      const malformed = { ...job(), watchdogExtensionGranted: "nope" } as unknown as Job;
      const result = await repository.update(malformed, { idempotencyKey: "update-invalid" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("invariant_violation");
      const all = await repository.readAll();
      expect(all.ok).toBe(true);
      if (all.ok) expect(all.value).toEqual([job()]);
    });

    it.each([
      ["processRecoveries", { processRecoveries: 1 }],
      ["ciFixRounds", { ciFixRounds: 1 }],
      ["reviewerFixRounds", { reviewerFixRounds: 1 }],
      ["reviewRuns", { reviewRuns: 1 }],
    ] as const)("rejects a %s counter rollback", async (_counter, attempts) => {
      const root = await temporaryDirectory();
      const location = paths(root);
      const repository = new FileJobRepository(location.file, location.lock);
      const current = job({ attempts: { ...emptyAttemptCounters(), ...attempts } });
      await repository.create(current);

      const result = await repository.update(job(), { idempotencyKey: "rollback" });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("invariant_violation");
      await expect(repository.readAll()).resolves.toEqual({ ok: true, value: [current] });
    });

    it.each([
      ["projectId", { projectId: id("project", "project_018f47d2-77a4-7cc1-8ef2-1123456789ab") }],
      ["issueId", { issueId: id("issue", "issue_018f47d2-77a4-7cc1-8ef2-1123456789ab") }],
      ["createdAt", { createdAt: instant("2026-08-07T12:01:00.000Z") }],
    ] as const)("rejects a %s identity mutation", async (_field, override) => {
      const root = await temporaryDirectory();
      const location = paths(root);
      const repository = new FileJobRepository(location.file, location.lock);
      const current = job();
      await repository.create(current);

      const result = await repository.update(job(override), { idempotencyKey: "identity-change" });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("invariant_violation");
      await expect(repository.readAll()).resolves.toEqual({ ok: true, value: [current] });
    });
  });
});
