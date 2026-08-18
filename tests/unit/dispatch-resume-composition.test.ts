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
 * not yet at the attempt limit -> implementer repair push; review-blocked, attempt limit reached ->
 * checkpointed (the "attempt-limit-checkpoint" scenario); lease conflict; exact-readback mismatch
 * -> requires_manual; a `"merging"`-staged job that re-checks merge status without re-running
 * CI/Review; a still-pending CI leaves the job at `ci_waiting` untouched.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runResumeCycle,
  type ResumeCycleDependencies,
} from "../../src/cli/dispatch/resume-composition.js";
import {
  FileJobProgressStore,
  type JobProgressRecordMutation,
} from "../../src/adapters/dispatch/job-progress-store.js";
import type {
  IssueAdmissionPort,
  IssueAdmissionRecord,
} from "../../src/adapters/dispatch/issue-admission-store.js";
import type { LinearDiscoveryReadModel } from "../../src/adapters/dispatch/linear-discovery.js";
import { FileJobRepository } from "../../src/infrastructure/jobs/index.js";
import { FileLeaseRepository } from "../../src/infrastructure/leases/index.js";
import { LeaseCoordinator } from "../../src/application/leases/index.js";
import {
  AutoMergeGate,
  LifecyclePipeline,
  REVIEW_STATUS_CONTEXT,
  canonicalVisualManifestInput,
  type CiRecoveryPipelineOutcome,
  type MergeGatePorts,
  type ReviewerRecoveryPipelineOutcome,
  type ReviewerPipelineOutcome,
  type ReviewerReport,
  type BeginReviewOutcome,
  type RecordReviewOutcome,
  type EnableAutoMergeOutcome,
  type LifecyclePipelineOutcome,
} from "../../src/application/pipelines/index.js";
import { NoOpAutoMergePauseAdapter } from "../../src/cli/dispatch/lifecycle-policy-adapter.js";
import type { ReviewerWaitPublicationPort } from "../../src/cli/dispatch/reviewer-wait-publication.js";
import {
  createFixedClock,
  domainError,
  err,
  ok,
  parseIdentifier,
  parseInstant,
  type Clock,
  type DomainError,
  type Identifier,
  type Instant,
  type Result,
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
  issueSchema,
  projectSchema,
  reviewRequirementSchema,
  type Project,
  type ReviewRequirement,
} from "../../src/domain/project/index.js";
import { readyGateTemplateHeadings } from "../../src/application/registration/linear-provision-model.js";
import { validReviewerRequest } from "../../src/application/pipelines/reviewer-policy.js";
import type {
  VisualEvidenceBuildRequest,
  VisualEvidenceBuildResult,
  VisualEvidenceVerifyRequest,
} from "../../src/application/pipelines/visual-evidence-builder.js";
import type { LinearPublicationResult } from "../../src/adapters/dispatch/linear-publication.js";
import {
  aggregateLinearPublicationDigest,
  type LinearPublicationReceiptRecord,
} from "../../src/adapters/dispatch/linear-publication-store.js";
import type { ProjectCommand } from "../../src/application/projects/index.js";
import { agentStatuses, blockingReasons } from "../../src/domain/workflow/index.js";
import type { WorkStatus } from "../../src/domain/workflow/index.js";
import {
  emptyAttemptCounters,
  jobSchema,
  watchdogHardStopMs,
  type Job,
} from "../../src/domain/jobs/index.js";
import {
  createReviewIdentity,
  headShaSchema,
  type EffectiveTreeChange,
} from "../../src/domain/review/index.js";

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
/** C015y decision A: the fixture "authoritative base" every test's default `changeRequest()`
 * (its `baseSha`) and default `resolveAuthoritativeBase` fake agree on -- almost every existing
 * test in this file seeds a *legacy* (pre-C015y) progress record (`seedProgressRecord` never sets
 * `baseRevision`), so `resolveLegacyBaseRevision`'s cross-check runs on every one of them; this
 * shared constant is what lets that cross-check succeed transparently unless a test deliberately
 * varies one side of it (see the dedicated `C015y decision A` describe block below for those). */
const baseRevisionValue = "f".repeat(40);
const baseRevision = (() => {
  const parsed = headShaSchema.safeParse(baseRevisionValue);
  if (!parsed.success) throw new Error("fixture invariant violated: invalid base revision");
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

/** E102-3: `reviewRequirement`/`description` are read directly off this snapshot (see
 * `toDomainIssue`, linear-discovery.ts) -- this fake `readIssue` bypasses the real
 * label-catalog-driven decoding entirely (unlike the real `LinearReadModel`), so setting
 * `reviewRequirement` here is the direct, correct way to drive a `visual_review`/`dual_review`
 * fixture, not a shortcut around anything real tests would otherwise exercise. */
function readModel(
  overrides: Readonly<{ reviewRequirement?: ReviewRequirement; description?: string }> = {},
): LinearDiscoveryReadModel {
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
          ...(overrides.reviewRequirement === undefined
            ? {}
            : { reviewRequirement: overrides.reviewRequirement }),
          ...(overrides.description === undefined ? {} : { description: overrides.description }),
        }),
      ),
  };
}

function acceptanceCriteriaDescription(criteria: readonly string[]): string {
  return `## ${readyGateTemplateHeadings.acceptanceCriteria}\n${criteria.map((criterion) => `- ${criterion}`).join("\n")}\n`;
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
    // C015y decision A: matches `baseRevisionValue`/the harness's default `resolveAuthoritativeBase`
    // fake -- see that constant's own header for why this must agree by default.
    baseSha: baseRevisionValue,
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
  /** E102-5: every request this test run's fake `linearPublication.publish` received, in order --
   * lets a test assert the exact `visualManifest`/`worktreePath`/`externalIssueId` threaded to it. */
  readonly linearPublicationRequests: unknown[];
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
      externalIssueId,
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
    ciRecoveryRun: ResumeCycleDependencies["ciRecovery"]["run"];
    reviewerOutcome: ReviewerPipelineOutcome;
    reviewerRecoveryOutcome: ReviewerRecoveryPipelineOutcome;
    beginOutcome: BeginReviewOutcome;
    recordOutcome: RecordReviewOutcome;
    enableOutcome: EnableAutoMergeOutcome;
    lifecycleOutcome: LifecyclePipelineOutcome;
    leaseConflict: boolean;
    leaseDurationMs: number;
    leaseHeartbeatIntervalMs: number;
    resolveAuthoritativeBaseOutcome: Awaited<
      ReturnType<ResumeCycleDependencies["resolveAuthoritativeBase"]>
    >;
    // E102-3: drives `readModel()`'s fake `readIssue` -- see that function's own header for why
    // setting `reviewRequirement` directly here is the correct fixture technique.
    reviewRequirement: ReviewRequirement;
    acceptanceCriteria: readonly string[];
    visualReviewCommands: readonly ProjectCommand[];
    visualEvidenceBuild: (
      request: VisualEvidenceBuildRequest,
    ) => Promise<VisualEvidenceBuildResult>;
    // E102-4b: drives the fake `deps.visualEvidence.verifyExisting` -- `resumeReview`'s pre-arm
    // merge recheck calls this (never `build()` again) once review-time succeeds for a
    // `dual_review`/`visual_review` job. Only ever wired (and only ever needs to be) when
    // `visualEvidenceBuild` is also supplied -- see this file's own `harness()` body for why the
    // key is always present on `deps.visualEvidence` (the real class's method is not optional) but
    // defaults to a loud rejection unless a test actually reaches the merge recheck.
    visualEvidenceVerify: (
      request: VisualEvidenceVerifyRequest,
    ) => Promise<VisualEvidenceBuildResult>;
    visualReviewModel: string;
    // E102-5: drives the fake `deps.linearPublication.publish` -- omitted means
    // `deps.linearPublication` itself stays undefined (the composition-root-gap fixture).
    linearPublish: (request: unknown) => Promise<LinearPublicationResult>;
    // E102-4b: drives the fake `deps.linearPublicationStore.load` -- `resumeReview`'s pre-arm merge
    // recheck calls this to recompute `currentPublicationDigest`. Omitted means
    // `deps.linearPublicationStore` itself stays undefined (the composition-root-gap fixture,
    // symmetric to `linearPublish`/`deps.linearPublication` above).
    linearPublicationStoreLoad: (
      projectId: string,
      issueId: string,
      headSha: string,
    ) => Promise<Result<LinearPublicationReceiptRecord | undefined, DomainError>>;
    reviewWaitPublish: ReviewerWaitPublicationPort["publish"];
    workStatus: WorkStatus;
    workStatusReadSequence: readonly WorkStatus[];
    prePrRun: NonNullable<ResumeCycleDependencies["prePrImplementation"]>["run"];
    workStatusTransition: NonNullable<ResumeCycleDependencies["workStatusLifecycle"]>["transition"];
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
    overrides.leaseDurationMs === undefined ? {} : { leaseDurationMs: overrides.leaseDurationMs },
  );
  if (overrides.leaseConflict === true) {
    await leases.acquire({ jobId, issueId, holderId: "other-holder" });
  }

  const calls: string[] = [];
  const sidecarRecords: Readonly<{ jobId: string; category: string; rejectedOutput: string }>[] =
    [];
  const reviewerRequests: unknown[] = [];
  const linearPublicationRequests: unknown[] = [];
  const lifecycleRequests: unknown[] = [];
  const admission = new InMemoryAdmissionFake();
  admission.seedActive(projectId, issueId, jobId);
  const visualEvidenceBuild = overrides.visualEvidenceBuild;
  const linearPublish = overrides.linearPublish;
  let currentWorkStatus = overrides.workStatus ?? "in_review";
  const workStatusReadSequence = [...(overrides.workStatusReadSequence ?? [])];
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
    workManagement: {
      getIssue: () =>
        Promise.resolve(
          ok({
            issue: issueSchema.parse({
              schemaVersion: 1,
              id: issueId,
              projectId,
              externalId: externalIssueId,
              title: "Ship the thing",
            }),
            workStatus: workStatusReadSequence.shift() ?? currentWorkStatus,
            updatedAt: now,
            revision: now,
          }),
        ),
    },
    ...(overrides.reviewWaitPublish === undefined
      ? {}
      : {
          reviewWaitPublication: {
            publish: (request) => {
              calls.push("reviewWaitPublication.publish");
              const publish = overrides.reviewWaitPublish;
              if (publish === undefined) throw new Error("unreachable");
              return publish(request);
            },
          },
        }),
    readModel: readModel({
      ...(overrides.reviewRequirement === undefined
        ? {}
        : { reviewRequirement: overrides.reviewRequirement }),
      ...(overrides.acceptanceCriteria === undefined
        ? {}
        : { description: acceptanceCriteriaDescription(overrides.acceptanceCriteria) }),
    }),
    teamId: "team-1",
    linearProjectId: "proj-1",
    project: project(repositoryPath),
    // E102-3: schema-complete (not the pre-existing loose `as never` stub) so the new
    // "assembled request satisfies the real `validReviewerRequest`" tests below can run the actual
    // production validator against it -- every field here matches `project(repositoryPath)`
    // exactly, the same way it always implicitly needed to for `commands.visualReview` (only ever
    // read when a job's `reviewRequirement` actually needs a visual reviewer) to be meaningful.
    trustedConfig: {
      schemaVersion: 1,
      projectId,
      defaultBranch: "main",
      platforms: {
        workManagement: { provider: "linear", containerId: "team-1", projectId: "proj-1" },
        sourceControl: { provider: "github", repository: "owner/sandbox" },
      },
      projectRules: [],
      roleInstructions: {},
      commands: {
        quality: [{ executable: "true", arguments: [] }],
        visualReview: [...(overrides.visualReviewCommands ?? [])],
      },
    },
    ciRecovery: {
      run: (request) => {
        calls.push("ciRecovery.run");
        if (overrides.ciRecoveryRun !== undefined) return overrides.ciRecoveryRun(request);
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
    ...(visualEvidenceBuild === undefined
      ? {}
      : {
          visualEvidence: {
            build: (request: VisualEvidenceBuildRequest) => {
              calls.push("visualEvidence.build");
              return visualEvidenceBuild(request);
            },
            // E102-4b: real production always has this key present (`VisualEvidenceBuilder`'s own
            // `verifyExisting` method is not optional) -- defaults to a loud rejection so any test
            // that never means to reach the merge recheck fails immediately, loudly, if it somehow
            // does, rather than silently succeeding on an unconsidered fixture. Only a test that
            // actually supplies `visualEvidenceVerify` (because it means to reach
            // `deps.autoMerge.enable`) gets real behavior here.
            verifyExisting: (request: VisualEvidenceVerifyRequest) => {
              calls.push("visualEvidence.verifyExisting");
              return (
                overrides.visualEvidenceVerify ??
                (() =>
                  Promise.reject(
                    new Error(
                      "visualEvidence.verifyExisting was called but this test never wired visualEvidenceVerify",
                    ),
                  ))
              )(request);
            },
          },
        }),
    ...(overrides.visualReviewModel === undefined
      ? {}
      : { visualReviewModel: overrides.visualReviewModel }),
    ...(linearPublish === undefined
      ? {}
      : {
          linearPublication: {
            publish: (request: unknown) => {
              calls.push("linearPublication.publish");
              linearPublicationRequests.push(request);
              return linearPublish(request);
            },
          },
        }),
    ...(overrides.linearPublicationStoreLoad === undefined
      ? {}
      : {
          linearPublicationStore: {
            load: (projectIdValue: string, issueIdValue: string, headShaValue: string) => {
              calls.push("linearPublicationStore.load");
              const loader = overrides.linearPublicationStoreLoad;
              if (loader === undefined) throw new Error("unreachable");
              return loader(projectIdValue, issueIdValue, headShaValue);
            },
          },
        }),
    reviewerRecovery: {
      run: () => {
        calls.push("reviewerRecovery.run");
        return Promise.resolve(
          overrides.reviewerRecoveryOutcome ??
            ({
              state: "repair_pushed",
              job: job(),
              commit: { sha: "b".repeat(40), branch: "agent-team/job-1" },
              push: { sha: "b".repeat(40), branch: "agent-team/job-1" },
            } as ReviewerRecoveryPipelineOutcome),
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
              mutations: [],
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
    ...(overrides.leaseHeartbeatIntervalMs === undefined
      ? {}
      : { leaseHeartbeatIntervalMs: overrides.leaseHeartbeatIntervalMs }),
    // C015y decision A: only ever exercised when a seeded record has no `baseRevision` (the
    // legacy-repair path) -- see `resolveLegacyBaseRevision`'s own header. Returns
    // `baseRevisionValue`, matching `changeRequest()`'s own default `baseSha` so the cross-check
    // succeeds transparently for every test that does not deliberately vary one side of it.
    resolveAuthoritativeBase: () => {
      calls.push("resolveAuthoritativeBase");
      return Promise.resolve(
        overrides.resolveAuthoritativeBaseOutcome ?? ok({ baseRevision, defaultBranch: "main" }),
      );
    },
    reviewReportSidecar: {
      record: (input) => {
        calls.push("reviewReportSidecar.record");
        sidecarRecords.push(input);
        return Promise.resolve(ok({ path: `/fake/${input.jobId}.json` }));
      },
    },
    admission,
    ...(overrides.workStatusTransition === undefined
      ? {}
      : {
          workStatusLifecycle: {
            transition: (request) => {
              calls.push(`workStatusLifecycle.transition:${request.step}`);
              const transition = overrides.workStatusTransition;
              if (transition === undefined) throw new Error("unreachable");
              return transition(request).then((outcome) => {
                if (
                  outcome.state === "permitted" &&
                  outcome.mode === "enforce" &&
                  request.mainTarget !== undefined
                ) {
                  currentWorkStatus = request.mainTarget;
                }
                return outcome;
              });
            },
          },
        }),
    ...(overrides.prePrRun === undefined
      ? {}
      : {
          prePrImplementation: {
            run: (record, options) => {
              calls.push("prePrImplementation.run");
              const run = overrides.prePrRun;
              if (run === undefined) throw new Error("unreachable");
              return run(record, options);
            },
          },
        }),
  };
  return {
    deps,
    progress,
    jobRepository,
    calls,
    repositoryPath,
    sidecarRecords,
    reviewerRequests,
    linearPublicationRequests,
    lifecycleRequests,
    admission,
    progressDirectory,
  };
}

async function seedProgressRecord(
  progress: FileJobProgressStore,
  stage: Readonly<{ kind: string }> & Readonly<Record<string, unknown>>,
  overrides: Partial<JobProgressRecordMutation> = {},
) {
  await progress.compareAndSwap(jobId, null, {
    jobId,
    projectId,
    issueId,
    externalIssueId,
    model: "gpt-5.6-terra",
    providerAssignments: {
      execution: { provider: "codex", model: "gpt-5.6-terra" },
      codeReview: { provider: "claude", model: "claude-opus" },
    },
    stage: stage as never,
    branch: "agent-team/job-1",
    worktreePath: "/tmp/does-not-need-to-exist-for-these-fakes",
    changeRequestId: "42",
    headSha,
    ...overrides,
    // C015z decision (Q3): a legacy (no-`baseRevision`) record now fails closed unconditionally to
    // `requires_manual(legacy_base_revision_unrecoverable)` instead of being transparently
    // repaired -- every test in this file *except* the dedicated "C015y decision A" describe block
    // (which builds its own records directly via `compareAndSwap`, bypassing this helper, precisely
    // to exercise the legacy path on purpose) needs a real `baseRevision` here to reach whatever
    // behavior it actually means to test.
    baseRevision: overrides.baseRevision ?? baseRevision,
  });
}

describe("runResumeCycle", () => {
  it("confirms In Review before invoking the reviewer for an enforce Job", async () => {
    const { deps, progress, calls } = await harness({
      workStatusTransition: () =>
        Promise.resolve({
          state: "permitted",
          mode: "enforce",
          main: "confirmed",
          agent: "confirmed",
        }),
    });
    await seedProgressRecord(
      progress,
      { kind: "ci_waiting" },
      {
        workStatusLifecycle: {
          admissionMode: "enforce",
          capabilityDigest: "c".repeat(64),
          phase: "implementing",
          transitions: [],
        },
      },
    );

    await runResumeCycle(deps);

    expect(calls.indexOf("reviewStatus.begin")).toBeLessThan(
      calls.indexOf("workStatusLifecycle.transition:review_start"),
    );
    expect(calls.indexOf("workStatusLifecycle.transition:review_start")).toBeLessThan(
      calls.indexOf("reviewer.run"),
    );
  });

  it("persists the terminal lifecycle transition before Lifecycle publishes its audit comment", async () => {
    const { deps, progress, calls } = await harness({
      workStatusTransition: () =>
        Promise.resolve({
          state: "permitted",
          mode: "enforce",
          main: "confirmed",
          agent: "confirmed",
        }),
    });
    await seedProgressRecord(
      progress,
      { kind: "ci_waiting" },
      {
        workStatusLifecycle: {
          admissionMode: "enforce",
          capabilityDigest: "c".repeat(64),
          phase: "implementing",
          transitions: [],
        },
      },
    );

    await expect(runResumeCycle(deps)).resolves.toMatchObject({
      ok: true,
      value: [{ outcome: "completed" }],
    });
    expect(calls.indexOf("workStatusLifecycle.transition:complete")).toBeGreaterThan(-1);
    expect(calls.indexOf("workStatusLifecycle.transition:complete")).toBeLessThan(
      calls.indexOf("lifecycle.run"),
    );
  });

  it("does not invoke the reviewer when the enforce In Review gate is unconfirmed", async () => {
    const { deps, progress, calls } = await harness({
      workStatusTransition: () =>
        Promise.resolve({ state: "blocked", reason: "human_status_drift" }),
    });
    await seedProgressRecord(
      progress,
      { kind: "ci_waiting" },
      {
        workStatusLifecycle: {
          admissionMode: "enforce",
          capabilityDigest: "c".repeat(64),
          phase: "implementing",
          transitions: [],
        },
      },
    );

    const result = await runResumeCycle(deps);

    expect(result).toMatchObject({
      ok: true,
      value: [
        { outcome: "requires_manual", reason: "work_status_review_start_human_status_drift" },
      ],
    });
    expect(calls).not.toContain("reviewer.run");
  });

  it("keeps a retryable lifecycle provider outage resumable before the bounded budget is exhausted", async () => {
    const { deps, progress, calls } = await harness({
      workStatusTransition: () =>
        Promise.resolve({
          state: "blocked",
          reason: "provider_outage",
          error: domainError("unavailable"),
        }),
    });
    await seedProgressRecord(
      progress,
      { kind: "ci_waiting" },
      {
        workStatusLifecycle: {
          admissionMode: "enforce",
          capabilityDigest: "c".repeat(64),
          phase: "implementing",
          transitions: [],
        },
      },
    );

    await expect(runResumeCycle(deps)).resolves.toMatchObject({
      ok: true,
      value: [{ outcome: "transient_failure", reason: "work_status_review_start_provider_outage" }],
    });
    expect(calls).not.toContain("reviewer.run");
  });

  it("moves a lifecycle transition to requires_manual when its bounded retry budget is exhausted", async () => {
    const { deps, progress, calls } = await harness({
      workStatusTransition: () =>
        Promise.resolve({
          state: "blocked",
          reason: "retry_exhausted",
          error: domainError("unavailable"),
        }),
    });
    await seedProgressRecord(
      progress,
      { kind: "ci_waiting" },
      {
        workStatusLifecycle: {
          admissionMode: "enforce",
          capabilityDigest: "c".repeat(64),
          phase: "implementing",
          transitions: [],
          incident: { reasonCode: "retry_exhausted", channel: "main" },
        },
      },
    );

    await expect(runResumeCycle(deps)).resolves.toMatchObject({
      ok: true,
      value: [{ outcome: "requires_manual", reason: "work_status_review_start_retry_exhausted" }],
    });
    expect(calls).not.toContain("reviewer.run");
  });

  it("confirms the fix transition before invoking ReviewerRecovery", async () => {
    const { deps, progress, calls } = await harness({
      reviewerOutcome: {
        state: "changes_requested",
        job: job(),
        changeRequest: changeRequest(),
        checks: {} as never,
        identity: {} as never,
        reports: [],
        findings: [],
      },
      workStatusTransition: () =>
        Promise.resolve({
          state: "permitted",
          mode: "enforce",
          main: "confirmed",
          agent: "confirmed",
        }),
    });
    await seedProgressRecord(
      progress,
      { kind: "ci_waiting" },
      {
        workStatusLifecycle: {
          admissionMode: "enforce",
          capabilityDigest: "c".repeat(64),
          phase: "implementing",
          transitions: [],
        },
      },
    );

    await runResumeCycle(deps);

    expect(calls.indexOf("workStatusLifecycle.transition:fix_start")).toBeGreaterThan(
      calls.indexOf("reviewStatus.record"),
    );
    expect(calls.indexOf("workStatusLifecycle.transition:fix_start")).toBeLessThan(
      calls.indexOf("reviewerRecovery.run"),
    );
  });

  it("re-reads cancellation immediately before Reviewer and invokes Reviewer zero times", async () => {
    const { deps, progress, calls } = await harness({
      workStatusReadSequence: ["in_review", "canceled"],
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    await expect(runResumeCycle(deps)).resolves.toEqual(
      ok([{ jobId, outcome: "requires_manual", reason: "provider_authority_mismatch" }]),
    );
    expect(calls).not.toContain("reviewer.run");
  });

  it("re-reads cancellation immediately before ReviewerRecovery and invokes it zero times", async () => {
    const { deps, progress, calls } = await harness({
      workStatusReadSequence: ["in_review", "in_review", "canceled"],
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

    await expect(runResumeCycle(deps)).resolves.toEqual(
      ok([{ jobId, outcome: "requires_manual", reason: "provider_authority_mismatch" }]),
    );
    expect(calls).toContain("reviewer.run");
    expect(calls).not.toContain("reviewerRecovery.run");
  });

  it("routes work_start_pending through the leased pre-PR path before any PR read", async () => {
    const { deps, progress, calls } = await harness({
      prePrRun: (record) => Promise.resolve({ jobId: record.jobId, outcome: "still_ci_waiting" }),
    });
    await progress.compareAndSwap(jobId, null, {
      jobId,
      projectId,
      issueId,
      externalIssueId,
      model: "gpt-5.6-terra",
      providerAssignments: {
        execution: { provider: "codex", model: "gpt-5.6-terra" },
        codeReview: { provider: "claude", model: "claude-opus" },
      },
      stage: { kind: "work_start_pending" },
      branch: "agent-team/job-1",
      worktreePath: "/tmp/pre-pr-fixture",
      workStatusLifecycle: {
        admissionMode: "off",
        phase: "work_start",
        transitions: [],
      },
    });

    await expect(runResumeCycle(deps)).resolves.toEqual({
      ok: true,
      value: [{ jobId, outcome: "still_ci_waiting" }],
    });
    expect(calls).toEqual(["prePrImplementation.run"]);
  });

  it("does not auto-resume a legacy bare implementing record", async () => {
    const { deps, progress, calls } = await harness({
      prePrRun: (record) => Promise.resolve({ jobId: record.jobId, outcome: "still_ci_waiting" }),
    });
    await progress.compareAndSwap(jobId, null, {
      jobId,
      projectId,
      issueId,
      externalIssueId,
      model: "gpt-5.6-terra",
      providerAssignments: {
        execution: { provider: "codex", model: "gpt-5.6-terra" },
        codeReview: { provider: "claude", model: "claude-opus" },
      },
      stage: { kind: "implementing" },
      branch: "agent-team/job-1",
      worktreePath: "/tmp/pre-pr-fixture",
    });

    await expect(runResumeCycle(deps)).resolves.toEqual({ ok: true, value: [] });
    expect(calls).toEqual([]);
  });

  it("fails a pre-ADR-009 record closed instead of guessing its execution or review provider", async () => {
    const { deps, progress, calls } = await harness();
    await progress.compareAndSwap(jobId, null, {
      jobId,
      projectId,
      issueId,
      externalIssueId,
      model: "claude-opus",
      stage: { kind: "ci_waiting" },
      branch: "agent-team/job-1",
      worktreePath: "/tmp/does-not-need-to-exist-for-these-fakes",
      changeRequestId: "42",
      headSha,
      baseRevision,
      // Deliberately omits providerAssignments: the old model string is not authoritative.
    });

    const result = await runResumeCycle(deps);
    expect(result).toEqual({
      ok: true,
      value: [
        { jobId, outcome: "requires_manual", reason: "legacy_provider_assignment_unavailable" },
      ],
    });
    expect(calls).toEqual([]);
    await expect(progress.load(jobId)).resolves.toMatchObject({
      ok: true,
      value: {
        stage: {
          kind: "requires_manual",
          cause: { stage: "setup", reasonCode: "legacy_provider_assignment_unavailable" },
        },
      },
    });
    const reloaded = await progress.load(jobId);
    expect(reloaded.ok && reloaded.value?.providerAssignments).toBeUndefined();
  });

  it("persists and publishes a confirmed Claude wall without accepting a partial review", async () => {
    const resetAt = instant("2026-08-07T13:00:00.000Z");
    const { deps, progress, calls } = await harness({
      reviewerOutcome: {
        state: "failed",
        stage: "provider_run",
        error: domainError("rate_limited"),
        job: job(),
        reviewWait: {
          confidence: "confirmed",
          bucket: "five_hour",
          resetAt,
          requirementsDigest: "a".repeat(64),
          headSha,
          diffDigest: "b".repeat(64),
        },
      },
      reviewWaitPublish: () => Promise.resolve(ok(undefined)),
    });
    await seedProgressRecord(progress, { kind: "awaiting_review" });

    const result = await runResumeCycle(deps);
    expect(result).toEqual({
      ok: true,
      value: [
        {
          jobId,
          outcome: "reviewer_waiting",
          reason: "confirmed_quota_wall",
          retryNotBefore: resetAt,
        },
      ],
    });
    expect(calls).toContain("reviewWaitPublication.publish");
    expect(calls).not.toContain("reviewStatus.record");
    expect(calls).not.toContain("autoMerge.enable");
    await expect(progress.load(jobId)).resolves.toMatchObject({
      ok: true,
      value: {
        stage: {
          kind: "reviewer_waiting",
          reason: "confirmed_quota_wall",
          confidence: "confirmed",
          bucket: "five_hour",
          resetAt,
          retryNotBefore: resetAt,
          publication: "confirmed",
          binding: { requirementsDigest: "a".repeat(64), headSha, diffDigest: "b".repeat(64) },
        },
      },
    });
  });

  it("keeps an unconfirmed Claude 429 waiting indefinitely until an operator confirms a retry", async () => {
    const { deps, progress } = await harness({
      reviewerOutcome: {
        state: "failed",
        stage: "provider_run",
        error: domainError("quota_unknown"),
        job: job(),
        reviewWait: {
          confidence: "unconfirmed",
          requirementsDigest: "c".repeat(64),
          headSha,
          diffDigest: "d".repeat(64),
        },
      },
      reviewWaitPublish: () => Promise.resolve(ok(undefined)),
    });
    await seedProgressRecord(progress, { kind: "awaiting_review" });

    await expect(runResumeCycle(deps)).resolves.toEqual({
      ok: true,
      value: [{ jobId, outcome: "reviewer_waiting", reason: "unconfirmed_throttling" }],
    });
    const loaded = await progress.load(jobId);
    expect(loaded.ok && loaded.value?.stage).toMatchObject({
      kind: "reviewer_waiting",
      confidence: "unconfirmed",
      publication: "confirmed",
    });
    if (loaded.ok && loaded.value?.stage.kind === "reviewer_waiting") {
      expect(loaded.value.stage.retryNotBefore).toBeUndefined();
    }
  });

  it("does not start Claude before retryNotBefore and only re-arms awaiting_review after it", async () => {
    const future = instant("2026-08-07T13:00:00.000Z");
    const first = await harness();
    await seedProgressRecord(first.progress, {
      kind: "reviewer_waiting",
      reason: "confirmed_quota_wall",
      confidence: "confirmed",
      bucket: "weekly",
      resetAt: future,
      retryNotBefore: future,
      binding: { requirementsDigest: "e".repeat(64), headSha, diffDigest: "f".repeat(64) },
      publication: "confirmed",
    });
    await expect(runResumeCycle(first.deps)).resolves.toEqual({
      ok: true,
      value: [
        {
          jobId,
          outcome: "reviewer_waiting",
          reason: "confirmed_quota_wall",
          retryNotBefore: future,
        },
      ],
    });
    expect(first.calls).not.toContain("reviewer.run");

    const past = instant("2026-08-07T11:00:00.000Z");
    const second = await harness();
    await seedProgressRecord(second.progress, {
      kind: "reviewer_waiting",
      reason: "confirmed_quota_wall",
      confidence: "confirmed",
      bucket: "weekly",
      resetAt: past,
      retryNotBefore: past,
      binding: { requirementsDigest: "e".repeat(64), headSha, diffDigest: "f".repeat(64) },
      publication: "confirmed",
    });
    await expect(runResumeCycle(second.deps)).resolves.toEqual({
      ok: true,
      value: [{ jobId, outcome: "awaiting_review" }],
    });
    expect(second.calls).not.toContain("reviewer.run");
    await expect(second.progress.load(jobId)).resolves.toMatchObject({
      ok: true,
      value: { stage: { kind: "awaiting_review" } },
    });
  });

  it("happy path: ci_waiting -> CI green -> approved -> merged -> Lifecycle completed, in one cycle", async () => {
    const { deps, progress, calls } = await harness({ changeRequestState: { draft: true } });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([{ jobId, outcome: "completed" }]);
    expect(calls).toEqual([
      "getChangeRequest",
      // C015y decision A: this record already carries a `baseRevision` (`seedProgressRecord`'s own
      // default, C015z) -- `resolveAuthoritativeBase` is never called; that seam is now exercised
      // only by the dedicated "C015y decision A" describe block below.
      "ciRecovery.run",
      "reviewStatus.begin",
      "getChangeRequest",
      "reviewer.run",
      "reviewStatus.record",
      "autoMerge.enable",
      "lifecycle.run",
    ]);

    const reloaded = await progress.load(jobId);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) expect(reloaded.value?.stage).toEqual({ kind: "completed" });
  });

  it("reruns a fresh Reviewer for an existing success status before merge instead of reusing it", async () => {
    const { deps, progress, calls } = await harness({
      beginOutcome: {
        state: "already_approved",
        changeRequest: changeRequest(),
        checks: { headSha, aggregate: "success", checks: [] },
      },
    });
    await seedProgressRecord(progress, {
      kind: "requires_manual",
      cause: {
        stage: "review",
        reasonCode: "review_reuse_unimplemented",
        attempts: { count: 1 },
      },
    });

    const result = await runResumeCycle(deps);

    expect(result).toEqual(ok([{ jobId, outcome: "completed" }]));
    expect(calls).toEqual([
      "getChangeRequest",
      "reviewStatus.begin",
      "getChangeRequest",
      "reviewer.run",
      "reviewStatus.record",
      "autoMerge.enable",
      "lifecycle.run",
    ]);
    const reloaded = await progress.load(jobId);
    expect(reloaded.ok && reloaded.value?.stage).toEqual({ kind: "completed" });
  });

  it("selection is bound to the inventory revision and never retries a changed candidate", async () => {
    const { deps, progress, calls } = await harness();
    await seedProgressRecord(progress, { kind: "ci_waiting" });
    const loaded = await progress.load(jobId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok || loaded.value === undefined) return;

    const result = await runResumeCycle(deps, {
      selections: [{ jobId, expectedRevision: loaded.value.revision + 1 }],
    });

    expect(result).toEqual(
      ok([{ jobId, outcome: "candidate_changed", reason: "revision_changed" }]),
    );
    expect(calls).toEqual([]);
  });

  it("revalidates the selected revision after acquiring the lease before any external call", async () => {
    const { deps, progress, calls } = await harness();
    const prepare = vi.fn(() => Promise.resolve());
    await seedProgressRecord(progress, { kind: "ci_waiting" });
    const selected = await progress.load(jobId);
    expect(selected.ok).toBe(true);
    if (!selected.ok || selected.value === undefined) return;
    const selectedRecord = selected.value;

    const acquire = deps.leases.acquire.bind(deps.leases);
    vi.spyOn(deps.leases, "acquire").mockImplementationOnce(async (request) => {
      const { schemaVersion, revision, updatedAt, ...mutation } = selectedRecord;
      void schemaVersion;
      void updatedAt;
      const changed = await progress.compareAndSwap(jobId, revision, {
        ...mutation,
        stage: {
          kind: "paused",
          checkpointId: id("checkpoint", "checkpoint_018f47d2-77a4-7cc1-8ef2-0123456789ab"),
        },
      });
      expect(changed.ok).toBe(true);
      return acquire(request);
    });

    const result = await runResumeCycle(
      { ...deps, prepare },
      {
        selections: [{ jobId, expectedRevision: selectedRecord.revision }],
      },
    );

    expect(result).toEqual(
      ok([{ jobId, outcome: "candidate_changed", reason: "revision_changed" }]),
    );
    expect(prepare).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("renews the per-job lease while a long provider call is still running", async () => {
    let finishCi: ((outcome: CiRecoveryPipelineOutcome) => void) | undefined;
    let observedSignal: AbortSignal | undefined;
    let markCiStarted: (() => void) | undefined;
    const ciStarted = new Promise<void>((resolve) => {
      markCiStarted = resolve;
    });
    const { deps, progress } = await harness({
      changeRequestState: { draft: true },
      leaseDurationMs: 2_000,
      leaseHeartbeatIntervalMs: 20,
      ciRecoveryRun: (request) => {
        observedSignal = request.signal;
        markCiStarted?.();
        return new Promise((resolve) => {
          finishCi = resolve;
        });
      },
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const renew = vi
      .spyOn(deps.leases, "renew")
      .mockResolvedValue(ok({ value: {}, changed: true }) as never);
    const running = runResumeCycle(deps);
    await ciStarted;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(renew).toHaveBeenCalled();
    const competing = await deps.leases.acquire({ jobId, issueId, holderId: "second-process" });
    expect(competing).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(false);

    finishCi?.({ state: "ready_for_review", source: "polling", job: job(), checks: {} } as never);
    await expect(running).resolves.toEqual(ok([{ jobId, outcome: "completed" }]));
  });

  it("aborts the provider request and reports lease_conflict when renewal is lost", async () => {
    let observedSignal: AbortSignal | undefined;
    let providerStarted = false;
    const { deps, progress, calls } = await harness({
      changeRequestState: { draft: true },
      leaseHeartbeatIntervalMs: 5,
      ciRecoveryRun: (request) => {
        providerStarted = true;
        observedSignal = request.signal;
        return new Promise((resolve) => {
          request.signal?.addEventListener(
            "abort",
            () => {
              resolve({
                state: "failed",
                stage: "provider_run",
                error: domainError("conflict"),
                job: job(),
              });
            },
            { once: true },
          );
        });
      },
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });
    const renew = deps.leases.renew.bind(deps.leases);
    vi.spyOn(deps.leases, "renew").mockImplementation((request) =>
      providerStarted ? Promise.resolve(err(domainError("external_failure"))) : renew(request),
    );

    const result = await runResumeCycle(deps);

    expect(result).toEqual(ok([{ jobId, outcome: "lease_conflict" }]));
    expect(observedSignal?.aborted).toBe(true);
    expect(calls).not.toContain("reviewer.run");
    expect(calls).not.toContain("autoMerge.enable");
  });

  it("stops after a provider ignores abort and returns success after lease renewal is lost", async () => {
    let providerStarted = false;
    const { deps, progress, calls } = await harness({
      changeRequestState: { draft: true },
      leaseHeartbeatIntervalMs: 5,
      ciRecoveryRun: async () => {
        providerStarted = true;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return {
          state: "ready_for_review",
          source: "polling",
          job: job(),
          checks: {},
        } as never;
      },
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });
    const renew = deps.leases.renew.bind(deps.leases);
    vi.spyOn(deps.leases, "renew").mockImplementation((request) =>
      providerStarted ? Promise.resolve(err(domainError("external_failure"))) : renew(request),
    );

    const result = await runResumeCycle(deps);

    expect(result).toEqual(ok([{ jobId, outcome: "lease_conflict" }]));
    expect(calls).toContain("ciRecovery.run");
    expect(calls).not.toContain("reviewer.run");
    expect(calls).not.toContain("autoMerge.enable");
    const reloaded = await progress.load(jobId);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) expect(reloaded.value?.stage).toEqual({ kind: "ci_waiting" });
  });

  it("C035: ci_waiting canceled in Linear stops before CI, review, or merge", async () => {
    const { deps, progress, calls } = await harness({
      workStatus: "canceled",
      lifecycleOutcome: {
        state: "canceled",
        changeRequest: "closed",
        checkpoint: "preserved",
        checkpointId: "checkpoint_018f47d2-77a4-7cc1-8ef2-0123456789ab",
      },
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);

    expect(result).toEqual(
      ok([{ jobId, outcome: "requires_manual", reason: "work_item_canceled" }]),
    );
    expect(calls).toEqual(["getChangeRequest", "lifecycle.run"]);
  });

  it("C035: an armed merging job canceled in Linear preserves the actual merge mutation audit across resume", async () => {
    const { deps, progress, calls, lifecycleRequests } = await harness({
      workStatus: "canceled",
      lifecycleOutcome: {
        state: "canceled",
        changeRequest: "closed",
        checkpoint: "preserved",
        checkpointId: "checkpoint_018f47d2-77a4-7cc1-8ef2-0123456789ab",
      },
    });
    await seedProgressRecord(
      progress,
      { kind: "merging", armedAt: now },
      {
        mergeMutations: [
          {
            kind: "enable_auto_merge",
            idempotencyKey: "resume-test:enable-auto-merge",
            attemptedAt: now,
            outcome: "confirmed_enabled",
          },
        ],
      },
    );

    const result = await runResumeCycle(deps);

    expect(result).toEqual(
      ok([{ jobId, outcome: "requires_manual", reason: "work_item_canceled" }]),
    );
    expect(calls).toEqual(["getChangeRequest", "lifecycle.run"]);
    expect(lifecycleRequests[0]).toMatchObject({
      cancellationRaceAudit: {
        observedAt: now,
        mergeMutations: [
          {
            kind: "enable_auto_merge",
            idempotencyKey: "resume-test:enable-auto-merge",
            attemptedAt: now,
            outcome: "confirmed_enabled",
          },
        ],
      },
    });
  });

  it("CI-red -> CiRecoveryPipeline checkpoints (attempt-count scenario) -> stage paused with checkpointId", async () => {
    const { deps, progress } = await harness({
      changeRequestState: { draft: true },
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
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toEqual({
        kind: "paused",
        checkpointId: "checkpoint_018f47d2-77a4-7cc1-8ef2-0123456789ab",
      });
    }
  });

  it("review-blocked, attempt limit not yet reached -> reviewer recovery pushes repair", async () => {
    const { deps, progress, calls } = await harness({
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
      expect(result.value).toEqual([{ jobId, outcome: "reviewer_fix_pushed" }]);
    }
    expect(calls).toContain("reviewerRecovery.run");
    const reloaded = await progress.load(jobId);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) expect(reloaded.value?.stage).toEqual({ kind: "ci_waiting" });
  });

  it("clarification_required keeps the existing fix_round transition without reviewer recovery", async () => {
    const { deps, progress, calls } = await harness({
      reviewerOutcome: {
        state: "clarification_required",
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
      expect(result.value).toEqual([
        { jobId, outcome: "fix_round", verdict: "clarification_required" },
      ]);
    }
    expect(calls).not.toContain("reviewerRecovery.run");
    const reloaded = await progress.load(jobId);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) expect(reloaded.value?.stage).toEqual({ kind: "fix_round" });
  });

  it("reviewer recovery checkpoint maps to a paused stage with its checkpoint id", async () => {
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
      reviewerRecoveryOutcome: {
        state: "checkpointed",
        reason: "attempt_limit_reached",
        job: job(),
        checkpointId: "checkpoint_018f47d2-77a4-7cc1-8ef2-2123456789ab",
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
          checkpointId: "checkpoint_018f47d2-77a4-7cc1-8ef2-2123456789ab",
        },
      ]);
    }
    const reloaded = await progress.load(jobId);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toEqual({
        kind: "paused",
        checkpointId: "checkpoint_018f47d2-77a4-7cc1-8ef2-2123456789ab",
      });
    }
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
    expect(reloaded.ok).toBe(true);
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
    expect(reloaded.ok).toBe(true);
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
    expect(reloaded.ok).toBe(true);
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
    expect(reloaded.ok).toBe(true);
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
    expect(reloaded.ok).toBe(true);
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
      changeRequestState: { draft: true },
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
    expect(reloaded.ok).toBe(true);
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
    expect(reloaded.ok).toBe(true);
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
    expect(reloaded.ok).toBe(true);
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
      expect(reloaded.ok).toBe(true);
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
      expect(reloaded.ok).toBe(true);
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
    expect(reloaded.ok).toBe(true);
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
      changeRequestState: { draft: true },
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
    expect(reloaded.ok).toBe(true);
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
      changeRequestState: { draft: true },
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
    expect(reloaded.ok).toBe(true);
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
    const { deps: baseDeps, progress } = await harness({ changeRequestState: { draft: true } });
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
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toEqual({ kind: "ci_waiting" });
      expect(reloaded.value?.revision).toBe(0);
    }
  });

  it("C031: resumes a non-draft review_report_pending_retry directly through reviewer with report retry feedback", async () => {
    const { deps, progress, calls, reviewerRequests } = await harness();
    await seedProgressRecord(progress, {
      kind: "review_report_pending_retry",
      retries: 1,
      lastCategory: "schema_invalid",
    });

    const result = await runResumeCycle(deps);

    expect(result.ok).toBe(true);
    expect(calls).not.toContain("ciRecovery.run");
    expect(calls).toContain("reviewer.run");
    expect(reviewerRequests[reviewerRequests.length - 1]).toMatchObject({
      reportRetryFeedback: { category: "schema_invalid" },
    });
  });

  it("C031: a draft PR resume still runs CI recovery", async () => {
    const { deps, progress, calls } = await harness({ changeRequestState: { draft: true } });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);

    expect(result.ok).toBe(true);
    expect(calls).toContain("ciRecovery.run");
  });

  it("C031: a non-draft PR with failed CI at review begin requires manual intervention", async () => {
    const { deps, progress } = await harness({
      beginOutcome: {
        state: "not_ready",
        reason: "ci_failed",
        changeRequest: changeRequest(),
        checks: {} as never,
      },
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        { jobId, outcome: "requires_manual", reason: "ci_failed_after_ready" },
      ]);
    }
    const reloaded = await progress.load(jobId);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toMatchObject({
        kind: "requires_manual",
        cause: { stage: "review", reasonCode: "ci_failed_after_ready" },
      });
    }
  });

  it("C031: a non-draft PR with pending CI at review begin remains ci_waiting", async () => {
    const { deps, progress } = await harness({
      beginOutcome: {
        state: "not_ready",
        reason: "ci_pending",
        changeRequest: changeRequest(),
        checks: {} as never,
      },
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([{ jobId, outcome: "still_ci_waiting" }]);
    const reloaded = await progress.load(jobId);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) expect(reloaded.value?.stage).toEqual({ kind: "ci_waiting" });
  });

  // C031: pins the `!begin.changeRequest.draft` half of the `ci_failed_after_ready` guard. A draft
  // PR can still reach `begin()` with `ci_failed` -- CI recovery hands back `ready_for_review` and
  // the merge gate's own re-read races a check turning red -- and that job must stay resumable, so
  // the next cycle can drive it back through CI recovery. Only a non-draft PR, which recovery can
  // never touch again, is allowed to fail closed here.
  it("C031: a draft PR with failed CI at review begin still retreats to ci_waiting", async () => {
    const { deps, progress } = await harness({
      changeRequestState: { draft: true },
      beginOutcome: {
        state: "not_ready",
        reason: "ci_failed",
        changeRequest: changeRequest({ draft: true }),
        checks: {} as never,
      },
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([{ jobId, outcome: "still_ci_waiting" }]);
    const reloaded = await progress.load(jobId);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) expect(reloaded.value?.stage).toEqual({ kind: "ci_waiting" });
  });

  it("C031: a non-draft review_pending_retry does not re-enter CI recovery", async () => {
    const { deps, progress, calls } = await harness();
    await seedProgressRecord(progress, {
      kind: "review_pending_retry",
      retries: 1,
      lastErrorCode: "timeout",
    });

    const result = await runResumeCycle(deps);

    expect(result.ok).toBe(true);
    expect(calls).not.toContain("ciRecovery.run");
  });

  it("C031: a non-draft fix_round does not re-enter CI recovery", async () => {
    const { deps, progress, calls } = await harness();
    await seedProgressRecord(progress, { kind: "fix_round" });

    const result = await runResumeCycle(deps);

    expect(result.ok).toBe(true);
    expect(calls).not.toContain("ciRecovery.run");
  });

  it("C031: a non-draft awaiting_review does not re-enter CI recovery", async () => {
    const { deps, progress, calls } = await harness();
    await seedProgressRecord(progress, { kind: "awaiting_review" });

    const result = await runResumeCycle(deps);

    expect(result.ok).toBe(true);
    expect(calls).not.toContain("ciRecovery.run");
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
    expect(reloaded.ok).toBe(true);
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
    expect(reloaded.ok).toBe(true);
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
        headSha,
        mutations: [
          {
            kind: "direct_squash",
            idempotencyKey: "resume-test:direct-squash",
            attemptedAt: now,
            outcome: "merged_directly",
          },
        ],
      },
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([{ jobId, outcome: "completed" }]);

    expect(lifecycleRequests).toHaveLength(1);
    expect(lifecycleRequests[0]).toMatchObject({ mergeAuthorizationHeadSha: headSha });

    const reloaded = await progress.load(jobId);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) expect(reloaded.value?.stage).toEqual({ kind: "completed" });

    expect(admission.releaseCalls).toEqual([{ projectId, issueId, reason: "completed" }]);
  });

  it("C035: persists direct-squash receipts before Lifecycle so a later failure cannot erase them", async () => {
    const receipt = {
      kind: "direct_squash" as const,
      idempotencyKey: "resume-test:direct-squash",
      attemptedAt: now,
      outcome: "merged_directly" as const,
    };
    const { deps, progress } = await harness({
      enableOutcome: { state: "directly_merged", headSha, mutations: [receipt] },
      lifecycleOutcome: {
        state: "failed",
        stage: "comment",
        error: domainError("external_failure"),
      },
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);

    expect(result.ok).toBe(true);
    const reloaded = await progress.load(jobId);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) expect(reloaded.value?.mergeMutations).toEqual([receipt]);
  });

  it("C035: persists failed fallback receipts before entering requires-manual", async () => {
    const receipts = [
      {
        kind: "enable_auto_merge" as const,
        idempotencyKey: "resume-test:enable-auto-merge",
        attemptedAt: now,
        outcome: "outcome_unknown" as const,
      },
      {
        kind: "direct_squash" as const,
        idempotencyKey: "resume-test:direct-squash",
        attemptedAt: now,
        outcome: "rejected" as const,
      },
    ] as const;
    const { deps, progress } = await harness({
      enableOutcome: {
        state: "failed",
        stage: "auto_merge",
        error: domainError("external_failure"),
        mutations: receipts,
      },
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);

    expect(result.ok).toBe(true);
    const reloaded = await progress.load(jobId);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) expect(reloaded.value?.mergeMutations).toEqual(receipts);
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
    expect(reloaded.ok).toBe(true);
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
        mutations: [
          {
            kind: "enable_auto_merge",
            idempotencyKey: "resume-test:enable-auto-merge",
            attemptedAt: now,
            outcome: "confirmed_enabled",
          },
        ],
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
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toEqual({
        kind: "merging",
        armedAt: now,
        // C015z decision (Q4): the fingerprint no longer carries `baseSha` at all -- see
        // `mergeFingerprintOf`'s own header (resume-composition.ts).
        fingerprint: {
          headSha,
          mergeStateStatus: "unknown",
          merged: false,
        },
        noProgressCount: 0,
        // C015y decision C: seeded to this same arm-time instant.
        lastProgressAt: now,
      });
      expect(reloaded.value?.mergeMutations).toEqual([
        {
          kind: "enable_auto_merge",
          idempotencyKey: "resume-test:enable-auto-merge",
          attemptedAt: now,
          outcome: "confirmed_enabled",
        },
      ]);
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
    expect(reloaded.ok).toBe(true);
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
    expect(reloaded.ok).toBe(true);
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
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toMatchObject({
        kind: "requires_manual",
        cause: { stage: "merge", reasonCode: "auto_merge_not_enabled" },
      });
    }
  });

  it("E116cap: not_ready:auto_merge_paused maps to requires_manual with a dedicated reasonCode, never the generic auto_merge_not_enabled bucket", async () => {
    const { deps, progress } = await harness({
      enableOutcome: { state: "not_ready", reason: "auto_merge_paused" },
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        {
          jobId,
          outcome: "requires_manual",
          reason: "auto_merge_paused_out_of_process_merge",
        },
      ]);
    }
    const reloaded = await progress.load(jobId);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toMatchObject({
        kind: "requires_manual",
        cause: { stage: "merge", reasonCode: "auto_merge_paused_out_of_process_merge" },
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
    expect(reloaded.ok).toBe(true);
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
      model: "gpt-5.6-terra",
      providerAssignments: {
        execution: { provider: "codex", model: "gpt-5.6-terra" },
        codeReview: { provider: "claude", model: "claude-opus" },
      },
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
      idempotencyKeyPrefix: `cli-dispatch-lifecycle:${jobId}:42`,
    });

    const reloaded = await progress.load(jobId);
    expect(reloaded.ok).toBe(true);
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
      leaseRelease: {
        release: () => Promise.reject(new Error("must never be called: merge path only")),
      },
    });

    const result = await runResumeCycle({ ...deps, lifecycle: realLifecycle });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([{ jobId, outcome: "merge_reconciled" }]);

    expect(linearCalls).toEqual(["getIssue", "setWorkStatus", "appendComment"]);
    expect(commentBody).toContain("該 PR 已合併，無 pending auto-merge 可取消");
    expect(commentBody).not.toContain("已暫停此專案新的 Auto-merge");

    const reloaded = await progress.load(jobId);
    expect(reloaded.ok).toBe(true);
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

  it("C035: reconcile forwards durable receipts when a later run discovers merged+canceled", async () => {
    const receipt = {
      kind: "direct_squash" as const,
      idempotencyKey: "resume-test:direct-squash",
      attemptedAt: now,
      outcome: "merged_directly" as const,
    };
    const { deps, progress, lifecycleRequests } = await harness({
      workStatus: "canceled",
      changeRequestState: { state: "merged" },
      lifecycleOutcome: { state: "blocked", reason: "cancellation_after_merge" },
    });
    await seedProgressRecord(
      progress,
      {
        kind: "requires_manual",
        cause: { stage: "merge", reasonCode: "lifecycle_not_completed", attempts: { count: 1 } },
      },
      { mergeMutations: [receipt] },
    );

    const result = await runResumeCycle(deps);

    expect(result.ok).toBe(true);
    expect(lifecycleRequests[0]).toMatchObject({
      cancellationRaceAudit: { observedAt: now, mergeMutations: [receipt] },
    });
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
    expect(reloaded.ok).toBe(true);
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

  /** C015y decision C acceptance criterion ③: every wall-clock assertion in this describe block
   * needs a *controllable* clock -- `createFixedClock` (harness()'s own default) never advances,
   * so it cannot exercise the new `now - lastProgressAt`/`now - armedAt` conditions at all. A
   * closure-based fake satisfying the plain `Clock` interface (`{now(): Instant}`) is sufficient;
   * no production seam changes needed for this. */
  function mutableClock(
    start: Instant,
  ): Readonly<{ clock: Clock; advanceMinutes: (m: number) => void }> {
    let value = start;
    return Object.freeze({
      clock: Object.freeze({ now: () => value }),
      advanceMinutes(minutes: number) {
        const next = new Date(Date.parse(value) + minutes * 60_000).toISOString();
        const parsed = parseInstant(next);
        if (!parsed.ok)
          throw new Error("fixture invariant violated: clock advance produced an invalid instant");
        value = parsed.value;
      },
    });
  }

  it("escalates immediately to requires_manual(change_request_behind_base) the instant mergeStateStatus is behind, with no prior history", async () => {
    const base = await harness();
    await seedProgressRecord(base.progress, { kind: "merging" });
    const deps = readbackDeps(base, () => ({
      mergeStateStatus: "behind",
      baseSha: "b".repeat(40),
    }));

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        { jobId, outcome: "requires_manual", reason: "change_request_behind_base" },
      ]);
    }

    const reloaded = await base.progress.load(jobId);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toEqual({
        kind: "requires_manual",
        cause: {
          stage: "merge",
          reasonCode: "change_request_behind_base",
          attempts: { count: 1 },
          // C015z decision (Q4): `mergeEvidence` comes from `mergeFingerprintOf`, which no longer
          // carries `baseSha` -- see that function's own header.
          mergeEvidence: {
            headSha,
            mergeStateStatus: "behind",
            merged: false,
          },
        },
      });
    }
  });

  it("C015y decision C: invocation count ALONE never escalates -- 5+ resumes with zero elapsed wall-clock time stay still_merging forever (the exact half-implemented gap codex's review named)", async () => {
    const base = await harness();
    await seedProgressRecord(base.progress, {
      kind: "merging",
      armedAt: now,
      fingerprint: { headSha, baseSha: "c".repeat(40), mergeStateStatus: "clean", merged: false },
      noProgressCount: 0,
    });
    // harness()'s own `createFixedClock(now)` -- deliberately never advances.
    const deps = readbackDeps(base, () => ({ mergeStateStatus: "clean", baseSha: "c".repeat(40) }));

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const result = await runResumeCycle(deps);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual([{ jobId, outcome: "still_merging" }]);
      const reloaded = await base.progress.load(jobId);
      expect(reloaded.ok).toBe(true);
      if (reloaded.ok) {
        expect(reloaded.value?.stage).toMatchObject({ kind: "merging", noProgressCount: attempt });
      }
    }
  });

  it("escalates to requires_manual(auto_merge_stalled) only once BOTH noProgressCount>=5 AND >=10 minutes have elapsed since the last observed progress -- staying still_merging on the first 4, surviving a restart into a fresh FileJobProgressStore instance", async () => {
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
    const clock = mutableClock(now);
    const deps: ResumeCycleDependencies = {
      ...readbackDeps(base, () => ({ mergeStateStatus: "clean", baseSha: "c".repeat(40) })),
      clock: clock.clock,
    };

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const result = await runResumeCycle(deps);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual([{ jobId, outcome: "still_merging" }]);
      const reloaded = await base.progress.load(jobId);
      expect(reloaded.ok).toBe(true);
      if (reloaded.ok) {
        expect(reloaded.value?.stage).toMatchObject({
          kind: "merging",
          noProgressCount: attempt,
          // `lastProgressAt` is seeded on the very first observation (attempt 1) and never moves
          // again while the fingerprint stays unchanged -- unlike `noProgressCount`, it does not
          // track the attempt number.
          lastProgressAt: now,
        });
      }
      // 3 minutes per resume -- by the 5th call (below) this totals 12 minutes since attempt 1's
      // own `lastProgressAt` baseline: >= the 10-minute wall-clock bound, but still comfortably
      // under the independent 30-minute absolute deadline.
      clock.advanceMinutes(3);
    }

    // Restart-safety (acceptance criterion ③'s own explicit requirement): a *different*
    // `FileJobProgressStore` instance against the exact same on-disk directory -- simulating a
    // fresh `agent-team run` process -- must see the persisted count *and* `lastProgressAt`, and
    // continue both, not reset either.
    const restartedProgress = new FileJobProgressStore(base.progressDirectory);
    const restartedDeps: ResumeCycleDependencies = { ...deps, progress: restartedProgress };

    const fifth = await runResumeCycle(restartedDeps);
    expect(fifth.ok).toBe(true);
    if (fifth.ok) {
      expect(fifth.value).toEqual([
        { jobId, outcome: "requires_manual", reason: "auto_merge_stalled:no_progress_timeout" },
      ]);
    }
    const reloaded = await base.progress.load(jobId);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toEqual({
        kind: "requires_manual",
        cause: {
          stage: "merge",
          reasonCode: "auto_merge_stalled",
          attempts: { count: 5 },
          // C015z decision (Q4): no `baseSha` -- see `mergeFingerprintOf`'s own header.
          mergeEvidence: {
            headSha,
            mergeStateStatus: "clean",
            merged: false,
          },
          stallTiming: {
            armedAt: now,
            lastProgressAt: now,
            observedAt: clock.clock.now(),
            elapsedMs: 12 * 60_000,
          },
        },
      });
    }
  });

  it("a changed mergeStateStatus (a genuine progress signal -- e.g. checks resolving from unstable to clean) resets noProgressCount to 0 rather than escalating, even after prior no-progress resumes", async () => {
    // `headSha` cannot serve as this test's changing quantity: `resumeUnderLease`'s own
    // exact-readback pre-check (this file's module header; the `record.headSha !== undefined &&
    // currentChangeRequest.value.headSha !== record.headSha` branch) fails the resume closed to
    // `change_request_state_mismatch` *before* `resumeMergingStage` is ever reached the instant the
    // live head SHA differs from the one the record was armed against -- a moved head is never
    // observed as "still merging, but with progress" by this code path at all. `mergeStateStatus`
    // is the one field codex's own review named that genuinely can (and, in reality, does) change
    // between resumes while a `"merging"` job's head/base stay fixed (e.g. required checks settling
    // from `"unstable"` to `"clean"`).
    const base = await harness();
    let observedStatus: "unstable" | "clean" = "unstable";
    await seedProgressRecord(base.progress, {
      kind: "merging",
      armedAt: now,
      fingerprint: { headSha, mergeStateStatus: observedStatus, merged: false },
      noProgressCount: 0,
    });
    const deps = readbackDeps(base, () => ({ mergeStateStatus: observedStatus }));

    await runResumeCycle(deps);
    await runResumeCycle(deps);
    const beforeChange = await base.progress.load(jobId);
    expect(beforeChange.ok).toBe(true);
    if (beforeChange.ok) {
      expect(beforeChange.value?.stage).toMatchObject({ kind: "merging", noProgressCount: 2 });
    }

    observedStatus = "clean";
    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([{ jobId, outcome: "still_merging" }]);
    const reloaded = await base.progress.load(jobId);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toMatchObject({ kind: "merging", noProgressCount: 0 });
    }
  });

  it("C015z decision (Q4): a changed baseSha ALONE (GitHub's frozen, PR-creation-time `.base.sha` -- never a live signal, see source-control.ts's corrected header) does NOT reset noProgressCount -- the exact false-progress signal this ticket removes from the fingerprint", async () => {
    const base = await harness();
    let currentBaseSha = "d".repeat(40);
    await seedProgressRecord(base.progress, {
      kind: "merging",
      armedAt: now,
      // Deliberately seeded *without* `baseSha` in the fingerprint -- matching what a fresh write
      // from this ticket onward actually produces (`mergeFingerprintOf` no longer populates it).
      fingerprint: { headSha, mergeStateStatus: "clean", merged: false },
      noProgressCount: 0,
    });
    const deps = readbackDeps(base, () => ({ mergeStateStatus: "clean", baseSha: currentBaseSha }));

    await runResumeCycle(deps);
    const afterFirst = await base.progress.load(jobId);
    expect(afterFirst.ok).toBe(true);
    if (afterFirst.ok) {
      expect(afterFirst.value?.stage).toMatchObject({ kind: "merging", noProgressCount: 1 });
    }

    // Before C015z, this would have reset `noProgressCount` to 0 (the exact bug: `baseSha` was
    // part of the fingerprint equality check, so a changed base tip -- which never happens on its
    // own between resumes anyway, since it is frozen at PR-creation time -- looked like progress).
    currentBaseSha = "e".repeat(40);
    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([{ jobId, outcome: "still_merging" }]);
    const reloaded = await base.progress.load(jobId);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toMatchObject({ kind: "merging", noProgressCount: 2 });
    }
  });

  it('migrates a pre-C015x bare {kind:"merging"} record on its first resume, seeding a fresh baseline rather than treating absent history as zero progress', async () => {
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
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toEqual({
        kind: "merging",
        armedAt: now,
        // C015z decision (Q4): no `baseSha` -- see `mergeFingerprintOf`'s own header.
        fingerprint: {
          headSha,
          mergeStateStatus: "clean",
          merged: false,
        },
        noProgressCount: 0,
        // C015y decision C: seeded to this same first-observation instant.
        lastProgressAt: now,
      });
    }
  });

  it("C015y decision C: the 30-minute absolute deadline fires unconditionally, even when the fingerprint keeps changing every resume (never gated on noProgressCount at all)", async () => {
    const base = await harness();
    await seedProgressRecord(base.progress, {
      kind: "merging",
      armedAt: now,
      fingerprint: { headSha, mergeStateStatus: "clean", merged: false },
      noProgressCount: 0,
      lastProgressAt: now,
    });
    const clock = mutableClock(now);
    // C015z decision (Q4): `headSha` cannot serve as a "real progress every time" signal here --
    // `resumeUnderLease`'s own exact-readback pre-check fails closed the instant the live head SHA
    // differs from the record's own, before `resumeMergingStage` is ever reached (see the sibling
    // test above for the full explanation). `baseSha` is gone from the fingerprint entirely. A
    // genuinely changing `mergeStateStatus` (excluding `"behind"`, which escalates immediately, and
    // `"unknown"`, tracked entirely separately) is the one field left that can actually vary here.
    let currentStatus: "clean" | "unstable" | "blocked" | "dirty" | "draft" = "clean";
    const deps: ResumeCycleDependencies = {
      ...readbackDeps(base, () => ({ mergeStateStatus: currentStatus })),
      clock: clock.clock,
    };

    // Three resumes, 5 minutes apart (15 minutes cumulative -- still under the 30-minute deadline),
    // each observing a genuinely *different* concrete mergeStateStatus (real progress every time)
    // -- noProgressCount would stay at 0 forever under the first OR-branch alone.
    for (const next of ["unstable", "blocked", "dirty"] as const) {
      clock.advanceMinutes(5);
      currentStatus = next;
      const result = await runResumeCycle(deps);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual([{ jobId, outcome: "still_merging" }]);
      const reloaded = await base.progress.load(jobId);
      expect(reloaded.ok).toBe(true);
      if (reloaded.ok) {
        expect(reloaded.value?.stage).toMatchObject({ kind: "merging", noProgressCount: 0 });
      }
    }

    // A 4th resume, 20 minutes later -- 35 minutes total since `armedAt`, still with fresh progress
    // (a new concrete status again) -- must still escalate on elapsed time alone.
    clock.advanceMinutes(20);
    currentStatus = "draft";
    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        { jobId, outcome: "requires_manual", reason: "auto_merge_stalled:absolute_deadline" },
      ]);
    }
    const reloaded = await base.progress.load(jobId);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toMatchObject({
        kind: "requires_manual",
        cause: {
          stage: "merge",
          reasonCode: "auto_merge_stalled",
          stallTiming: { armedAt: now, elapsedMs: 35 * 60_000 },
        },
      });
    }
  });

  it('C015y decision C: mergeStateStatus "unknown" is tracked independently of noProgressCount -- it neither counts toward, nor resets, ordinary progress tracking', async () => {
    const base = await harness();
    await seedProgressRecord(base.progress, {
      kind: "merging",
      armedAt: now,
      fingerprint: { headSha, baseSha: "a".repeat(40), mergeStateStatus: "clean", merged: false },
      noProgressCount: 2,
      lastProgressAt: now,
    });
    const clock = mutableClock(now);
    const deps: ResumeCycleDependencies = {
      ...readbackDeps(base, () => ({ mergeStateStatus: "unknown", baseSha: "a".repeat(40) })),
      clock: clock.clock,
    };

    clock.advanceMinutes(1);
    const first = await runResumeCycle(deps);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value).toEqual([{ jobId, outcome: "still_merging" }]);
    const afterFirst = await base.progress.load(jobId);
    expect(afterFirst.ok).toBe(true);
    if (afterFirst.ok) {
      // `noProgressCount`/`lastProgressAt`/`fingerprint` all stay exactly as they were before this
      // "unknown" observation -- only `unknownSince`/`unknownCount` move.
      expect(afterFirst.value?.stage).toMatchObject({
        kind: "merging",
        noProgressCount: 2,
        lastProgressAt: now,
        fingerprint: { mergeStateStatus: "clean" },
        unknownCount: 1,
      });
    }

    clock.advanceMinutes(1);
    const second = await runResumeCycle(deps);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value).toEqual([{ jobId, outcome: "still_merging" }]);
    const afterSecond = await base.progress.load(jobId);
    expect(afterSecond.ok).toBe(true);
    if (afterSecond.ok) {
      expect(afterSecond.value?.stage).toMatchObject({
        kind: "merging",
        noProgressCount: 2,
        unknownCount: 2,
      });
    }
  });

  it('C015y decision C: mergeStateStatus "unknown" persisting across >=2 fresh readbacks and >=10 minutes escalates to requires_manual(merge_state_unknown_timeout), independent of the 30-minute absolute deadline', async () => {
    const base = await harness();
    await seedProgressRecord(base.progress, {
      kind: "merging",
      armedAt: now,
      fingerprint: { headSha, baseSha: "a".repeat(40), mergeStateStatus: "clean", merged: false },
      noProgressCount: 0,
      lastProgressAt: now,
    });
    const clock = mutableClock(now);
    const deps: ResumeCycleDependencies = {
      ...readbackDeps(base, () => ({ mergeStateStatus: "unknown", baseSha: "a".repeat(40) })),
      clock: clock.clock,
    };

    clock.advanceMinutes(1);
    const first = await runResumeCycle(deps);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value).toEqual([{ jobId, outcome: "still_merging" }]);

    // Total elapsed since the first "unknown" observation is now 11 minutes (>= 10), and this is
    // the 2nd consecutive fresh "unknown" readback (>= 2) -- escalates. Still well under the
    // independent 30-minute absolute deadline (11 < 30), proving this fires on its own bound, not
    // as a side effect of that one.
    clock.advanceMinutes(10);
    const second = await runResumeCycle(deps);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value).toEqual([
        { jobId, outcome: "requires_manual", reason: "merge_state_unknown_timeout" },
      ]);
    }
    const reloaded = await base.progress.load(jobId);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toMatchObject({
        kind: "requires_manual",
        cause: {
          stage: "merge",
          reasonCode: "merge_state_unknown_timeout",
          attempts: { count: 2 },
          mergeEvidence: { mergeStateStatus: "unknown" },
          stallTiming: { armedAt: now, elapsedMs: 11 * 60_000 },
        },
      });
    }
  });

  it('C015y decision C: a non-"unknown" reading clears an in-progress unknown streak rather than letting it accumulate across an interruption', async () => {
    const base = await harness();
    await seedProgressRecord(base.progress, {
      kind: "merging",
      armedAt: now,
      fingerprint: { headSha, baseSha: "a".repeat(40), mergeStateStatus: "clean", merged: false },
      noProgressCount: 0,
      lastProgressAt: now,
    });
    const clock = mutableClock(now);
    let currentStatus: "unknown" | "clean" = "unknown";
    const deps: ResumeCycleDependencies = {
      ...readbackDeps(base, () => ({ mergeStateStatus: currentStatus, baseSha: "a".repeat(40) })),
      clock: clock.clock,
    };

    clock.advanceMinutes(1);
    await runResumeCycle(deps);
    const afterUnknown = await base.progress.load(jobId);
    expect(afterUnknown.ok).toBe(true);
    if (afterUnknown.ok) {
      expect(afterUnknown.value?.stage).toMatchObject({ kind: "merging", unknownCount: 1 });
    }

    // A concrete reading interrupts the streak -- unknownSince/unknownCount must be cleared, not
    // merely paused, so a *later* unknown streak starts counting from zero again.
    currentStatus = "clean";
    clock.advanceMinutes(1);
    await runResumeCycle(deps);
    const afterClean = await base.progress.load(jobId);
    expect(afterClean.ok).toBe(true);
    if (afterClean.ok) {
      expect(afterClean.value?.stage).not.toHaveProperty("unknownSince");
      expect(afterClean.value?.stage).not.toHaveProperty("unknownCount");
    }

    currentStatus = "unknown";
    clock.advanceMinutes(11);
    const third = await runResumeCycle(deps);
    // If the earlier streak had survived, this single fresh "unknown" reading (count=1) would not
    // yet meet `mergeStateUnknownMinReadbacks` (2) -- it must stay still_merging, not escalate.
    expect(third.ok).toBe(true);
    if (third.ok) expect(third.value).toEqual([{ jobId, outcome: "still_merging" }]);
    const afterRestart = await base.progress.load(jobId);
    expect(afterRestart.ok).toBe(true);
    if (afterRestart.ok) {
      expect(afterRestart.value?.stage).toMatchObject({ unknownCount: 1 });
    }
  });
});

/**
 * C015y decision A (acceptance criterion ①): dispatch resolves the authoritative base exactly
 * once and persists it as `baseRevision`; resume must read it back, never re-derive it. Every
 * other test in this file gives `seedProgressRecord` a real `baseRevision` by default (C015z) so
 * it reaches whatever behavior it actually means to test -- this describe block is the one place
 * that deliberately builds *legacy* (no-`baseRevision`) records directly, via `compareAndSwap`,
 * bypassing that helper, to exercise the persisted-value path and the legacy-record failure path
 * on purpose.
 *
 * C015z decision (Q3): the legacy failure path no longer *repairs* anything -- see
 * `resolveLegacyBaseRevision`'s own header (resume-composition.ts) for why the prior cross-check
 * heuristic's premise was false. It fails closed to `requires_manual(legacy_base_revision_unrecoverable)`
 * unconditionally, `resolveAuthoritativeBase` is never called, and `baseRevision` is never written.
 */
describe("C015y decision A: persisted baseRevision is authoritative -- resume reads it back, never re-derives it", () => {
  const persistedBaseRevisionValue = "9".repeat(40);
  const persistedBaseRevision = (() => {
    const parsed = headShaSchema.safeParse(persistedBaseRevisionValue);
    if (!parsed.success) throw new Error("fixture invariant violated");
    return parsed.data;
  })();

  async function seedLegacyCiWaiting(progress: FileJobProgressStore) {
    await progress.compareAndSwap(jobId, null, {
      jobId,
      projectId,
      issueId,
      externalIssueId,
      model: "gpt-5.6-terra",
      providerAssignments: {
        execution: { provider: "codex", model: "gpt-5.6-terra" },
        codeReview: { provider: "claude", model: "claude-opus" },
      },
      stage: { kind: "ci_waiting" },
      branch: "agent-team/job-1",
      worktreePath: "/tmp/does-not-need-to-exist-for-these-fakes",
      changeRequestId: "42",
      headSha,
      // Deliberately omits `baseRevision` -- the legacy shape.
    });
  }

  it("a record that already carries baseRevision is trusted as-is: resolveAuthoritativeBase is never called, and that exact value reaches the reviewer request", async () => {
    const { deps, progress, calls, reviewerRequests } = await harness();
    await progress.compareAndSwap(jobId, null, {
      jobId,
      projectId,
      issueId,
      externalIssueId,
      model: "gpt-5.6-terra",
      providerAssignments: {
        execution: { provider: "codex", model: "gpt-5.6-terra" },
        codeReview: { provider: "claude", model: "claude-opus" },
      },
      stage: { kind: "ci_waiting" },
      branch: "agent-team/job-1",
      worktreePath: "/tmp/does-not-need-to-exist-for-these-fakes",
      changeRequestId: "42",
      headSha,
      // Deliberately a *different* SHA from `baseRevisionValue`/`current.baseSha` -- if resume
      // ever re-derived or cross-checked this, the reviewer request below would observe the wrong
      // value, or this test's own `resolveAuthoritativeBase` call-count assertion would fail.
      baseRevision: persistedBaseRevision,
    });

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([{ jobId, outcome: "completed" }]);
    expect(calls).not.toContain("resolveAuthoritativeBase");
    expect(reviewerRequests).toHaveLength(1);
    expect(reviewerRequests[0]).toMatchObject({ baseRevision: persistedBaseRevisionValue });
  });

  it("a legacy record (no baseRevision) fails closed unconditionally to requires_manual(legacy_base_revision_unrecoverable) -- resolveAuthoritativeBase is never called, and no baseRevision is ever written", async () => {
    const { deps, progress, calls } = await harness();
    await seedLegacyCiWaiting(progress);

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        { jobId, outcome: "requires_manual", reason: "legacy_base_revision_unrecoverable" },
      ]);
    }
    // C015z decision (Q3): unconditional -- the prior repair heuristic's own cross-check premise
    // was false (see `resolveLegacyBaseRevision`'s own header, resume-composition.ts); this
    // dependency is never even reached any more.
    expect(calls).not.toContain("resolveAuthoritativeBase");

    // P0-4 fix: the assertion this replaces checked the *pre-cycle* snapshot (trivially always
    // true -- a record that was never given one obviously does not have one yet). This checks the
    // *post-cycle* snapshot -- the one this exact resume attempt just durably wrote -- to prove the
    // write itself never smuggled a guessed `baseRevision` in.
    const reloaded = await progress.load(jobId);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) {
      expect(reloaded.value?.baseRevision).toBeUndefined();
      expect(reloaded.value?.stage).toMatchObject({
        kind: "requires_manual",
        cause: {
          stage: "setup",
          reasonCode: "legacy_base_revision_unrecoverable",
          // The fresh PR readback's own evidence, for a human to act on via `dispatch resolve`.
          // `changeRequest()`'s own default fixture never sets `mergeStateStatus` explicitly, so it
          // falls back to `"unknown"` here -- same fallback `mergeFingerprintOf` uses.
          mergeEvidence: { headSha, baseSha: baseRevisionValue, mergeStateStatus: "unknown" },
        },
      });
    }
  });

  it("a legacy record's fate is unaffected by whatever resolveAuthoritativeBase would have returned (even a failure) -- it is never invoked any more", async () => {
    const { deps, progress, calls } = await harness({
      resolveAuthoritativeBaseOutcome: err({
        reason: "authoritative_branch_unavailable",
        error: domainError("timeout"),
      }),
    });
    await seedLegacyCiWaiting(progress);

    const result = await runResumeCycle(deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        { jobId, outcome: "requires_manual", reason: "legacy_base_revision_unrecoverable" },
      ]);
    }
    expect(calls).not.toContain("resolveAuthoritativeBase");
  });

  it("a legacy record whose requires_manual CAS write itself fails (concurrent writer) surfaces as progress_write_failed, never falsely reporting requires_manual without a durable write", async () => {
    /** Intercepts *only* the one CAS write `resolveLegacyBaseRevision` makes (the mutation whose
     * `next.stage.kind` is `"requires_manual"`) and reports a conflict exactly once -- every other
     * write in this test (the initial seed above) goes through untouched. */
    class ConflictOnceOnRequiresManualWrite extends FileJobProgressStore {
      #triggered = false;
      override async compareAndSwap(
        conflictJobId: string,
        expectedRevision: number | null,
        next: Parameters<FileJobProgressStore["compareAndSwap"]>[2],
        options?: Parameters<FileJobProgressStore["compareAndSwap"]>[3],
      ) {
        if (!this.#triggered && next.stage.kind === "requires_manual") {
          this.#triggered = true;
          return err(domainError("conflict"));
        }
        return super.compareAndSwap(conflictJobId, expectedRevision, next, options);
      }
    }
    const { deps, progress: realProgress, progressDirectory } = await harness();
    await seedLegacyCiWaiting(realProgress);
    const conflictingProgress = new ConflictOnceOnRequiresManualWrite(progressDirectory);
    const wrapped: ResumeCycleDependencies = { ...deps, progress: conflictingProgress };

    const result = await runResumeCycle(wrapped);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        expect.objectContaining({ jobId, outcome: "progress_write_failed" }),
      ]);
    }
  });
});

describe("E102-3: resumeReview visual/dual review evidence threading", () => {
  const evidenceCriterion = "畫面在健康狀態下正確顯示 status-none.png";
  const visualReviewCommand: ProjectCommand = {
    executable: "node",
    arguments: ["dist/scripts/screenshot.js", "--mode=none", "--out={{evidenceDir}}"],
  };
  const artifactPath = `.agent-team/evidence/${issueId}/${headSha}/status-none.png`;

  /** This file's own shared fixtures have one, pre-existing (and pre-E102-3) inconsistency
   * unrelated to visual/dual review threading: `job()`'s `issueId` is a fixed constant, while the
   * `Issue.id` `resumeReview` actually derives at runtime (`toDomainIssue`, linear-discovery.ts) is
   * `generateDeterministicIdentifier("issue", externalIssueId)` -- a different value, only because
   * no test in this file before this ticket ever ran the assembled request through the real
   * `validReviewerRequest` (every `reviewer.run` here is a scripted fake that never checks it). In
   * real production the two always agree (a job's `issueId` is itself set from that exact same
   * derivation at dispatch time). Patching just that one field lets these tests prove the actually
   * new thing E102-3 adds -- that a `visual_review`/`dual_review` request `resumeReview` now
   * assembles satisfies the real, unmodified validator -- without also being the ones on the hook
   * for repairing this file's unrelated fixture-id inconsistency.
   */
  function validAsAssembledByProduction(request: unknown): boolean {
    const typed = request as {
      job: { issueId: string };
      requirementSnapshot: { issue: { id: string } };
    };
    return validReviewerRequest({
      ...typed,
      job: { ...typed.job, issueId: typed.requirementSnapshot.issue.id },
    } as never);
  }

  function successfulVisualManifest() {
    return {
      schemaVersion: 1 as const,
      issueId,
      commitSha: headSha,
      generatedAt: now,
      environment: { runner: "fixture", operatingSystem: "linux" },
      artifacts: [
        {
          path: artifactPath,
          mediaType: "image/png",
          sha256: "d".repeat(64),
          title: "Status page (healthy)",
          acceptanceCriteria: [evidenceCriterion],
        },
      ],
    };
  }

  function successfulVisualEvidenceBuild(): () => Promise<VisualEvidenceBuildResult> {
    return () =>
      Promise.resolve(
        Object.freeze({
          ok: true as const,
          value: Object.freeze({
            visualManifest: successfulVisualManifest(),
            evidence: Object.freeze([
              {
                kind: "file" as const,
                category: "visual_artifact" as const,
                source: `agent-team:visual-evidence:${artifactPath}`,
                mediaType: "image/png",
                path: `/tmp/does-not-need-to-exist-for-these-fakes/${artifactPath}`,
                sha256: "d".repeat(64),
                repositoryPath: artifactPath,
              },
            ]),
            evidenceDirectory: `/tmp/does-not-need-to-exist-for-these-fakes/.agent-team/evidence/${issueId}/${headSha}`,
            reused: false,
          }),
        }),
      );
  }

  /** E102-5: every pre-existing dual/visual-review *success*-path test in this describe block now
   * also needs `deps.linearPublication` wired -- `resumeReview` gates `reviewer.run()` on a
   * successful publish, so without this these tests would land in `requires_manual` before ever
   * reaching the assertions they actually mean to make (models/visualManifest/evidence threading).
   * The dedicated "E102-5: Linear publication gate" describe block below is what actually tests
   * this coordinator's own wiring/fail-closed behavior. */
  function successfulLinearPublish(): () => Promise<LinearPublicationResult> {
    return () =>
      Promise.resolve(
        Object.freeze({
          ok: true as const,
          value: Object.freeze({
            receipt: {
              schemaVersion: 1 as const,
              projectId,
              issueId,
              externalIssueId,
              headSha,
              manifestDigest: "e".repeat(64),
              manifestComment: { id: "comment-manifest", sha256: "f".repeat(64) },
              artifacts: [
                {
                  path: artifactPath,
                  sha256: "d".repeat(64),
                  assetUrl: "https://uploads.linear.app/asset-1",
                  commentId: "comment-artifact-1",
                },
              ],
              createdAt: now,
            },
            reused: false,
          }),
        }),
      );
  }

  function successfulLinearReceipt(): LinearPublicationReceiptRecord {
    return {
      schemaVersion: 1,
      projectId,
      issueId,
      externalIssueId,
      headSha,
      manifestDigest: "e".repeat(64),
      manifestComment: { id: "comment-manifest", sha256: "f".repeat(64) },
      artifacts: [
        {
          path: artifactPath,
          sha256: "d".repeat(64),
          assetUrl: "https://uploads.linear.app/asset-1",
          commentId: "comment-artifact-1",
        },
      ],
      createdAt: now,
    };
  }

  /** E102-4b: every pre-existing dual/visual-review *success*-path test in this describe block now
   * also needs `deps.visualEvidence.verifyExisting` wired -- `resumeReview`'s pre-arm merge recheck
   * gates `deps.autoMerge.enable()` on it. Returns the exact same manifest `successfulVisualEvidenceBuild`
   * produced (`reused: true`, since this simulates re-verifying what is already on disk, never
   * building anything fresh), so a test that never means to exercise drift keeps the review-time and
   * merge-time evidence digests identical. */
  function successfulVisualEvidenceVerify(): () => Promise<VisualEvidenceBuildResult> {
    return () =>
      Promise.resolve(
        Object.freeze({
          ok: true as const,
          value: Object.freeze({
            visualManifest: successfulVisualManifest(),
            evidence: Object.freeze([
              {
                kind: "file" as const,
                category: "visual_artifact" as const,
                source: `agent-team:visual-evidence:${artifactPath}`,
                mediaType: "image/png",
                path: `/tmp/does-not-need-to-exist-for-these-fakes/${artifactPath}`,
                sha256: "d".repeat(64),
                repositoryPath: artifactPath,
              },
            ]),
            evidenceDirectory: `/tmp/does-not-need-to-exist-for-these-fakes/.agent-team/evidence/${issueId}/${headSha}`,
            reused: true,
          }),
        }),
      );
  }

  /** E102-4b: symmetric to `successfulVisualEvidenceVerify` above, for
   * `deps.linearPublicationStore.load` -- returns the exact same receipt `successfulLinearPublish`
   * durably records, so `aggregateLinearPublicationDigest` at merge time matches what
   * `resumeReview` threaded into `reviewer.run()` at review time. */
  function successfulLinearPublicationStoreLoad(): () => Promise<
    Result<LinearPublicationReceiptRecord | undefined, DomainError>
  > {
    return () => Promise.resolve(ok(successfulLinearReceipt()));
  }

  it("dual_review threads models.visual + visualManifest + visual_artifact evidence, and the assembled request satisfies validReviewerRequest", async () => {
    const { deps, progress, calls, reviewerRequests } = await harness({
      reviewRequirement: "dual_review",
      acceptanceCriteria: [evidenceCriterion],
      visualReviewCommands: [visualReviewCommand],
      visualEvidenceBuild: successfulVisualEvidenceBuild(),
      visualEvidenceVerify: successfulVisualEvidenceVerify(),
      visualReviewModel: "gemini-2.5-pro",
      linearPublish: successfulLinearPublish(),
      linearPublicationStoreLoad: successfulLinearPublicationStoreLoad(),
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);

    expect(result.ok).toBe(true);
    expect(calls.indexOf("visualEvidence.build")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("visualEvidence.build")).toBeLessThan(calls.indexOf("reviewer.run"));
    expect(reviewerRequests).toHaveLength(1);
    const request = reviewerRequests[0] as Record<string, unknown>;
    expect(request["models"]).toEqual({ code: "claude-opus", visual: "gemini-2.5-pro" });
    expect(request["visualManifest"]).toEqual(successfulVisualManifest());
    expect(request["evidence"]).toEqual([
      expect.objectContaining({ kind: "file", category: "visual_artifact" }),
    ]);
    // E102-4b: the actual production defect this ticket closes -- before it, `resumeReview` never
    // passed `publicationDigest` to `reviewer.run()` at all, so the resulting approval's
    // `identity.publicationDigest` was always `undefined` and `AutoMergeGate.enable()`'s own
    // `validApproval` (merge-gate.ts) would fail every `dual_review`/`visual_review` job closed.
    // Asserts the exact singleton-receipt digest contract from this ticket's spec: one receipt in,
    // never a directory scan or any other head/issue's receipts.
    expect(request["publicationDigest"]).toBe(
      aggregateLinearPublicationDigest([successfulLinearReceipt()]),
    );
    // The whole point of this ticket: before it, this exact shape of request always failed
    // `validReviewerRequest` (reviewer-policy.ts) for a `dual_review` job -- assembling it here and
    // running it through the real, unmodified production validator is the strongest possible proof
    // that the invariant no longer fails.
    expect(validAsAssembledByProduction(request)).toBe(true);
  });

  it("visual_review-only sets models.visual but never models.code", async () => {
    const { deps, progress, reviewerRequests } = await harness({
      reviewRequirement: "visual_review",
      acceptanceCriteria: [evidenceCriterion],
      visualReviewCommands: [visualReviewCommand],
      visualEvidenceBuild: successfulVisualEvidenceBuild(),
      visualEvidenceVerify: successfulVisualEvidenceVerify(),
      visualReviewModel: "gemini-2.5-pro",
      linearPublish: successfulLinearPublish(),
      linearPublicationStoreLoad: successfulLinearPublicationStoreLoad(),
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);

    expect(result.ok).toBe(true);
    const request = reviewerRequests[0] as Record<string, unknown>;
    expect(request["models"]).toEqual({ visual: "gemini-2.5-pro" });
    expect(validAsAssembledByProduction(request)).toBe(true);
  });

  it("code_review never invokes the visual evidence builder and never sets models.visual (unchanged from before this ticket)", async () => {
    const { deps, progress, calls, reviewerRequests } = await harness({
      reviewRequirement: "code_review",
      acceptanceCriteria: [evidenceCriterion],
      visualEvidenceBuild: () => Promise.reject(new Error("must not be called for code_review")),
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);

    expect(result.ok).toBe(true);
    expect(calls).not.toContain("visualEvidence.build");
    const request = reviewerRequests[0] as Record<string, unknown>;
    expect(request["models"]).toEqual({ code: "claude-opus" });
    expect(request["visualManifest"]).toBeUndefined();
    expect(validAsAssembledByProduction(request)).toBe(true);
  });

  it("dual_review fails closed to requires_manual when no visual evidence builder is wired, without ever calling reviewer.run", async () => {
    const { deps, progress, calls } = await harness({
      reviewRequirement: "dual_review",
      acceptanceCriteria: [evidenceCriterion],
      visualReviewCommands: [visualReviewCommand],
      // visualEvidenceBuild deliberately omitted -- deps.visualEvidence stays undefined.
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        { jobId, outcome: "requires_manual", reason: "visual_evidence_builder_unavailable" },
      ]);
    }
    expect(calls).not.toContain("visualEvidence.build");
    expect(calls).not.toContain("reviewer.run");
  });

  it("dual_review fails closed to requires_manual when no real visual review model is configured, even with the builder and commands wired", async () => {
    const { deps, progress, calls } = await harness({
      reviewRequirement: "dual_review",
      acceptanceCriteria: [evidenceCriterion],
      visualReviewCommands: [visualReviewCommand],
      visualEvidenceBuild: () =>
        Promise.reject(new Error("must not be called with no visual model")),
      // visualReviewModel deliberately omitted -- no gemini config on this host.
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        { jobId, outcome: "requires_manual", reason: "visual_evidence_builder_unavailable" },
      ]);
    }
    expect(calls).not.toContain("visualEvidence.build");
    expect(calls).not.toContain("reviewer.run");
  });

  it("dual_review fails closed to requires_manual when the project's commands.visualReview is empty, even with a builder wired", async () => {
    const { deps, progress, calls } = await harness({
      reviewRequirement: "dual_review",
      acceptanceCriteria: [evidenceCriterion],
      // visualReviewCommands deliberately omitted -- defaults to [].
      visualEvidenceBuild: () => Promise.reject(new Error("must not be called with no commands")),
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        { jobId, outcome: "requires_manual", reason: "visual_evidence_builder_unavailable" },
      ]);
    }
    expect(calls).not.toContain("visualEvidence.build");
    expect(calls).not.toContain("reviewer.run");
  });

  it("dual_review fails closed to requires_manual (never reviewer.run) when the visual evidence builder itself fails", async () => {
    const { deps, progress, calls } = await harness({
      reviewRequirement: "dual_review",
      acceptanceCriteria: [evidenceCriterion],
      visualReviewCommands: [visualReviewCommand],
      visualReviewModel: "gemini-2.5-pro",
      visualEvidenceBuild: () =>
        Promise.resolve(
          Object.freeze({
            ok: false as const,
            failure: Object.freeze({
              reason: "artifact_invalid" as const,
              error: domainError("invariant_violation"),
            }),
          }),
        ),
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        {
          jobId,
          outcome: "requires_manual",
          reason: "visual_evidence_build_failed:artifact_invalid",
        },
      ]);
    }
    expect(calls).toContain("visualEvidence.build");
    expect(calls).not.toContain("reviewer.run");
  });
});

describe("E102-5: Linear publication gate (resumeReview requires a successful publish before reviewer.run)", () => {
  const evidenceCriterion = "畫面在健康狀態下正確顯示 status-none.png";
  const visualReviewCommand: ProjectCommand = {
    executable: "node",
    arguments: ["dist/scripts/screenshot.js", "--mode=none", "--out={{evidenceDir}}"],
  };
  const artifactPath = `.agent-team/evidence/${issueId}/${headSha}/status-none.png`;

  function successfulVisualManifest() {
    return {
      schemaVersion: 1 as const,
      issueId,
      commitSha: headSha,
      generatedAt: now,
      environment: { runner: "fixture", operatingSystem: "linux" },
      artifacts: [
        {
          path: artifactPath,
          mediaType: "image/png",
          sha256: "d".repeat(64),
          title: "Status page (healthy)",
          acceptanceCriteria: [evidenceCriterion],
        },
      ],
    };
  }

  function successfulVisualEvidenceBuild(): () => Promise<VisualEvidenceBuildResult> {
    return () =>
      Promise.resolve(
        Object.freeze({
          ok: true as const,
          value: Object.freeze({
            visualManifest: successfulVisualManifest(),
            evidence: Object.freeze([
              {
                kind: "file" as const,
                category: "visual_artifact" as const,
                source: `agent-team:visual-evidence:${artifactPath}`,
                mediaType: "image/png",
                path: `/tmp/does-not-need-to-exist-for-these-fakes/${artifactPath}`,
                sha256: "d".repeat(64),
                repositoryPath: artifactPath,
              },
            ]),
            evidenceDirectory: `/tmp/does-not-need-to-exist-for-these-fakes/.agent-team/evidence/${issueId}/${headSha}`,
            reused: false,
          }),
        }),
      );
  }

  function successfulReceipt() {
    return {
      schemaVersion: 1 as const,
      projectId,
      issueId,
      externalIssueId,
      headSha,
      manifestDigest: "e".repeat(64),
      manifestComment: { id: "comment-manifest", sha256: "f".repeat(64) },
      artifacts: [
        {
          path: artifactPath,
          sha256: "d".repeat(64),
          assetUrl: "https://uploads.linear.app/asset-1",
          commentId: "comment-artifact-1",
        },
      ],
      createdAt: now,
    };
  }

  const baseHarnessOptions = {
    reviewRequirement: "dual_review" as const,
    acceptanceCriteria: [evidenceCriterion],
    visualReviewCommands: [visualReviewCommand],
    visualReviewModel: "gemini-2.5-pro",
    visualEvidenceBuild: successfulVisualEvidenceBuild(),
  };

  /** E102-4b: matches `successfulVisualEvidenceBuild`'s own manifest -- see this file's identically
   * named helper in the "E102-3" describe block above for the full rationale (`reused: true`, never
   * a fresh build). Only the one test below that actually reaches `deps.autoMerge.enable()` needs
   * this wired. */
  function successfulVisualEvidenceVerify(): () => Promise<VisualEvidenceBuildResult> {
    return () =>
      Promise.resolve(
        Object.freeze({
          ok: true as const,
          value: Object.freeze({
            visualManifest: successfulVisualManifest(),
            evidence: Object.freeze([
              {
                kind: "file" as const,
                category: "visual_artifact" as const,
                source: `agent-team:visual-evidence:${artifactPath}`,
                mediaType: "image/png",
                path: `/tmp/does-not-need-to-exist-for-these-fakes/${artifactPath}`,
                sha256: "d".repeat(64),
                repositoryPath: artifactPath,
              },
            ]),
            evidenceDirectory: `/tmp/does-not-need-to-exist-for-these-fakes/.agent-team/evidence/${issueId}/${headSha}`,
            reused: true,
          }),
        }),
      );
  }

  it("calls linearPublication.publish (with the built visualManifest) after visualEvidence.build and before reviewer.run, and proceeds on success", async () => {
    const { deps, progress, calls, linearPublicationRequests } = await harness({
      ...baseHarnessOptions,
      visualEvidenceVerify: successfulVisualEvidenceVerify(),
      linearPublicationStoreLoad: () => Promise.resolve(ok(successfulReceipt())),
      linearPublish: () =>
        Promise.resolve(
          Object.freeze({
            ok: true as const,
            value: Object.freeze({ receipt: successfulReceipt(), reused: false }),
          }),
        ),
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([{ jobId, outcome: "completed" }]);
    expect(calls.indexOf("visualEvidence.build")).toBeLessThan(
      calls.indexOf("linearPublication.publish"),
    );
    expect(calls.indexOf("linearPublication.publish")).toBeLessThan(calls.indexOf("reviewer.run"));
    expect(linearPublicationRequests).toHaveLength(1);
    const request = linearPublicationRequests[0] as Record<string, unknown>;
    expect(request["externalIssueId"]).toBe(externalIssueId);
    expect(request["worktreePath"]).toBe("/tmp/does-not-need-to-exist-for-these-fakes");
    expect(request["visualManifest"]).toEqual(successfulVisualManifest());
  });

  it("fails closed to requires_manual (reasonCode visual_publication_failed) when deps.linearPublication is never wired, without ever calling reviewer.run", async () => {
    const { deps, progress, calls } = await harness({
      ...baseHarnessOptions,
      // linearPublish deliberately omitted -- deps.linearPublication stays undefined.
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        { jobId, outcome: "requires_manual", reason: "linear_publication_unavailable" },
      ]);
    }
    expect(calls).toContain("visualEvidence.build");
    expect(calls).not.toContain("linearPublication.publish");
    expect(calls).not.toContain("reviewer.run");
    const reloaded = await progress.load(jobId);
    expect(reloaded.ok && reloaded.value?.stage).toMatchObject({
      kind: "requires_manual",
      cause: { stage: "review", reasonCode: "visual_publication_failed" },
    });
  });

  it("fails closed to requires_manual (reasonCode visual_publication_failed, never orphan) when publish fails before anything was created on Linear", async () => {
    const { deps, progress, calls } = await harness({
      ...baseHarnessOptions,
      linearPublish: () =>
        Promise.resolve(
          Object.freeze({
            ok: false as const,
            failure: Object.freeze({
              reason: "upload_failed" as const,
              error: domainError("external_failure"),
              orphan: false,
            }),
          }),
        ),
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        { jobId, outcome: "requires_manual", reason: "linear_publication_failed:upload_failed" },
      ]);
    }
    expect(calls).not.toContain("reviewer.run");
    const reloaded = await progress.load(jobId);
    expect(reloaded.ok && reloaded.value?.stage).toMatchObject({
      kind: "requires_manual",
      cause: { stage: "review", reasonCode: "visual_publication_failed" },
    });
  });

  it("fails closed to requires_manual with the distinct orphan reasonCode (visual_publication_orphan) when publish fails after a Linear-side write already succeeded, and never lets reviewer.run start", async () => {
    const { deps, progress, calls } = await harness({
      ...baseHarnessOptions,
      linearPublish: () =>
        Promise.resolve(
          Object.freeze({
            ok: false as const,
            failure: Object.freeze({
              reason: "manifest_comment_failed" as const,
              error: domainError("external_failure"),
              orphan: true,
            }),
          }),
        ),
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        {
          jobId,
          outcome: "requires_manual",
          reason: "linear_publication_failed:manifest_comment_failed",
        },
      ]);
    }
    expect(calls).not.toContain("reviewer.run");
    const reloaded = await progress.load(jobId);
    expect(reloaded.ok && reloaded.value?.stage).toMatchObject({
      kind: "requires_manual",
      // The orphan-identifiable acceptance criterion: this reasonCode is never written for the
      // "nothing was created yet" failure class above (`visual_publication_failed`) -- an operator
      // greps for this specific code to find a Linear-side asset/comment with no durable receipt.
      cause: { stage: "review", reasonCode: "visual_publication_orphan" },
    });
  });

  it("code_review never touches linearPublication at all (only visual_review/dual_review jobs are gated)", async () => {
    const { deps, progress, calls } = await harness({
      reviewRequirement: "code_review",
      acceptanceCriteria: [evidenceCriterion],
      linearPublish: () => Promise.reject(new Error("must not be called for code_review")),
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([{ jobId, outcome: "completed" }]);
    expect(calls).not.toContain("linearPublication.publish");
  });
});

describe("E102-4b: pre-arm merge recheck (verifyExisting + linearPublicationStore.load wired into AutoMergeGate.enable)", () => {
  const evidenceCriterion = "畫面在健康狀態下正確顯示 status-none.png";
  const visualReviewCommand: ProjectCommand = {
    executable: "node",
    arguments: ["dist/scripts/screenshot.js", "--mode=none", "--out={{evidenceDir}}"],
  };
  const artifactPath = `.agent-team/evidence/${issueId}/${headSha}/status-none.png`;

  function successfulVisualManifest() {
    return {
      schemaVersion: 1 as const,
      issueId,
      commitSha: headSha,
      generatedAt: now,
      environment: { runner: "fixture", operatingSystem: "linux" },
      artifacts: [
        {
          path: artifactPath,
          mediaType: "image/png",
          sha256: "d".repeat(64),
          title: "Status page (healthy)",
          acceptanceCriteria: [evidenceCriterion],
        },
      ],
    };
  }

  function successfulVisualEvidenceBuild(): () => Promise<VisualEvidenceBuildResult> {
    return () =>
      Promise.resolve(
        Object.freeze({
          ok: true as const,
          value: Object.freeze({
            visualManifest: successfulVisualManifest(),
            evidence: Object.freeze([
              {
                kind: "file" as const,
                category: "visual_artifact" as const,
                source: `agent-team:visual-evidence:${artifactPath}`,
                mediaType: "image/png",
                path: `/tmp/does-not-need-to-exist-for-these-fakes/${artifactPath}`,
                sha256: "d".repeat(64),
                repositoryPath: artifactPath,
              },
            ]),
            evidenceDirectory: `/tmp/does-not-need-to-exist-for-these-fakes/.agent-team/evidence/${issueId}/${headSha}`,
            reused: false,
          }),
        }),
      );
  }

  function successfulVisualEvidenceVerify(): () => Promise<VisualEvidenceBuildResult> {
    return () =>
      Promise.resolve(
        Object.freeze({
          ok: true as const,
          value: Object.freeze({
            visualManifest: successfulVisualManifest(),
            evidence: Object.freeze([
              {
                kind: "file" as const,
                category: "visual_artifact" as const,
                source: `agent-team:visual-evidence:${artifactPath}`,
                mediaType: "image/png",
                path: `/tmp/does-not-need-to-exist-for-these-fakes/${artifactPath}`,
                sha256: "d".repeat(64),
                repositoryPath: artifactPath,
              },
            ]),
            evidenceDirectory: `/tmp/does-not-need-to-exist-for-these-fakes/.agent-team/evidence/${issueId}/${headSha}`,
            reused: true,
          }),
        }),
      );
  }

  function successfulReceipt(): LinearPublicationReceiptRecord {
    return {
      schemaVersion: 1,
      projectId,
      issueId,
      externalIssueId,
      headSha,
      manifestDigest: "e".repeat(64),
      manifestComment: { id: "comment-manifest", sha256: "f".repeat(64) },
      artifacts: [
        {
          path: artifactPath,
          sha256: "d".repeat(64),
          assetUrl: "https://uploads.linear.app/asset-1",
          commentId: "comment-artifact-1",
        },
      ],
      createdAt: now,
    };
  }

  function successfulLinearPublish(): () => Promise<LinearPublicationResult> {
    return () =>
      Promise.resolve(
        Object.freeze({
          ok: true as const,
          value: Object.freeze({ receipt: successfulReceipt(), reused: false }),
        }),
      );
  }

  const dualHarnessOptions = {
    reviewRequirement: "dual_review" as const,
    acceptanceCriteria: [evidenceCriterion],
    visualReviewCommands: [visualReviewCommand],
    visualReviewModel: "gemini-2.5-pro",
    visualEvidenceBuild: successfulVisualEvidenceBuild(),
    visualEvidenceVerify: successfulVisualEvidenceVerify(),
    linearPublish: successfulLinearPublish(),
    linearPublicationStoreLoad: () => Promise.resolve(ok(successfulReceipt())),
  };

  it("threads currentVisualManifest/currentPublicationDigest into AutoMergeGate.enable(), read-only (verifyExisting, never a second build())", async () => {
    const enableRequests: unknown[] = [];
    const { deps, progress, calls } = await harness({ ...dualHarnessOptions });
    (deps as { autoMerge: ResumeCycleDependencies["autoMerge"] }).autoMerge = {
      enable: (request) => {
        calls.push("autoMerge.enable");
        enableRequests.push(request);
        return Promise.resolve({
          state: "auto_merge_enabled",
          reuse: "unchanged",
          identity: {} as never,
          changeRequest: changeRequest({ state: "merged" }) as never,
          mutations: [],
        });
      },
    };
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([{ jobId, outcome: "completed" }]);
    // `build()` only ever runs once, at review time -- the merge-time recheck exclusively calls
    // `verifyExisting()`, never `build()` again (the exact "never re-screenshot to recheck"
    // guarantee this ticket's spec requires).
    expect(calls.filter((call) => call === "visualEvidence.build")).toHaveLength(1);
    expect(calls).toContain("visualEvidence.verifyExisting");
    expect(calls.indexOf("reviewer.run")).toBeLessThan(
      calls.indexOf("visualEvidence.verifyExisting"),
    );
    expect(calls.indexOf("visualEvidence.verifyExisting")).toBeLessThan(
      calls.indexOf("autoMerge.enable"),
    );
    expect(calls).toContain("linearPublicationStore.load");
    expect(enableRequests).toHaveLength(1);
    const request = enableRequests[0] as Record<string, unknown>;
    expect(request["currentVisualManifest"]).toEqual(successfulVisualManifest());
    expect(request["currentPublicationDigest"]).toBe(
      aggregateLinearPublicationDigest([successfulReceipt()]),
    );
  });

  it("code_review never calls verifyExisting or linearPublicationStore.load (unaffected by this ticket's new read path)", async () => {
    const { deps, progress, calls } = await harness({
      reviewRequirement: "code_review",
      acceptanceCriteria: [evidenceCriterion],
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([{ jobId, outcome: "completed" }]);
    expect(calls).toContain("autoMerge.enable");
    expect(calls).not.toContain("visualEvidence.verifyExisting");
    expect(calls).not.toContain("linearPublicationStore.load");
  });

  it("fails closed to requires_manual (visual_evidence_missing_at_merge) when verifyExisting reports the evidence is gone/tampered, and never calls autoMerge.enable", async () => {
    const { deps, progress, calls } = await harness({
      ...dualHarnessOptions,
      visualEvidenceVerify: () =>
        Promise.resolve(
          Object.freeze({
            ok: false as const,
            failure: Object.freeze({
              reason: "existing_evidence_invalid" as const,
              error: domainError("conflict"),
            }),
          }),
        ),
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        {
          jobId,
          outcome: "requires_manual",
          reason: "visual_evidence_verify_failed:existing_evidence_invalid",
        },
      ]);
    }
    expect(calls).not.toContain("autoMerge.enable");
    const reloaded = await progress.load(jobId);
    expect(reloaded.ok && reloaded.value?.stage).toMatchObject({
      kind: "requires_manual",
      cause: { stage: "merge", reasonCode: "visual_evidence_missing_at_merge" },
    });
  });

  it("fails closed to requires_manual (visual_evidence_missing_at_merge) when deps.visualEvidence itself is never wired for the merge recheck", async () => {
    const { deps, progress, calls } = await harness({
      reviewRequirement: "dual_review",
      acceptanceCriteria: [evidenceCriterion],
      visualReviewCommands: [visualReviewCommand],
      visualReviewModel: "gemini-2.5-pro",
      // visualEvidenceBuild deliberately omitted -- deps.visualEvidence stays undefined, which also
      // means the review-time gate (E102-3) fires first; see the dedicated
      // `visualEvidenceVerify`-only-omission test below for the merge-time-specific gap.
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        { jobId, outcome: "requires_manual", reason: "visual_evidence_builder_unavailable" },
      ]);
    }
    expect(calls).not.toContain("autoMerge.enable");
  });

  it("fails closed to requires_manual (visual_publication_missing_at_merge) when linearPublicationStore.load finds no receipt, and never calls autoMerge.enable", async () => {
    const { deps, progress, calls } = await harness({
      ...dualHarnessOptions,
      linearPublicationStoreLoad: () => Promise.resolve(ok(undefined)),
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        {
          jobId,
          outcome: "requires_manual",
          reason: "linear_publication_receipt_missing_at_merge",
        },
      ]);
    }
    expect(calls).not.toContain("autoMerge.enable");
    const reloaded = await progress.load(jobId);
    expect(reloaded.ok && reloaded.value?.stage).toMatchObject({
      kind: "requires_manual",
      cause: { stage: "merge", reasonCode: "visual_publication_missing_at_merge" },
    });
  });

  it("fails closed to requires_manual (visual_publication_missing_at_merge) when deps.linearPublicationStore is never wired for the merge recheck", async () => {
    const { deps, progress, calls } = await harness({
      reviewRequirement: dualHarnessOptions.reviewRequirement,
      acceptanceCriteria: dualHarnessOptions.acceptanceCriteria,
      visualReviewCommands: dualHarnessOptions.visualReviewCommands,
      visualReviewModel: dualHarnessOptions.visualReviewModel,
      visualEvidenceBuild: dualHarnessOptions.visualEvidenceBuild,
      visualEvidenceVerify: dualHarnessOptions.visualEvidenceVerify,
      linearPublish: dualHarnessOptions.linearPublish,
      // linearPublicationStoreLoad deliberately omitted -- deps.linearPublicationStore stays
      // undefined (the composition-root-gap fixture for the merge-time recheck specifically).
    });
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        {
          jobId,
          outcome: "requires_manual",
          reason: "linear_publication_store_unavailable_at_merge",
        },
      ]);
    }
    expect(calls).not.toContain("autoMerge.enable");
  });

  it.each([
    [
      "evidence_drift_detected",
      { state: "evidence_drift_detected", identity: {} } as EnableAutoMergeOutcome,
      "evidence_drift_detected_at_merge",
    ],
    [
      "publication_drift_detected",
      { state: "publication_drift_detected", identity: {} } as EnableAutoMergeOutcome,
      "publication_drift_detected_at_merge",
    ],
  ] as const)(
    "maps AutoMergeGate.enable()'s %s outcome to requires_manual with a distinct reasonCode (never effective_diff_changed / auto_merge_not_enabled)",
    async (reasonCode, enableOutcome, expectedReason) => {
      const { deps, progress } = await harness({ ...dualHarnessOptions, enableOutcome });
      await seedProgressRecord(progress, { kind: "ci_waiting" });

      const result = await runResumeCycle(deps);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([
          { jobId, outcome: "requires_manual", reason: expectedReason },
        ]);
      }
      const reloaded = await progress.load(jobId);
      expect(reloaded.ok && reloaded.value?.stage).toMatchObject({
        kind: "requires_manual",
        cause: { stage: "merge", reasonCode },
      });
    },
  );

  /**
   * E102-4b acceptance criterion 3 + the ticket's own "先紅後綠" requirement: proves, with the
   * *real* `AutoMergeGate`/`createReviewIdentity` domain logic (never `deps.autoMerge.enable`'s
   * usual scripted fake), that a `dual_review` job whose review-time `publicationDigest` and
   * merge-time `currentPublicationDigest`/`currentVisualManifest` all trace back to the exact same
   * evidence really does arm auto-merge end to end. Before E102-4b wired `publicationDigest` into
   * `reviewer.run()` (review side) and `currentVisualManifest`/`currentPublicationDigest` into
   * `AutoMergeGate.enable()` (merge side), this exact scenario reproducibly failed closed at
   * `stage:"request"` (`AutoMergeGate`'s own `validApproval`, merge-gate.ts, requires both digests
   * non-empty and matching for every `dual_review`/`visual_review` report) -- see this test file's
   * own git history / PR description for the reproduction of that red state.
   */
  it("real AutoMergeGate: a dual_review job with matching evidence+publication digests actually arms auto-merge (regression guard for the production wiring gap)", async () => {
    const diff: readonly EffectiveTreeChange[] = [
      {
        before: null,
        after: {
          path: "src/status.ts",
          mode: "100644",
          objectId: { algorithm: "sha1", value: "1".repeat(40) },
        },
      },
    ];
    const mergePortCalls: string[] = [];
    const mergePorts: MergeGatePorts = {
      git: { getEffectiveTreeDiff: () => Promise.resolve(ok(diff)) },
      autoMergePause: { isPaused: () => Promise.resolve(ok({ paused: false })) },
      workManagement: {
        getIssue: () =>
          Promise.resolve(
            ok({
              issue: issueSchema.parse({
                schemaVersion: 1,
                id: issueId,
                projectId,
                externalId: externalIssueId,
                title: "Ship the thing",
              }),
              workStatus: "in_review" as const,
              updatedAt: now,
              revision: now,
            }),
          ),
      },
      sourceControl: {
        getChangeRequest: () => Promise.resolve(ok(changeRequest())),
        getCommitChecks: () =>
          Promise.resolve(ok({ headSha, aggregate: "success" as const, checks: [] })),
        getCommitStatuses: () =>
          Promise.resolve(
            ok({
              headSha,
              statuses: [{ context: REVIEW_STATUS_CONTEXT, state: "success" as const }],
            }),
          ),
        appendChangeRequestComment: () => {
          mergePortCalls.push("comment");
          return Promise.resolve(
            ok({
              id: "100",
              url: "https://github.com/owner/sandbox/pull/42#issuecomment-100",
              createdAt: now,
            }),
          );
        },
        setCommitStatus: () => {
          mergePortCalls.push("status");
          return Promise.resolve(ok(undefined));
        },
        enableAutoMerge: () => {
          mergePortCalls.push("enable");
          return Promise.resolve(
            ok({
              outcome: "enabled" as const,
              changeRequest: changeRequest({ autoMergeEnabled: true }) as never,
              mutations: [],
            }),
          );
        },
      },
    };

    const { deps, progress, calls } = await harness({ ...dualHarnessOptions });
    (deps as { autoMerge: ResumeCycleDependencies["autoMerge"] }).autoMerge = new AutoMergeGate(
      mergePorts,
    );
    (deps as { reviewer: ResumeCycleDependencies["reviewer"] }).reviewer = {
      run: (request) => {
        calls.push("reviewer.run");
        const manifest = request.visualManifest;
        const identity = createReviewIdentity(
          request.requirementSnapshot,
          request.expectedHeadSha,
          diff,
          {
            ...(manifest === undefined
              ? {}
              : { visualManifest: canonicalVisualManifestInput(manifest) }),
            ...(request.publicationDigest === undefined
              ? {}
              : { publicationDigest: request.publicationDigest }),
          },
        );
        if (!identity.ok)
          throw new Error("fixture invariant violated: identity must build cleanly");
        const identityValue = identity.value;
        function reportFor(role: ReviewerReport["role"]): ReviewerReport {
          return {
            schemaVersion: 1,
            role,
            verdict: "passed",
            requirementsDigest: identityValue.requirementsDigest,
            headSha: identityValue.headSha,
            diffDigest: identityValue.diffDigest,
            ...(identityValue.evidenceDigest === undefined
              ? {}
              : { evidenceDigest: identityValue.evidenceDigest }),
            ...(identityValue.publicationDigest === undefined
              ? {}
              : { publicationDigest: identityValue.publicationDigest }),
            summary: "All checks passed.",
            acceptanceCriteria: [
              {
                criterion: evidenceCriterion,
                status: "passed",
                summary: "Bound to exact evidence.",
                evidenceSources: ["agent-team:diff"],
              },
            ],
            qualityChecks: [
              {
                dimension: "correctness",
                status: "passed",
                summary: "Correct.",
                evidenceSources: ["agent-team:diff"],
              },
            ],
            findings: [],
          };
        }
        return Promise.resolve({
          state: "approved",
          job: job(),
          changeRequest: changeRequest(),
          checks: { headSha, aggregate: "success" as const, checks: [] },
          identity: identity.value,
          reports: [reportFor("code_reviewer"), reportFor("visual_reviewer")],
        } as never);
      },
    };
    (deps as { reviewStatus: ResumeCycleDependencies["reviewStatus"] }).reviewStatus = {
      begin: () => Promise.resolve({ state: "pending", changeRequest: changeRequest() } as never),
      record: (request) =>
        Promise.resolve({
          state: "approved",
          approval: {
            changeRequestId: "42",
            identity: request.decision.identity,
            reports: request.decision.reports,
            evidenceComment: {
              id: "100",
              url: "https://github.com/owner/sandbox/pull/42#issuecomment-100",
              createdAt: now,
            },
          },
        } as never),
    };
    await seedProgressRecord(progress, { kind: "ci_waiting" });

    const result = await runResumeCycle(deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([{ jobId, outcome: "merging" }]);
    }
    expect(mergePortCalls).toContain("enable");
    const reloaded = await progress.load(jobId);
    expect(reloaded.ok && reloaded.value?.stage).toMatchObject({ kind: "merging" });
  });
});
