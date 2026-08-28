import { describe, expect, it } from "vitest";

import {
  jobProgressRecordSchema,
  type JobProgressRecord,
  type JobProgressRecordMutation,
} from "../../src/adapters/dispatch/job-progress-store.js";
import {
  buildRepositoryReservationInventory,
  type ReservationProgressPort,
} from "../../src/cli/dispatch/reservation-inventory.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../src/domain/foundation/index.js";
import type { ChangeRegion } from "../../src/domain/project/index.js";

const projectId = "project_018f47d2-77a4-7cc1-8ef2-0123456789ab";
const issueId = "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab";
const repositoryId = "github:leadingtw273/agent-team";

function record(ordinal: number, overrides: Partial<JobProgressRecord> = {}): JobProgressRecord {
  const ordinalText = String(ordinal);
  return jobProgressRecordSchema.parse({
    schemaVersion: 1,
    revision: 0,
    jobId: `job_018f47d2-77a4-7cc1-8ef2-${String(ordinal).padStart(12, "0")}`,
    projectId,
    issueId,
    externalIssueId: `LEA-${ordinalText}`,
    model: "gpt-5.6-terra",
    stage: { kind: "ci_waiting" },
    branch: `feature/lea-${ordinalText}`,
    worktreePath: `/tmp/lea-${ordinalText}`,
    updatedAt: "2026-08-28T00:00:00.000Z",
    ...overrides,
  });
}

class MemoryProgress implements ReservationProgressPort {
  readonly writes: string[] = [];

  constructor(readonly records: JobProgressRecord[]) {}

  listForProject(): Promise<Result<readonly JobProgressRecord[], DomainError>> {
    return Promise.resolve(ok(this.records));
  }

  compareAndSwap(
    jobId: string,
    expectedRevision: number,
    next: JobProgressRecordMutation,
  ): Promise<Result<JobProgressRecord, DomainError>> {
    const index = this.records.findIndex((entry) => entry.jobId === jobId);
    if (index < 0 || this.records[index]?.revision !== expectedRevision) {
      return Promise.resolve(err(domainError("conflict")));
    }
    const written = jobProgressRecordSchema.parse({
      ...next,
      schemaVersion: 1,
      revision: expectedRevision + 1,
      updatedAt: "2026-08-28T00:01:00.000Z",
    });
    this.records[index] = written;
    this.writes.push(jobId);
    return Promise.resolve(ok(written));
  }
}

describe("repository reservation inventory", () => {
  it("uses frozen snapshots, excludes converged Jobs, and does not count model occupancy", async () => {
    const progress = new MemoryProgress([
      record(1, {
        admissionReservation: {
          repositoryId,
          declaredRegions: [{ path: "src/world", coverage: "subtree" }],
        },
      }),
      record(2, { stage: { kind: "completed" } }),
    ]);
    let reads = 0;

    const result = await buildRepositoryReservationInventory({
      projectId,
      repositoryId,
      progress,
      persistLegacySnapshots: true,
      readDeclaredRegions: () => {
        reads += 1;
        return Promise.resolve(ok([{ path: "src/changed-later", coverage: "subtree" }]));
      },
    });

    expect(result).toEqual(
      ok([
        {
          jobId: progress.records[0]?.jobId,
          projectId,
          repositoryId,
          stage: "ci",
          declaredRegions: [{ path: "src/world", coverage: "subtree" }],
        },
      ]),
    );
    expect(reads).toBe(0);
    expect(progress.writes).toEqual([]);
  });

  it("freezes the first successful legacy Linear read-back", async () => {
    const progress = new MemoryProgress([record(3, { stage: { kind: "awaiting_review" } })]);
    const regions: readonly ChangeRegion[] = [
      { path: "src/application/dispatch", coverage: "subtree" },
    ];

    const first = await buildRepositoryReservationInventory({
      projectId,
      repositoryId,
      progress,
      persistLegacySnapshots: true,
      readDeclaredRegions: () => Promise.resolve(ok(regions)),
    });
    const second = await buildRepositoryReservationInventory({
      projectId,
      repositoryId,
      progress,
      persistLegacySnapshots: true,
      readDeclaredRegions: () =>
        Promise.resolve(ok([{ path: "src/application/dispatch/model.ts", coverage: "exact" }])),
    });

    expect(first.ok && first.value[0]?.declaredRegions).toEqual(regions);
    expect(second.ok && second.value[0]?.declaredRegions).toEqual(regions);
    expect(progress.writes).toHaveLength(1);
  });

  it("fails closed to a whole-repository reservation and keeps dry-run mutation-free", async () => {
    const progress = new MemoryProgress([record(4)]);

    const result = await buildRepositoryReservationInventory({
      projectId,
      repositoryId,
      progress,
      persistLegacySnapshots: false,
      readDeclaredRegions: () => Promise.resolve(err(domainError("unavailable"))),
    });

    expect(result).toEqual(
      ok([
        {
          jobId: progress.records[0]?.jobId,
          projectId,
          repositoryId,
          stage: "ci",
        },
      ]),
    );
    expect(progress.writes).toEqual([]);
    expect(progress.records[0]).not.toHaveProperty("admissionReservation");
  });

  it("does not permanently freeze a whole-repository fallback after a transient read failure", async () => {
    const progress = new MemoryProgress([record(5)]);

    const result = await buildRepositoryReservationInventory({
      projectId,
      repositoryId,
      progress,
      persistLegacySnapshots: true,
      readDeclaredRegions: () => Promise.resolve(err(domainError("unavailable"))),
    });

    expect(result.ok && result.value[0]).toMatchObject({ repositoryId });
    expect(result.ok && result.value[0]).not.toHaveProperty("declaredRegions");
    expect(progress.writes).toEqual([]);
    expect(progress.records[0]).not.toHaveProperty("admissionReservation");
  });
});
