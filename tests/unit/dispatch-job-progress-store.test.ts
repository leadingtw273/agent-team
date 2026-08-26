/**
 * C015c item 1 unit tests: `FileJobProgressStore` (src/adapters/dispatch/job-progress-store.ts) --
 * the CLI-internal, per-job CAS progress index. Covers: reserve-new-record CAS semantics
 * (expectedRevision:null), strict-revision-mismatch conflict, read-back after write, 0600 file
 * mode, listForProject filtering by projectId (not stage -- that filtering is the caller's job),
 * `changeRequestId` rejecting a non-decimal (node-id-shaped) value, and every `stage` variant
 * round-tripping through the real schema.
 */
import { mkdtemp, rm, stat, symlink } from "node:fs/promises";
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

const skillSnapshots = {
  implementer: {
    schemaVersion: 1 as const,
    jobId,
    projectId,
    skills: [
      {
        name: "godot-testing-patterns",
        displayName: "Godot 測試模式",
        mode: "knowledge_only" as const,
        source: {
          repository: "https://github.com/example/skills",
          commit: "a".repeat(40),
          path: "skills/godot-testing-patterns",
          treeDigest: "1".repeat(64),
        },
        installedTreeDigest: "2".repeat(64),
        fileDigests: { "SKILL.md": "3".repeat(64) },
        allowedReferences: [],
        requirement: "optional" as const,
      },
    ],
    omitted: [],
  },
};

function baseRecord(overrides: Partial<JobProgressRecordMutation> = {}): JobProgressRecordMutation {
  return {
    jobId,
    projectId,
    issueId,
    externalIssueId: "linear-issue-1",
    model: "gpt-5.6-terra",
    providerAssignments: {
      execution: { provider: "codex", model: "gpt-5.6-terra" },
      codeReview: { provider: "claude", model: "claude-opus" },
    },
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
      expect(loaded.value?.providerAssignments).toEqual({
        execution: { provider: "codex", model: "gpt-5.6-terra" },
        codeReview: { provider: "claude", model: "claude-opus" },
      });
    }
  });

  it("preserves provider assignments across a fresh store instance and rejects later changes or removal", async () => {
    const directory = await temporaryDirectory();
    const writer = new FileJobProgressStore(directory, undefined, createFixedClock(now));
    const first = await writer.compareAndSwap(jobId, null, baseRecord());
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const reader = new FileJobProgressStore(directory, undefined, createFixedClock(now));
    await expect(reader.load(jobId)).resolves.toMatchObject({
      ok: true,
      value: {
        providerAssignments: {
          execution: { provider: "codex", model: "gpt-5.6-terra" },
          codeReview: { provider: "claude", model: "claude-opus" },
        },
      },
    });

    const changed = await reader.compareAndSwap(
      jobId,
      first.value.revision,
      baseRecord({
        providerAssignments: {
          execution: { provider: "codex", model: "gpt-5.6-sol" },
          codeReview: { provider: "claude", model: "claude-opus" },
        },
      }),
    );
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.error.code).toBe("invariant_violation");

    const { providerAssignments, ...withoutAssignments } = baseRecord();
    void providerAssignments;
    const removed = await reader.compareAndSwap(jobId, first.value.revision, withoutAssignments);
    expect(removed.ok).toBe(false);
    if (!removed.ok) expect(removed.error.code).toBe("invariant_violation");
  });

  it("persists the per-role Skill snapshot once and rejects later change or removal", async () => {
    const directory = await temporaryDirectory();
    const store = new FileJobProgressStore(directory, undefined, createFixedClock(now));
    const first = await store.compareAndSwap(jobId, null, baseRecord({ skillSnapshots }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const originalSkill = skillSnapshots.implementer.skills[0];
    if (originalSkill === undefined) throw new Error("missing Skill fixture");

    const changed = await store.compareAndSwap(
      jobId,
      first.value.revision,
      baseRecord({
        skillSnapshots: {
          implementer: {
            ...skillSnapshots.implementer,
            skills: [
              {
                ...originalSkill,
                installedTreeDigest: "4".repeat(64),
              },
            ],
          },
        },
      }),
    );
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.error.code).toBe("invariant_violation");

    const removed = await store.compareAndSwap(jobId, first.value.revision, baseRecord());
    expect(removed.ok).toBe(false);
    if (!removed.ok) expect(removed.error.code).toBe("invariant_violation");
  });

  it("rejects a Skill snapshot bound to another Job identity", () => {
    expect(
      jobProgressRecordSchema.safeParse({
        schemaVersion: 1,
        revision: 0,
        updatedAt: now,
        ...baseRecord({
          skillSnapshots: {
            implementer: {
              ...skillSnapshots.implementer,
              jobId: id("job", "job_018f47d2-77a4-7cc1-8ef2-1123456789ab"),
            },
          },
        }),
      }).success,
    ).toBe(false);
  });

  it("keeps the approved human-delivery snapshot immutable and attaches one acceptance identity", async () => {
    const directory = await temporaryDirectory();
    const store = new FileJobProgressStore(directory, undefined, createFixedClock(now));
    const humanDelivery = {
      acceptanceRequirement: "required" as const,
      verificationLevel: "light" as const,
      requirementDigest: "a".repeat(64),
      humanSummaryDigest: "b".repeat(64),
    };
    const first = await store.compareAndSwap(jobId, null, baseRecord({ humanDelivery }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const attached = await store.compareAndSwap(
      jobId,
      first.value.revision,
      baseRecord({
        humanDelivery: { ...humanDelivery, acceptanceIdentityDigest: "c".repeat(64) },
      }),
    );
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;

    const changedPolicy = await store.compareAndSwap(
      jobId,
      attached.value.revision,
      baseRecord({
        humanDelivery: {
          ...humanDelivery,
          acceptanceRequirement: "not_required",
          acceptanceIdentityDigest: "c".repeat(64),
        },
      }),
    );
    expect(changedPolicy.ok).toBe(false);
    if (!changedPolicy.ok) expect(changedPolicy.error.code).toBe("invariant_violation");

    const changedIdentity = await store.compareAndSwap(
      jobId,
      attached.value.revision,
      baseRecord({
        humanDelivery: { ...humanDelivery, acceptanceIdentityDigest: "d".repeat(64) },
      }),
    );
    expect(changedIdentity.ok).toBe(false);
    if (!changedIdentity.ok) expect(changedIdentity.error.code).toBe("invariant_violation");
  });

  it("does not silently migrate a legacy Job by attaching a human-delivery policy later", async () => {
    const directory = await temporaryDirectory();
    const store = new FileJobProgressStore(directory, undefined, createFixedClock(now));
    const first = await store.compareAndSwap(jobId, null, baseRecord());
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const migrated = await store.compareAndSwap(
      jobId,
      first.value.revision,
      baseRecord({
        humanDelivery: {
          acceptanceRequirement: "required",
          verificationLevel: "standard",
          requirementDigest: "a".repeat(64),
          humanSummaryDigest: "b".repeat(64),
        },
      }),
    );

    expect(migrated.ok).toBe(false);
    if (!migrated.ok) expect(migrated.error.code).toBe("invariant_violation");
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
      {
        kind: "implementing" as const,
        executionEpoch: { ordinal: 1, providerOutput: "none" as const, startedAt: now },
      },
      { kind: "work_start_pending" as const },
      { kind: "ci_waiting" as const },
      { kind: "awaiting_review" as const },
      { kind: "fix_round" as const },
      { kind: "merging" as const },
      { kind: "completed" as const },
      { kind: "failed" as const },
      { kind: "paused" as const, checkpointId },
      // C016 fix: `checkpointId` is now optional (`ImplementerPipelineOutcome`'s own `paused`
      // outcome may have no checkpoint at all) and `pauseReason` is a new optional field --
      // every combination must still parse, including the bare pre-C016 shape above.
      { kind: "paused" as const },
      { kind: "paused" as const, pauseReason: "scope_overrun" as const },
      { kind: "paused" as const, checkpointId, pauseReason: "no_changes" as const },
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

  describe("C016: paused stage carries pauseReason, checkpointId genuinely optional", () => {
    it("round-trips a paused stage with both checkpointId and pauseReason through a real compareAndSwap/load", async () => {
      const directory = await temporaryDirectory();
      const store = new FileJobProgressStore(directory, undefined, createFixedClock(now));
      const checkpointId = id("checkpoint", "checkpoint_018f47d2-77a4-7cc1-8ef2-0123456789ab");
      await store.compareAndSwap(
        jobId,
        null,
        baseRecord({ stage: { kind: "paused", checkpointId, pauseReason: "scope_overrun" } }),
      );
      const loaded = await store.load(jobId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.value?.stage).toEqual({
          kind: "paused",
          checkpointId,
          pauseReason: "scope_overrun",
        });
      }
    });

    it("round-trips a paused stage with pauseReason but no checkpointId at all -- the exact shape ImplementerPipelineOutcome's own `provider_interrupted`/`no_changes`/`safety_approval_required` reasons produce", async () => {
      const directory = await temporaryDirectory();
      const store = new FileJobProgressStore(directory, undefined, createFixedClock(now));
      await store.compareAndSwap(
        jobId,
        null,
        baseRecord({ stage: { kind: "paused", pauseReason: "provider_interrupted" } }),
      );
      const loaded = await store.load(jobId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.value?.stage).toEqual({
          kind: "paused",
          pauseReason: "provider_interrupted",
        });
      }
    });

    it("still round-trips a pre-C016 paused record shape -- checkpointId only, no pauseReason at all", async () => {
      const directory = await temporaryDirectory();
      const store = new FileJobProgressStore(directory, undefined, createFixedClock(now));
      const checkpointId = id("checkpoint", "checkpoint_018f47d2-77a4-7cc1-8ef2-0123456789ab");
      await store.compareAndSwap(
        jobId,
        null,
        baseRecord({ stage: { kind: "paused", checkpointId } }),
      );
      const loaded = await store.load(jobId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) expect(loaded.value?.stage).toEqual({ kind: "paused", checkpointId });
    });
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

  it("listAll reads every project in one deterministic global snapshot", async () => {
    const directory = await temporaryDirectory();
    const store = new FileJobProgressStore(directory, undefined, createFixedClock(now));
    const otherJobId = id("job", "job_018f47d2-77a4-7cc1-8ef2-1123456789ab");
    const otherProjectId = id("project", "project_018f47d2-77a4-7cc1-8ef2-1123456789ab");
    await store.compareAndSwap(
      otherJobId,
      null,
      baseRecord({ jobId: otherJobId, projectId: otherProjectId, stage: { kind: "completed" } }),
    );
    await store.compareAndSwap(jobId, null, baseRecord({ stage: { kind: "ci_waiting" } }));

    const all = await store.listAll();
    expect(all.ok).toBe(true);
    if (all.ok) {
      expect(all.value.map((record) => record.jobId)).toEqual([jobId, otherJobId]);
      expect(all.value.map((record) => record.projectId)).toEqual([projectId, otherProjectId]);
    }
  });

  it("listAll returns an empty array when the progress directory does not exist", async () => {
    const directory = await temporaryDirectory();
    const store = new FileJobProgressStore(join(directory, "never-created"));
    await expect(store.listAll()).resolves.toEqual({ ok: true, value: [] });
  });

  it("fails closed when an entry discovered by the directory scan disappears before read-back", async () => {
    const directory = await temporaryDirectory();
    await symlink(join(directory, "missing-target.json"), join(directory, `${jobId}.json`));
    const result = await new FileJobProgressStore(directory).listAll();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("external_failure");
  });

  it("fails closed on a relative directory path", () => {
    expect(() => new FileJobProgressStore("relative/path")).toThrow();
  });

  /**
   * C015z decision (P0-5): `baseRevision`'s own field header (this file) documents write-once
   * immutability as an invariant this store enforces directly, at `#compareAndSwapLocked` -- not
   * merely a convention every caller has to remember (which is exactly the shape of bug class
   * C015y/C015z's `resolveLegacyBaseRevision` history demonstrated: nothing at the store layer
   * would have stopped a future caller from silently overwriting or dropping an already-persisted
   * value). These four tests exercise that mechanism directly, independent of any CLI-layer caller.
   */
  describe("baseRevision write-once immutability (C015z decision P0-5)", () => {
    it("a mutation that attempts to change an already-persisted baseRevision is rejected, fail-closed, leaving the record untouched", async () => {
      const directory = await temporaryDirectory();
      const store = new FileJobProgressStore(directory, undefined, createFixedClock(now));
      const original = headSha("a".repeat(40));
      const created = await store.compareAndSwap(
        jobId,
        null,
        baseRecord({ baseRevision: original }),
      );
      expect(created.ok).toBe(true);

      const changed = await store.compareAndSwap(
        jobId,
        0,
        baseRecord({ baseRevision: headSha("b".repeat(40)), stage: { kind: "awaiting_review" } }),
      );
      expect(changed.ok).toBe(false);
      if (!changed.ok) expect(changed.error.code).toBe("invariant_violation");

      const reloaded = await store.load(jobId);
      expect(reloaded.ok).toBe(true);
      if (reloaded.ok) {
        expect(reloaded.value?.baseRevision).toBe(original);
        expect(reloaded.value?.revision).toBe(0);
        expect(reloaded.value?.stage).toEqual({ kind: "ci_waiting" });
      }
    });

    it("a mutation that omits a previously-persisted baseRevision is rejected, not silently dropped", async () => {
      const directory = await temporaryDirectory();
      const store = new FileJobProgressStore(directory, undefined, createFixedClock(now));
      const original = headSha("a".repeat(40));
      await store.compareAndSwap(jobId, null, baseRecord({ baseRevision: original }));

      const dropped = await store.compareAndSwap(
        jobId,
        0,
        baseRecord({ stage: { kind: "awaiting_review" } }), // no `baseRevision` at all
      );
      expect(dropped.ok).toBe(false);
      if (!dropped.ok) expect(dropped.error.code).toBe("invariant_violation");

      const reloaded = await store.load(jobId);
      expect(reloaded.ok).toBe(true);
      if (reloaded.ok) {
        expect(reloaded.value?.baseRevision).toBe(original);
        expect(reloaded.value?.stage).toEqual({ kind: "ci_waiting" });
      }
    });

    it("a mutation that repeats the exact same baseRevision (the normal case -- every real caller carries it forward unchanged) is accepted", async () => {
      const directory = await temporaryDirectory();
      const store = new FileJobProgressStore(directory, undefined, createFixedClock(now));
      const original = headSha("a".repeat(40));
      await store.compareAndSwap(jobId, null, baseRecord({ baseRevision: original }));

      const advanced = await store.compareAndSwap(
        jobId,
        0,
        baseRecord({ baseRevision: original, stage: { kind: "awaiting_review" } }),
      );
      expect(advanced.ok).toBe(true);
      if (advanced.ok) {
        expect(advanced.value.baseRevision).toBe(original);
        expect(advanced.value.stage).toEqual({ kind: "awaiting_review" });
      }
    });

    it("a legacy record with no baseRevision yet is unaffected by this invariant -- one can still be established for the first time", async () => {
      const directory = await temporaryDirectory();
      const store = new FileJobProgressStore(directory, undefined, createFixedClock(now));
      await store.compareAndSwap(jobId, null, baseRecord()); // no baseRevision

      const written = await store.compareAndSwap(
        jobId,
        0,
        baseRecord({ baseRevision: headSha("c".repeat(40)) }),
      );
      expect(written.ok).toBe(true);
      if (written.ok) expect(written.value.baseRevision).toBe("c".repeat(40));
    });
  });

  describe("LWS01 work-status lifecycle checkpoint invariants", () => {
    const transition = {
      step: "work_start" as const,
      instance: "b".repeat(64),
      mainTarget: "in_progress" as const,
      agentTarget: { kind: "set" as const, status: "executing" as const },
      main: { state: "intent" as const, idempotencyKey: "work-status:main" },
      agent: { state: "intent" as const, idempotencyKey: "work-status:agent" },
      mainFailures: { count: 0 },
      agentFailures: { count: 0 },
    };
    const lifecycle = {
      admissionMode: "enforce" as const,
      capabilityDigest: "a".repeat(64),
      phase: "work_start" as const,
      transitions: [transition],
    };

    it("keeps legacy records readable while new work_start_pending records carry a strict checkpoint", async () => {
      const directory = await temporaryDirectory();
      const store = new FileJobProgressStore(directory, undefined, createFixedClock(now));
      const legacy = await store.compareAndSwap(jobId, null, baseRecord());
      expect(legacy.ok && legacy.value.workStatusLifecycle === undefined).toBe(true);

      const otherJobId = id("job", "job_018f47d2-77a4-7cc1-8ef2-1123456789ab");
      const created = await store.compareAndSwap(
        otherJobId,
        null,
        baseRecord({
          jobId: otherJobId,
          stage: { kind: "work_start_pending" },
          workStatusLifecycle: lifecycle,
        }),
      );
      expect(created.ok ? created.value.workStatusLifecycle : created.error.code).toEqual(
        lifecycle,
      );
    });

    it("makes admission identity and confirmed receipts immutable", async () => {
      const store = new FileJobProgressStore(
        await temporaryDirectory(),
        undefined,
        createFixedClock(now),
      );
      const created = await store.compareAndSwap(
        jobId,
        null,
        baseRecord({ stage: { kind: "work_start_pending" }, workStatusLifecycle: lifecycle }),
      );
      if (!created.ok) throw new Error(created.error.code);
      const confirmedTransition = {
        ...transition,
        main: {
          state: "confirmed" as const,
          idempotencyKey: "work-status:main",
          confirmedAt: now,
          observedRevision: "linear-revision-1",
        },
        mainFailures: { count: 0 },
      };
      const confirmed = await store.compareAndSwap(
        jobId,
        created.value.revision,
        baseRecord({
          stage: { kind: "work_start_pending" },
          workStatusLifecycle: { ...lifecycle, transitions: [confirmedTransition] },
        }),
      );
      expect(confirmed.ok).toBe(true);
      if (!confirmed.ok) return;

      for (const changedLifecycle of [
        { ...lifecycle, admissionMode: "observe" as const, transitions: [confirmedTransition] },
        { ...lifecycle, capabilityDigest: "c".repeat(64), transitions: [confirmedTransition] },
        {
          ...lifecycle,
          transitions: [
            {
              ...confirmedTransition,
              main: { ...confirmedTransition.main, observedRevision: "forged" },
            },
          ],
        },
        { ...lifecycle, transitions: [] },
      ]) {
        const rejected = await store.compareAndSwap(
          jobId,
          confirmed.value.revision,
          baseRecord({
            stage: { kind: "implementing" },
            workStatusLifecycle: changedLifecycle,
          }),
        );
        expect(rejected.ok ? "ok" : rejected.error.code).toBe("invariant_violation");
      }
    });

    it("keeps sent_unknown immutable even when a caller claims authoritative confirmation", async () => {
      const store = new FileJobProgressStore(
        await temporaryDirectory(),
        undefined,
        createFixedClock(now),
      );
      const unknown = {
        ...transition,
        main: {
          state: "sent_unknown" as const,
          idempotencyKey: "work-status:main",
          errorCode: "timeout",
        },
        mainFailures: { count: 1, lastErrorCode: "timeout" },
      };
      const created = await store.compareAndSwap(
        jobId,
        null,
        baseRecord({
          stage: { kind: "work_start_pending" },
          workStatusLifecycle: { ...lifecycle, transitions: [unknown] },
        }),
      );
      if (!created.ok) throw new Error(created.error.code);
      const settled = await store.compareAndSwap(
        jobId,
        created.value.revision,
        baseRecord({
          stage: { kind: "implementing", executionEpoch: { ordinal: 1, providerOutput: "none" } },
          workStatusLifecycle: {
            ...lifecycle,
            phase: "implementing",
            transitions: [
              {
                ...unknown,
                main: {
                  state: "confirmed",
                  idempotencyKey: "work-status:main",
                  confirmedAt: now,
                  observedRevision: "linear-revision-2",
                },
                mainFailures: { count: 0 },
              },
            ],
          },
        }),
      );
      expect(settled.ok).toBe(false);
      expect(settled.ok ? "ok" : settled.error.code).toBe("invariant_violation");
    });
  });
});
