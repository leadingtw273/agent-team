/**
 * C015c item 2 unit tests: `runResumeCycle`/`resumeOneJob` (src/cli/dispatch/resume-composition.ts)
 * -- the state machine that drives a `ci_waiting` (or later-stage) job-progress record forward
 * across a fresh `agent-team run` process. Every engine pipeline (CiRecovery/Reviewer/
 * ReviewStatus/AutoMerge/Lifecycle) is a scripted fake here (their own real behavior is covered by
 * their own unit/contract tests and by dispatch-implementer-composition.test.ts's siblings) --
 * this file's job is only to prove the *orchestration* reads live GitHub state correctly, writes
 * the right next `stage` for every outcome, and never silently invents a merge/completion it
 * cannot support. `FileJobProgressStore`/`FileJobRepository`/`FileLeaseRepository` are real
 * (temp-file), per this ticket's established "fake pipelines + real file stores" convention.
 *
 * Covers: the happy path (ci_waiting -> CI green -> approved -> merged -> Lifecycle completed,
 * in one resume cycle); CI-red -> checkpointed (the "attempt-count" scenario); review-blocked,
 * not yet at the attempt limit -> fix_round; review-blocked, attempt limit reached ->
 * checkpointed (the "attempt-limit-checkpoint" scenario); lease conflict; exact-readback mismatch
 * -> requires_manual; a `"merging"`-staged job that re-checks merge status without re-running
 * CI/Review; a still-pending CI leaves the job at `ci_waiting` untouched.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  runResumeCycle,
  type ResumeCycleDependencies,
} from "../../src/cli/dispatch/resume-composition.js";
import { FileJobProgressStore } from "../../src/adapters/dispatch/job-progress-store.js";
import type { LinearDiscoveryReadModel } from "../../src/adapters/dispatch/linear-discovery.js";
import { FileJobRepository } from "../../src/infrastructure/jobs/index.js";
import { FileLeaseRepository } from "../../src/infrastructure/leases/index.js";
import { LeaseCoordinator } from "../../src/application/leases/index.js";
import type {
  CiRecoveryPipelineOutcome,
  ReviewerPipelineOutcome,
  BeginReviewOutcome,
  RecordReviewOutcome,
  EnableAutoMergeOutcome,
  LifecyclePipelineOutcome,
} from "../../src/application/pipelines/index.js";
import {
  createFixedClock,
  ok,
  parseIdentifier,
  parseInstant,
  type Identifier,
  type Instant,
} from "../../src/domain/foundation/index.js";
import {
  buildLinearReadCatalog,
  linearAgentRoleNames,
  linearAgentStatusNames,
  linearBlockingReasonNames,
  linearReviewRequirementNames,
  linearWorkStatusNames,
  type LinearLabelRecord,
  type LinearProjectContext,
  type LinearWorkflowStateRecord,
} from "../../src/adapters/linear/model.js";
import {
  agentRoleSchema,
  projectSchema,
  reviewRequirementSchema,
  type Project,
} from "../../src/domain/project/index.js";
import { agentStatuses, blockingReasons } from "../../src/domain/workflow/index.js";
import { emptyAttemptCounters, jobSchema, type Job } from "../../src/domain/jobs/index.js";
import { headShaSchema } from "../../src/domain/review/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
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
const projectId = id("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const issueId = id("issue", "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const jobId = id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const externalIssueId = "linear-issue-1";
const headShaValue = "a".repeat(40);
const headSha = (() => {
  const parsed = headShaSchema.safeParse(headShaValue);
  if (!parsed.success) throw new Error("fixture invariant violated: invalid head sha");
  return parsed.data;
})();

function project(repositoryPath: string): Project {
  return projectSchema.parse({
    schemaVersion: 1,
    id: projectId,
    displayName: "Sandbox",
    localRepositoryPath: repositoryPath,
    defaultBranch: "main",
    workManagement: { provider: "linear", containerId: "team-1", projectId: "proj-1" },
    sourceControl: { provider: "github", repository: "owner/sandbox" },
  });
}

function job(overrides: Partial<Job> = {}): Job {
  return jobSchema.parse({
    schemaVersion: 1,
    id: jobId,
    projectId,
    issueId,
    createdAt: now,
    watchdogExtensionGranted: false,
    attempts: emptyAttemptCounters(),
    ...overrides,
  });
}

/** Same fixture technique as dispatch-linear-discovery.test.ts's own `context()`. */
function linearContext(): LinearProjectContext {
  const states: LinearWorkflowStateRecord[] = Object.entries(linearWorkStatusNames).map(
    ([status, name], index) => ({ id: `state-${status}-${String(index)}`, name, type: status }),
  );
  function group(groupName: string, groupId: string): LinearLabelRecord {
    return { id: groupId, name: groupName, isGroup: true, parentId: null };
  }
  function child(name: string, parentId: string, childId: string): LinearLabelRecord {
    return { id: childId, name, isGroup: false, parentId };
  }
  const groupIds = {
    agentRole: "label-group-agent-role",
    reviewRequirement: "label-group-review-requirement",
    agentStatus: "label-group-agent-status",
    blockingReason: "label-group-blocking-reason",
  };
  const labels: LinearLabelRecord[] = [
    group("Agent 角色", groupIds.agentRole),
    ...agentRoleSchema.options.map((key, index) =>
      child(linearAgentRoleNames[key], groupIds.agentRole, `label-agent-role-${String(index)}`),
    ),
    group("審查需求", groupIds.reviewRequirement),
    ...reviewRequirementSchema.options.map((key, index) =>
      child(
        linearReviewRequirementNames[key],
        groupIds.reviewRequirement,
        `label-review-requirement-${String(index)}`,
      ),
    ),
    group("Agent 狀態", groupIds.agentStatus),
    ...agentStatuses.map((key, index) =>
      child(
        linearAgentStatusNames[key],
        groupIds.agentStatus,
        `label-agent-status-${String(index)}`,
      ),
    ),
    group("阻塞原因", groupIds.blockingReason),
    ...blockingReasons.map((key, index) =>
      child(
        linearBlockingReasonNames[key],
        groupIds.blockingReason,
        `label-blocking-reason-${String(index)}`,
      ),
    ),
  ];
  const catalog = buildLinearReadCatalog(states, labels);
  if (!catalog.ok) throw new Error("fixture invariant violated: catalog must build cleanly");
  return Object.freeze({
    team: Object.freeze({ id: "team-1", name: "Team", key: "TM" }),
    project: Object.freeze({ id: "proj-1", name: "Project" }),
    catalog: catalog.value,
  });
}

function readModel(): LinearDiscoveryReadModel {
  return {
    readContext: () => Promise.resolve(ok(linearContext())),
    listIssueIdsInState: () => Promise.resolve(ok([externalIssueId])),
    readIssue: () =>
      Promise.resolve(
        ok({
          id: externalIssueId,
          identifier: "SBX-1",
          title: "Ship the thing",
          updatedAt: now,
          teamId: "team-1",
          projectId: "proj-1",
          workStatus: "ready" as const,
          agentRole: "implementer" as const,
          otherLabelIds: [],
          relations: [],
          comments: [],
        }),
      ),
  };
}

function changeRequest(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: "PR_node_fixture",
    number: 42,
    url: "https://github.com/owner/sandbox/pull/42",
    state: "open" as const,
    draft: false,
    baseBranch: "main",
    headBranch: "agent-team/job-1",
    headSha,
    mergeability: "mergeable" as const,
    autoMergeEnabled: false,
    updatedAt: now,
    ...overrides,
  };
}

async function seededRepositoryPath(): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const directory = await temporaryDirectory("agent-team-resume-repo-");
  await run("git", ["init", "--quiet", "--initial-branch=main", directory]);
  await run("git", ["-C", directory, "config", "user.email", "test@example.com"]);
  await run("git", ["-C", directory, "config", "user.name", "Test"]);
  await run("git", ["-C", directory, "commit", "--allow-empty", "-m", "init", "--quiet"], {
    cwd: directory,
  });
  return directory;
}

async function progressRoot(): Promise<string> {
  return temporaryDirectory("agent-team-resume-progress-");
}

interface Harness {
  readonly deps: ResumeCycleDependencies;
  readonly progress: FileJobProgressStore;
  readonly jobRepository: FileJobRepository;
  readonly calls: string[];
  readonly repositoryPath: string;
}

async function harness(
  overrides: Partial<{
    changeRequestState: Readonly<Record<string, unknown>>;
    ciRecoveryOutcome: CiRecoveryPipelineOutcome;
    reviewerOutcome: ReviewerPipelineOutcome;
    beginOutcome: BeginReviewOutcome;
    recordOutcome: RecordReviewOutcome;
    enableOutcome: EnableAutoMergeOutcome;
    lifecycleOutcome: LifecyclePipelineOutcome;
    leaseConflict: boolean;
  }> = {},
): Promise<Harness> {
  const repositoryPath = await seededRepositoryPath();
  const progressDirectory = await progressRoot();
  const progress = new FileJobProgressStore(progressDirectory);
  const leaseRoot = await temporaryDirectory("agent-team-resume-leases-");
  const jobsRoot = await temporaryDirectory("agent-team-resume-jobs-");
  const jobRepository = new FileJobRepository(
    join(jobsRoot, "jobs.json"),
    join(jobsRoot, "jobs.lock"),
  );
  await jobRepository.create(job());
  const leases = new LeaseCoordinator(
    new FileLeaseRepository(join(leaseRoot, "leases.json"), join(leaseRoot, "leases.lock")),
  );
  if (overrides.leaseConflict === true) {
    await leases.acquire({ jobId, issueId, holderId: "other-holder" });
  }

  const calls: string[] = [];
  const deps: ResumeCycleDependencies = {
    progress,
    jobRepository,
    leases,
    sourceControl: {
      getChangeRequest: () => {
        calls.push("getChangeRequest");
        return Promise.resolve(ok(changeRequest(overrides.changeRequestState ?? {})));
      },
    },
    readModel: readModel(),
    teamId: "team-1",
    linearProjectId: "proj-1",
    project: project(repositoryPath),
    trustedConfig: {
      projectRules: [],
      roleInstructions: {},
    } as never,
    ciRecovery: {
      run: () => {
        calls.push("ciRecovery.run");
        return Promise.resolve(
          overrides.ciRecoveryOutcome ??
            ({ state: "ready_for_review", source: "polling", job: job(), checks: {} } as never),
        );
      },
    },
    reviewer: {
      run: () => {
        calls.push("reviewer.run");
        return Promise.resolve(
          overrides.reviewerOutcome ??
            ({ state: "approved", job: job(), changeRequest: changeRequest() } as never),
        );
      },
    },
    reviewStatus: {
      begin: () => {
        calls.push("reviewStatus.begin");
        return Promise.resolve(
          overrides.beginOutcome ?? ({ state: "pending", changeRequest: changeRequest() } as never),
        );
      },
      record: () => {
        calls.push("reviewStatus.record");
        return Promise.resolve(
          overrides.recordOutcome ??
            ({
              state: "approved",
              approval: { changeRequestId: "42", identity: {}, reports: [], evidenceComment: {} },
            } as never),
        );
      },
    },
    autoMerge: {
      enable: () => {
        calls.push("autoMerge.enable");
        return Promise.resolve(
          overrides.enableOutcome ??
            ({
              state: "enabled",
              reuse: "unchanged",
              identity: {},
              changeRequest: changeRequest({ state: "merged" }),
            } as never),
        );
      },
    },
    lifecycle: {
      run: () => {
        calls.push("lifecycle.run");
        return Promise.resolve(
          overrides.lifecycleOutcome ??
            ({ state: "completed", merge: "authorized", headSha, autoMergePaused: false } as never),
        );
      },
    },
    clock: createFixedClock(now),
    holderId: "resume-holder",
  };
  return { deps, progress, jobRepository, calls, repositoryPath };
}

async function seedProgressRecord(
  progress: FileJobProgressStore,
  stage: Readonly<{ kind: string; checkpointId?: string }>,
) {
  await progress.compareAndSwap(jobId, null, {
    jobId,
    projectId,
    issueId,
    externalIssueId,
    model: "claude-opus",
    stage: stage as never,
    branch: "agent-team/job-1",
    worktreePath: "/tmp/does-not-need-to-exist-for-these-fakes",
    changeRequestId: "42",
    headSha,
  });
}

describe("runResumeCycle", () => {
  it("happy path: ci_waiting -> CI green -> approved -> merged -> Lifecycle completed, in one cycle", async () => {
    const { deps, progress, calls } = await harness();
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([{ jobId, outcome: "completed" }]);
    expect(calls).toEqual([
      "getChangeRequest",
      "ciRecovery.run",
      "reviewStatus.begin",
      "reviewer.run",
      "reviewStatus.record",
      "autoMerge.enable",
      "lifecycle.run",
    ]);

    const reloaded = await progress.load(jobId);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) expect(reloaded.value?.stage).toEqual({ kind: "completed" });
  });

  it("CI-red -> CiRecoveryPipeline checkpoints (attempt-count scenario) -> stage paused with checkpointId", async () => {
    const { deps, progress } = await harness({
      ciRecoveryOutcome: {
        state: "checkpointed",
        reason: "attempt_limit_reached",
        job: job(),
        checkpointId: "checkpoint_018f47d2-77a4-7cc1-8ef2-0123456789ab",
        checks: {} as never,
      },
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        {
          jobId,
          outcome: "checkpointed",
          checkpointId: "checkpoint_018f47d2-77a4-7cc1-8ef2-0123456789ab",
        },
      ]);
    }
    const reloaded = await progress.load(jobId);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toEqual({
        kind: "paused",
        checkpointId: "checkpoint_018f47d2-77a4-7cc1-8ef2-0123456789ab",
      });
    }
  });

  it("review-blocked, attempt limit not yet reached -> stage fix_round", async () => {
    const { deps, progress } = await harness({
      reviewerOutcome: {
        state: "changes_requested",
        job: job(),
        changeRequest: changeRequest(),
        checks: {} as never,
        identity: {} as never,
        reports: [],
        findings: [],
      },
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([{ jobId, outcome: "fix_round", verdict: "changes_requested" }]);
    }
    const reloaded = await progress.load(jobId);
    if (reloaded.ok) expect(reloaded.value?.stage).toEqual({ kind: "fix_round" });
  });

  it("review-blocked, attempt limit reached -> ReviewerPipeline checkpoints (attempt-limit-checkpoint scenario)", async () => {
    const { deps, progress } = await harness({
      reviewerOutcome: {
        state: "checkpointed",
        reason: "attempt_limit_reached",
        job: job(),
        checkpointId: "checkpoint_018f47d2-77a4-7cc1-8ef2-1123456789ab",
        checks: {} as never,
      },
    });
    await seedProgressRecord(progress, { kind: "fix_round" });

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        {
          jobId,
          outcome: "checkpointed",
          checkpointId: "checkpoint_018f47d2-77a4-7cc1-8ef2-1123456789ab",
        },
      ]);
    }
    const reloaded = await progress.load(jobId);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toEqual({
        kind: "paused",
        checkpointId: "checkpoint_018f47d2-77a4-7cc1-8ef2-1123456789ab",
      });
    }
  });

  it("skips a job whose lease is already held by another process", async () => {
    const { deps, progress } = await harness({ leaseConflict: true });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([{ jobId, outcome: "lease_conflict" }]);
    const reloaded = await progress.load(jobId);
    if (reloaded.ok) expect(reloaded.value?.stage).toEqual({ kind: "ci_waiting" });
  });

  it("fails closed to requires_manual on an exact-readback branch mismatch", async () => {
    const { deps, progress } = await harness({
      changeRequestState: { headBranch: "someone-else/branch" },
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        { jobId, outcome: "requires_manual", reason: "change_request_state_mismatch" },
      ]);
    }
    const reloaded = await progress.load(jobId);
    if (reloaded.ok) expect(reloaded.value?.stage).toEqual({ kind: "requires_manual" });
  });

  it('a "merging"-staged job re-checks merge status without re-running CI/Review', async () => {
    const { deps, progress, calls } = await harness({
      changeRequestState: { state: "open" },
    });
    await seedProgressRecord(progress, { kind: "merging" });

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([{ jobId, outcome: "still_merging" }]);
    expect(calls).toEqual(["getChangeRequest"]);
  });

  it('a "merging"-staged job that has since merged runs Lifecycle straight away', async () => {
    const { deps, progress, calls } = await harness({
      changeRequestState: { state: "merged" },
    });
    await seedProgressRecord(progress, { kind: "merging" });

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([{ jobId, outcome: "completed" }]);
    expect(calls).toEqual(["getChangeRequest", "lifecycle.run"]);
  });

  it("still-pending CI leaves the job at ci_waiting, untouched, without ever reaching the reviewer", async () => {
    const { deps, progress, calls } = await harness({
      ciRecoveryOutcome: {
        state: "ci_waiting",
        source: "polling",
        job: job(),
        checks: { headSha, aggregate: "pending", checks: [] },
      },
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([{ jobId, outcome: "still_ci_waiting" }]);
    expect(calls).toEqual(["getChangeRequest", "ciRecovery.run"]);
  });

  it("does nothing when there is no resumable record for the project", async () => {
    const { deps } = await harness();
    const result = await runResumeCycle(deps);
    expect(result).toEqual({ ok: true, value: [] });
  });
});
