import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  FileIssueScopeLock,
  JobProgressWorkStatusLifecycleLedger,
} from "../../adapters/dispatch/index.js";
import { GitHubAdapter, GhTransport } from "../../adapters/github/index.js";
import { LeaseCoordinator } from "../../application/leases/index.js";
import { WorkStatusLifecycleCoordinator } from "../../application/pipelines/index.js";
import { resolveWorkStatusLifecycleMode } from "../../application/projects/index.js";
import { createClock, type Clock } from "../../domain/foundation/index.js";
import { jobIdSchema } from "../../domain/jobs/index.js";
import type { CliCommandOutcome } from "../program.js";
import { CiResumeCoordinator, type CiResumeOutcome } from "./ci-resume-coordinator.js";
import { buildDispatchComposition, type DispatchCompositionReady } from "./composition.js";
import {
  buildAutoMergePauseStore,
  buildIssueAdmissionStore,
  buildJobProgressStore,
  type ResumeJobOutcome,
} from "./resume-composition.js";
import {
  resumeExistingProjectJobs,
  type ResumeExistingProjectJobsResult,
} from "./resume-existing.js";
import { LinearWorkManagementAdapter } from "./work-management-adapter.js";

export interface CiResumeHandlerInput {
  readonly jobId: string;
  readonly dryRun?: boolean;
}

interface CiResumeRuntime {
  readonly coordinator: CiResumeCoordinator;
  readonly continueExistingJob: (revision: number) => Promise<ResumeExistingProjectJobsResult>;
}

export interface CreateCiResumeHandlerOptions {
  readonly agentTeamHome: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly clock?: Clock;
  readonly generateHolderId?: () => string;
  readonly runtimeFactory?: (jobId: string) => Promise<CiResumeRuntime | CliCommandOutcome>;
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

function renderCoordinator(result: CiResumeOutcome): CliCommandOutcome {
  return output(
    result.state === "ready" || result.state === "checkpointed"
      ? "success"
      : result.state === "blocked"
        ? "blocked"
        : "failed",
    { operation: "ci-resume", ...result },
  );
}

async function buildRuntime(
  options: CreateCiResumeHandlerOptions,
  jobId: string,
  holderId: string,
  clock: Clock,
): Promise<CiResumeRuntime | CliCommandOutcome> {
  const progress = buildJobProgressStore(options.agentTeamHome);
  const record = await progress.load(jobId);
  if (!record.ok || record.value === undefined) {
    return output("blocked", {
      operation: "ci-resume",
      state: "blocked",
      jobId,
      reason: record.ok ? "job_not_found" : "authoritative_read_failed",
      ...(!record.ok ? { errorCode: record.error.code } : {}),
    });
  }
  const existingRecord = record.value;
  const built = await buildDispatchComposition({
    agentTeamHome: options.agentTeamHome,
    projectId: existingRecord.projectId,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  });
  if (
    built.state !== "ready" ||
    resolveWorkStatusLifecycleMode(built.value.trustedConfig) !== "enforce"
  ) {
    return output("blocked", {
      operation: "ci-resume",
      state: "blocked",
      jobId,
      reason: built.state === "ready" ? "job_not_eligible" : built.reason,
    });
  }
  const ready: DispatchCompositionReady = built.value;
  const admission = buildIssueAdmissionStore(options.agentTeamHome);
  const leases = new LeaseCoordinator(ready.leases, { clock });
  const workManagement = new LinearWorkManagementAdapter({
    readModel: ready.discovery.readModel,
    mutationClient: ready.discovery.mutationClient,
    teamId: ready.discovery.teamId,
    linearProjectId: ready.discovery.linearProjectId,
  });
  const locks = new FileIssueScopeLock(
    join(options.agentTeamHome, "state", "dispatch", "issue-scope-locks"),
  );
  const coordinator = new CiResumeCoordinator({
    project: ready.project,
    progress,
    jobs: ready.jobs,
    admission,
    leases,
    locks,
    workManagement,
    lifecycle: new WorkStatusLifecycleCoordinator({
      workManagement,
      history: workManagement,
      ledger: new JobProgressWorkStatusLifecycleLedger(progress),
      locks,
      clock,
    }),
    sourceControl: new GitHubAdapter(new GhTransport()),
  });
  return Object.freeze({
    coordinator,
    continueExistingJob: (revision: number) =>
      resumeExistingProjectJobs({
        agentTeamHome: options.agentTeamHome,
        ready,
        holderId: `${holderId}:continue`,
        clock,
        autoMergePause: buildAutoMergePauseStore(options.agentTeamHome),
        selections: Object.freeze([{ jobId: existingRecord.jobId, expectedRevision: revision }]),
      }),
  });
}

export function createCiResumeHandler(options: CreateCiResumeHandlerOptions) {
  const clock = options.clock ?? createClock();
  return async (input: CiResumeHandlerInput): Promise<CliCommandOutcome> => {
    if (!jobIdSchema.safeParse(input.jobId).success) {
      return output("rejected", {
        operation: "ci-resume",
        state: "rejected",
        reason: "invalid_command_input",
      });
    }
    const holderId = options.generateHolderId?.() ?? `ci-resume:${randomUUID()}`;
    const runtime =
      options.runtimeFactory === undefined
        ? await buildRuntime(options, input.jobId, holderId, clock)
        : await options.runtimeFactory(input.jobId);
    if (!("coordinator" in runtime)) return runtime;
    const result = await runtime.coordinator.run({
      jobId: input.jobId,
      holderId,
      dryRun: input.dryRun === true,
    });
    if (result.state !== "checkpointed") return renderCoordinator(result);
    const resumed = await runtime.continueExistingJob(result.revision);
    return output(resumeState(resumed), {
      operation: "ci-resume",
      state: "continued",
      projectId: result.projectId,
      jobId: result.jobId,
      headSha: result.headSha,
      checkpointRevision: result.revision,
      resume:
        resumed.state === "resumed"
          ? { state: resumed.state, outcomes: safeResumeOutcomes(resumed.outcomes) }
          : resumed.state === "blocked"
            ? { state: resumed.state, reason: resumed.reason }
            : { state: resumed.state },
    });
  };
}
