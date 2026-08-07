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
import type {
  IssueAdmissionPort,
  IssueAdmissionRecord,
} from "../../src/adapters/dispatch/issue-admission-store.js";
import type { LinearDiscoveryReadModel } from "../../src/adapters/dispatch/linear-discovery.js";
import { FileJobRepository } from "../../src/infrastructure/jobs/index.js";
import { FileLeaseRepository } from "../../src/infrastructure/leases/index.js";
import { LeaseCoordinator } from "../../src/application/leases/index.js";
import {
  LifecyclePipeline,
  type CiRecoveryPipelineOutcome,
  type ReviewerPipelineOutcome,
  type BeginReviewOutcome,
  type RecordReviewOutcome,
  type EnableAutoMergeOutcome,
  type LifecyclePipelineOutcome,
} from "../../src/application/pipelines/index.js";
import { NoOpAutoMergePauseAdapter } from "../../src/cli/dispatch/lifecycle-policy-adapter.js";
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
  /** C015r decision 5: every call this test run made to the fake `reviewReportSidecar`, in order --
   * lets tests assert *only* a `report`-stage failure ever writes to it, and that the raw rejected
   * text reaches it (this fake, never any durable `JobProgressRecord`/`ResumeJobOutcome`). */
  readonly sidecarRecords: Readonly<{ jobId: string; category: string; rejectedOutput: string }>[];
  /** C015r decision 4: every request this test run's fake `reviewer.run` received, in order -- lets
   * a test assert `reportRetryFeedback` was (or was not) threaded in. */
  readonly reviewerRequests: unknown[];
  /** C015t decision 1/3: every request this test run's fake `lifecycle.run` received, in order --
   * lets a test assert `mergeAuthorizationHeadSha` is present (or deliberately absent) and inspect
   * `idempotencyKeyPrefix`. */
  readonly lifecycleRequests: unknown[];
  /** C015t decision 3: the fake admission store `reconcileMergeStateUnderLease` releases through --
   * seeded with one active claim for `(projectId, issueId)` by default so release-path tests have
   * something real to release. */
  readonly admission: InMemoryAdmissionFake;
  /** C015x decision 3: the real on-disk directory `progress` (`FileJobProgressStore`) is rooted
   * at -- exposed so a restart-safety test can construct a *second*, independent
   * `FileJobProgressStore` instance against the same directory (simulating a fresh
   * `agent-team run` process) and prove the persisted `noProgressCount`/`fingerprint` survive. */
  readonly progressDirectory: string;
}

/** C015t decision 3: minimal in-memory fake satisfying `IssueAdmissionPort` -- only `load`/`release`
 * are ever exercised by `reconcileMergeStateUnderLease` (the ordinary resume path never touches
 * admission at all), but the full interface is implemented for type compatibility. */
class InMemoryAdmissionFake implements IssueAdmissionPort {
  #records = new Map<string, IssueAdmissionRecord>();
  readonly releaseCalls: Readonly<{ projectId: string; issueId: string; reason: string }>[] = [];

  #key(projectId: string, issueId: string): string {
    return `${projectId}__${issueId}`;
  }

  seedActive(projectId: string, issueId: string, jobId?: string): void {
    this.#records.set(this.#key(projectId, issueId), {
      schemaVersion: 1,
      revision: 0,
      projectId: projectId as never,
      issueId: issueId as never,
      state: "active",
      claimedAt: now,
      updatedAt: now,
      ...(jobId === undefined ? {} : { jobId: jobId as never }),
    });
  }

  load(projectId: string, issueId: string) {
    return Promise.resolve(ok(this.#records.get(this.#key(projectId, issueId))));
  }

  claim(projectId: string, issueId: string) {
    if (this.#records.get(this.#key(projectId, issueId))?.state === "active") {
      return Promise.resolve(err(domainError("conflict")));
    }
    const record: IssueAdmissionRecord = {
      schemaVersion: 1,
      revision: 0,
      projectId: projectId as never,
      issueId: issueId as never,
      state: "active",
      claimedAt: now,
      updatedAt: now,
    };
    this.#records.set(this.#key(projectId, issueId), record);
    return Promise.resolve(ok(record));
  }

  attachJob(projectId: string, issueId: string, expectedRevision: number, jobId: string) {
    const existing = this.#records.get(this.#key(projectId, issueId));
    if (existing?.revision !== expectedRevision) {
      return Promise.resolve(err(domainError("conflict")));
    }
    const updated: IssueAdmissionRecord = {
      ...existing,
      jobId: jobId as never,
      revision: existing.revision + 1,
      updatedAt: now,
    };
    this.#records.set(this.#key(projectId, issueId), updated);
    return Promise.resolve(ok(updated));
  }

  release(
    projectId: string,
    issueId: string,
    expectedRevision: number,
    reason: string,
    supersededByJobId?: string,
  ) {
    this.releaseCalls.push({ projectId, issueId, reason });
    const existing = this.#records.get(this.#key(projectId, issueId));
    if (existing?.revision !== expectedRevision) {
      return Promise.resolve(err(domainError("conflict")));
    }
    const updated: IssueAdmissionRecord = {
      ...existing,
      state: "released",
      releaseReason: reason as never,
      revision: existing.revision + 1,
      updatedAt: now,
      ...(supersededByJobId === undefined ? {} : { supersededByJobId: supersededByJobId as never }),
    };
    this.#records.set(this.#key(projectId, issueId), updated);
    return Promise.resolve(ok(updated));
  }
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
  const sidecarRecords: Readonly<{ jobId: string; category: string; rejectedOutput: string }>[] =
    [];
  const reviewerRequests: unknown[] = [];
  const lifecycleRequests: unknown[] = [];
  const admission = new InMemoryAdmissionFake();
  admission.seedActive(projectId, issueId, jobId);
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
      run: (reviewerRequest) => {
        calls.push("reviewer.run");
        reviewerRequests.push(reviewerRequest);
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
              state: "auto_merge_enabled",
              reuse: "unchanged",
              identity: {},
              changeRequest: changeRequest({ state: "merged" }),
            } as never),
        );
      },
    },
    lifecycle: {
      run: (lifecycleRequest) => {
        calls.push("lifecycle.run");
        lifecycleRequests.push(lifecycleRequest);
        return Promise.resolve(
          overrides.lifecycleOutcome ??
            ({
              state: "completed",
              merge: "authorized",
              headSha,
              autoMergeDisposition: "not_required" as const,
            } as never),
        );
      },
    },
    clock: createFixedClock(now),
    holderId: "resume-holder",
    reviewReportSidecar: {
      record: (input) => {
        calls.push("reviewReportSidecar.record");
        sidecarRecords.push(input);
        return Promise.resolve(ok({ path: `/fake/${input.jobId}.json` }));
      },
    },
    admission,
  };
  return {
    deps,
    progress,
    jobRepository,
    calls,
    repositoryPath,
    sidecarRecords,
    reviewerRequests,
    lifecycleRequests,
    admission,
    progressDirectory,
  };
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
    if (reloaded.ok)
      expect(reloaded.value?.stage).toMatchObject({
        kind: "requires_manual",
        cause: { stage: "setup", reasonCode: "change_request_unavailable" },
      });
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
    if (reloaded.ok)
      expect(reloaded.value?.stage).toMatchObject({
        kind: "requires_manual",
        cause: { stage: "setup", reasonCode: "change_request_unavailable" },
      });
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
    if (reloaded.ok)
      expect(reloaded.value?.stage).toMatchObject({
        kind: "requires_manual",
        cause: { stage: "setup", reasonCode: "change_request_unavailable" },
      });
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
    if (reloaded.ok)
      expect(reloaded.value?.stage).toMatchObject({
        kind: "requires_manual",
        cause: { stage: "review", reasonCode: "review_provider_failed" },
      });
  });

  describe("C015r decisions 4/5: report-contract failures (separate from provider-start/run retries)", () => {
    it("a report-contract failure becomes review_report_pending_retry (never review_pending_retry) and writes the sidecar", async () => {
      const { deps, progress, sidecarRecords } = await harness({
        reviewerOutcome: {
          state: "failed",
          stage: "report",
          error: domainError("external_failure"),
          job: job(),
          reportFailureCategory: "enum_mismatch",
          rejectedOutput: '{"verdict":"met"}',
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
            stage: "report",
            error: domainError("external_failure"),
            retries: 1,
          },
        ]);
      }
      const reloaded = await progress.load(jobId);
      if (reloaded.ok) {
        expect(reloaded.value?.stage).toEqual({
          kind: "review_report_pending_retry",
          retries: 1,
          lastCategory: "enum_mismatch",
        });
        // Decision 1/5: the raw rejected text must never land in the durable progress record.
        expect(JSON.stringify(reloaded.value?.stage)).not.toContain("met");
      }
      expect(sidecarRecords).toEqual([
        { jobId, category: "enum_mismatch", rejectedOutput: '{"verdict":"met"}' },
      ]);
    });

    it("exhausts reportContractRetryLimit (1) on the second consecutive report-contract failure -> requires_manual with the closed-enum cause, no raw text in it", async () => {
      const { deps, progress, sidecarRecords } = await harness({
        reviewerOutcome: {
          state: "failed",
          stage: "report",
          error: domainError("external_failure"),
          job: job(),
          reportFailureCategory: "preamble_or_trailing_content",
          rejectedOutput: "Confirmed. {}",
        },
      });
      await seedProgressRecord(progress, {
        kind: "review_report_pending_retry",
        retries: 1,
        lastCategory: "enum_mismatch",
      });

      const result = await runResumeCycle(deps);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([
          {
            jobId,
            outcome: "requires_manual",
            reason: "review_report_contract:preamble_or_trailing_content",
          },
        ]);
      }
      const reloaded = await progress.load(jobId);
      if (reloaded.ok) {
        expect(reloaded.value?.stage).toEqual({
          kind: "requires_manual",
          cause: {
            stage: "review",
            reasonCode: "review_report_contract",
            attempts: { count: 2, lastCategory: "preamble_or_trailing_content" },
          },
        });
        expect(JSON.stringify(reloaded.value?.stage)).not.toContain("Confirmed");
      }
      // Decision 5 still fires on the exhausting attempt too -- every report-contract failure gets
      // a sidecar write, not just the ones that stay resumable.
      expect(sidecarRecords).toHaveLength(1);
      expect(sidecarRecords[0]).toMatchObject({ category: "preamble_or_trailing_content" });
    });

    it("threads the last report-contract failure category into the reviewer request as reportRetryFeedback when resuming review_report_pending_retry", async () => {
      const { deps, progress, reviewerRequests } = await harness({
        reviewerOutcome: { state: "approved", job: job(), changeRequest: changeRequest() } as never,
      });
      await seedProgressRecord(progress, {
        kind: "review_report_pending_retry",
        retries: 1,
        lastCategory: "missing_field",
      });

      await runResumeCycle(deps);

      expect(reviewerRequests).toHaveLength(1);
      expect(reviewerRequests[0]).toMatchObject({
        reportRetryFeedback: { category: "missing_field" },
      });
    });

    it("never sets reportRetryFeedback when resuming a plain ci_waiting record (first attempt, nothing to feed back)", async () => {
      const { deps, progress, reviewerRequests } = await harness({
        reviewerOutcome: { state: "approved", job: job(), changeRequest: changeRequest() } as never,
      });
      await seedProgressRecord(progress, { kind: "ci_waiting" });

      await runResumeCycle(deps);

      expect(reviewerRequests).toHaveLength(1);
      expect(reviewerRequests[0]).not.toHaveProperty("reportRetryFeedback");
    });
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
    if (reloaded.ok)
      expect(reloaded.value?.stage).toMatchObject({
        kind: "requires_manual",
        cause: { stage: "review", reasonCode: "review_provider_failed" },
      });
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
    if (reloaded.ok)
      expect(reloaded.value?.stage).toMatchObject({
        kind: "requires_manual",
        cause: { stage: "ci_recovery", reasonCode: "ci_recovery_failed" },
      });
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
    if (reloaded.ok)
      expect(reloaded.value?.stage).toMatchObject({
        kind: "requires_manual",
        cause: { stage: "setup", reasonCode: "change_request_unavailable" },
      });
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

/**
 * C015t decisions 1-3: `AutoMergeGate.enable()`'s new outcome union mapping, the `merge` cause-stage
 * fix, and the narrow `requires_manual` readback re-entry. Every test here uses the real
 * `EnableAutoMergeOutcome` type (imported above) for its fixtures -- no hand-rolled shapes that could
 * silently drift from the actual union.
 */
describe("C015t decisions 1-3: merge-outcome mapping, cause.stage, and narrow requires_manual readback", () => {
  it("② directly_merged: converges through Lifecycle with controller authorization, writes completed, and releases admission", async () => {
    const { deps, progress, lifecycleRequests, admission } = await harness({
      enableOutcome: {
        state: "directly_merged",
        changeRequest: changeRequest({ state: "merged" }),
      },
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([{ jobId, outcome: "completed" }]);

    expect(lifecycleRequests).toHaveLength(1);
    expect(lifecycleRequests[0]).toMatchObject({ mergeAuthorizationHeadSha: headSha });

    const reloaded = await progress.load(jobId);
    if (reloaded.ok) expect(reloaded.value?.stage).toEqual({ kind: "completed" });

    expect(admission.releaseCalls).toEqual([{ projectId, issueId, reason: "completed" }]);
  });

  it("③ already_merged_external: converges through Lifecycle but explicitly WITHOUT controller authorization (provenance never reverse-inferred)", async () => {
    const { deps, progress, lifecycleRequests, admission } = await harness({
      enableOutcome: {
        state: "already_merged_external",
        changeRequest: changeRequest({ state: "merged" }),
      },
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([{ jobId, outcome: "completed" }]);

    expect(lifecycleRequests).toHaveLength(1);
    // The exact assertion codex's review named: this must never carry a head-SHA-derived
    // authorization for a merge this call chain did not itself cause.
    expect(lifecycleRequests[0]).not.toHaveProperty("mergeAuthorizationHeadSha");

    const reloaded = await progress.load(jobId);
    if (reloaded.ok) expect(reloaded.value?.stage).toEqual({ kind: "completed" });
    expect(admission.releaseCalls).toEqual([{ projectId, issueId, reason: "completed" }]);
  });

  it("④ auto_merge_enabled not yet landed stays at merging (unchanged pre-existing behavior)", async () => {
    const { deps, progress } = await harness({
      enableOutcome: {
        state: "auto_merge_enabled",
        reuse: "unchanged",
        identity: {} as never,
        changeRequest: changeRequest({ autoMergeEnabled: true }),
      },
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([{ jobId, outcome: "merging" }]);
    const reloaded = await progress.load(jobId);
    // C015x decision 3: the arm-time write now seeds the persisted readback fingerprint/bound --
    // no longer the bare `{kind:"merging"}` -- see job-progress-store.ts's own header for why
    // `armedAt`/`fingerprint`/`noProgressCount` are all still schema-optional (back-compat with a
    // real, un-migrated `~/.agent-team/state` record this ticket is forbidden from touching), even
    // though every *new* write (this one included) always populates them.
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toEqual({
        kind: "merging",
        armedAt: now,
        fingerprint: { headSha, baseSha: "", mergeStateStatus: "unknown", merged: false },
        noProgressCount: 0,
      });
    }
  });

  it("④ not_ready:ci_pending / ci_failed map to still_ci_waiting (ci_waiting stage)", async () => {
    const { deps, progress } = await harness({
      enableOutcome: { state: "not_ready", reason: "ci_pending" },
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([{ jobId, outcome: "still_ci_waiting" }]);
    const reloaded = await progress.load(jobId);
    if (reloaded.ok) expect(reloaded.value?.stage).toEqual({ kind: "ci_waiting" });
  });

  it("④ re_review_required maps to awaiting_review, not requires_manual", async () => {
    const { deps, progress } = await harness({
      enableOutcome: {
        state: "re_review_required",
        reason: "effective_diff_changed",
        identity: {} as never,
      },
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([{ jobId, outcome: "awaiting_review" }]);
    const reloaded = await progress.load(jobId);
    if (reloaded.ok) expect(reloaded.value?.stage).toEqual({ kind: "awaiting_review" });
  });

  it("④ not_ready:review_status_missing also maps to awaiting_review", async () => {
    const { deps, progress } = await harness({
      enableOutcome: { state: "not_ready", reason: "review_status_missing" },
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([{ jobId, outcome: "awaiting_review" }]);
  });

  it("④ closed-not-merged-shaped not_ready reasons (draft/conflict) still go to requires_manual, cause.stage=merge", async () => {
    const { deps, progress } = await harness({
      enableOutcome: { state: "not_ready", reason: "draft" },
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        { jobId, outcome: "requires_manual", reason: "auto_merge_not_enabled:not_ready:draft" },
      ]);
    }
    const reloaded = await progress.load(jobId);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toMatchObject({
        kind: "requires_manual",
        cause: { stage: "merge", reasonCode: "auto_merge_not_enabled" },
      });
    }
  });

  it("⑤ a genuine auto_merge `failed` outcome writes cause.stage=merge, not review (the exact C015s mistag this ticket fixes)", async () => {
    const { deps, progress } = await harness({
      enableOutcome: {
        state: "failed",
        stage: "auto_merge",
        error: domainError("conflict"),
      },
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    await runResumeCycle(deps);
    const reloaded = await progress.load(jobId);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toMatchObject({
        kind: "requires_manual",
        cause: { stage: "merge", reasonCode: "auto_merge_not_enabled" },
      });
    }
  });

  it("⑥ narrow readback only fires for auto_merge_not_enabled/lifecycle_not_completed -- other requires_manual reasonCodes are left completely untouched", async () => {
    const { deps, progress, calls } = await harness();
    // jobId (the harness default): reconcilable reasonCode -- should be picked up.
    await seedProgressRecord(progress, {
      kind: "requires_manual",
      cause: {
        stage: "merge",
        reasonCode: "auto_merge_not_enabled",
        attempts: { count: 1 },
      },
    });
    // A second, distinct job at requires_manual for a NON-reconcilable reasonCode -- must be left
    // byte-for-byte untouched: no readback call, no CAS write.
    const otherJobId = id("job", "job_018f47d2-77a4-7cc1-8ef2-1123456789ab");
    await progress.compareAndSwap(otherJobId, null, {
      jobId: otherJobId,
      projectId,
      issueId,
      externalIssueId,
      model: "claude-opus",
      stage: {
        kind: "requires_manual",
        cause: {
          stage: "setup",
          reasonCode: "change_request_unavailable",
          attempts: { count: 1 },
        },
      },
      branch: "agent-team/job-2",
      worktreePath: "/tmp/does-not-need-to-exist-for-these-fakes",
      changeRequestId: "43",
      headSha,
    });
    const before = await progress.load(otherJobId);

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Exactly one outcome -- for jobId's own reconcile pass. otherJobId never appears at all.
      expect(result.value.map((outcome) => outcome.jobId)).toEqual([jobId]);
    }
    // Exactly one getChangeRequest call (jobId's reconcile readback) -- otherJobId's own
    // changeRequestId ("43") was never queried at all.
    expect(calls.filter((call) => call === "getChangeRequest")).toHaveLength(1);

    const after = await progress.load(otherJobId);
    expect(after).toEqual(before);
  });

  it("⑥/decision 3: readback=open leaves requires_manual completely unchanged, never auto-released", async () => {
    const { deps, progress, admission } = await harness({
      changeRequestState: { state: "open" },
    });
    await seedProgressRecord(progress, {
      kind: "requires_manual",
      cause: { stage: "merge", reasonCode: "auto_merge_not_enabled", attempts: { count: 1 } },
    });
    const before = await progress.load(jobId);

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        { jobId, outcome: "merge_reconcile_unchanged", readback: "open" },
      ]);
    }
    const after = await progress.load(jobId);
    expect(after).toEqual(before);
    expect(admission.releaseCalls).toEqual([]);
  });

  it("decision 3: readback=closed-not-merged leaves requires_manual unchanged -- never completed, never releases admission", async () => {
    const { deps, progress, admission } = await harness({
      changeRequestState: { state: "closed" },
    });
    await seedProgressRecord(progress, {
      kind: "requires_manual",
      cause: { stage: "merge", reasonCode: "lifecycle_not_completed", attempts: { count: 1 } },
    });
    const before = await progress.load(jobId);

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        { jobId, outcome: "merge_reconcile_unchanged", readback: "closed_not_merged" },
      ]);
    }
    const after = await progress.load(jobId);
    expect(after).toEqual(before);
    expect(admission.releaseCalls).toEqual([]);
  });

  it("decision 3: readback=merged converges -- Lifecycle runs unauthorized, progress becomes completed, admission releases last", async () => {
    const { deps, progress, lifecycleRequests, admission } = await harness({
      changeRequestState: { state: "merged" },
    });
    await seedProgressRecord(progress, {
      kind: "requires_manual",
      cause: { stage: "merge", reasonCode: "auto_merge_not_enabled", attempts: { count: 1 } },
    });

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([{ jobId, outcome: "merge_reconciled" }]);

    expect(lifecycleRequests).toHaveLength(1);
    expect(lifecycleRequests[0]).not.toHaveProperty("mergeAuthorizationHeadSha");
    expect(lifecycleRequests[0]).toMatchObject({
      idempotencyKeyPrefix: `cli-dispatch-reconcile:${jobId}:0:lifecycle`,
    });

    const reloaded = await progress.load(jobId);
    if (reloaded.ok) expect(reloaded.value?.stage).toEqual({ kind: "completed" });
    expect(admission.releaseCalls).toEqual([{ projectId, issueId, reason: "completed" }]);
  });

  /**
   * C015v decision 4's composition-matrix requirement: `merge provenance × PR state × policy
   * capability × Linear status × admission state`, covering the exact cell that deadlocked a real
   * E101 job before this ticket -- `external × merged × no real pause capability × non-terminal ×
   * active claim`. The test above already covers this shape with a *fake* `deps.lifecycle`; this
   * one swaps in a genuinely real `LifecyclePipeline` -- constructed with the real, capability-less
   * `NoOpAutoMergePauseAdapter` for policy (never a mocked `LifecyclePolicyPort`) -- so the full
   * chain (decision 3's admission-guarded reconcile pass -> real Lifecycle -> real policy adapter ->
   * real Linear-status transition -> real admission release) is proven to actually compose, not
   * just that each piece individually behaves correctly in isolation.
   */
  it("C015v decision 4 composition matrix: external provenance × merged PR × no real pause capability × non-terminal Linear status × active admission claim all converge together", async () => {
    const { deps, progress, admission } = await harness({
      changeRequestState: { state: "merged" },
    });
    await seedProgressRecord(progress, {
      kind: "requires_manual",
      cause: { stage: "merge", reasonCode: "auto_merge_not_enabled", attempts: { count: 1 } },
    });

    const linearCalls: string[] = [];
    let commentBody = "";
    const realLifecycle = new LifecyclePipeline({
      sourceControl: {
        getChangeRequest: () => Promise.resolve(ok(changeRequest({ state: "merged" }))),
        closeChangeRequest: () =>
          Promise.reject(new Error("must never be called: merge path only")),
      },
      workManagement: {
        getIssue: () => {
          linearCalls.push("getIssue");
          return Promise.resolve(
            ok({
              issue: {
                schemaVersion: 1 as const,
                id: issueId,
                projectId,
                externalId: externalIssueId,
                title: "Ship it",
              },
              // Non-terminal Linear status -- the exact matrix cell requiring a real completed
              // transition, not a no-op against an already-Done issue.
              workStatus: "in_review" as const,
              updatedAt: now,
              revision: "1",
            }),
          );
        },
        setWorkStatus: () => {
          linearCalls.push("setWorkStatus");
          return Promise.resolve(
            ok({
              issue: {
                schemaVersion: 1 as const,
                id: issueId,
                projectId,
                externalId: externalIssueId,
                title: "Ship it",
              },
              workStatus: "completed" as const,
              updatedAt: now,
              revision: "2",
            }),
          );
        },
        setAgentCondition: () => Promise.reject(new Error("must never be called")),
        appendComment: (_reference: unknown, body: string) => {
          linearCalls.push("appendComment");
          commentBody = body;
          return Promise.resolve(ok({ id: "comment-1", body, createdAt: now }));
        },
      },
      // Real, capability-less adapter -- never a mocked `LifecyclePolicyPort`. Its own only
      // possible answer, `not_applicable`, is what this whole matrix cell hinges on.
      policy: new NoOpAutoMergePauseAdapter(),
      cancellation: {
        prepare: () => Promise.reject(new Error("must never be called: merge path only")),
      },
    });

    const result = await runResumeCycle({ ...deps, lifecycle: realLifecycle });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([{ jobId, outcome: "merge_reconciled" }]);

    expect(linearCalls).toEqual(["getIssue", "setWorkStatus", "appendComment"]);
    expect(commentBody).toContain("該 PR 已合併，無 pending auto-merge 可取消");
    expect(commentBody).not.toContain("已暫停此專案新的 Auto-merge");

    const reloaded = await progress.load(jobId);
    if (reloaded.ok) expect(reloaded.value?.stage).toEqual({ kind: "completed" });
    const claim = await admission.load(projectId, issueId);
    expect(claim).toMatchObject({
      ok: true,
      value: { state: "released", releaseReason: "completed" },
    });
  });

  it("⑦ decision 3: a Lifecycle failure during reconcile leaves the record completely untouched (idempotent retry, same revision)", async () => {
    const { deps, progress, lifecycleRequests, admission } = await harness({
      changeRequestState: { state: "merged" },
      lifecycleOutcome: {
        state: "failed",
        stage: "work_status",
        error: domainError("external_failure"),
      } as never,
    });
    await seedProgressRecord(progress, {
      kind: "requires_manual",
      cause: { stage: "merge", reasonCode: "auto_merge_not_enabled", attempts: { count: 1 } },
    });
    const before = await progress.load(jobId);

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.outcome).toBe("merge_reconcile_lifecycle_failed");
    }
    const after = await progress.load(jobId);
    expect(after).toEqual(before); // no CAS write at all -- same revision preserved
    expect(admission.releaseCalls).toEqual([]);

    // Retrying (same revision, unchanged record) must reuse the exact same idempotencyKeyPrefix.
    await runResumeCycle(deps);
    expect(lifecycleRequests).toHaveLength(2);
    const [first, second] = lifecycleRequests as { idempotencyKeyPrefix: string }[];
    expect(first?.idempotencyKeyPrefix).toBe(second?.idempotencyKeyPrefix);
  });

  it("⑦ decision 3: admission already released by a concurrent process is treated as success, not an error", async () => {
    const { deps, progress, admission } = await harness({
      changeRequestState: { state: "merged" },
    });
    await admission.release(projectId, issueId, 0, "completed");
    await seedProgressRecord(progress, {
      kind: "requires_manual",
      cause: { stage: "merge", reasonCode: "lifecycle_not_completed", attempts: { count: 1 } },
    });

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([{ jobId, outcome: "merge_reconciled" }]);
    const reloaded = await progress.load(jobId);
    if (reloaded.ok) expect(reloaded.value?.stage).toEqual({ kind: "completed" });
  });
});

/**
 * C015x decision 3 (acceptance criterion ③): the resume-time half of the bounded `"merging"` wait
 * (`resumeMergingStage`, resume-composition.ts). Each test here builds its own `sourceControl` fake
 * on top of `harness()`'s otherwise-real wiring (real `FileJobProgressStore`, real
 * `FileJobRepository`, real `InMemoryAdmissionFake`) so the exact authoritative readback returned
 * on each individual `runResumeCycle` call can be varied call-by-call -- something `harness()`'s
 * own `changeRequestState` override cannot do (it is bound once, for the whole harness).
 */
describe("C015x decision 3: bounded still_merging (BEHIND visibility + persisted no-progress limit)", () => {
  function readbackDeps(
    base: Harness,
    readback: () => Readonly<Record<string, unknown>>,
  ): ResumeCycleDependencies {
    return {
      ...base.deps,
      sourceControl: { getChangeRequest: () => Promise.resolve(ok(changeRequest(readback()))) },
    };
  }

  it("escalates immediately to requires_manual(change_request_behind_base) the instant mergeStateStatus is behind, with no prior history", async () => {
    const base = await harness();
    await seedProgressRecord(base.progress, { kind: "merging" });
    const deps = readbackDeps(base, () => ({ mergeStateStatus: "behind", baseSha: "b".repeat(40) }));

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([{ jobId, outcome: "requires_manual", reason: "change_request_behind_base" }]);
    }

    const reloaded = await base.progress.load(jobId);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toEqual({
        kind: "requires_manual",
        cause: {
          stage: "merge",
          reasonCode: "change_request_behind_base",
          attempts: { count: 1 },
          mergeEvidence: {
            headSha,
            baseSha: "b".repeat(40),
            mergeStateStatus: "behind",
            merged: false,
          },
        },
      });
    }
  });

  it("escalates to requires_manual(auto_merge_stalled) only on the 5th consecutive unchanged readback, staying still_merging (and persisting noProgressCount) on the first 4", async () => {
    const base = await harness();
    // Seeded in the *normal* arm-time shape (matching exactly what `resumeReview`'s own
    // `auto_merge_enabled` arm-time write produces, resume-composition.ts) -- not the bare
    // pre-C015x shape (that migration path is covered by its own dedicated test below, where the
    // very first resume legitimately seeds a fresh baseline rather than counting as "no progress").
    await seedProgressRecord(base.progress, {
      kind: "merging",
      armedAt: now,
      fingerprint: { headSha, baseSha: "c".repeat(40), mergeStateStatus: "clean", merged: false },
      noProgressCount: 0,
    });
    const deps = readbackDeps(base, () => ({ mergeStateStatus: "clean", baseSha: "c".repeat(40) }));

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const result = await runResumeCycle(deps);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual([{ jobId, outcome: "still_merging" }]);
      const reloaded = await base.progress.load(jobId);
      if (reloaded.ok) {
        expect(reloaded.value?.stage).toMatchObject({ kind: "merging", noProgressCount: attempt });
      }
    }

    // Restart-safety (acceptance criterion ③'s own explicit requirement): a *different*
    // `FileJobProgressStore` instance against the exact same on-disk directory -- simulating a
    // fresh `agent-team run` process -- must see the persisted count and continue it, not reset it.
    const restartedProgress = new FileJobProgressStore(base.progressDirectory);
    const restartedDeps: ResumeCycleDependencies = { ...deps, progress: restartedProgress };

    const fifth = await runResumeCycle(restartedDeps);
    expect(fifth.ok).toBe(true);
    if (fifth.ok) {
      expect(fifth.value).toEqual([
        { jobId, outcome: "requires_manual", reason: "auto_merge_stalled" },
      ]);
    }
    const reloaded = await base.progress.load(jobId);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toEqual({
        kind: "requires_manual",
        cause: {
          stage: "merge",
          reasonCode: "auto_merge_stalled",
          attempts: { count: 5 },
          mergeEvidence: {
            headSha,
            baseSha: "c".repeat(40),
            mergeStateStatus: "clean",
            merged: false,
          },
        },
      });
    }
  });

  it("a changed fingerprint resets noProgressCount to 0 rather than escalating, even after prior no-progress resumes", async () => {
    const base = await harness();
    let baseSha = "d".repeat(40);
    await seedProgressRecord(base.progress, {
      kind: "merging",
      armedAt: now,
      fingerprint: { headSha, baseSha, mergeStateStatus: "clean", merged: false },
      noProgressCount: 0,
    });
    const deps = readbackDeps(base, () => ({ mergeStateStatus: "clean", baseSha }));

    await runResumeCycle(deps);
    await runResumeCycle(deps);
    const beforeChange = await base.progress.load(jobId);
    if (beforeChange.ok) {
      expect(beforeChange.value?.stage).toMatchObject({ kind: "merging", noProgressCount: 2 });
    }

    // The base branch's own tip moved (a real progress signal, e.g. a future E105 update-branch
    // action, or simply the base being re-observed differently) -- this must reset, not escalate.
    baseSha = "e".repeat(40);
    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([{ jobId, outcome: "still_merging" }]);
    const reloaded = await base.progress.load(jobId);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toMatchObject({ kind: "merging", noProgressCount: 0 });
    }
  });

  it("migrates a pre-C015x bare {kind:\"merging\"} record on its first resume, seeding a fresh baseline rather than treating absent history as zero progress", async () => {
    const base = await harness();
    // Exactly the shape a real, un-migrated `~/.agent-team/state` record has today -- this ticket
    // is forbidden from editing or migrating any existing file under that directory, so
    // `resumeMergingStage` must handle this shape correctly forever, not just once.
    await seedProgressRecord(base.progress, { kind: "merging" });
    const deps = readbackDeps(base, () => ({ mergeStateStatus: "clean", baseSha: "f".repeat(40) }));

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([{ jobId, outcome: "still_merging" }]);
    const reloaded = await base.progress.load(jobId);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toEqual({
        kind: "merging",
        armedAt: now,
        fingerprint: {
          headSha,
          baseSha: "f".repeat(40),
          mergeStateStatus: "clean",
          merged: false,
        },
        noProgressCount: 0,
      });
    }
  });
});
