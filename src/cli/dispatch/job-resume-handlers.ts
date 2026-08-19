import { randomUUID } from "node:crypto";

import type { JobProgressRecord } from "../../adapters/dispatch/job-progress-store.js";
import { createClock, type Clock } from "../../domain/foundation/index.js";
import { jobIdSchema } from "../../domain/jobs/index.js";
import type { CliCommandOutcome } from "../program.js";
import { buildDispatchComposition } from "./composition.js";
import {
  buildAutoMergePauseStore,
  buildIssueAdmissionStore,
  buildJobProgressStore,
  isResumeCandidate,
  type ResumeJobOutcome,
} from "./resume-composition.js";
import {
  resumeExistingProjectJobs,
  type ResumeExistingProjectJobsResult,
} from "./resume-existing.js";

export interface JobResumeHandlerInput {
  readonly jobId: string;
  readonly dryRun?: boolean;
}

interface JobResumeRuntime {
  readonly record: Pick<
    JobProgressRecord,
    "jobId" | "projectId" | "issueId" | "externalIssueId" | "revision" | "stage" | "headSha"
  >;
  readonly continueExistingJob: () => Promise<ResumeExistingProjectJobsResult>;
}

export interface CreateJobResumeHandlerOptions {
  readonly agentTeamHome: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly clock?: Clock;
  readonly generateHolderId?: () => string;
  readonly runtimeFactory?: (
    jobId: string,
    holderId: string,
  ) => Promise<JobResumeRuntime | CliCommandOutcome>;
}

function output(
  state: "success" | "failed" | "blocked" | "rejected",
  payload: unknown,
): CliCommandOutcome {
  return Object.freeze({ state, message: JSON.stringify(payload) });
}

function safeResumeOutcomes(
  outcomes: readonly ResumeJobOutcome[],
): readonly Readonly<Record<string, unknown>>[] {
  return Object.freeze(
    outcomes.map((candidate) => {
      const withPossibleError = candidate as ResumeJobOutcome & { readonly error?: unknown };
      const { error: _error, ...safe } = withPossibleError;
      void _error;
      return Object.freeze(safe);
    }),
  );
}

function resumeState(result: ResumeExistingProjectJobsResult): "success" | "failed" | "blocked" {
  if (result.state === "none") return "blocked";
  if (result.state === "blocked") return "failed";
  return result.outcomes.some(
    (candidate) =>
      candidate.outcome === "failed" ||
      candidate.outcome === "progress_write_failed" ||
      candidate.outcome === "transient_failure" ||
      candidate.outcome === "admission_release_failed",
  )
    ? "failed"
    : result.outcomes.every(
          (candidate) =>
            candidate.outcome === "completed" || candidate.outcome === "merge_reconciled",
        )
      ? "success"
      : "blocked";
}

function renderResume(
  record: JobResumeRuntime["record"],
  resumed: ResumeExistingProjectJobsResult,
): CliCommandOutcome {
  return output(resumeState(resumed), {
    operation: "job-resume",
    state: "continued",
    projectId: record.projectId,
    jobId: record.jobId,
    expectedRevision: record.revision,
    resume:
      resumed.state === "resumed"
        ? { state: resumed.state, outcomes: safeResumeOutcomes(resumed.outcomes) }
        : resumed.state === "blocked"
          ? { state: resumed.state, reason: resumed.reason }
          : { state: resumed.state },
  });
}

async function buildRuntime(
  options: CreateJobResumeHandlerOptions,
  jobId: string,
  holderId: string,
  clock: Clock,
): Promise<JobResumeRuntime | CliCommandOutcome> {
  const progress = buildJobProgressStore(options.agentTeamHome);
  const loaded = await progress.load(jobId);
  if (!loaded.ok || loaded.value === undefined) {
    return output("blocked", {
      operation: "job-resume",
      state: "blocked",
      jobId,
      reason: loaded.ok ? "job_not_found" : "authoritative_read_failed",
      ...(!loaded.ok ? { errorCode: loaded.error.code } : {}),
    });
  }
  const record = loaded.value;
  if (!isResumeCandidate(record)) {
    return output("blocked", {
      operation: "job-resume",
      state: "blocked",
      jobId,
      reason: "job_not_resumable",
    });
  }
  const built = await buildDispatchComposition({
    agentTeamHome: options.agentTeamHome,
    projectId: record.projectId,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  });
  if (built.state !== "ready") {
    return output("blocked", {
      operation: "job-resume",
      state: "blocked",
      jobId,
      reason: `dispatch_composition:${built.reason}`,
    });
  }
  const admission = buildIssueAdmissionStore(options.agentTeamHome);
  const [jobs, claim] = await Promise.all([
    built.value.jobs.readAll(),
    admission.load(record.projectId, record.issueId),
  ]);
  if (!jobs.ok || !claim.ok) {
    return output("failed", {
      operation: "job-resume",
      state: "failed",
      jobId,
      reason: "authoritative_read_failed",
      errorCode: !jobs.ok ? jobs.error.code : !claim.ok ? claim.error.code : "external_failure",
    });
  }
  const exactJobs = jobs.value.filter(
    (job) =>
      job.id === record.jobId &&
      job.projectId === record.projectId &&
      job.issueId === record.issueId,
  );
  if (exactJobs.length !== 1) {
    return output("blocked", {
      operation: "job-resume",
      state: "blocked",
      jobId,
      reason: "job_identity_mismatch",
    });
  }
  if (
    claim.value?.state !== "active" ||
    claim.value.jobId !== record.jobId ||
    claim.value.projectId !== record.projectId ||
    claim.value.issueId !== record.issueId ||
    claim.value.externalIssueId !== record.externalIssueId
  ) {
    return output("blocked", {
      operation: "job-resume",
      state: "blocked",
      jobId,
      reason: "claim_mismatch",
    });
  }
  return Object.freeze({
    record,
    continueExistingJob: () =>
      resumeExistingProjectJobs({
        agentTeamHome: options.agentTeamHome,
        ready: built.value,
        holderId,
        clock,
        autoMergePause: buildAutoMergePauseStore(options.agentTeamHome),
        selections: Object.freeze([{ jobId: record.jobId, expectedRevision: record.revision }]),
      }),
  });
}

export function createJobResumeHandler(options: CreateJobResumeHandlerOptions) {
  const clock = options.clock ?? createClock();
  return async (input: JobResumeHandlerInput): Promise<CliCommandOutcome> => {
    if (!jobIdSchema.safeParse(input.jobId).success) {
      return output("rejected", {
        operation: "job-resume",
        state: "rejected",
        reason: "invalid_command_input",
      });
    }
    const holderId = options.generateHolderId?.() ?? `job-resume:${randomUUID()}`;
    const runtime = await (options.runtimeFactory === undefined
      ? buildRuntime(options, input.jobId, holderId, clock)
      : options.runtimeFactory(input.jobId, holderId));
    if (!("record" in runtime)) return runtime;
    if (input.dryRun === true) {
      return output("success", {
        operation: "job-resume",
        state: "ready",
        dryRun: true,
        projectId: runtime.record.projectId,
        jobId: runtime.record.jobId,
        stage: runtime.record.stage.kind,
        expectedRevision: runtime.record.revision,
        ...(runtime.record.headSha === undefined ? {} : { headSha: runtime.record.headSha }),
        plannedMutation: "existing-job-resume",
      });
    }
    return renderResume(runtime.record, await runtime.continueExistingJob());
  };
}
