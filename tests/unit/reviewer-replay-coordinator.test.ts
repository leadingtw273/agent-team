import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ReviewerReplayCoordinator } from "../../src/cli/dispatch/reviewer-replay-coordinator.js";
import { LocalYamlCheckpointStore } from "../../src/adapters/checkpoint/local-yaml.js";
import { LocalYamlCheckpointReader } from "../../src/adapters/checkpoint/local-yaml-reader.js";
import { checkpointSchema } from "../../src/domain/checkpoint/index.js";
import { FileFinalReviewRecoveryStore } from "../../src/adapters/dispatch/final-review-recovery-store.js";
import {
  resumeUnderLease,
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
import { InMemoryLeaseRepository } from "../../src/cli/dispatch/ephemeral-ports.js";
import { LeaseCoordinator } from "../../src/application/leases/index.js";
import type {
  ReviewerPipelineOutcome,
  ReviewerPipelineRequest,
  ReviewerReport,
} from "../../src/application/pipelines/index.js";
import {
  currentReviewerReportContractBinding,
  requiredReviewerRoles,
} from "../../src/application/pipelines/reviewer-policy.js";
import { workStatusLifecycleCheckpointSchema } from "../../src/application/pipelines/work-status-lifecycle-model.js";
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
  projectIssueByExternalId,
  type LinearDiscoveryReadModel,
} from "../../src/adapters/dispatch/linear-discovery.js";
import { readyGateTemplateHeadings } from "../../src/application/registration/linear-provision-model.js";
import {
  agentRoleSchema,
  issueSchema,
  projectSchema,
  reviewRequirementSchema,
} from "../../src/domain/project/index.js";
import { agentStatuses, blockingReasons } from "../../src/domain/workflow/index.js";
import {
  createFixedClock,
  domainError,
  err,
  generateDeterministicIdentifier,
  ok,
  parseIdentifier,
  parseInstant,
  type Identifier,
  type Instant,
} from "../../src/domain/foundation/index.js";
import { emptyAttemptCounters, jobSchema, type Job } from "../../src/domain/jobs/index.js";
import {
  createRequirementSnapshot,
  headShaSchema,
  sha256Digest,
  type ReviewIdentity,
} from "../../src/domain/review/index.js";

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

const now = instant("2026-08-17T08:00:00.000Z");
const externalIssueId = "linear-issue-1";
const projectId = id("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const generatedIssueId = generateDeterministicIdentifier("issue", externalIssueId);
if (!generatedIssueId.ok) throw new Error(generatedIssueId.error.code);
const issueId = generatedIssueId.value;
const jobId = id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const headSha = headShaSchema.parse("a".repeat(40));
const baseRevision = headShaSchema.parse("b".repeat(40));
const requirementsDigest = "c".repeat(64);
const diffDigest = "d".repeat(64);
const finalCheckpointId = id("checkpoint", "checkpoint_018f47d2-77a4-7cc1-8ef2-0123456789ab");

function project() {
  return projectSchema.parse({
    schemaVersion: 1,
    id: projectId,
    displayName: "Replay Test",
    localRepositoryPath: "/tmp/reviewer-replay-project",
    defaultBranch: "main",
    workManagement: { provider: "linear", containerId: "team-1", projectId: "linear-project" },
    sourceControl: { provider: "github", repository: "owner/replay-test" },
  });
}

function job(finalReview = false): Job {
  return jobSchema.parse({
    schemaVersion: 1,
    id: jobId,
    projectId,
    issueId,
    createdAt: now,
    watchdogExtensionGranted: false,
    attempts: finalReview
      ? { ...emptyAttemptCounters(), reviewerFixRounds: 2, reviewRuns: 1 }
      : { ...emptyAttemptCounters(), reviewRuns: 3 },
  });
}

function linearContext(): LinearProjectContext {
  const states: LinearWorkflowStateRecord[] = Object.entries(linearWorkStatusNames).map(
    ([status, name], index) => ({ id: `state-${status}-${String(index)}`, name, type: status }),
  );
  const group = (name: string, groupId: string): LinearLabelRecord => ({
    id: groupId,
    name,
    isGroup: true,
    parentId: null,
  });
  const child = (name: string, parentId: string, childId: string): LinearLabelRecord => ({
    id: childId,
    name,
    isGroup: false,
    parentId,
  });
  const groups = {
    role: "label-group-role",
    review: "label-group-review",
    status: "label-group-status",
    blocking: "label-group-blocking",
  };
  const labels: LinearLabelRecord[] = [
    group("Agent 角色", groups.role),
    ...agentRoleSchema.options.map((key, index) =>
      child(linearAgentRoleNames[key], groups.role, `role-${String(index)}`),
    ),
    group("審查需求", groups.review),
    ...reviewRequirementSchema.options.map((key, index) =>
      child(linearReviewRequirementNames[key], groups.review, `review-${String(index)}`),
    ),
    group("Agent 狀態", groups.status),
    ...agentStatuses.map((key, index) =>
      child(linearAgentStatusNames[key], groups.status, `status-${String(index)}`),
    ),
    group("阻塞原因", groups.blocking),
    ...blockingReasons.map((key, index) =>
      child(linearBlockingReasonNames[key], groups.blocking, `blocking-${String(index)}`),
    ),
  ];
  const catalog = buildLinearReadCatalog(states, labels);
  if (!catalog.ok) throw new Error(catalog.error.code);
  return {
    team: { id: "team-1", name: "Team", key: "TM" },
    project: { id: "linear-project", name: "Project" },
    catalog: catalog.value,
  };
}

function readModel(
  reviewRequirement: "code_review" | "dual_review" = "code_review",
): LinearDiscoveryReadModel {
  return {
    readContext: () => Promise.resolve(ok(linearContext())),
    listIssueIdsInState: () => Promise.resolve(ok([externalIssueId])),
    readIssue: () =>
      Promise.resolve(
        ok({
          id: externalIssueId,
          identifier: "LEA-TEST",
          title: "Replay review",
          description: `## ${readyGateTemplateHeadings.acceptanceCriteria}\n- Review passes\n`,
          updatedAt: now,
          teamId: "team-1",
          projectId: "linear-project",
          workStatus: "ready" as const,
          agentRole: "implementer" as const,
          reviewRequirement,
          otherLabelIds: [],
          relations: [],
          comments: [],
        }),
      ),
  };
}

function changeRequest(state: "open" | "merged" = "open") {
  return {
    id: "PR_node",
    number: 42,
    url: "https://github.com/owner/replay-test/pull/42",
    state,
    draft: false,
    baseBranch: "main",
    headBranch: "agent-team/replay",
    headSha,
    mergeability: "mergeable" as const,
    mergeStateStatus: "clean" as const,
    baseSha: baseRevision,
    autoMergeEnabled: false,
    updatedAt: now,
  };
}

function identity(requirements = requirementsDigest): ReviewIdentity {
  return { requirementsDigest: requirements as never, headSha, diffDigest: diffDigest as never };
}

function report(
  request: ReviewerPipelineRequest,
  approvedIdentity?: ReviewIdentity,
): ReviewerReport {
  return {
    schemaVersion: 1,
    role: "code_reviewer",
    verdict: "passed",
    requirementsDigest:
      approvedIdentity?.requirementsDigest ?? request.requirementSnapshot.requirementsDigest,
    headSha: approvedIdentity?.headSha ?? request.expectedHeadSha,
    diffDigest: approvedIdentity?.diffDigest ?? diffDigest,
    ...(approvedIdentity?.evidenceDigest === undefined
      ? {}
      : { evidenceDigest: approvedIdentity.evidenceDigest }),
    ...(approvedIdentity?.publicationDigest === undefined
      ? {}
      : { publicationDigest: approvedIdentity.publicationDigest }),
    summary: "All acceptance criteria pass.",
    acceptanceCriteria: [
      { criterion: "Review passes", status: "passed", summary: "Verified.", evidenceSources: [] },
    ],
    qualityChecks: [
      { dimension: "correctness", status: "passed", summary: "Correct.", evidenceSources: [] },
    ],
    findings: [],
  };
}

class AdmissionFake implements IssueAdmissionPort {
  record: IssueAdmissionRecord = {
    schemaVersion: 1,
    revision: 0,
    projectId,
    issueId,
    jobId,
    state: "active",
    claimedAt: now,
    updatedAt: now,
  };

  load() {
    return Promise.resolve(ok(this.record));
  }
  claim() {
    return Promise.resolve(err(domainError("conflict")));
  }
  attachJob() {
    return Promise.resolve(ok(this.record));
  }
  release(_project: string, _issue: string, expected: number, reason: never) {
    if (expected !== this.record.revision) return Promise.resolve(err(domainError("conflict")));
    this.record = {
      ...this.record,
      revision: this.record.revision + 1,
      state: "released",
      releaseReason: reason,
      updatedAt: now,
    };
    return Promise.resolve(ok(this.record));
  }
}

interface Harness {
  readonly coordinator: ReviewerReplayCoordinator;
  readonly progress: FileJobProgressStore;
  readonly admission: AdmissionFake;
  readonly calls: string[];
  readonly providerStarts: string[];
  readonly requests: ReviewerPipelineRequest[];
  readonly lifecycleRequests: unknown[];
  readonly leases: InMemoryLeaseRepository;
  readonly deps: ResumeCycleDependencies;
  readonly policy: { enabled: boolean };
  readonly finalRecovery?: FileFinalReviewRecoveryStore;
}

class FailSuccessCheckpointProgressStore extends FileJobProgressStore {
  override compareAndSwap(
    targetJobId: string,
    expectedRevision: number | null,
    next: JobProgressRecordMutation,
    options?: Parameters<FileJobProgressStore["compareAndSwap"]>[3],
  ): ReturnType<FileJobProgressStore["compareAndSwap"]> {
    if (next.reviewerReplay?.state === "review_succeeded") {
      return Promise.resolve(err(domainError("conflict")));
    }
    return super.compareAndSwap(targetJobId, expectedRevision, next, options);
  }
}

async function harness(
  reviewerOutcomes: readonly ("approved" | "changes" | "format" | "transport")[],
  overrides: Readonly<{
    enabled?: boolean;
    workStatus?: "in_review" | "canceled";
    claimJobId?: Identifier<"job">;
    inspectIdentities?: readonly ReviewIdentity[];
    failSuccessCheckpoint?: boolean;
    crashOnFirstReviewRecord?: boolean;
    reviewRecordMismatch?: boolean;
    approvedIdentity?: ReviewIdentity;
    autoMergePending?: boolean;
    seedReplay?: "legacy_exhausted" | "legacy_mixed_exhausted" | "v2_exhausted" | "v2_zero";
    reviewRequirement?: "code_review" | "dual_review";
    finalReview?: boolean;
    throwOnProvider?: boolean;
  }> = {},
): Promise<Harness> {
  const progressRoot = await temporaryDirectory("reviewer-replay-progress-");
  const progress =
    overrides.failSuccessCheckpoint === true
      ? new FailSuccessCheckpointProgressStore(progressRoot)
      : new FileJobProgressStore(progressRoot);
  const workIssue = issueSchema.parse({
    schemaVersion: 1,
    id: issueId,
    projectId,
    externalId: externalIssueId,
    title: "Replay review",
    acceptanceCriteria: ["Review passes"],
    reviewRequirement: overrides.reviewRequirement ?? "code_review",
  });
  const authoritativeIssue = await projectIssueByExternalId(
    project(),
    readModel(overrides.reviewRequirement),
    "team-1",
    "linear-project",
    externalIssueId,
  );
  if (!authoritativeIssue.ok) throw new Error(authoritativeIssue.error.code);
  const snapshot = createRequirementSnapshot(authoritativeIssue.value, now);
  if (!snapshot.ok) throw new Error(snapshot.error.code);
  const legacyIdentity = {
    schemaVersion: 1 as const,
    jobId,
    projectId,
    issueId,
    externalIssueId,
    changeRequestId: "42",
    baseRevision,
    requirementsDigest: snapshot.value.requirementsDigest,
    headSha,
    diffDigest,
  };
  const legacyDigest = sha256Digest(legacyIdentity);
  if (!legacyDigest.ok) throw new Error(legacyDigest.error.code);
  const legacyReplay = {
    state: "attempting" as const,
    identity: legacyIdentity,
    identityDigest: legacyDigest.value,
    counters: { providerAttempts: 2, formatFailures: 2, transportFailures: 0 },
    lastFormatCategory: "missing_field" as const,
  };
  const mixedLegacyReplay = {
    ...legacyReplay,
    counters: { providerAttempts: 2, formatFailures: 1, transportFailures: 0 },
  };
  const v2Identity = { ...legacyIdentity, schemaVersion: 2 as const, epochOrdinal: 2 };
  const v2Digest = sha256Digest(v2Identity);
  if (!v2Digest.ok) throw new Error(v2Digest.error.code);
  const v2Replay = {
    state: "attempting" as const,
    identity: v2Identity,
    identityDigest: v2Digest.value,
    reviewContractBinding: currentReviewerReportContractBinding,
    counters: { providerAttempts: 0, formatFailures: 0, transportFailures: 0 },
  };
  const v2ExhaustedIdentity = { ...legacyIdentity, schemaVersion: 2 as const, epochOrdinal: 1 };
  const v2ExhaustedDigest = sha256Digest(v2ExhaustedIdentity);
  if (!v2ExhaustedDigest.ok) throw new Error(v2ExhaustedDigest.error.code);
  const v2ExhaustedReplay = {
    state: "attempting" as const,
    identity: v2ExhaustedIdentity,
    identityDigest: v2ExhaustedDigest.value,
    reviewContractBinding: currentReviewerReportContractBinding,
    counters: { providerAttempts: 2, formatFailures: 2, transportFailures: 0 },
    lastFormatCategory: "missing_field" as const,
  };
  const baseProgress: JobProgressRecordMutation = {
    jobId,
    projectId,
    issueId,
    externalIssueId,
    model: "claude-opus",
    providerAssignments: {
      execution: { provider: "codex", model: "gpt-sol" },
      codeReview: { provider: "claude", model: "claude-opus" },
    },
    stage: {
      kind: "requires_manual",
      cause: {
        stage: "review",
        reasonCode: "review_report_contract",
        attempts: { count: 2, lastCategory: "missing_field" },
      },
    },
    branch: "agent-team/replay",
    worktreePath: "/tmp/reviewer-replay-project",
    changeRequestId: "42",
    headSha,
    baseRevision,
  };
  const initialProgress =
    overrides.seedReplay === undefined
      ? {
          ...baseProgress,
          ...(overrides.finalReview === true
            ? {
                stage: { kind: "paused" as const, checkpointId: finalCheckpointId },
                workStatusLifecycle: workStatusLifecycleCheckpointSchema.parse({
                  admissionMode: "enforce" as const,
                  capabilityDigest: "9".repeat(64),
                  phase: "reviewing" as const,
                  transitions: [
                    {
                      step: "review_start" as const,
                      instance: "8".repeat(64),
                      mainTarget: "in_review" as const,
                      allowedMainSources: ["in_progress", "in_review"],
                      agentTarget: { kind: "set" as const, status: "waiting" as const },
                      main: {
                        state: "confirmed" as const,
                        idempotencyKey: "lifecycle:main",
                        confirmedAt: now,
                        observedRevision: now,
                      },
                      agent: {
                        state: "confirmed" as const,
                        idempotencyKey: "lifecycle:agent",
                        confirmedAt: now,
                        observedRevision: now,
                      },
                      mainFailures: { count: 0 },
                      agentFailures: { count: 0 },
                      historyEvidence: {
                        preStateId: "state-progress",
                        targetStateId: "state-review",
                        observedRevision: now,
                        historyPrefixDigest: "7".repeat(64),
                        historyEntryCount: 1,
                        historyTailId: "history-tail",
                        preStateSpanId: "history-span",
                      },
                    },
                  ],
                }),
              }
            : {}),
        }
      : {
          ...baseProgress,
          reviewerReplay:
            overrides.seedReplay === "legacy_mixed_exhausted"
              ? mixedLegacyReplay
              : overrides.seedReplay === "v2_exhausted"
                ? v2ExhaustedReplay
                : legacyReplay,
        };
  const seeded = await progress.compareAndSwap(jobId, null, initialProgress);
  expect(seeded.ok).toBe(true);
  if (!seeded.ok) throw new Error("test setup could not seed job progress");
  if (overrides.seedReplay === "v2_zero") {
    const archived = await progress.compareAndSwap(jobId, seeded.value.revision, {
      ...baseProgress,
      previousReviewerReplay: legacyReplay,
      reviewerReplay: v2Replay,
    });
    expect(archived.ok).toBe(true);
  }
  const admission = new AdmissionFake();
  if (overrides.claimJobId !== undefined)
    admission.record = { ...admission.record, jobId: overrides.claimJobId };
  const leases = new InMemoryLeaseRepository();
  const leaseCoordinator = new LeaseCoordinator(leases, { clock: createFixedClock(now) });
  const calls: string[] = [];
  const providerStarts: string[] = [];
  const requests: ReviewerPipelineRequest[] = [];
  const lifecycleRequests: unknown[] = [];
  let reviewerIndex = 0;
  let inspectIndex = 0;
  let reviewRecordCalls = 0;
  const jobs = [job(overrides.finalReview === true)];
  const reviewer = {
    inspect: (request: ReviewerPipelineRequest) => {
      calls.push("inspect");
      const selected =
        overrides.inspectIdentities?.[inspectIndex] ??
        identity(request.requirementSnapshot.requirementsDigest);
      inspectIndex += 1;
      return Promise.resolve({
        state: "ready" as const,
        job: request.job,
        changeRequest: changeRequest(),
        checks: {
          headSha,
          aggregate: "success" as const,
          checks: [
            { name: "quality", status: "completed" as const, conclusion: "success" as const },
          ],
        },
        identity: selected,
        diff: [],
      });
    },
    run: (request: ReviewerPipelineRequest): Promise<ReviewerPipelineOutcome> => {
      calls.push("provider");
      providerStarts.push(...requiredReviewerRoles(request));
      requests.push(request);
      if (overrides.throwOnProvider === true) throw new Error("simulated_provider_process_crash");
      const scripted = reviewerOutcomes[reviewerIndex] ?? "approved";
      reviewerIndex += 1;
      if (scripted === "format") {
        return Promise.resolve({
          state: "failed",
          stage: "report",
          error: domainError("external_failure"),
          job: request.job,
          reportFailureCategory: "schema_invalid",
          diagnostics: [
            {
              code: "invalid_type",
              path: "qualityChecks.[*].status",
              message: "Value type does not match the report schema.",
            },
          ],
          rejectedOutput: "SECRET RAW OUTPUT",
        });
      }
      if (scripted === "transport") {
        return Promise.resolve({
          state: "failed",
          stage: "provider_run",
          error: domainError("timeout"),
          job: request.job,
        });
      }
      if (scripted === "changes") {
        const blocking = {
          ...report(request),
          verdict: "changes_requested" as const,
          findings: [
            {
              severity: "blocking" as const,
              title: "Blocking finding",
              description: "A blocking issue remains.",
              acceptanceCriteria: ["Review passes"],
              evidenceSources: [],
            },
          ],
        };
        return Promise.resolve({
          state: "changes_requested",
          job: request.job,
          changeRequest: changeRequest(),
          checks: {
            headSha,
            aggregate: "success",
            checks: [{ name: "quality", status: "completed", conclusion: "success" }],
          },
          identity: identity(request.requirementSnapshot.requirementsDigest),
          reports: [blocking],
          findings: blocking.findings,
        });
      }
      const approvedIdentity =
        overrides.approvedIdentity ?? identity(request.requirementSnapshot.requirementsDigest);
      return Promise.resolve({
        state: "approved",
        job: request.job,
        changeRequest: changeRequest(),
        checks: {
          headSha,
          aggregate: "success",
          checks: [{ name: "quality", status: "completed", conclusion: "success" }],
        },
        identity: approvedIdentity,
        reports: [report(request, approvedIdentity)],
      });
    },
  };
  const policy = { enabled: overrides.enabled ?? true };
  const deps: ResumeCycleDependencies = {
    progress,
    jobRepository: {
      create: () => Promise.resolve(ok({ durability: "confirmed" as const })),
      readAll: () => Promise.resolve(ok(jobs)),
      update: () => Promise.resolve(ok({ durability: "confirmed" as const })),
    },
    leases: leaseCoordinator,
    sourceControl: {
      getChangeRequest: () => Promise.resolve(ok(changeRequest())),
      getCommitStatuses: () =>
        Promise.resolve(
          ok({
            headSha,
            statuses: [{ context: "agent-team/review", state: "pending" as const }],
          }),
        ),
    },
    workManagement: {
      getIssue: () =>
        Promise.resolve(
          ok({
            issue: workIssue,
            workStatus: overrides.workStatus ?? "in_review",
            updatedAt: now,
            revision: now,
          }),
        ),
    },
    readModel: readModel(overrides.reviewRequirement),
    teamId: "team-1",
    linearProjectId: "linear-project",
    project: project(),
    trustedConfig: {
      schemaVersion: 1,
      projectId,
      defaultBranch: "main",
      platforms: {
        workManagement: { provider: "linear", containerId: "team-1", projectId: "linear-project" },
        sourceControl: { provider: "github", repository: "owner/replay-test" },
      },
      projectRules: [],
      roleInstructions: {},
      commands: { quality: [], visualReview: [] },
    },
    ...(overrides.reviewRequirement === "dual_review"
      ? {
          visualReviewModel: "claude-visual",
          visualEvidence: {
            build: () => Promise.reject(new Error("must not build during replay")),
            verifyExisting: () =>
              Promise.resolve({
                ok: true as const,
                value: {
                  visualManifest: {
                    schemaVersion: 1 as const,
                    issueId,
                    commitSha: headSha,
                    generatedAt: now,
                    environment: { runner: "fixture", operatingSystem: "linux" },
                    artifacts: [],
                  },
                  evidence: [],
                  evidenceDirectory: "/tmp/reviewer-replay-project/.agent-team/evidence",
                  reused: true,
                },
              } as never),
          },
          linearPublicationStore: {
            load: () =>
              Promise.resolve(
                ok({
                  schemaVersion: 1 as const,
                  projectId,
                  issueId,
                  externalIssueId,
                  headSha,
                  manifestDigest: "e".repeat(64),
                  manifestComment: { id: "manifest-comment", sha256: "f".repeat(64) },
                  artifacts: [
                    {
                      path: "evidence.png",
                      sha256: "d".repeat(64),
                      assetUrl: "https://example.test/evidence.png",
                      commentId: "artifact-comment",
                    },
                  ],
                  createdAt: now,
                } as never),
              ),
          },
        }
      : {}),
    ciRecovery: { run: () => Promise.reject(new Error("must not run")) },
    reviewerRecovery: { run: () => Promise.reject(new Error("must not run")) },
    reviewer,
    reviewerReplayPolicy: {
      load: () =>
        Promise.resolve(
          ok({
            schemaVersion: 1,
            revision: 0,
            projectId,
            enabled: policy.enabled,
            updatedAt: now,
          }),
        ),
    },
    ...(overrides.finalReview === true
      ? {
          workStatusLifecycle: {
            transition: () =>
              Promise.resolve({
                state: "permitted" as const,
                mode: "enforce" as const,
                main: "confirmed" as const,
                agent: "confirmed" as const,
              }),
          },
        }
      : {}),
    reviewStatus: {
      begin: () => {
        calls.push("reviewStatus.begin");
        return Promise.resolve({ state: "pending", changeRequest: changeRequest() } as never);
      },
      record: async () => {
        reviewRecordCalls += 1;
        if (overrides.crashOnFirstReviewRecord === true && reviewRecordCalls === 1) {
          throw new Error("simulated_crash_after_checkpoint");
        }
        const checkpoint = await progress.load(jobId);
        expect(checkpoint.ok && checkpoint.value?.reviewerReplay?.state).toBe("review_succeeded");
        calls.push("reviewStatus.record");
        return overrides.reviewRecordMismatch === true
          ? ({ state: "not_approved" } as never)
          : ({ state: "approved", approval: { identity: {}, reports: [] } } as never);
      },
    },
    autoMerge: {
      enable: () => {
        calls.push("autoMerge.enable");
        if (overrides.autoMergePending === true) {
          return Promise.resolve({
            state: "not_ready",
            reason: "ci_pending",
            changeRequest: changeRequest(),
          } as never);
        }
        return Promise.resolve({
          state: "already_merged_external",
          changeRequest: changeRequest("merged"),
        });
      },
    },
    lifecycle: {
      run: (request) => {
        calls.push("lifecycle.run");
        lifecycleRequests.push(request);
        return Promise.resolve({ state: "completed", merge: "external" } as never);
      },
    },
    clock: createFixedClock(now),
    holderId: "reviewer-replay-test",
    reviewReportSidecar: {
      record: () => Promise.resolve(ok({ path: "/tmp/reviewer-replay-sidecar-unused" })),
    },
    admission,
    resolveAuthoritativeBase: () => Promise.reject(new Error("must not resolve live base")),
  };
  let finalRecovery: FileFinalReviewRecoveryStore | undefined;
  let finalReviewDependencies:
    | Readonly<{
        store: FileFinalReviewRecoveryStore;
        checkpoints: LocalYamlCheckpointReader;
      }>
    | undefined;
  if (overrides.finalReview === true) {
    const finalRoot = await temporaryDirectory("final-review-recovery-");
    const checkpointRoot = await temporaryDirectory("final-review-checkpoint-");
    finalRecovery = new FileFinalReviewRecoveryStore(finalRoot, undefined, createFixedClock(now));
    const checkpoint = {
      schemaVersion: 1 as const,
      id: finalCheckpointId,
      projectId,
      issueId,
      jobId,
      createdAt: now,
      reason: "retry_exhausted" as const,
      completedItems: [],
      remainingItems: [],
      tests: [{ commandSummary: "quality", status: "passed" as const }],
      nextSteps: ["審查回合已達上限，請人工檢視 Reviewer 意見與變更請求 diff 後決定下一步。"],
      blockers: [],
      requirementSnapshot: snapshot.value,
      model: { provider: "dispatch-cli", model: "unassigned" },
      worktree: {
        path: "/tmp/reviewer-replay-project",
        branch: "agent-team/replay",
        commitSha: headSha,
        pushed: true,
      },
    };
    const persisted = await new LocalYamlCheckpointStore(checkpointRoot).persist(
      checkpointSchema.parse(checkpoint),
      {
        idempotencyKey: "final-review:test-checkpoint",
      },
    );
    if (!persisted.ok) throw new Error(`final checkpoint setup failed: ${persisted.error.code}`);
    finalReviewDependencies = {
      store: finalRecovery,
      checkpoints: new LocalYamlCheckpointReader(checkpointRoot),
    };
  }
  const coordinator = new ReviewerReplayCoordinator({
    resume: deps,
    diagnostics: {
      append: (_job, _identity, entry) => {
        calls.push(`diagnostic:${entry.kind}`);
        expect(JSON.stringify(entry)).not.toContain("SECRET RAW OUTPUT");
        return Promise.resolve(ok(undefined));
      },
    },
    publication: {
      sourceControl: {
        appendChangeRequestComment: () => {
          calls.push("pr-summary");
          return Promise.resolve(ok({ id: "comment", url: "url", createdAt: now }));
        },
      },
      workManagement: {
        appendComment: (_ref, body) => {
          calls.push("linear-summary");
          expect(body).not.toContain("SECRET RAW OUTPUT");
          return Promise.resolve(ok({ id: "comment", body, createdAt: now }));
        },
      },
    },
    delay: () => Promise.resolve(),
    ...(finalReviewDependencies === undefined
      ? {}
      : { finalReviewRecovery: finalReviewDependencies }),
  });
  return {
    coordinator,
    progress,
    admission,
    calls,
    providerStarts,
    requests,
    lifecycleRequests,
    leases,
    deps,
    policy,
    ...(finalRecovery === undefined ? {} : { finalRecovery }),
  };
}

describe("ReviewerReplayCoordinator", () => {
  it("final-review dry-run validates the exact paused checkpoint with zero mutation", async () => {
    const value = await harness(["approved"], { finalReview: true });
    const before = await value.progress.load(jobId);
    const result = await value.coordinator.run(jobId, true, {
      finalReviewEpoch: true,
      expectCheckpoint: finalCheckpointId,
    });
    const after = await value.progress.load(jobId);

    expect(result).toMatchObject({
      state: "ready",
      providerAttemptsUsed: 0,
      providerAttemptsRemaining: 1,
    });
    expect(value.calls).toEqual(["inspect"]);
    expect(after).toEqual(before);
    await expect(value.finalRecovery?.load(jobId)).resolves.toEqual({ ok: true, value: undefined });
    await expect(value.leases.readAll()).resolves.toEqual({ ok: true, value: [] });
  });

  it("final-review approval calls one provider, checkpoints success, then resumes the existing gate", async () => {
    const value = await harness(["approved"], { finalReview: true });
    const result = await value.coordinator.run(jobId, false, {
      finalReviewEpoch: true,
      expectCheckpoint: finalCheckpointId,
    });

    expect(result).toMatchObject({ state: "continued", providerAttempts: 1 });
    expect(value.calls.filter((call) => call === "provider")).toHaveLength(1);
    expect(value.calls, JSON.stringify(result)).toContain("reviewStatus.record");
    expect(value.calls).toContain("autoMerge.enable");
    await expect(value.finalRecovery?.load(jobId)).resolves.toMatchObject({
      ok: true,
      value: { state: "review_succeeded", providerRuns: 1 },
    });
    await expect(value.progress.load(jobId)).resolves.toMatchObject({
      ok: true,
      value: { reviewerReplay: { state: "review_succeeded" } },
    });
  });

  it("final-review changes-requested consumes the one run and never invokes fixer, status, or merge", async () => {
    const value = await harness(["changes"], { finalReview: true });
    const result = await value.coordinator.run(jobId, false, {
      finalReviewEpoch: true,
      expectCheckpoint: finalCheckpointId,
    });

    expect(result).toMatchObject({ state: "blocked", reason: "review_not_approved" });
    expect(value.calls.filter((call) => call === "provider")).toHaveLength(1);
    expect(value.calls).not.toContain("reviewStatus.record");
    expect(value.calls).not.toContain("autoMerge.enable");
    await expect(value.finalRecovery?.load(jobId)).resolves.toMatchObject({
      ok: true,
      value: { state: "review_not_approved", verdict: "changes_requested" },
    });
    await expect(value.progress.load(jobId)).resolves.toMatchObject({
      ok: true,
      value: { stage: { kind: "paused", checkpointId: finalCheckpointId } },
    });
  });

  it("final-review crash after reservation converges to outcome-unknown without a second provider", async () => {
    const value = await harness(["approved"], { finalReview: true, throwOnProvider: true });
    await expect(
      value.coordinator.run(jobId, false, {
        finalReviewEpoch: true,
        expectCheckpoint: finalCheckpointId,
      }),
    ).rejects.toThrow("simulated_provider_process_crash");
    const second = await value.coordinator.run(jobId, false, {
      finalReviewEpoch: true,
      expectCheckpoint: finalCheckpointId,
    });

    expect(second).toMatchObject({
      state: "blocked",
      reason: "final_provider_outcome_unknown",
    });
    expect(value.calls.filter((call) => call === "provider")).toHaveLength(1);
    await expect(value.finalRecovery?.load(jobId)).resolves.toMatchObject({
      ok: true,
      value: { state: "provider_outcome_unknown", providerRuns: 1 },
    });
  });

  it("final-review wrong checkpoint is read-only and never reaches the provider", async () => {
    const value = await harness(["approved"], { finalReview: true });
    const result = await value.coordinator.run(jobId, true, {
      finalReviewEpoch: true,
      expectCheckpoint: "checkpoint_018f47d2-77a4-7cc1-8ef2-1123456789ab",
    });
    expect(result).toMatchObject({ state: "blocked", reason: "job_not_eligible" });
    expect(value.calls).toEqual([]);
  });

  it("final-review rejects evidence identity drift even when the report is internally consistent", async () => {
    const value = await harness(["approved"], {
      finalReview: true,
      approvedIdentity: { ...identity(), evidenceDigest: "e".repeat(64) as never },
    });
    const result = await value.coordinator.run(jobId, false, {
      finalReviewEpoch: true,
      expectCheckpoint: finalCheckpointId,
    });

    expect(result).toMatchObject({ state: "blocked", reason: "identity_mismatch" });
    expect(value.calls.filter((call) => call === "provider")).toHaveLength(1);
    expect(value.calls).not.toContain("reviewStatus.record");
    expect(value.calls).not.toContain("autoMerge.enable");
  });

  it("contract epoch dry-run admits the exhausted legacy identity without mutation", async () => {
    const value = await harness(["approved"], { seedReplay: "legacy_exhausted" });
    const before = await value.progress.load(jobId);
    const result = await value.coordinator.run(jobId, true, {
      newContractEpoch: true,
      expectContractVersion: 2,
    });
    const after = await value.progress.load(jobId);
    expect(result).toMatchObject({
      state: "ready",
      providerAttemptsUsed: 0,
      providerAttemptsRemaining: 2,
    });
    if (result.state !== "ready")
      throw new Error("contract epoch dry-run was unexpectedly blocked");
    expect(result.plannedMutations).toContain("archive-reviewer-replay-epoch");
    expect(result.plannedMutations).toContain("create-reviewer-contract-epoch");
    expect(value.calls).toEqual(["inspect"]);
    expect(after).toEqual(before);
    await expect(value.leases.readAll()).resolves.toEqual({ ok: true, value: [] });
  });

  it("contract epoch requires the exact expected version and never calls the provider on mismatch", async () => {
    const value = await harness(["approved"], { seedReplay: "legacy_exhausted" });
    await expect(
      value.coordinator.run(jobId, true, {
        newContractEpoch: true,
        expectContractVersion: 3,
      }),
    ).resolves.toMatchObject({ state: "blocked", reason: "contract_version_mismatch" });
    expect(value.calls).toEqual([]);
  });

  it("never replaces an ambiguously reserved legacy epoch as format-only exhaustion", async () => {
    const value = await harness(["approved"], { seedReplay: "legacy_mixed_exhausted" });
    const before = await value.progress.load(jobId);
    const dryRun = await value.coordinator.run(jobId, true, {
      newContractEpoch: true,
      expectContractVersion: 2,
    });
    const live = await value.coordinator.run(jobId, false, {
      newContractEpoch: true,
      expectContractVersion: 2,
    });
    const after = await value.progress.load(jobId);

    expect(dryRun).toMatchObject({ state: "blocked", reason: "contract_epoch_not_allowed" });
    expect(live).toMatchObject({ state: "blocked", reason: "contract_epoch_not_allowed" });
    expect(value.providerStarts).toHaveLength(0);
    expect(after).toEqual(before);
  });

  it("does not report ready when the deployed contract is not newer than the exhausted epoch", async () => {
    const value = await harness(["approved"], { seedReplay: "v2_exhausted" });
    const before = await value.progress.load(jobId);
    const result = await value.coordinator.run(jobId, true, {
      newContractEpoch: true,
      expectContractVersion: 2,
    });
    const after = await value.progress.load(jobId);

    expect(result).toMatchObject({ state: "blocked", reason: "contract_epoch_not_allowed" });
    expect(value.providerStarts).toHaveLength(0);
    expect(after).toEqual(before);
  });

  it("archives legacy epoch 1, succeeds in ordinal 2, and preserves the old counters", async () => {
    const value = await harness(["approved"], { seedReplay: "legacy_exhausted" });
    const result = await value.coordinator.run(jobId, false, {
      newContractEpoch: true,
      expectContractVersion: 2,
    });
    expect(result).toMatchObject({ state: "continued", providerAttempts: 1 });
    expect(value.calls.filter((call) => call === "provider")).toHaveLength(1);
    const stored = await value.progress.load(jobId);
    expect(stored.ok && stored.value?.previousReviewerReplay?.counters).toEqual({
      providerAttempts: 2,
      formatFailures: 2,
      transportFailures: 0,
    });
    expect(stored.ok && stored.value?.reviewerReplay).toMatchObject({
      state: "review_succeeded",
      identity: { schemaVersion: 2, epochOrdinal: 2 },
      reviewContractBinding: currentReviewerReportContractBinding,
      counters: { providerAttempts: 1, formatFailures: 0, transportFailures: 0 },
    });
  });

  it("plain dedicated replay continues a persisted non-exhausted ordinal-2 epoch after crash", async () => {
    const value = await harness(["approved"], { seedReplay: "v2_zero" });
    const result = await value.coordinator.run(jobId, false);
    expect(result).toMatchObject({ state: "continued", providerAttempts: 1 });
    expect(value.calls.filter((call) => call === "provider")).toHaveLength(1);
    const stored = await value.progress.load(jobId);
    expect(stored.ok && stored.value?.previousReviewerReplay?.counters.providerAttempts).toBe(2);
    expect(stored.ok && stored.value?.reviewerReplay?.state).toBe("review_succeeded");
  });

  it("plain dry-run keeps an exhausted legacy epoch blocked and does not duplicate publication", async () => {
    const value = await harness(["approved"], { seedReplay: "legacy_exhausted" });
    const result = await value.coordinator.run(jobId, true);
    expect(result).toMatchObject({ state: "blocked", reason: "attempts_exhausted" });
    expect(value.calls).toEqual(["inspect"]);
    expect(value.calls).not.toContain("pr-summary");
    expect(value.calls).not.toContain("linear-summary");
  });

  it("bounds epoch 2 to two format failures and keeps both epoch audits without status or merge", async () => {
    const value = await harness(["format", "format"], { seedReplay: "legacy_exhausted" });
    const result = await value.coordinator.run(jobId, false, {
      newContractEpoch: true,
      expectContractVersion: 2,
    });
    expect(result).toMatchObject({
      state: "blocked",
      reason: "attempts_exhausted",
      providerAttempts: 2,
      formatFailures: 2,
      transportFailures: 0,
    });
    expect(value.calls.filter((call) => call === "provider")).toHaveLength(2);
    expect(value.calls.filter((call) => call === "pr-summary")).toHaveLength(1);
    expect(value.calls.filter((call) => call === "linear-summary")).toHaveLength(1);
    expect(value.calls).not.toContain("reviewStatus.record");
    expect(value.calls).not.toContain("autoMerge.enable");
    const stored = await value.progress.load(jobId);
    expect(stored.ok && stored.value?.previousReviewerReplay?.counters.providerAttempts).toBe(2);
    expect(stored.ok && stored.value?.reviewerReplay?.counters).toEqual({
      providerAttempts: 2,
      formatFailures: 2,
      transportFailures: 0,
    });
  });

  it("reserves the hard epoch budget per provider invocation for dual review", async () => {
    const value = await harness(["format", "approved"], {
      seedReplay: "legacy_exhausted",
      reviewRequirement: "dual_review",
    });
    const result = await value.coordinator.run(jobId, false, {
      newContractEpoch: true,
      expectContractVersion: 2,
    });

    expect(result).toMatchObject({
      state: "blocked",
      reason: "attempts_exhausted",
      providerAttempts: 2,
      formatFailures: 1,
      transportFailures: 0,
    });
    expect(value.calls.filter((call) => call === "provider")).toHaveLength(1);
    expect(value.providerStarts).toEqual(["code_reviewer", "visual_reviewer"]);
    const stored = await value.progress.load(jobId);
    expect(stored.ok && stored.value?.reviewerReplay?.counters).toEqual({
      providerAttempts: 2,
      formatFailures: 1,
      transportFailures: 0,
    });
  });

  it("AC2/AC11 first attempt succeeds, checkpoints before status, then completes lifecycle and releases claim", async () => {
    const value = await harness(["approved"]);
    const result = await value.coordinator.run(jobId, false);
    expect(result.state).toBe("continued");
    expect(result.state === "continued" && result.providerAttempts).toBe(1);
    expect(value.calls.filter((call) => call === "provider")).toHaveLength(1);
    expect(value.calls.indexOf("provider")).toBeLessThan(
      value.calls.indexOf("reviewStatus.record"),
    );
    expect(value.calls).toContain("autoMerge.enable");
    expect(value.calls).toContain("lifecycle.run");
    const stored = await value.progress.load(jobId);
    expect(stored.ok && stored.value?.stage.kind).toBe("completed");
    expect(stored.ok && stored.value?.reviewerReplay?.state).toBe("review_succeeded");
    expect(value.lifecycleRequests).toHaveLength(1);
    expect(value.lifecycleRequests[0]).toMatchObject({
      reviewerReplayAudit: {
        operation: "reviewer-replay",
        checkpointDigest:
          stored.ok && stored.value?.reviewerReplay?.state === "review_succeeded"
            ? stored.value.reviewerReplay.checkpointDigest
            : "missing",
        attemptTotal: 1,
        outcome: "review_succeeded",
      },
    });
    expect(value.admission.record.state).toBe("released");
    expect(value.requests[0]?.attemptAccounting).toBe("reviewer_replay");
  });

  it("AC3 retries one safe format failure once, then succeeds", async () => {
    const value = await harness(["format", "approved"]);
    const result = await value.coordinator.run(jobId, false);
    expect(result.state === "continued" && result.providerAttempts).toBe(2);
    expect(value.requests).toHaveLength(2);
    expect(value.requests[1]?.reportRetryFeedback).toEqual({ category: "schema_invalid" });
    const stored = await value.progress.load(jobId);
    expect(stored.ok && stored.value?.reviewerReplay?.counters).toMatchObject({
      providerAttempts: 2,
      formatFailures: 1,
      transportFailures: 0,
    });
  });

  it("AC4 two format failures remain requires_manual, publish one safe summary, and never record or merge", async () => {
    const value = await harness(["format", "format"]);
    const result = await value.coordinator.run(jobId, false);
    expect(result).toMatchObject({
      state: "blocked",
      reason: "attempts_exhausted",
      providerAttempts: 2,
      formatFailures: 2,
    });
    expect(value.calls.filter((call) => call === "provider")).toHaveLength(2);
    expect(value.calls).not.toContain("reviewStatus.record");
    expect(value.calls).not.toContain("autoMerge.enable");
    expect(value.calls.filter((call) => call === "pr-summary")).toHaveLength(1);
    expect(value.calls.filter((call) => call === "linear-summary")).toHaveLength(1);
    const stored = await value.progress.load(jobId);
    expect(stored.ok && stored.value?.stage.kind).toBe("requires_manual");
    expect(stored.ok && stored.value?.reviewerReplay?.state).toBe("attempting");
  });

  it("AC5 classifies retryable transport separately under the same hard total cap", async () => {
    const value = await harness(["transport", "approved"]);
    const result = await value.coordinator.run(jobId, false);
    expect(result.state === "continued" && result.providerAttempts).toBe(2);
    const stored = await value.progress.load(jobId);
    expect(stored.ok && stored.value?.reviewerReplay?.counters).toMatchObject({
      providerAttempts: 2,
      formatFailures: 0,
      transportFailures: 1,
    });
  });

  it("AC6 checkpoint CAS failure prevents review status and merge", async () => {
    const value = await harness(["approved"], { failSuccessCheckpoint: true });
    const result = await value.coordinator.run(jobId, false);
    expect(result).toMatchObject({ state: "blocked", reason: "checkpoint_write_failed" });
    expect(value.calls.filter((call) => call === "provider")).toHaveLength(1);
    expect(value.calls).not.toContain("reviewStatus.record");
    expect(value.calls).not.toContain("autoMerge.enable");
    const stored = await value.progress.load(jobId);
    expect(stored.ok && stored.value?.reviewerReplay?.state).toBe("attempting");
  });

  it("AC7 a crash after checkpoint resumes without another provider invocation", async () => {
    const value = await harness(["approved"], { crashOnFirstReviewRecord: true });
    await expect(value.coordinator.run(jobId, false)).rejects.toThrow(
      "simulated_crash_after_checkpoint",
    );
    const checkpoint = await value.progress.load(jobId);
    expect(checkpoint.ok && checkpoint.value?.reviewerReplay?.state).toBe("review_succeeded");
    expect(value.calls.filter((call) => call === "provider")).toHaveLength(1);

    const resumed = await value.coordinator.run(jobId, false);
    expect(resumed.state).toBe("continued");
    expect(value.calls.filter((call) => call === "provider")).toHaveLength(1);
    expect(value.calls).toContain("lifecycle.run");
  });

  it("AC8 concurrent invocations share one Lease and never duplicate provider or completion", async () => {
    const value = await harness(["approved"]);
    const results = await Promise.all([
      value.coordinator.run(jobId, false),
      value.coordinator.run(jobId, false),
    ]);
    expect(results.filter((result) => result.state === "continued")).toHaveLength(1);
    expect(
      results.filter((result) => result.state === "blocked" && result.reason === "lease_conflict"),
    ).toHaveLength(1);
    expect(value.calls.filter((call) => call === "provider")).toHaveLength(1);
    expect(value.calls.filter((call) => call === "lifecycle.run")).toHaveLength(1);
  });

  it("AC10 review status read-back mismatch never reaches merge", async () => {
    const value = await harness(["approved"], { reviewRecordMismatch: true });
    const result = await value.coordinator.run(jobId, false);
    expect(result).toMatchObject({ state: "continued", outcome: { outcome: "requires_manual" } });
    expect(value.calls).toContain("reviewStatus.record");
    expect(value.calls).not.toContain("autoMerge.enable");
  });

  it("AC13 dry-run performs authoritative identity inspection with zero provider, mutation, or Lease", async () => {
    const value = await harness(["approved"]);
    const before = await value.progress.load(jobId);
    const result = await value.coordinator.run(jobId, true);
    const after = await value.progress.load(jobId);
    expect(result).toMatchObject({
      state: "ready",
      providerAttemptsUsed: 0,
      providerAttemptsRemaining: 2,
    });
    expect(value.calls).toEqual(["inspect"]);
    expect(after).toEqual(before);
    await expect(value.leases.readAll()).resolves.toEqual({ ok: true, value: [] });
  });

  it("AC1 kill switch off, claim mismatch, and canceled work all stop before provider", async () => {
    const disabled = await harness(["approved"], { enabled: false });
    expect(await disabled.coordinator.run(jobId, false)).toMatchObject({
      state: "blocked",
      reason: "policy_disabled",
    });
    expect(disabled.calls).toEqual([]);
    await expect(disabled.leases.readAll()).resolves.toEqual({ ok: true, value: [] });

    const otherJob = id("job", "job_018f47d2-77a4-7cc1-8ef2-111111111111");
    const wrongClaim = await harness(["approved"], { claimJobId: otherJob });
    expect(await wrongClaim.coordinator.run(jobId, false)).toMatchObject({
      state: "blocked",
      reason: "claim_mismatch",
    });
    expect(wrongClaim.calls).toEqual([]);
    await expect(wrongClaim.leases.readAll()).resolves.toEqual({ ok: true, value: [] });

    const canceled = await harness(["approved"], { workStatus: "canceled" });
    expect(await canceled.coordinator.run(jobId, true)).toMatchObject({
      state: "blocked",
      reason: "work_item_canceled",
    });
    expect(canceled.calls).not.toContain("provider");
  });

  it("AC10 identity drift between attempts permanently stops without success/status/merge", async () => {
    const first = identity();
    const drifted = identity("e".repeat(64));
    const value = await harness(["format", "approved"], { inspectIdentities: [first, drifted] });
    const result = await value.coordinator.run(jobId, false);
    expect(result).toMatchObject({ state: "blocked", reason: "identity_mismatch" });
    expect(value.calls.filter((call) => call === "provider")).toHaveLength(1);
    expect(value.calls).not.toContain("reviewStatus.record");
    expect(value.calls).not.toContain("autoMerge.enable");
  });

  it("rejects an approval whose provider-run identity differs from the inspected replay identity", async () => {
    const value = await harness(["approved"], {
      approvedIdentity: identity("e".repeat(64)),
    });
    const result = await value.coordinator.run(jobId, false);
    expect(result).toMatchObject({ state: "blocked", reason: "identity_mismatch" });
    expect(value.calls).not.toContain("reviewStatus.record");
    expect(value.calls).not.toContain("autoMerge.enable");
  });

  it("keeps the kill switch effective after a success checkpoint advances to ci_waiting", async () => {
    const value = await harness(["approved"], { autoMergePending: true });
    expect(await value.coordinator.run(jobId, false)).toMatchObject({
      state: "continued",
      outcome: { outcome: "still_ci_waiting" },
    });
    const stored = await value.progress.load(jobId);
    if (!stored.ok || stored.value === undefined) throw new Error("missing replay checkpoint");
    expect(stored.value.stage.kind).toBe("ci_waiting");
    value.policy.enabled = false;
    await expect(resumeUnderLease(stored.value, value.deps)).resolves.toMatchObject({
      outcome: "requires_manual",
      reason: "reviewer_replay_disabled",
    });
  });
});
