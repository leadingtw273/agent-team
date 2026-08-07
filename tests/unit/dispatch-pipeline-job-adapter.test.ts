/**
 * C015c items 3/3b unit test: `FileJobUpdateAdapter` (src/cli/dispatch/pipeline-job-adapter.ts) --
 * a thin delegation to `FileJobRepository.update` (C015c item 1), satisfying both
 * `ReviewerJobPort` and `CiRecoveryJobPort` (structurally identical). Against a real temp-file
 * repository, not a mock, since the delegation itself is the only thing to prove.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileJobUpdateAdapter } from "../../src/cli/dispatch/pipeline-job-adapter.js";
import {
  parseIdentifier,
  parseInstant,
  type Identifier,
  type Instant,
} from "../../src/domain/foundation/index.js";
import { emptyAttemptCounters, type Job } from "../../src/domain/jobs/index.js";
import { FileJobRepository } from "../../src/infrastructure/jobs/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-pipeline-job-adapter-"));
  temporaryDirectories.push(directory);
  return directory;
}

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

describe("FileJobUpdateAdapter", () => {
  it("delegates to FileJobRepository.update and reads back the mutation", async () => {
    const root = await temporaryDirectory();
    const repository = new FileJobRepository(join(root, "jobs.json"), join(root, "jobs.lock"));
    await repository.create(job());
    const adapter = new FileJobUpdateAdapter(repository);

    const updated = job({ attempts: { ...emptyAttemptCounters(), reviewRuns: 2 } });
    const result = await adapter.update(updated, { idempotencyKey: "update-1" });
    expect(result).toEqual({ ok: true, value: { durability: "confirmed" } });

    const all = await repository.readAll();
    expect(all.ok).toBe(true);
    if (all.ok) expect(all.value[0]?.attempts.reviewRuns).toBe(2);
  });

  it("propagates not_found when the job does not exist yet", async () => {
    const root = await temporaryDirectory();
    const repository = new FileJobRepository(join(root, "jobs.json"), join(root, "jobs.lock"));
    const adapter = new FileJobUpdateAdapter(repository);

    const result = await adapter.update(job(), { idempotencyKey: "update-missing" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});
