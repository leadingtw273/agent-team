import { LocalGitAdapter } from "../../adapters/git/index.js";
import { GitHubAdapter } from "../../adapters/github/index.js";
import { LeaseCoordinator } from "../../application/leases/index.js";
import { domainError, type Clock, type DomainError } from "../../domain/foundation/index.js";
import type { DispatchCompositionReady } from "./composition.js";
import {
  buildAutoMergePauseStore,
  buildIssueAdmissionStore,
  buildJobProgressStore,
  buildReviewReportDiagnosticsSidecar,
  hasReviewerReplaySuccessCheckpoint,
  isResumeCandidate,
  runResumeCycle,
  type ResumeCycleSelection,
  type ResumeJobOutcome,
} from "./resume-composition.js";
import {
  buildResumeComposition,
  type BuildResumeCompositionResult,
  type ResumeCompositionBlockedReason,
  type ResumePipelineComposition,
} from "./resume-full-composition.js";
import { resolveAuthoritativeBaseRevision } from "./authoritative-base.js";
import { ensureDispatchWorktreesDirectory } from "./worktree-directories.js";
import { FileReviewerReplayPolicyStore } from "../../adapters/dispatch/reviewer-replay-policy-store.js";
import { join } from "node:path";

export type ResumeExistingProjectJobsResult =
  | Readonly<{ state: "none" }>
  | Readonly<{ state: "resumed"; outcomes: readonly ResumeJobOutcome[] }>
  | Readonly<{ state: "blocked"; reason: "job_progress_read_failed"; error: DomainError }>
  | Readonly<{
      state: "blocked";
      reason: "resume_composition_blocked";
      compositionReason: ResumeCompositionBlockedReason;
    }>
  | Readonly<{ state: "blocked"; reason: "worktree_directory_unavailable"; error: DomainError }>
  | Readonly<{ state: "blocked"; reason: "resume_cycle_failed"; error: DomainError }>;

export interface ResumeExistingProjectJobsOptions {
  readonly agentTeamHome: string;
  readonly ready: DispatchCompositionReady;
  readonly holderId: string;
  readonly clock: Clock;
  readonly autoMergePause?: ReturnType<typeof buildAutoMergePauseStore>;
  readonly reviewerReplayPolicy?: FileReviewerReplayPolicyStore;
  /** When supplied, only jobs captured by the caller's one-pass durable inventory may run. */
  readonly selections?: ResumeCycleSelection["selections"];
  readonly buildResumeComposition?: (
    options: Parameters<typeof buildResumeComposition>[0],
  ) => Promise<BuildResumeCompositionResult>;
  readonly runResumeCycle?: typeof runResumeCycle;
  readonly resolveAuthoritativeBase?: typeof resolveAuthoritativeBaseRevision;
}

class ResumePreparationBlockedError extends Error {
  constructor(readonly result: Extract<ResumeExistingProjectJobsResult, { state: "blocked" }>) {
    super("Resume project preparation failed.");
    this.name = "ResumePreparationBlockedError";
  }
}

/**
 * Runs only the existing-job half of `agent-team run`. It never calls discovery or dispatchOnce,
 * so a stale reconcile inventory can converge to `none` but can never fall through to a new Job.
 */
export async function resumeExistingProjectJobs(
  options: ResumeExistingProjectJobsOptions,
): Promise<ResumeExistingProjectJobsResult> {
  if (
    options.selections !== undefined &&
    new Set(options.selections.map((selection) => selection.jobId)).size !==
      options.selections.length
  ) {
    return Object.freeze({
      state: "blocked" as const,
      reason: "resume_cycle_failed" as const,
      error: domainError("conflict"),
    });
  }
  const progress = buildJobProgressStore(options.agentTeamHome);
  const existing = await progress.listForProject(options.ready.project.id);
  if (!existing.ok) {
    return Object.freeze({
      state: "blocked" as const,
      reason: "job_progress_read_failed" as const,
      error: existing.error,
    });
  }
  const reviewerReplayPolicy =
    options.reviewerReplayPolicy ??
    new FileReviewerReplayPolicyStore(
      join(options.agentTeamHome, "state", "dispatch", "reviewer-replay-policy"),
    );
  let reviewerReplayEnabled = false;
  if (existing.value.some(hasReviewerReplaySuccessCheckpoint)) {
    const policy = await reviewerReplayPolicy.load(options.ready.project.id);
    if (!policy.ok) {
      return Object.freeze({
        state: "blocked" as const,
        reason: "resume_cycle_failed" as const,
        error: policy.error,
      });
    }
    reviewerReplayEnabled = policy.value?.enabled === true;
  }
  const selected = existing.value.filter(
    (record) =>
      isResumeCandidate(record) &&
      (!hasReviewerReplaySuccessCheckpoint(record) || reviewerReplayEnabled) &&
      (options.selections === undefined ||
        options.selections.some(
          (selection) =>
            selection.jobId === record.jobId && selection.expectedRevision === record.revision,
        )),
  );
  const selectedByJobId = new Map(selected.map((record) => [record.jobId, record]));
  const preflightOutcomes: ResumeJobOutcome[] = [];
  if (options.selections !== undefined) {
    const byJobId = new Map(existing.value.map((record) => [record.jobId, record]));
    for (const selection of options.selections) {
      if (selectedByJobId.has(selection.jobId)) continue;
      const record = byJobId.get(selection.jobId);
      preflightOutcomes.push({
        jobId: selection.jobId,
        outcome: "candidate_changed",
        reason:
          record === undefined
            ? "missing"
            : record.revision !== selection.expectedRevision
              ? "revision_changed"
              : "no_longer_resumable",
      });
    }
  }
  if (selected.length === 0 && options.selections === undefined) {
    return Object.freeze({ state: "none" as const });
  }
  if (options.selections !== undefined && selected.length === 0) {
    return Object.freeze({
      state: "resumed" as const,
      outcomes: Object.freeze(preflightOutcomes),
    });
  }

  const autoMergePause = options.autoMergePause ?? buildAutoMergePauseStore(options.agentTeamHome);
  const leases = new LeaseCoordinator(options.ready.leases);
  let resumeComposition: ResumePipelineComposition | undefined;
  let preparePromise: Promise<void> | undefined;
  const prepare = (): Promise<void> => {
    preparePromise ??= (async () => {
      const built = await (options.buildResumeComposition ?? buildResumeComposition)({
        agentTeamHome: options.agentTeamHome,
        codexConfig: options.ready.codex.config,
        claudeConfig: options.ready.claude.config,
        ...(options.ready.gemini === undefined ? {} : { geminiConfig: options.ready.gemini }),
        jobs: options.ready.jobs,
        readModel: options.ready.discovery.readModel,
        mutationClient: options.ready.discovery.mutationClient,
        teamId: options.ready.discovery.teamId,
        linearProjectId: options.ready.discovery.linearProjectId,
        progress,
        leases,
        autoMergePause,
        linearTransport: options.ready.discovery.linearTransport,
      });
      if (built.state !== "ready") {
        throw new ResumePreparationBlockedError(
          Object.freeze({
            state: "blocked" as const,
            reason: "resume_composition_blocked" as const,
            compositionReason: built.reason,
          }),
        );
      }
      const worktrees = await ensureDispatchWorktreesDirectory(options.agentTeamHome);
      if (!worktrees.ok) {
        throw new ResumePreparationBlockedError(
          Object.freeze({
            state: "blocked" as const,
            reason: "worktree_directory_unavailable" as const,
            error: worktrees.error,
          }),
        );
      }
      resumeComposition = built.value;
    })();
    return preparePromise;
  };
  const prepared = (): ResumePipelineComposition => {
    if (resumeComposition === undefined) throw new Error("resume_composition_not_prepared");
    return resumeComposition;
  };
  const preparedCapability = <Value>(
    select: (composition: ResumePipelineComposition) => Value | undefined,
  ): Value => {
    const value = select(prepared());
    if (value === undefined) throw new Error("resume_capability_not_prepared");
    return value;
  };

  try {
    const cycle = await (options.runResumeCycle ?? runResumeCycle)(
      {
        progress,
        jobRepository: options.ready.jobs,
        leases,
        prepare,
        sourceControl: {
          getChangeRequest: (...args) => prepared().sourceControl.getChangeRequest(...args),
        },
        workManagement: {
          getIssue: (...args) => prepared().workManagement.getIssue(...args),
        },
        reviewWaitPublication: {
          publish: (...args) => prepared().reviewWaitPublication.publish(...args),
        },
        readModel: options.ready.discovery.readModel,
        teamId: options.ready.discovery.teamId,
        linearProjectId: options.ready.discovery.linearProjectId,
        project: options.ready.project,
        trustedConfig: options.ready.trustedConfig,
        ciRecovery: { run: (...args) => prepared().ciRecovery.run(...args) },
        reviewerRecovery: { run: (...args) => prepared().reviewerRecovery.run(...args) },
        reviewer: {
          run: (...args) => prepared().reviewer.run(...args),
          inspect: (...args) => {
            const inspect = prepared().reviewer.inspect;
            if (inspect === undefined) throw new Error("reviewer_inspect_not_prepared");
            return inspect(...args);
          },
        },
        reviewerReplayPolicy,
        reviewStatus: {
          begin: (...args) => prepared().reviewStatus.begin(...args),
          record: (...args) => prepared().reviewStatus.record(...args),
        },
        autoMerge: { enable: (...args) => prepared().autoMerge.enable(...args) },
        lifecycle: { run: (...args) => prepared().lifecycle.run(...args) },
        visualEvidence: {
          build: (...args) =>
            preparedCapability((composition) => composition.visualEvidence).build(...args),
          verifyExisting: (...args) =>
            preparedCapability((composition) => composition.visualEvidence).verifyExisting(...args),
        },
        ...(options.ready.gemini?.models[0] === undefined
          ? {}
          : { visualReviewModel: options.ready.gemini.models[0] }),
        linearPublication: {
          publish: (...args) =>
            preparedCapability((composition) => composition.linearPublication).publish(...args),
        },
        linearPublicationStore: {
          load: (...args) =>
            preparedCapability((composition) => composition.linearPublicationStore).load(...args),
        },
        clock: options.clock,
        holderId: options.holderId,
        reviewReportSidecar: buildReviewReportDiagnosticsSidecar(options.agentTeamHome),
        admission: buildIssueAdmissionStore(options.agentTeamHome),
        resolveAuthoritativeBase: (project, resolveOptions) =>
          (options.resolveAuthoritativeBase ?? resolveAuthoritativeBaseRevision)(
            project,
            { git: new LocalGitAdapter(), sourceControl: new GitHubAdapter() },
            resolveOptions,
          ),
      },
      {
        selections: Object.freeze(
          selected.map((record) => ({
            jobId: record.jobId,
            expectedRevision: record.revision,
          })),
        ),
      },
    );
    if (!cycle.ok) {
      return Object.freeze({
        state: "blocked" as const,
        reason: "resume_cycle_failed" as const,
        error: cycle.error,
      });
    }
    return Object.freeze({
      state: "resumed" as const,
      outcomes: Object.freeze([...preflightOutcomes, ...cycle.value]),
    });
  } catch (error) {
    if (error instanceof ResumePreparationBlockedError) return error.result;
    throw error;
  }
}
