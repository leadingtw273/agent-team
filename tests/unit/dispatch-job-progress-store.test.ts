/**
 * C015c item 1 unit tests: `FileJobProgressStore` (src/adapters/dispatch/job-progress-store.ts) --
 * the CLI-internal, per-job CAS progress index. Covers: reserve-new-record CAS semantics
 * (expectedRevision:null), strict-revision-mismatch conflict, read-back after write, 0600 file
 * mode, listForProject filtering by projectId (not stage -- that filtering is the caller's job),
 * `changeRequestId` rejecting a non-decimal (node-id-shaped) value, and every `stage` variant
 * round-tripping through the real schema.
 */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileJobProgressStore,
  jobProgressRecordSchema,
  type JobProgressRecordMutation,
} from "../../src/adapters/dispatch/job-progress-store.js";
import {
  createFixedClock,
  parseIdentifier,
  parseInstant,
  type Identifier,
  type Instant,
} from "../../src/domain/foundation/index.js";
import { headShaSchema, type HeadSha } from "../../src/domain/review/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-job-progress-"));
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

function headSha(value: string): HeadSha {
  const parsed = headShaSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid head sha fixture");
  return parsed.data;
}

const now = instant("2026-08-07T12:00:00.000Z");
const jobId = id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const projectId = id("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const issueId = id("issue", "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab");

function baseRecord(overrides: Partial<JobProgressRecordMutation> = {}): JobProgressRecordMutation {
  return {
    jobId,
    projectId,
    issueId,
    externalIssueId: "linear-issue-1",
    model: "claude-opus",
    stage: { kind: "ci_waiting" },
    branch: "agent-team/job-018f47d2",
    worktreePath: "/tmp/sandbox-worktree",
    ...overrides,
  };
}

describe("FileJobProgressStore", () => {
  it("reserves a brand-new record with expectedRevision:null, revision starts at 0, and stamps updatedAt from the injected clock", async () => {
    const directory = await temporaryDirectory();
    const store = new FileJobProgressStore(directory, undefined, createFixedClock(now));

    const result = await store.compareAndSwap(jobId, null, baseRecord());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.revision).toBe(0);
    expect(result.value.updatedAt).toBe(now);
    expect(result.value.stage).toEqual({ kind: "ci_waiting" });

    expect((await stat(join(directory, `${jobId}.json`))).mode & 0o777).toBe(0o600);
  });

  it("rejects reserving a new record when one already exists (expectedRevision:null but present)", async () => {
    const directory = await temporaryDirectory();
    const store = new FileJobProgressStore(directory, undefined, createFixedClock(now));
    await store.compareAndSwap(jobId, null, baseRecord());

    const result = await store.compareAndSwap(jobId, null, baseRecord());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("conflict");
  });

  it("advances the revision on a matching CAS and rejects a stale expectedRevision", async () => {
    const directory = await temporaryDirectory();
    const store = new FileJobProgressStore(directory, undefined, createFixedClock(now));
    const first = await store.compareAndSwap(jobId, null, baseRecord());
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const advanced = await store.compareAndSwap(
      jobId,
      0,
      baseRecord({ stage: { kind: "awaiting_review" } }),
    );
    expect(advanced.ok).toBe(true);
    if (advanced.ok) {
      expect(advanced.value.revision).toBe(1);
      expect(advanced.value.stage).toEqual({ kind: "awaiting_review" });
    }

    const stale = await store.compareAndSwap(jobId, 0, baseRecord({ stage: { kind: "merging" } }));
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("conflict");
  });

  it("load returns undefined (not an error) for a job with no record yet", async () => {
    const directory = await temporaryDirectory();
    const store = new FileJobProgressStore(directory);
    await expect(store.load(jobId)).resolves.toEqual({ ok: true, value: undefined });
  });

  it("load reads back exactly what compareAndSwap wrote", async () => {
    const directory = await temporaryDirectory();
    const store = new FileJobProgressStore(directory, undefined, createFixedClock(now));
    await store.compareAndSwap(
      jobId,
      null,
      baseRecord({ changeRequestId: "42", headSha: headSha("a".repeat(40)) }),
    );
    const loaded = await store.load(jobId);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value?.changeRequestId).toBe("42");
      expect(loaded.value?.headSha).toBe("a".repeat(40));
    }
  });

  it("rejects a changeRequestId shaped like a GitHub node id instead of a decimal PR number (O009c)", () => {
    const parsed = jobProgressRecordSchema.safeParse({
      schemaVersion: 1,
      revision: 0,
      ...baseRecord({ changeRequestId: "PR_kwDOTvUUF877drQL" }),
      updatedAt: now,
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts every stage variant, including paused with a checkpointId reference", () => {
    const checkpointId = "checkpoint_018f47d2-77a4-7cc1-8ef2-0123456789ab";
    const otherJobId = "job_018f47d2-77a4-7cc1-8ef2-1123456789ab";
    const stages = [
      { kind: "implementing" as const },
      { kind: "ci_waiting" as const },
      { kind: "awaiting_review" as const },
      { kind: "fix_round" as const },
      { kind: "merging" as const },
      { kind: "completed" as const },
      { kind: "failed" as const },
      { kind: "paused" as const, checkpointId },
      // C015r decision 1: `cause` stays optional -- a bare pre-C015r record must still parse.
      { kind: "requires_manual" as const },
      {
        kind: "requires_manual" as const,
        cause: {
          stage: "review" as const,
          reasonCode: "review_report_contract" as const,
          attempts: { count: 2, lastCategory: "enum_mismatch" as const },
        },
      },
      // C015o decision 2: retryable-provider-failure resumable stages.
      { kind: "review_pending_retry" as const, retries: 1, lastErrorCode: "timeout" },
      { kind: "ci_pending_retry" as const, retries: 0, lastErrorCode: "unavailable" },
      // C015o decision 4: explicit, human-issued terminal verdicts.
      { kind: "superseded" as const, supersededByJobId: otherJobId },
      { kind: "cancelled" as const },
      // C015r decision 4: dedicated, separately-capped report-contract retry stage.
      {
        kind: "review_report_pending_retry" as const,
        retries: 1,
        lastCategory: "preamble_or_trailing_content" as const,
      },
    ];
    for (const stage of stages) {
      // Deliberately not routed through `baseRecord()` here: this test exercises runtime schema
      // acceptance of every `stage` shape (including the loosely-typed loop variable above), not
      // the store's own compile-time-branded CAS typing -- `safeParse` takes `unknown`.
      const parsed = jobProgressRecordSchema.safeParse({
        schemaVersion: 1,
        revision: 0,
        jobId,
        projectId,
        issueId,
        externalIssueId: "linear-issue-1",
        model: "claude-opus",
        branch: "agent-team/job-018f47d2",
        worktreePath: "/tmp/sandbox-worktree",
        stage,
        updatedAt: now,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("listForProject returns every record for that project regardless of stage, and none for another project", async () => {
    const directory = await temporaryDirectory();
    const store = new FileJobProgressStore(directory, undefined, createFixedClock(now));
    const otherJobId = id("job", "job_018f47d2-77a4-7cc1-8ef2-1123456789ab");
    const otherProjectId = id("project", "project_018f47d2-77a4-7cc1-8ef2-1123456789ab");
    await store.compareAndSwap(jobId, null, baseRecord({ stage: { kind: "ci_waiting" } }));
    await store.compareAndSwap(
      otherJobId,
      null,
      baseRecord({ jobId: otherJobId, projectId: otherProjectId, stage: { kind: "failed" } }),
    );

    const forProject = await store.listForProject(projectId);
    expect(forProject.ok).toBe(true);
    if (forProject.ok) {
      expect(forProject.value.map((record) => record.jobId)).toEqual([jobId]);
    }

    // The other project's own job is correctly included when queried by its own id...
    const forOtherProject = await store.listForProject(otherProjectId);
    expect(forOtherProject.ok).toBe(true);
    if (forOtherProject.ok) {
      expect(forOtherProject.value.map((record) => record.jobId)).toEqual([otherJobId]);
    }

    // ...but a genuinely unrelated third project sees neither.
    const unrelatedProjectId = "project_018f47d2-77a4-7cc1-8ef2-2123456789ab";
    const forUnrelatedProject = await store.listForProject(unrelatedProjectId);
    expect(forUnrelatedProject.ok).toBe(true);
    if (forUnrelatedProject.ok) expect(forUnrelatedProject.value).toHaveLength(0);
  });

  it("listForProject returns an empty array (not an error) when the directory has never been created", async () => {
    const directory = await temporaryDirectory();
    const store = new FileJobProgressStore(join(directory, "never-created"));
    await expect(store.listForProject(projectId)).resolves.toEqual({ ok: true, value: [] });
  });

  it("fails closed on a relative directory path", () => {
    expect(() => new FileJobProgressStore("relative/path")).toThrow();
  });
});
