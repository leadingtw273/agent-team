import { randomUUID } from "node:crypto";

import { LocalGitAdapter } from "../../adapters/git/index.js";
import { GitHubAdapter } from "../../adapters/github/index.js";
import { buildIssueAdmissionStore, buildJobProgressStore } from "./resume-composition.js";
import { buildDispatchComposition, type DispatchCompositionReady } from "./composition.js";
import { LeaseCoordinator } from "../../application/leases/index.js";
import type {
  FileJobProgressStore,
  JobProgressRecord,
  JobProgressRecordMutation,
} from "../../adapters/dispatch/index.js";
import { projectIssueByExternalId } from "../../adapters/dispatch/index.js";
import {
  createClock,
  type Clock,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import {
  createRequirementSnapshot,
  headShaSchema,
  sha256Digest,
  type EffectiveTreeChange,
} from "../../domain/review/index.js";
import type { Project } from "../../domain/project/index.js";
import type { WorkStatus } from "../../domain/workflow/index.js";
import type { CommitChecksSnapshot, SourceControlPort } from "../../application/ports/index.js";
import type { GitPort } from "../../application/ports/index.js";
import { parsePullRequestBackPointer } from "../../application/pipelines/index.js";
import { rotateJobControlFence } from "./managed-mutation-authority.js";
import { JobMutationRuntime } from "./job-mutation-runtime.js";
import { LinearWorkManagementAdapter } from "./work-management-adapter.js";
import {
  resumeExistingProjectJobs,
  type ResumeExistingProjectJobsResult,
} from "./resume-existing.js";
import type { CliCommandOutcome } from "../program.js";
import { readStdinConfirmation } from "../registration/confirmation.js";

export interface JobPrAdoptionInput {
  readonly jobId: string;
  readonly adoptPr: number;
  readonly expectHead: string;
  readonly expectRequirementsDigest: string;
  readonly dryRun?: boolean;
}

export type JobPrAdoptionBlockedReason =
  | "invalid_command_input"
  | "job_not_found"
  | "job_not_eligible"
  | "job_identity_mismatch"
  | "claim_mismatch"
  | "requirement_mismatch"
  | "human_delivery_mismatch"
  | "issue_state_mismatch"
  | "change_request_mismatch"
  | "backpointer_mismatch"
  | "ci_not_successful"
  | "effective_diff_invalid"
  | "lease_conflict"
  | "candidate_changed"
  | "confirmation_required"
  | "adoption_write_failed";

export interface JobPrAdoptionDependencies {
  readonly project: Project;
  readonly progress: Pick<FileJobProgressStore, "load" | "compareAndSwap">;
  readonly jobs: Pick<DispatchCompositionReady["jobs"], "readAll">;
  readonly admission: Pick<ReturnType<typeof buildIssueAdmissionStore>, "load">;
  readonly leases: Pick<LeaseCoordinator, "acquire" | "renew" | "release">;
  readonly issue: (externalIssueId: string) => ReturnType<typeof projectIssueByExternalId>;
  readonly workIssue: (externalIssueId: string) => Promise<
    Result<
      {
        readonly issue: {
          readonly id: string;
          readonly projectId: string;
          readonly externalId: string;
        };
        readonly workStatus: WorkStatus;
        readonly archivedAt?: string;
        readonly trashed?: boolean;
      },
      DomainError
    >
  >;
  readonly sourceControl: Pick<SourceControlPort, "getChangeRequest" | "getCommitChecks">;
  readonly git: Pick<GitPort, "getEffectiveTreeDiff">;
  readonly clock: Clock;
  readonly holderId: string;
  readonly confirmed: boolean;
  readonly bind: (
    record: JobProgressRecord,
    pr: number,
    head: string,
  ) => Promise<Result<JobProgressRecord, DomainError>>;
  readonly resume: (record: JobProgressRecord) => Promise<ResumeExistingProjectJobsResult>;
}

function render(state: CliCommandOutcome["state"], payload: unknown): CliCommandOutcome {
  return Object.freeze({ state, message: JSON.stringify(payload) });
}
function mutation(record: JobProgressRecord): JobProgressRecordMutation {
  const {
    schemaVersion: _schemaVersion,
    revision: _revision,
    updatedAt: _updatedAt,
    ...next
  } = record;
  void _schemaVersion;
  void _revision;
  void _updatedAt;
  return next;
}
function blocked(jobId: string, reason: JobPrAdoptionBlockedReason): CliCommandOutcome {
  return render(reason === "invalid_command_input" ? "rejected" : "blocked", {
    operation: "job-pr-adoption",
    jobId,
    state: "blocked",
    reason,
  });
}
function allowed(
  change: EffectiveTreeChange,
  regions: readonly { readonly path: string; readonly coverage: "exact" | "subtree" }[],
): boolean {
  const paths = [change.before?.path, change.after?.path].filter(
    (path): path is string => path !== undefined,
  );
  return paths.every((path) =>
    regions.some((region) =>
      region.coverage === "exact" ? path === region.path : path.startsWith(`${region.path}/`),
    ),
  );
}
function green(checks: CommitChecksSnapshot, head: string): boolean {
  return (
    checks.headSha === head &&
    checks.aggregate === "success" &&
    checks.checks.length > 0 &&
    checks.checks.every((check) => check.status === "completed" && check.conclusion === "success")
  );
}

/** Narrow, fail-closed coordinator for a human-confirmed existing PR.  It deliberately has no
 * implementer dependency: after its single adoption CAS it re-enters only the normal resume path. */
export class JobPrAdoptionCoordinator {
  constructor(readonly dependencies: JobPrAdoptionDependencies) {}

  async run(input: JobPrAdoptionInput): Promise<CliCommandOutcome> {
    if (
      !Number.isSafeInteger(input.adoptPr) ||
      input.adoptPr <= 0 ||
      !/^[0-9a-f]{40}$/u.test(input.expectHead) ||
      !/^[0-9a-f]{64}$/u.test(input.expectRequirementsDigest)
    )
      return blocked(input.jobId, "invalid_command_input");
    const loaded = await this.dependencies.progress.load(input.jobId);
    if (!loaded.ok)
      return render("failed", {
        operation: "job-pr-adoption",
        jobId: input.jobId,
        reason: "authoritative_read_failed",
        errorCode: loaded.error.code,
      });
    const record = loaded.value;
    if (record === undefined) return blocked(input.jobId, "job_not_found");
    if (
      record.stage.kind !== "paused" ||
      record.stage.pauseReason !== "scope_overrun" ||
      record.changeRequestId !== undefined ||
      record.headSha !== undefined ||
      record.humanDelivery === undefined ||
      record.humanDelivery.acceptanceIdentityDigest !== undefined ||
      record.approvedScopeAdoption !== undefined
    )
      return blocked(input.jobId, "job_not_eligible");
    const [jobs, claim, issue, work, pr, checks] = await Promise.all([
      this.dependencies.jobs.readAll(),
      this.dependencies.admission.load(record.projectId, record.issueId),
      this.dependencies.issue(record.externalIssueId),
      this.dependencies.workIssue(record.externalIssueId),
      this.dependencies.sourceControl.getChangeRequest({
        project: this.dependencies.project,
        changeRequestId: String(input.adoptPr),
      }),
      this.dependencies.sourceControl.getCommitChecks(
        { project: this.dependencies.project },
        input.expectHead,
      ),
    ]);
    if (!jobs.ok || !claim.ok || !issue.ok || !work.ok || !pr.ok || !checks.ok)
      return render("failed", {
        operation: "job-pr-adoption",
        jobId: input.jobId,
        reason: "authoritative_read_failed",
      });
    if (
      record.projectId !== this.dependencies.project.id ||
      jobs.value.filter(
        (job) =>
          job.id === record.jobId &&
          job.projectId === record.projectId &&
          job.issueId === record.issueId,
      ).length !== 1
    )
      return blocked(input.jobId, "job_identity_mismatch");
    if (
      claim.value?.state !== "active" ||
      claim.value.jobId !== record.jobId ||
      claim.value.projectId !== record.projectId ||
      claim.value.issueId !== record.issueId ||
      claim.value.externalIssueId !== record.externalIssueId
    )
      return blocked(input.jobId, "claim_mismatch");
    if (
      issue.value.id !== record.issueId ||
      issue.value.projectId !== record.projectId ||
      issue.value.externalId !== record.externalIssueId ||
      work.value.issue.id !== record.issueId ||
      work.value.issue.projectId !== record.projectId ||
      work.value.issue.externalId !== record.externalIssueId ||
      ["canceled", "completed"].includes(work.value.workStatus) ||
      work.value.archivedAt !== undefined ||
      work.value.trashed === true
    )
      return blocked(input.jobId, "issue_state_mismatch");
    const requirements = createRequirementSnapshot(issue.value, this.dependencies.clock.now());
    const humanSummary =
      issue.value.humanSummary === undefined ? undefined : sha256Digest(issue.value.humanSummary);
    if (
      !requirements.ok ||
      !humanSummary?.ok ||
      requirements.value.requirementsDigest !== input.expectRequirementsDigest
    )
      return blocked(input.jobId, "requirement_mismatch");
    if (
      issue.value.humanAcceptanceRequirement !== record.humanDelivery.acceptanceRequirement ||
      issue.value.verificationLevel !== record.humanDelivery.verificationLevel
    )
      return blocked(input.jobId, "human_delivery_mismatch");
    if (
      pr.value.state !== "open" ||
      pr.value.number !== input.adoptPr ||
      pr.value.baseBranch !== this.dependencies.project.defaultBranch ||
      pr.value.headBranch !== record.branch ||
      pr.value.headSha !== input.expectHead
    )
      return blocked(input.jobId, "change_request_mismatch");
    const pointer = parsePullRequestBackPointer(pr.value.body ?? "");
    const pointerValue = pointer.ok ? pointer.value : undefined;
    if (
      pointerValue?.projectId !== record.projectId ||
      pointerValue.issueId !== record.issueId ||
      pointerValue.jobId !== record.jobId ||
      pointerValue.branch !== record.branch
    )
      return blocked(input.jobId, "backpointer_mismatch");
    if (!green(checks.value, input.expectHead)) return blocked(input.jobId, "ci_not_successful");
    if (record.baseRevision === undefined) return blocked(input.jobId, "effective_diff_invalid");
    const diff = await this.dependencies.git.getEffectiveTreeDiff(
      { rootPath: this.dependencies.project.localRepositoryPath },
      record.baseRevision,
      input.expectHead,
    );
    if (!diff.ok)
      return render("failed", {
        operation: "job-pr-adoption",
        jobId: input.jobId,
        reason: "authoritative_read_failed",
        errorCode: diff.error.code,
      });
    const changeRegions = issue.value.changeRegions;
    if (
      diff.value.length === 0 ||
      changeRegions === undefined ||
      !diff.value.every((entry) => allowed(entry, changeRegions))
    )
      return blocked(input.jobId, "effective_diff_invalid");
    if (input.dryRun === true)
      return render("success", {
        operation: "job-pr-adoption",
        state: "ready",
        dryRun: true,
        jobId: record.jobId,
        projectId: record.projectId,
        plannedMutations: [
          "lease",
          "fence",
          "adopt-existing-pr",
          "pr-bound",
          "existing-job-resume",
        ],
      });
    if (!this.dependencies.confirmed) return blocked(input.jobId, "confirmation_required");
    const acquired = await this.dependencies.leases.acquire({
      jobId: record.jobId,
      issueId: record.issueId,
      holderId: this.dependencies.holderId,
    });
    if (!acquired.ok) return blocked(input.jobId, "lease_conflict");
    let bound: JobProgressRecord | undefined;
    let releaseFailed = false;
    try {
      const reread = await this.dependencies.progress.load(record.jobId);
      if (!reread.ok || reread.value?.revision !== record.revision)
        return blocked(record.jobId, "candidate_changed");
      const [claimAfter, issueAfter, workAfter, prAfter, checksAfter] = await Promise.all([
        this.dependencies.admission.load(record.projectId, record.issueId),
        this.dependencies.issue(record.externalIssueId),
        this.dependencies.workIssue(record.externalIssueId),
        this.dependencies.sourceControl.getChangeRequest({
          project: this.dependencies.project,
          changeRequestId: String(input.adoptPr),
        }),
        this.dependencies.sourceControl.getCommitChecks(
          { project: this.dependencies.project },
          input.expectHead,
        ),
      ]);
      const snapshotAfter = issueAfter.ok
        ? createRequirementSnapshot(issueAfter.value, this.dependencies.clock.now())
        : undefined;
      const summaryAfter =
        issueAfter.ok && issueAfter.value.humanSummary !== undefined
          ? sha256Digest(issueAfter.value.humanSummary)
          : undefined;
      const pointerAfter = prAfter.ok
        ? parsePullRequestBackPointer(prAfter.value.body ?? "")
        : undefined;
      if (
        !claimAfter.ok ||
        claimAfter.value?.state !== "active" ||
        claimAfter.value.jobId !== record.jobId ||
        claimAfter.value.projectId !== record.projectId ||
        claimAfter.value.issueId !== record.issueId ||
        claimAfter.value.externalIssueId !== record.externalIssueId ||
        !issueAfter.ok ||
        issueAfter.value.id !== record.issueId ||
        issueAfter.value.humanAcceptanceRequirement !==
          record.humanDelivery.acceptanceRequirement ||
        issueAfter.value.verificationLevel !== record.humanDelivery.verificationLevel ||
        !workAfter.ok ||
        ["canceled", "completed"].includes(workAfter.value.workStatus) ||
        workAfter.value.archivedAt !== undefined ||
        workAfter.value.trashed === true ||
        workAfter.value.issue.id !== record.issueId ||
        workAfter.value.issue.projectId !== record.projectId ||
        workAfter.value.issue.externalId !== record.externalIssueId ||
        !prAfter.ok ||
        prAfter.value.state !== "open" ||
        prAfter.value.number !== input.adoptPr ||
        prAfter.value.baseBranch !== this.dependencies.project.defaultBranch ||
        prAfter.value.headBranch !== record.branch ||
        prAfter.value.headSha !== input.expectHead ||
        pointerAfter?.ok !== true ||
        pointerAfter.value?.projectId !== record.projectId ||
        pointerAfter.value.issueId !== record.issueId ||
        pointerAfter.value.jobId !== record.jobId ||
        pointerAfter.value.branch !== record.branch ||
        !checksAfter.ok ||
        !green(checksAfter.value, input.expectHead) ||
        !snapshotAfter?.ok ||
        snapshotAfter.value.requirementsDigest !== input.expectRequirementsDigest ||
        !summaryAfter?.ok ||
        summaryAfter.value !== humanSummary.value
      )
        return blocked(record.jobId, "candidate_changed");
      const fenced = await rotateJobControlFence(
        this.dependencies.progress as FileJobProgressStore,
        reread.value,
        acquired.value.value,
      );
      if (!fenced.ok) return blocked(record.jobId, "adoption_write_failed");
      const renewed = await this.dependencies.leases.renew({
        leaseId: acquired.value.value.id,
        holderId: this.dependencies.holderId,
      });
      if (!renewed.ok) return blocked(record.jobId, "lease_conflict");
      const head = headShaSchema.parse(input.expectHead);
      const adoptedPolicy = {
        acceptanceRequirement: issue.value.humanAcceptanceRequirement,
        verificationLevel: issue.value.verificationLevel,
        requirementDigest: requirements.value.requirementsDigest,
        humanSummaryDigest: humanSummary.value,
      };
      const adopted = await this.dependencies.progress.compareAndSwap(
        record.jobId,
        fenced.value.revision,
        {
          ...mutation(fenced.value),
          stage: { kind: "awaiting_review" },
          changeRequestId: String(input.adoptPr),
          headSha: head,
          humanDelivery: adoptedPolicy,
          approvedScopeAdoption: {
            schemaVersion: 1,
            previousHumanDelivery: record.humanDelivery,
            approvedHumanDelivery: adoptedPolicy,
            changeRequestId: String(input.adoptPr),
            headSha: head,
            approvedAt: this.dependencies.clock.now(),
          },
        },
      );
      if (!adopted.ok) return blocked(record.jobId, "adoption_write_failed");
      const heartbeatState: { failed: boolean } = { failed: false };
      const heartbeat = setInterval(() => {
        void this.dependencies.leases
          .renew({ leaseId: acquired.value.value.id, holderId: this.dependencies.holderId })
          .then((renewal) => {
            heartbeatState.failed ||= !renewal.ok;
          })
          .catch(() => {
            heartbeatState.failed = true;
          });
      }, 30_000);
      let binding: Result<JobProgressRecord, DomainError>;
      try {
        binding = await this.dependencies.bind(adopted.value, input.adoptPr, input.expectHead);
      } finally {
        clearInterval(heartbeat);
      }
      if (heartbeatState.failed) return blocked(record.jobId, "lease_conflict");
      if (!binding.ok)
        return render("failed", {
          operation: "job-pr-adoption",
          jobId: record.jobId,
          reason: "pr_bind_failed",
          errorCode: binding.error.code,
        });
      bound = binding.value;
    } finally {
      const released = await this.dependencies.leases.release({
        leaseId: acquired.value.value.id,
        holderId: this.dependencies.holderId,
      });
      releaseFailed = !released.ok;
    }
    if (releaseFailed)
      return render("failed", {
        operation: "job-pr-adoption",
        jobId: record.jobId,
        reason: "lease_release_failed",
      });
    const resumed = await this.dependencies.resume(bound);
    const outcomes =
      resumed.state === "resumed"
        ? resumed.outcomes.map((candidate) => {
            const { error: _error, ...outcome } = candidate as typeof candidate & {
              readonly error?: unknown;
            };
            void _error;
            return outcome;
          })
        : undefined;
    const state =
      resumed.state === "resumed" &&
      resumed.outcomes.length > 0 &&
      resumed.outcomes.every(
        (outcome) => outcome.outcome === "completed" || outcome.outcome === "merge_reconciled",
      )
        ? "success"
        : resumed.state === "blocked"
          ? "failed"
          : "blocked";
    return render(state, {
      operation: "job-pr-adoption",
      state: "adopted",
      jobId: record.jobId,
      projectId: record.projectId,
      revision: bound.revision,
      resume:
        resumed.state === "resumed"
          ? { state: resumed.state, outcomes }
          : resumed.state === "blocked"
            ? { state: resumed.state, reason: resumed.reason }
            : { state: resumed.state },
    });
  }
}

export interface CreateJobPrAdoptionHandlerOptions {
  readonly agentTeamHome: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly clock?: Clock;
  readonly stdin?: AsyncIterable<string | Uint8Array>;
  readonly adoptionRuntimeFactory?: (
    holderId: string,
    confirmed: boolean,
  ) => Promise<JobPrAdoptionDependencies | CliCommandOutcome>;
}

async function productionRuntime(
  options: CreateJobPrAdoptionHandlerOptions,
  jobId: string,
  holderId: string,
  clock: Clock,
  confirmed: boolean,
): Promise<JobPrAdoptionDependencies | CliCommandOutcome> {
  const record = await buildJobProgressStore(options.agentTeamHome).load(jobId);
  if (!record.ok || record.value === undefined)
    return blocked(jobId, record.ok ? "job_not_found" : "job_not_eligible");
  const ready = await buildDispatchComposition({
    agentTeamHome: options.agentTeamHome,
    projectId: record.value.projectId,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  });
  if (ready.state !== "ready")
    return render("blocked", {
      operation: "job-pr-adoption",
      state: "blocked",
      reason: `dispatch_composition:${ready.reason}`,
    });
  const progress = buildJobProgressStore(options.agentTeamHome);
  const leases = new LeaseCoordinator(ready.value.leases, { clock });
  const github = new GitHubAdapter();
  const linear = new LinearWorkManagementAdapter({
    readModel: ready.value.discovery.readModel,
    mutationClient: ready.value.discovery.mutationClient,
    teamId: ready.value.discovery.teamId,
    linearProjectId: ready.value.discovery.linearProjectId,
  });
  const runtime = new JobMutationRuntime({
    agentTeamHome: options.agentTeamHome,
    project: ready.value.project,
    progress,
    workManagement: linear,
    escalationWorkManagement: linear,
    codexConfig: ready.value.codex.config,
    clock,
  });
  return {
    project: ready.value.project,
    progress,
    jobs: ready.value.jobs,
    admission: buildIssueAdmissionStore(options.agentTeamHome),
    leases,
    issue: (externalIssueId) =>
      projectIssueByExternalId(
        ready.value.project,
        ready.value.discovery.readModel,
        ready.value.discovery.teamId,
        ready.value.discovery.linearProjectId,
        externalIssueId,
      ),
    workIssue: (externalIssueId) =>
      linear.getIssue({ project: ready.value.project, externalIssueId }),
    sourceControl: github,
    git: new LocalGitAdapter(),
    clock,
    holderId,
    confirmed,
    bind: (record, pr, head) => runtime.bindPullRequest(record, pr, head),
    resume: (record) =>
      resumeExistingProjectJobs({
        agentTeamHome: options.agentTeamHome,
        ready: ready.value,
        holderId,
        clock,
        selections: [{ jobId: record.jobId, expectedRevision: record.revision }],
      }),
  };
}

export function createJobPrAdoptionHandler(options: CreateJobPrAdoptionHandlerOptions) {
  const clock = options.clock ?? createClock();
  return async (input: JobPrAdoptionInput): Promise<CliCommandOutcome> => {
    const holderId = `job-pr-adoption:${randomUUID()}`;
    const confirmation =
      input.dryRun === true
        ? undefined
        : await readStdinConfirmation(options.stdin ?? process.stdin);
    const confirmed =
      input.dryRun === true ||
      (confirmation?.ok === true && confirmation.value === "ADOPT EXISTING PR FOR JOB");
    const runtime = await (options.adoptionRuntimeFactory === undefined
      ? productionRuntime(options, input.jobId, holderId, clock, confirmed)
      : options.adoptionRuntimeFactory(holderId, confirmed));
    return "project" in runtime ? new JobPrAdoptionCoordinator(runtime).run(input) : runtime;
  };
}
