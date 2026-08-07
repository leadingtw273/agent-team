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
  domainError,
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
import {
  emptyAttemptCounters,
  jobSchema,
  watchdogHardStopMs,
  type Job,
} from "../../src/domain/jobs/index.js";
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
  stage: Readonly<{ kind: string }> & Readonly<Record<string, unknown>>,
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

  it("fails closed to requires_manual on an exact-readback branch mismatch, with zero downstream mutation", async () => {
    const { deps, progress, calls } = await harness({
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
    // Zero mutation: the mismatch is caught before CiRecovery/Reviewer/ReviewStatus/AutoMerge/
    // Lifecycle are ever reached -- only the read-back getChangeRequest call happens.
    expect(calls).toEqual(["getChangeRequest"]);
  });

  it("fails closed to requires_manual on an exact-readback head SHA drift, with zero downstream mutation", async () => {
    const { deps, progress, calls } = await harness({
      changeRequestState: { headSha: "b".repeat(40) },
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
    expect(calls).toEqual(["getChangeRequest"]);
  });

  it("fails closed to requires_manual when the PR was closed without merging, with zero downstream mutation", async () => {
    const { deps, progress, calls } = await harness({
      changeRequestState: { state: "closed" },
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        { jobId, outcome: "requires_manual", reason: "change_request_closed" },
      ]);
    }
    const reloaded = await progress.load(jobId);
    if (reloaded.ok) expect(reloaded.value?.stage).toEqual({ kind: "requires_manual" });
    // Closed-not-merged must never reach Lifecycle (that path is reserved for state === "merged",
    // checked strictly before this branch) -- only the read-back getChangeRequest call happens.
    expect(calls).toEqual(["getChangeRequest"]);
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

  /**
   * C015o decisions 1 + 2 (D1's confirmed root cause, real incident E101): a retryable reviewer
   * provider-start failure must become `review_pending_retry` (resumable), never `requires_manual`
   * -- this is the direct fix for "resume 把 retryable timeout 打成終態". Acceptance criterion (1)
   * ("retryable reviewer 啟動失敗後不建新 job") is verified end to end from *this* side: the record
   * stays resumable, so a later `agent-team run` retries the same job instead of ever needing a
   * fresh dispatch for the same issue at all.
   */
  it("a retryable reviewer provider-start failure becomes review_pending_retry, not requires_manual", async () => {
    const timeoutError = domainError("timeout");
    const { deps, progress } = await harness({
      reviewerOutcome: {
        state: "failed",
        stage: "provider_start",
        error: timeoutError,
        job: job(),
      },
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        {
          jobId,
          outcome: "pending_retry",
          stage: "provider_start",
          error: timeoutError,
          retries: 1,
        },
      ]);
    }
    const reloaded = await progress.load(jobId);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toEqual({
        kind: "review_pending_retry",
        retries: 1,
        lastErrorCode: "timeout",
      });
    }
  });

  it("a second consecutive retryable reviewer failure increments retries to 2, still resumable", async () => {
    const unavailableError = domainError("unavailable");
    const { deps, progress } = await harness({
      reviewerOutcome: {
        state: "failed",
        stage: "provider_start",
        error: unavailableError,
        job: job(),
      },
    });
    await seedProgressRecord(progress, {
      kind: "review_pending_retry",
      retries: 1,
      lastErrorCode: "timeout",
    });

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        {
          jobId,
          outcome: "pending_retry",
          stage: "provider_start",
          error: unavailableError,
          retries: 2,
        },
      ]);
    }
    const reloaded = await progress.load(jobId);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toEqual({
        kind: "review_pending_retry",
        retries: 2,
        lastErrorCode: "unavailable",
      });
    }
  });

  it("a third consecutive retryable reviewer failure exhausts providerRetryLimit -> requires_manual", async () => {
    const timeoutError = domainError("timeout");
    const { deps, progress } = await harness({
      reviewerOutcome: {
        state: "failed",
        stage: "provider_start",
        error: timeoutError,
        job: job(),
      },
    });
    await seedProgressRecord(progress, {
      kind: "review_pending_retry",
      retries: 2,
      lastErrorCode: "timeout",
    });

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        { jobId, outcome: "requires_manual", reason: "review_failed:provider_start:timeout" },
      ]);
    }
    const reloaded = await progress.load(jobId);
    if (reloaded.ok) expect(reloaded.value?.stage).toEqual({ kind: "requires_manual" });
  });

  it("a non-retryable reviewer failure goes straight to requires_manual, never review_pending_retry", async () => {
    const permissionError = domainError("permission_denied");
    const { deps, progress } = await harness({
      reviewerOutcome: {
        state: "failed",
        stage: "provider_run",
        error: permissionError,
        job: job(),
      },
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        {
          jobId,
          outcome: "requires_manual",
          reason: "review_failed:provider_run:permission_denied",
        },
      ]);
    }
    const reloaded = await progress.load(jobId);
    if (reloaded.ok) expect(reloaded.value?.stage).toEqual({ kind: "requires_manual" });
  });

  /** Symmetric to the reviewer scenarios above -- `CiRecoveryPipeline.run()`'s own retryable
   * provider failures get the same `ci_pending_retry` treatment, never a shared counter with the
   * reviewer's `review_pending_retry`. */
  it("a retryable CI-recovery provider failure becomes ci_pending_retry, not requires_manual", async () => {
    const timeoutError = domainError("timeout");
    const { deps, progress } = await harness({
      ciRecoveryOutcome: {
        state: "failed",
        stage: "provider_start",
        error: timeoutError,
        job: job(),
      },
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        {
          jobId,
          outcome: "pending_retry",
          stage: "provider_start",
          error: timeoutError,
          retries: 1,
        },
      ]);
    }
    const reloaded = await progress.load(jobId);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toEqual({
        kind: "ci_pending_retry",
        retries: 1,
        lastErrorCode: "timeout",
      });
    }
  });

  it("ci_pending_retry exhausting providerRetryLimit goes to requires_manual, independent of review's own counter", async () => {
    const timeoutError = domainError("timeout");
    const { deps, progress } = await harness({
      ciRecoveryOutcome: {
        state: "failed",
        stage: "provider_run",
        error: timeoutError,
        job: job(),
      },
    });
    await seedProgressRecord(progress, {
      kind: "ci_pending_retry",
      retries: 2,
      lastErrorCode: "timeout",
    });

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        { jobId, outcome: "requires_manual", reason: "ci_recovery_failed:provider_run:timeout" },
      ]);
    }
    const reloaded = await progress.load(jobId);
    if (reloaded.ok) expect(reloaded.value?.stage).toEqual({ kind: "requires_manual" });
  });

  /**
   * C015o decision 1: the real root cause -- `deadlineAt` must be a genuine future instant, never
   * `clock.now()` verbatim (see resume-composition.ts's own `computeProviderDeadline` comment for
   * why that guaranteed an instant, deterministic timeout unrelated to cold-start latency).
   */
  it("passes a real future deadline (now + watchdogHardStopMs) to both CiRecovery and Reviewer, never clock.now() verbatim", async () => {
    const seenDeadlines: string[] = [];
    const { deps: baseDeps, progress } = await harness();
    const deps: ResumeCycleDependencies = {
      ...baseDeps,
      ciRecovery: {
        run: (request: { deadlineAt: string }) => {
          seenDeadlines.push(request.deadlineAt);
          return Promise.resolve({
            state: "ready_for_review",
            source: "polling",
            job: job(),
            checks: {},
          } as never);
        },
      },
      reviewer: {
        run: (request: { deadlineAt: string }) => {
          seenDeadlines.push(request.deadlineAt);
          return Promise.resolve({
            state: "approved",
            job: job(),
            changeRequest: changeRequest(),
          } as never);
        },
      },
    };
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    await runResumeCycle(deps);
    expect(seenDeadlines).toHaveLength(2);
    for (const deadline of seenDeadlines) {
      expect(deadline).not.toBe(now);
      expect(Date.parse(deadline)).toBe(Date.parse(now) + watchdogHardStopMs);
    }
  });

  /**
   * C015o decision 5: a retryable failure at a call site with no dedicated attempt-counter stage
   * (here, the change-request read-back itself) must leave `record.stage` completely untouched --
   * never demoted to `requires_manual` -- and must report a distinguishable `transient_failure`
   * outcome, not silently claim `requires_manual` happened when it did not.
   */
  it("a retryable getChangeRequest failure leaves the stage untouched and reports transient_failure", async () => {
    const rateLimitedError = domainError("rate_limited");
    const { deps: baseDeps, progress } = await harness();
    const deps: ResumeCycleDependencies = {
      ...baseDeps,
      sourceControl: {
        getChangeRequest: () => Promise.resolve({ ok: false, error: rateLimitedError }),
      },
    };
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        {
          jobId,
          outcome: "transient_failure",
          reason: "change_request_read_failed",
          error: rateLimitedError,
        },
      ]);
    }
    // Stage is untouched -- still ci_waiting, not requires_manual, not even a written revision
    // bump.
    const reloaded = await progress.load(jobId);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toEqual({ kind: "ci_waiting" });
      expect(reloaded.value?.revision).toBe(0);
    }
  });

  it("a non-retryable getChangeRequest failure still goes to requires_manual exactly as before", async () => {
    const externalFailure = domainError("external_failure");
    const { deps: baseDeps, progress } = await harness();
    const deps: ResumeCycleDependencies = {
      ...baseDeps,
      sourceControl: {
        getChangeRequest: () => Promise.resolve({ ok: false, error: externalFailure }),
      },
    };
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        { jobId, outcome: "requires_manual", reason: "change_request_read_failed" },
      ]);
    }
    const reloaded = await progress.load(jobId);
    if (reloaded.ok) expect(reloaded.value?.stage).toEqual({ kind: "requires_manual" });
  });

  /**
   * C015o decision 5: `transition(...)`'s own CAS write can fail (a genuinely concurrent writer)
   * -- the caller must report that honestly (`progress_write_failed`), never claim the intended
   * state change (`requires_manual`, in this scenario) took effect when the durable record was
   * never actually updated.
   */
  it("reports progress_write_failed, never a false requires_manual, when the underlying CAS write loses a race", async () => {
    const { deps: baseDeps, progress } = await harness({
      changeRequestState: { state: "closed" },
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });
    // Simulate a concurrent writer winning the race for this exact record, between this cycle's
    // `listForProject` snapshot and its later `transition(...)` call -- the fake `getChangeRequest`
    // (awaited well before `transition` runs) is the natural place to inject this deterministically.
    const deps: ResumeCycleDependencies = {
      ...baseDeps,
      sourceControl: {
        getChangeRequest: async () => {
          const current = await progress.load(jobId);
          if (current.ok && current.value !== undefined) {
            const { schemaVersion: _s, revision: _r, updatedAt: _u, ...rest } = current.value;
            void _s;
            void _r;
            void _u;
            await progress.compareAndSwap(jobId, current.value.revision, rest);
          }
          return { ok: true as const, value: changeRequest({ state: "closed" }) };
        },
      },
    };

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      const outcome = result.value[0];
      expect(outcome?.outcome).toBe("progress_write_failed");
      if (outcome?.outcome === "progress_write_failed") {
        expect(outcome.error.code).toBe("conflict");
      }
    }
    // The record's stage must still be whatever the concurrent writer actually left it as
    // (ci_waiting, revision 1) -- never requires_manual, which this attempt only *intended* but
    // never durably achieved.
    const reloaded = await progress.load(jobId);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toEqual({ kind: "ci_waiting" });
      expect(reloaded.value?.revision).toBe(1);
    }
  });
});
