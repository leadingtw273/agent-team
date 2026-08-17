import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { safeReviewReportDiagnostics } from "../../src/application/pipelines/index.js";
import { FileReviewerReplayPolicyStore } from "../../src/adapters/dispatch/reviewer-replay-policy-store.js";
import { FileReviewerReplayDiagnosticStore } from "../../src/adapters/dispatch/reviewer-replay-diagnostic-store.js";
import { FileJobProgressStore } from "../../src/adapters/dispatch/job-progress-store.js";
import { readJsonWithSchema } from "../../src/infrastructure/files/index.js";
import { reviewerReplayDiagnosticRecordSchema } from "../../src/adapters/dispatch/reviewer-replay-diagnostic-store.js";
import {
  createFixedClock,
  ok,
  parseIdentifier,
  parseInstant,
} from "../../src/domain/foundation/index.js";
import {
  createReviewerReplayHandlers,
  reviewerReplayCliOutcome,
  reviewerReplayPolicyConfirmationPhrase,
} from "../../src/cli/dispatch/reviewer-replay-handlers.js";
import { createReviewerReplaySuccessCheckpoint } from "../../src/cli/dispatch/reviewer-replay-identity.js";
import { buildJobProgressStore } from "../../src/cli/dispatch/resume-composition.js";
import { resumeExistingProjectJobs } from "../../src/cli/dispatch/resume-existing.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function identifier(scope: "project" | "job", value: string): string {
  const parsed = parseIdentifier(scope, value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function stdin(value: string): AsyncIterable<string> {
  return (async function* () {
    await Promise.resolve();
    yield `${value}\n`;
  })();
}

describe("reviewer-replay safe diagnostics", () => {
  it("AC9 masks dynamic paths and never copies Zod messages, unknown keys, or received values", () => {
    const secret = "sk-ant-secret-value";
    const diagnostics = safeReviewReportDiagnostics([
      {
        code: "unrecognized_keys",
        path: ["findings", 0, secret],
        message: `Unrecognized key ${secret}`,
        keys: [secret],
        input: secret,
      } as never,
      {
        code: "invalid_type",
        path: ["acceptanceCriteria", 4, "status"],
        message: `received ${secret}`,
        input: secret,
      } as never,
      {
        code: "invalid_value",
        path: [secret],
        message: secret,
      } as never,
    ]);

    expect(diagnostics).toEqual([
      {
        code: "unrecognized_keys",
        path: "findings.[*].[*]",
        message: "Report contains one or more unrecognized keys.",
      },
      {
        code: "invalid_type",
        path: "acceptanceCriteria.[*].status",
        message: "Value type does not match the report schema.",
      },
      {
        code: "invalid_value",
        path: "[*]",
        message: "Value is outside the report schema allowlist.",
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
  });

  it("AC9 private journal persists only closed diagnostics and deduplicates an attempt", async () => {
    const directory = await temporaryDirectory("reviewer-replay-diagnostics-");
    const store = new FileReviewerReplayDiagnosticStore(directory);
    const jobId = identifier("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab");
    const digest = "a".repeat(64);
    const entry = {
      attempt: 1,
      kind: "format" as const,
      category: "schema_invalid" as const,
      diagnostics: [
        {
          code: "invalid_type" as const,
          path: "acceptanceCriteria.[*].status",
          message: "Value type does not match the report schema.",
        },
        {
          code: "invalid_value" as const,
          path: "[*]",
          message: "Value is outside the report schema allowlist.",
        },
      ],
    };
    await expect(store.append(jobId, digest, entry)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(store.append(jobId, digest, entry)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    const loaded = await readJsonWithSchema(
      join(directory, `${jobId}.json`),
      reviewerReplayDiagnosticRecordSchema,
    );
    expect(loaded.ok && loaded.value.entries).toHaveLength(1);
  });
});

describe("reviewer-replay CLI outcome", () => {
  const continued = (nested: unknown) =>
    ({
      state: "continued",
      jobId: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
      identityDigest: "a".repeat(64),
      checkpointDigest: "b".repeat(64),
      providerAttempts: 1,
      outcome: nested,
    }) as never;

  it("reports only a converged completion or armed merge as exit-zero success", () => {
    expect(
      reviewerReplayCliOutcome(continued({ jobId: "job", outcome: "completed" }), false).state,
    ).toBe("success");
    expect(
      reviewerReplayCliOutcome(
        continued({ jobId: "job", outcome: "requires_manual", reason: "status_mismatch" }),
        false,
      ).state,
    ).toBe("blocked");
    expect(
      reviewerReplayCliOutcome(
        continued({
          jobId: "job",
          outcome: "progress_write_failed",
          error: { code: "conflict", retryable: false },
        }),
        false,
      ).state,
    ).toBe("failed");
  });
});

describe("reviewer-replay project policy", () => {
  it("AC1 defaults off and enable/disable is durable and idempotent", async () => {
    const directory = await temporaryDirectory("reviewer-replay-policy-");
    const store = new FileReviewerReplayPolicyStore(directory);
    const projectId = identifier("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab");
    await expect(store.load(projectId)).resolves.toEqual({ ok: true, value: undefined });
    const enabled = await store.setEnabled(projectId, true);
    if (!enabled.ok) throw new Error(enabled.error.code);
    expect(enabled.value.enabled).toBe(true);
    const same = await store.setEnabled(projectId, true);
    if (!same.ok) throw new Error(same.error.code);
    expect(same.value.revision).toBe(enabled.value.revision);
    const disabled = await store.setEnabled(projectId, false);
    if (!disabled.ok) throw new Error(disabled.error.code);
    expect(disabled.value.enabled).toBe(false);
  });

  it("requires the controlled confirmation phrase before enabling a project", async () => {
    const root = await temporaryDirectory("reviewer-replay-policy-handler-");
    const projectId = identifier("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab");
    const rejected = createReviewerReplayHandlers({ agentTeamHome: root, stdin: stdin("WRONG") });
    await expect(
      rejected.reviewerReplayPolicy({ projectId, enabled: true }),
    ).resolves.toMatchObject({ state: "rejected" });

    const accepted = createReviewerReplayHandlers({
      agentTeamHome: root,
      stdin: stdin(reviewerReplayPolicyConfirmationPhrase),
    });
    await expect(
      accepted.reviewerReplayPolicy({ projectId, enabled: true }),
    ).resolves.toMatchObject({ state: "success" });
    const store = new FileReviewerReplayPolicyStore(
      join(root, "state", "dispatch", "reviewer-replay-policy"),
    );
    await expect(store.load(projectId)).resolves.toMatchObject({
      ok: true,
      value: { projectId, enabled: true },
    });
  });
});

describe("reviewer-replay scheduler selection", () => {
  it("never passes a disabled success-checkpoint job back into a cycle when another job is resumable", async () => {
    const root = await temporaryDirectory("reviewer-replay-resume-selection-");
    const projectId = identifier("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab");
    const checkpointJobId = identifier("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab");
    const ordinaryJobId = identifier("job", "job_018f47d2-77a4-7cc1-8ef2-111111111111");
    const completedAt = parseInstant("2026-08-17T08:00:00.000Z");
    if (!completedAt.ok) throw new Error(completedAt.error.code);
    const attempting = {
      state: "attempting" as const,
      identity: {
        schemaVersion: 1 as const,
        jobId: checkpointJobId as never,
        projectId: projectId as never,
        issueId: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab" as never,
        externalIssueId: "LEA-46",
        changeRequestId: "8",
        baseRevision: "b".repeat(40) as never,
        requirementsDigest: "c".repeat(64),
        headSha: "a".repeat(40) as never,
        diffDigest: "d".repeat(64),
      },
      identityDigest: "e".repeat(64),
      counters: { providerAttempts: 1, formatFailures: 0, transportFailures: 0 },
    };
    const checkpoint = createReviewerReplaySuccessCheckpoint(
      attempting,
      [
        {
          schemaVersion: 1,
          role: "code_reviewer",
          verdict: "passed",
          requirementsDigest: attempting.identity.requirementsDigest,
          headSha: attempting.identity.headSha,
          diffDigest: attempting.identity.diffDigest,
          summary: "Approved.",
          acceptanceCriteria: [
            { criterion: "Safe", status: "passed", summary: "Safe.", evidenceSources: [] },
          ],
          qualityChecks: [
            {
              dimension: "correctness",
              status: "passed",
              summary: "Correct.",
              evidenceSources: [],
            },
          ],
          findings: [],
        },
      ],
      completedAt.value,
    );
    if (!checkpoint.ok) throw new Error(checkpoint.error.code);
    const progress = buildJobProgressStore(root);
    const base = {
      projectId: projectId as never,
      issueId: attempting.identity.issueId,
      externalIssueId: "LEA-46",
      model: "claude-opus",
      providerAssignments: {
        execution: { provider: "codex" as const, model: "gpt-sol" },
        codeReview: { provider: "claude" as const, model: "claude-opus" },
      },
      stage: { kind: "ci_waiting" as const },
      branch: "agent-team/replay",
      worktreePath: "/tmp/replay",
      changeRequestId: "8",
      headSha: attempting.identity.headSha,
      baseRevision: attempting.identity.baseRevision,
    };
    await expect(
      progress.compareAndSwap(checkpointJobId, null, {
        ...base,
        jobId: checkpointJobId as never,
        reviewerReplay: checkpoint.value,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      progress.compareAndSwap(ordinaryJobId, null, {
        ...base,
        jobId: ordinaryJobId as never,
        externalIssueId: "LEA-47",
        reviewerReplay: undefined,
      }),
    ).resolves.toMatchObject({ ok: true });

    let selectedJobIds: readonly string[] = [];
    const result = await resumeExistingProjectJobs({
      agentTeamHome: root,
      ready: {
        project: { id: projectId },
        leases: {},
        jobs: {},
        discovery: { readModel: {}, teamId: "team", linearProjectId: "linear-project" },
        trustedConfig: {},
      } as never,
      holderId: "selection-test",
      clock: createFixedClock(completedAt.value),
      runResumeCycle: (_deps, selection) => {
        selectedJobIds = selection?.selections.map((candidate) => candidate.jobId) ?? [];
        return Promise.resolve(ok([]));
      },
    });

    expect(result.state).toBe("resumed");
    expect(selectedJobIds).toEqual([ordinaryJobId]);
  });
});

describe("reviewer-replay progress invariants", () => {
  it("AC6 never permits replay identity removal or counter rollback after initialization", async () => {
    const directory = await temporaryDirectory("reviewer-replay-progress-invariant-");
    const store = new FileJobProgressStore(directory);
    const replay = {
      state: "attempting" as const,
      identity: {
        schemaVersion: 1 as const,
        jobId: identifier("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab") as never,
        projectId: identifier("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab") as never,
        issueId: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab" as never,
        externalIssueId: "LEA-1",
        changeRequestId: "42",
        baseRevision: "b".repeat(40) as never,
        requirementsDigest: "c".repeat(64),
        headSha: "a".repeat(40) as never,
        diffDigest: "d".repeat(64),
      },
      identityDigest: "e".repeat(64),
      counters: { providerAttempts: 1, formatFailures: 1, transportFailures: 0 },
    };
    const base = {
      jobId: replay.identity.jobId,
      projectId: replay.identity.projectId,
      issueId: replay.identity.issueId,
      externalIssueId: "LEA-1",
      model: "claude-opus",
      providerAssignments: {
        execution: { provider: "codex" as const, model: "gpt-sol" },
        codeReview: { provider: "claude" as const, model: "claude-opus" },
      },
      stage: {
        kind: "requires_manual" as const,
        cause: {
          stage: "review" as const,
          reasonCode: "review_report_contract" as const,
          attempts: { count: 2 },
        },
      },
      branch: "agent-team/replay",
      worktreePath: "/tmp/replay",
      changeRequestId: "42",
      headSha: "a".repeat(40) as never,
      baseRevision: "b".repeat(40) as never,
      reviewerReplay: replay,
    };
    const seeded = await store.compareAndSwap(replay.identity.jobId, null, base);
    if (!seeded.ok) throw new Error(seeded.error.code);
    const removed = await store.compareAndSwap(replay.identity.jobId, seeded.value.revision, {
      ...base,
      reviewerReplay: undefined,
    });
    expect(removed).toMatchObject({ ok: false, error: { code: "invariant_violation" } });
    const rolledBack = await store.compareAndSwap(replay.identity.jobId, seeded.value.revision, {
      ...base,
      reviewerReplay: {
        ...replay,
        counters: { providerAttempts: 0, formatFailures: 0, transportFailures: 0 },
      },
    });
    expect(rolledBack).toMatchObject({ ok: false, error: { code: "invariant_violation" } });
  });
});
