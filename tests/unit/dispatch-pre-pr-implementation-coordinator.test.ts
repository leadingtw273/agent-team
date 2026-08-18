import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FileJobProgressStore } from "../../src/adapters/dispatch/job-progress-store.js";
import type { ImplementerPipeline } from "../../src/application/pipelines/index.js";
import {
  PrePrImplementationCoordinator,
  type PrePrImplementationCoordinatorDependencies,
} from "../../src/cli/dispatch/pre-pr-implementation-coordinator.js";
import { FileJobRepository } from "../../src/infrastructure/jobs/index.js";
import {
  createFixedClock,
  domainError,
  err,
  ok,
  parseIdentifier,
  parseInstant,
  type Identifier,
  type Instant,
} from "../../src/domain/foundation/index.js";
import { emptyAttemptCounters, type Job } from "../../src/domain/jobs/index.js";
import { issueSchema, projectSchema } from "../../src/domain/project/index.js";
import { headShaSchema } from "../../src/domain/review/index.js";
import { trustedProjectConfigSchema } from "../../src/application/projects/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-pre-pr-"));
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

const projectId = id("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const issueId = id("issue", "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const jobId = id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const now = instant("2026-08-18T02:00:00.000Z");
const baseRevision = headShaSchema.parse("a".repeat(40));
const headSha = headShaSchema.parse("b".repeat(40));
const project = projectSchema.parse({
  schemaVersion: 1,
  id: projectId,
  displayName: "Sandbox",
  localRepositoryPath: "/tmp/sandbox",
  defaultBranch: "main",
  workManagement: { provider: "linear", containerId: "team-1", projectId: "project-1" },
  sourceControl: { provider: "github", repository: "owner/sandbox" },
});
const issue = issueSchema.parse({
  schemaVersion: 1,
  id: issueId,
  projectId,
  externalId: "LEA-100",
  title: "Pre-PR recovery",
  goal: "Recover safely",
  acceptanceCriteria: ["Create one exact change"],
  inScope: ["src/feature.ts"],
  outOfScope: ["everything else"],
  dependencies: { kind: "none" },
  agentRole: "implementer",
  reviewRequirement: "code_review",
  changeRegions: [{ path: "src/feature.ts", coverage: "exact" }],
});
const workflowIssue = issueSchema.parse({
  schemaVersion: 1,
  id: issueId,
  projectId,
  externalId: issue.externalId,
  title: issue.title,
  agentRole: "implementer",
  reviewRequirement: "code_review",
});
const trustedConfig = trustedProjectConfigSchema.parse({
  schemaVersion: 1,
  projectId,
  defaultBranch: "main",
  platforms: {
    workManagement: { provider: "linear", containerId: "team-1", projectId: "project-1" },
    sourceControl: { provider: "github", repository: "owner/sandbox" },
  },
  projectRules: [],
  roleInstructions: {},
  commands: { quality: [{ executable: "true", arguments: [] }], visualReview: [] },
});

function job(processRecoveries = 0): Job {
  return {
    schemaVersion: 1,
    id: jobId,
    projectId,
    issueId,
    createdAt: now,
    watchdogExtensionGranted: false,
    attempts: { ...emptyAttemptCounters(), processRecoveries },
  };
}

function ciWaitingOutcome() {
  return {
    state: "ci_waiting" as const,
    worktree: {
      repositoryRoot: project.localRepositoryPath,
      path: `/tmp/${jobId}`,
      branch: `agent-team/${jobId}`,
      headSha,
    },
    commit: { sha: headSha, branch: `agent-team/${jobId}` },
    push: { sha: headSha, branch: `agent-team/${jobId}`, remote: "origin" },
    changeRequest: {
      id: "PR_100",
      number: 100,
      url: "https://example.invalid/pr/100",
      state: "open" as const,
      draft: true,
      baseBranch: "main",
      headBranch: `agent-team/${jobId}`,
      headSha,
      mergeability: "unknown" as const,
      autoMergeEnabled: false,
      updatedAt: now,
    },
    checks: { headSha, aggregate: "pending" as const, checks: [] },
  };
}

async function harness(
  processRecoveries = 0,
  providerIssue: Readonly<{
    workStatus: "in_progress" | "canceled";
    agentCondition?: Readonly<{ status: "executing"; blockingReasons: readonly [] }>;
  }> = {
    workStatus: "in_progress",
    agentCondition: { status: "executing", blockingReasons: [] },
  },
  resolveRequirementIssueOverride?: PrePrImplementationCoordinatorDependencies["resolveRequirementIssue"],
) {
  const root = await temporaryDirectory();
  const progress = new FileJobProgressStore(
    join(root, "progress"),
    undefined,
    createFixedClock(now),
  );
  const jobs = new FileJobRepository(join(root, "jobs.json"), join(root, "jobs.lock"));
  await jobs.create(job(processRecoveries));
  const pipelineRun = vi.fn<ImplementerPipeline["run"]>(() => Promise.resolve(ciWaitingOutcome()));
  const workStatusTransition = vi.fn(() =>
    Promise.resolve({
      state: "permitted" as const,
      mode: "enforce" as const,
      main: "confirmed" as const,
      agent: "confirmed" as const,
    }),
  );
  const getIssue = vi
    .fn()
    .mockResolvedValueOnce(
      ok({ issue: workflowIssue, workStatus: "ready" as const, updatedAt: now, revision: "1" }),
    )
    .mockResolvedValue(
      ok({ issue: workflowIssue, ...providerIssue, updatedAt: now, revision: "2" }),
    );
  const resolveRequirementIssue = vi.fn(
    resolveRequirementIssueOverride ?? (() => Promise.resolve(ok(issue))),
  );
  const coordinator = new PrePrImplementationCoordinator({
    agentTeamHome: root,
    project,
    trustedConfig,
    progress,
    jobs,
    admission: {
      load: () =>
        Promise.resolve(
          ok({
            schemaVersion: 1 as const,
            revision: 2,
            projectId,
            issueId,
            externalIssueId: issue.externalId,
            jobId,
            state: "active" as const,
            claimedAt: now,
            updatedAt: now,
          }),
        ),
    },
    workManagement: {
      getIssue,
    } as never,
    resolveRequirementIssue,
    workStatus: { transition: workStatusTransition } as never,
    clock: createFixedClock(now),
    ensureWorktreeDirectory: () => Promise.resolve(ok(undefined)),
    buildPipeline: () =>
      Promise.resolve({ state: "ready" as const, value: { run: pipelineRun } as never }),
    resolveAuthoritativeBase: () => Promise.resolve(ok({ baseRevision, defaultBranch: "main" })),
  });
  return {
    coordinator,
    progress,
    jobs,
    pipelineRun,
    workStatusTransition,
    getIssue,
    resolveRequirementIssue,
  };
}

async function seed(
  progress: FileJobProgressStore,
  stage:
    | { readonly kind: "work_start_pending" }
    | {
        readonly kind: "implementing";
        readonly executionEpoch: {
          readonly ordinal: 1;
          readonly providerOutput: "none";
          readonly startedAt: Instant;
        };
      },
) {
  return progress.compareAndSwap(jobId, null, {
    jobId,
    projectId,
    issueId,
    externalIssueId: issue.externalId,
    model: "gpt-5.6-terra",
    providerAssignments: {
      execution: { provider: "codex", model: "gpt-5.6-terra" },
      codeReview: { provider: "claude", model: "claude-opus" },
    },
    stage,
    branch: `agent-team/${jobId}`,
    worktreePath: `/tmp/${jobId}`,
    ...(stage.kind === "implementing" ? { baseRevision } : {}),
    workStatusLifecycle: {
      admissionMode: "enforce",
      capabilityDigest: "c".repeat(64),
      phase: stage.kind === "implementing" ? "implementing" : "work_start",
      transitions: [],
    },
  });
}

describe("PrePrImplementationCoordinator", () => {
  it("continues the original work_start Job and persists Provider output before ci_waiting", async () => {
    const fixture = await harness();
    const record = await seed(fixture.progress, { kind: "work_start_pending" });
    if (!record.ok) throw new Error(record.error.code);

    await expect(
      fixture.coordinator.run(record.value, { holderId: "resume-holder" }),
    ).resolves.toEqual({ jobId, outcome: "still_ci_waiting" });

    expect(fixture.pipelineRun).toHaveBeenCalledOnce();
    expect(fixture.resolveRequirementIssue).toHaveBeenCalledTimes(2);
    expect(fixture.resolveRequirementIssue).toHaveBeenNthCalledWith(1, issue.externalId, undefined);
    expect(fixture.resolveRequirementIssue).toHaveBeenNthCalledWith(2, issue.externalId, undefined);
    const pipelineRequest = fixture.pipelineRun.mock.calls[0]?.[0];
    expect(pipelineRequest?.requirementSnapshot.issue).toMatchObject({
      goal: "Recover safely",
      changeRegions: [{ path: "src/feature.ts", coverage: "exact" }],
    });
    await expect(fixture.progress.load(jobId)).resolves.toMatchObject({
      ok: true,
      value: { stage: { kind: "ci_waiting" }, baseRevision, headSha, changeRequestId: "100" },
    });
  });

  it("does not gate Provider on a missing optional Agent label projection", async () => {
    const fixture = await harness(0, { workStatus: "in_progress" });
    const record = await seed(fixture.progress, { kind: "work_start_pending" });
    if (!record.ok) throw new Error(record.error.code);

    const result = await fixture.coordinator.run(record.value, { holderId: "resume-holder" });

    expect(result).toMatchObject({ outcome: "still_ci_waiting" });
    expect(fixture.pipelineRun).toHaveBeenCalledOnce();
  });

  it("allows exactly one bounded implementing-process recovery", async () => {
    const fixture = await harness();
    const record = await seed(fixture.progress, {
      kind: "implementing",
      executionEpoch: { ordinal: 1, providerOutput: "none", startedAt: now },
    });
    if (!record.ok) throw new Error(record.error.code);

    await fixture.coordinator.run(record.value, { holderId: "resume-holder" });

    const jobs = await fixture.jobs.readAll();
    expect(jobs).toMatchObject({ ok: true, value: [{ attempts: { processRecoveries: 1 } }] });
    expect(fixture.pipelineRun).toHaveBeenCalledOnce();
  });

  it("keeps an exhausted recovery requires_manual and never invokes Provider", async () => {
    const fixture = await harness(1);
    const record = await seed(fixture.progress, {
      kind: "implementing",
      executionEpoch: { ordinal: 1, providerOutput: "none", startedAt: now },
    });
    if (!record.ok) throw new Error(record.error.code);

    await expect(
      fixture.coordinator.run(record.value, { holderId: "resume-holder" }),
    ).resolves.toEqual({ jobId, outcome: "requires_manual", reason: "process_recovery_exhausted" });
    expect(fixture.pipelineRun).not.toHaveBeenCalled();
  });

  it("re-reads cancellation immediately before Provider and invokes Provider zero times", async () => {
    const fixture = await harness(0, { workStatus: "canceled" });
    const record = await seed(fixture.progress, { kind: "work_start_pending" });
    if (!record.ok) throw new Error(record.error.code);

    await expect(
      fixture.coordinator.run(record.value, { holderId: "resume-holder" }),
    ).resolves.toEqual({
      jobId,
      outcome: "requires_manual",
      reason: "pre_pr_identity_unrecoverable",
    });

    expect(fixture.getIssue).toHaveBeenCalledTimes(2);
    expect(fixture.pipelineRun).not.toHaveBeenCalled();
  });

  it("fails closed before work starts when the initial requirement projection cannot be read", async () => {
    const resolveRequirementIssue: PrePrImplementationCoordinatorDependencies["resolveRequirementIssue"] =
      () => Promise.resolve(err(domainError("external_failure")));
    const fixture = await harness(0, undefined, resolveRequirementIssue);
    const record = await seed(fixture.progress, { kind: "work_start_pending" });
    if (!record.ok) throw new Error(record.error.code);

    await expect(
      fixture.coordinator.run(record.value, { holderId: "resume-holder" }),
    ).resolves.toEqual({
      jobId,
      outcome: "requires_manual",
      reason: "pre_pr_identity_unrecoverable",
    });

    expect(fixture.workStatusTransition).not.toHaveBeenCalled();
    expect(fixture.pipelineRun).not.toHaveBeenCalled();
  });

  it("returns a transient failure when the final requirement projection cannot be read", async () => {
    const resolveRequirementIssue = vi
      .fn<PrePrImplementationCoordinatorDependencies["resolveRequirementIssue"]>()
      .mockResolvedValueOnce(ok(issue))
      .mockResolvedValueOnce(err(domainError("external_failure")));
    const fixture = await harness(0, undefined, resolveRequirementIssue);
    const record = await seed(fixture.progress, { kind: "work_start_pending" });
    if (!record.ok) throw new Error(record.error.code);

    await expect(
      fixture.coordinator.run(record.value, { holderId: "resume-holder" }),
    ).resolves.toMatchObject({
      jobId,
      outcome: "transient_failure",
      reason: "pre_pr_authority_read_failed",
      error: { code: "external_failure" },
    });

    expect(fixture.pipelineRun).not.toHaveBeenCalled();
  });

  it("fails closed when the final requirement projection drifts from the admitted identity", async () => {
    const driftedIssue = issueSchema.parse({
      ...issue,
      id: id("issue", "issue_018f47d2-77a4-7cc1-8ef2-111111111111"),
    });
    const resolveRequirementIssue = vi
      .fn<PrePrImplementationCoordinatorDependencies["resolveRequirementIssue"]>()
      .mockResolvedValueOnce(ok(issue))
      .mockResolvedValueOnce(ok(driftedIssue));
    const fixture = await harness(0, undefined, resolveRequirementIssue);
    const record = await seed(fixture.progress, { kind: "work_start_pending" });
    if (!record.ok) throw new Error(record.error.code);

    await expect(
      fixture.coordinator.run(record.value, { holderId: "resume-holder" }),
    ).resolves.toEqual({
      jobId,
      outcome: "requires_manual",
      reason: "pre_pr_identity_unrecoverable",
    });

    expect(fixture.pipelineRun).not.toHaveBeenCalled();
  });
});
