import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { LocalYamlCheckpointReader } from "../../adapters/checkpoint/index.js";
import { GitHubAdapter, GhTransport } from "../../adapters/github/index.js";
import { LocalGitAdapter } from "../../adapters/git/index.js";
import { LeaseCoordinator } from "../../application/leases/index.js";
import { createClock, type Clock } from "../../domain/foundation/index.js";
import { jobIdSchema } from "../../domain/jobs/index.js";
import { FileReviewerReplayDiagnosticStore } from "../../adapters/dispatch/reviewer-replay-diagnostic-store.js";
import { FileReviewerReplayPolicyStore } from "../../adapters/dispatch/reviewer-replay-policy-store.js";
import { FileFinalReviewRecoveryStore } from "../../adapters/dispatch/final-review-recovery-store.js";
import {
  FileIssueScopeLock,
  JobProgressWorkStatusLifecycleLedger,
} from "../../adapters/dispatch/index.js";
import { WorkStatusLifecycleCoordinator } from "../../application/pipelines/index.js";
import type { CliCommandOutcome } from "../program.js";
import { readStdinConfirmation } from "../registration/confirmation.js";
import { buildDispatchComposition } from "./composition.js";
import {
  buildAutoMergePauseStore,
  buildIssueAdmissionStore,
  buildJobProgressStore,
  buildReviewReportDiagnosticsSidecar,
  type ResumeCycleDependencies,
  type ResumeJobOutcome,
} from "./resume-composition.js";
import {
  buildResumeComposition,
  type ResumePipelineComposition,
} from "./resume-full-composition.js";
import { resolveAuthoritativeBaseRevision } from "./authoritative-base.js";
import { LinearWorkManagementAdapter } from "./work-management-adapter.js";
import {
  isReviewerReplayCommandEligible,
  ReviewerReplayCoordinator,
  type ReviewerReplayOutcome,
} from "./reviewer-replay-coordinator.js";
import { createLazyReviewerFacade } from "./reviewer-facade.js";

export const reviewerReplayPolicyConfirmationPhrase = "SET REVIEWER REPLAY POLICY" as const;

export interface ReviewerReplayHandlerInput {
  readonly jobId: string;
  readonly dryRun?: boolean;
  readonly newContractEpoch?: boolean;
  readonly expectContractVersion?: number;
  readonly finalReviewEpoch?: boolean;
  readonly expectCheckpoint?: string;
}

export interface ReviewerReplayPolicyHandlerInput {
  readonly projectId: string;
  readonly enabled: boolean;
}

export interface CreateReviewerReplayHandlersOptions {
  readonly agentTeamHome: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly clock?: Clock;
  readonly stdin?: AsyncIterable<Uint8Array | string>;
  readonly generateHolderId?: () => string;
  readonly coordinatorFactory?: (
    jobId: string,
  ) => Promise<ReviewerReplayCoordinator | CliCommandOutcome>;
}

function outcome(
  state: "success" | "failed" | "blocked" | "rejected",
  payload: unknown,
): CliCommandOutcome {
  return { state, message: JSON.stringify(payload) };
}

function resumeOutcomeCliState(result: ResumeJobOutcome): "success" | "failed" | "blocked" {
  switch (result.outcome) {
    case "completed":
    case "merging":
      return "success";
    case "failed":
    case "progress_write_failed":
    case "transient_failure":
    case "admission_release_failed":
    case "merge_reconcile_readback_failed":
    case "merge_reconcile_lifecycle_failed":
      return "failed";
    default:
      return "blocked";
  }
}

export function reviewerReplayCliOutcome(
  result: ReviewerReplayOutcome,
  dryRun: boolean,
): CliCommandOutcome {
  if (result.state === "blocked") {
    return outcome("blocked", {
      operation: "reviewer-replay",
      dryRun,
      ...result,
    });
  }
  const state = result.state === "continued" ? resumeOutcomeCliState(result.outcome) : "success";
  return outcome(state, {
    operation: "reviewer-replay",
    dryRun,
    ...result,
  });
}

export function createReviewerReplayHandlers(options: CreateReviewerReplayHandlersOptions): {
  readonly reviewerReplay: (input: ReviewerReplayHandlerInput) => Promise<CliCommandOutcome>;
  readonly reviewerReplayPolicy: (
    input: ReviewerReplayPolicyHandlerInput,
  ) => Promise<CliCommandOutcome>;
} {
  const clock = options.clock ?? createClock();
  const progress = buildJobProgressStore(options.agentTeamHome);
  const admission = buildIssueAdmissionStore(options.agentTeamHome);
  const policy = new FileReviewerReplayPolicyStore(
    join(options.agentTeamHome, "state", "dispatch", "reviewer-replay-policy"),
    undefined,
    clock,
  );
  const diagnostics = new FileReviewerReplayDiagnosticStore(
    join(options.agentTeamHome, "state", "dispatch", "reviewer-replay-diagnostics"),
    undefined,
    clock,
  );
  const finalReviewRecovery = new FileFinalReviewRecoveryStore(
    join(options.agentTeamHome, "state", "dispatch", "final-review-recovery"),
    undefined,
    clock,
  );
  const checkpoints = new LocalYamlCheckpointReader(
    join(options.agentTeamHome, "state", "checkpoints"),
  );
  const stdin = options.stdin ?? process.stdin;

  const buildCoordinator = async (
    jobId: string,
    finalReviewEpoch = false,
  ): Promise<ReviewerReplayCoordinator | CliCommandOutcome> => {
    if (options.coordinatorFactory !== undefined) return options.coordinatorFactory(jobId);
    const record = await progress.load(jobId);
    if (!record.ok || record.value === undefined) {
      return outcome("blocked", {
        operation: "reviewer-replay",
        state: "blocked",
        reason: record.ok ? "job_not_found" : "job_progress_read_failed",
        ...(!record.ok ? { errorCode: record.error.code } : {}),
      });
    }
    const ordinaryEligible = isReviewerReplayCommandEligible(record.value);
    if (!finalReviewEpoch && !ordinaryEligible) {
      return outcome("blocked", {
        operation: "reviewer-replay",
        state: "blocked",
        reason: "job_not_eligible",
      });
    }
    const policyRead = await policy.load(record.value.projectId);
    if (!policyRead.ok || policyRead.value?.enabled !== true) {
      return outcome("blocked", {
        operation: "reviewer-replay",
        state: "blocked",
        reason: policyRead.ok ? "policy_disabled" : "policy_read_failed",
        ...(!policyRead.ok ? { errorCode: policyRead.error.code } : {}),
      });
    }
    const claim = await admission.load(record.value.projectId, record.value.issueId);
    if (!claim.ok || claim.value?.state !== "active" || claim.value.jobId !== record.value.jobId) {
      return outcome("blocked", {
        operation: "reviewer-replay",
        state: "blocked",
        reason: claim.ok ? "claim_mismatch" : "claim_read_failed",
        ...(!claim.ok ? { errorCode: claim.error.code } : {}),
      });
    }
    const built = await buildDispatchComposition({
      agentTeamHome: options.agentTeamHome,
      projectId: record.value.projectId,
      ...(options.environment === undefined ? {} : { environment: options.environment }),
    });
    if (built.state !== "ready") {
      return outcome("blocked", {
        operation: "reviewer-replay",
        state: "blocked",
        reason: built.reason,
      });
    }
    const leases = new LeaseCoordinator(built.value.leases, { clock });
    const autoMergePause = buildAutoMergePauseStore(options.agentTeamHome);
    let composition: ResumePipelineComposition | undefined;
    const prepare = async (): Promise<void> => {
      if (composition !== undefined) return;
      const result = await buildResumeComposition({
        agentTeamHome: options.agentTeamHome,
        codexConfig: built.value.codex.config,
        claudeConfig: built.value.claude.config,
        ...(built.value.gemini === undefined ? {} : { geminiConfig: built.value.gemini }),
        jobs: built.value.jobs,
        readModel: built.value.discovery.readModel,
        mutationClient: built.value.discovery.mutationClient,
        teamId: built.value.discovery.teamId,
        linearProjectId: built.value.discovery.linearProjectId,
        progress,
        leases,
        autoMergePause,
        linearTransport: built.value.discovery.linearTransport,
      });
      if (result.state !== "ready") throw new Error(result.reason);
      composition = result.value;
    };
    const prepared = (): ResumePipelineComposition => {
      if (composition === undefined) throw new Error("reviewer_replay_runtime_not_prepared");
      return composition;
    };
    const workManagement = new LinearWorkManagementAdapter({
      readModel: built.value.discovery.readModel,
      mutationClient: built.value.discovery.mutationClient,
      teamId: built.value.discovery.teamId,
      linearProjectId: built.value.discovery.linearProjectId,
    });
    const issueScopeLocks = new FileIssueScopeLock(
      join(options.agentTeamHome, "state", "dispatch", "issue-scope-locks"),
    );
    const resume: ResumeCycleDependencies = {
      progress,
      jobRepository: built.value.jobs,
      leases,
      sourceControl: {
        getChangeRequest: (...args) => prepared().sourceControl.getChangeRequest(...args),
        getCommitStatuses: (...args) => {
          const sourceControl = prepared().sourceControl;
          const getCommitStatuses = sourceControl.getCommitStatuses;
          if (getCommitStatuses === undefined) {
            throw new Error("reviewer_replay_status_read_unavailable");
          }
          return getCommitStatuses.call(sourceControl, ...args);
        },
      },
      workManagement,
      reviewWaitPublication: {
        publish: (...args) => prepared().reviewWaitPublication.publish(...args),
      },
      readModel: built.value.discovery.readModel,
      teamId: built.value.discovery.teamId,
      linearProjectId: built.value.discovery.linearProjectId,
      project: built.value.project,
      trustedConfig: built.value.trustedConfig,
      ciRecovery: { run: (...args) => prepared().ciRecovery.run(...args) },
      reviewerRecovery: { run: (...args) => prepared().reviewerRecovery.run(...args) },
      reviewer: createLazyReviewerFacade(() => prepared().reviewer),
      reviewerReplayPolicy: policy,
      reviewStatus: {
        begin: (...args) => prepared().reviewStatus.begin(...args),
        record: (...args) => prepared().reviewStatus.record(...args),
      },
      autoMerge: { enable: (...args) => prepared().autoMerge.enable(...args) },
      lifecycle: { run: (...args) => prepared().lifecycle.run(...args) },
      visualEvidence: {
        build: (...args) => prepared().visualEvidence.build(...args),
        verifyExisting: (...args) => prepared().visualEvidence.verifyExisting(...args),
      },
      ...(built.value.gemini?.models[0] === undefined
        ? {}
        : { visualReviewModel: built.value.gemini.models[0] }),
      linearPublication: { publish: (...args) => prepared().linearPublication.publish(...args) },
      linearPublicationStore: {
        load: (...args) => prepared().linearPublicationStore.load(...args),
      },
      clock,
      holderId: options.generateHolderId?.() ?? `reviewer-replay:${randomUUID()}`,
      prepare,
      reviewReportSidecar: buildReviewReportDiagnosticsSidecar(options.agentTeamHome),
      admission,
      workStatusLifecycle: new WorkStatusLifecycleCoordinator({
        workManagement,
        history: workManagement,
        ledger: new JobProgressWorkStatusLifecycleLedger(progress),
        locks: issueScopeLocks,
        clock,
      }),
      resolveAuthoritativeBase: (project, resolveOptions) =>
        resolveAuthoritativeBaseRevision(
          project,
          { git: new LocalGitAdapter(), sourceControl: new GitHubAdapter() },
          resolveOptions,
        ),
    };
    return new ReviewerReplayCoordinator({
      resume,
      diagnostics,
      publication: {
        sourceControl: new GitHubAdapter(new GhTransport()),
        workManagement,
      },
      finalReviewRecovery: { store: finalReviewRecovery, checkpoints },
    });
  };

  return Object.freeze({
    async reviewerReplay(input) {
      if (!jobIdSchema.safeParse(input.jobId).success) {
        return outcome("rejected", {
          operation: "reviewer-replay",
          state: "rejected",
          reason: "job_id_invalid",
        });
      }
      const hasNewEpoch = input.newContractEpoch === true;
      const hasExpectedVersion = input.expectContractVersion !== undefined;
      const hasFinalEpoch = input.finalReviewEpoch === true;
      const hasExpectedCheckpoint = input.expectCheckpoint !== undefined;
      if (
        hasNewEpoch !== hasExpectedVersion ||
        hasFinalEpoch !== hasExpectedCheckpoint ||
        (hasNewEpoch && hasFinalEpoch) ||
        (hasExpectedVersion &&
          (!Number.isSafeInteger(input.expectContractVersion) ||
            (input.expectContractVersion ?? 0) < 2)) ||
        (hasExpectedCheckpoint && input.expectCheckpoint.trim().length === 0)
      ) {
        return outcome(input.dryRun === true ? "blocked" : "rejected", {
          operation: "reviewer-replay",
          state: input.dryRun === true ? "blocked" : "rejected",
          dryRun: input.dryRun === true,
          reason: "contract_epoch_options_invalid",
        });
      }
      const coordinator = await buildCoordinator(input.jobId, hasFinalEpoch);
      if (!(coordinator instanceof ReviewerReplayCoordinator)) return coordinator;
      const dryRun = input.dryRun === true;
      return reviewerReplayCliOutcome(
        await coordinator.run(input.jobId, dryRun, {
          ...(hasNewEpoch ? { newContractEpoch: true } : {}),
          ...(hasExpectedVersion ? { expectContractVersion: input.expectContractVersion } : {}),
          ...(hasFinalEpoch ? { finalReviewEpoch: true } : {}),
          ...(hasExpectedCheckpoint ? { expectCheckpoint: input.expectCheckpoint } : {}),
        }),
        dryRun,
      );
    },
    async reviewerReplayPolicy(input) {
      if (input.projectId.trim().length === 0) {
        return outcome("rejected", {
          operation: "reviewer-replay-policy",
          state: "rejected",
          reason: "project_id_required",
        });
      }
      const confirmation = await readStdinConfirmation(stdin);
      if (!confirmation.ok || confirmation.value !== reviewerReplayPolicyConfirmationPhrase) {
        return outcome("rejected", {
          operation: "reviewer-replay-policy",
          state: "rejected",
          reason: "confirmation_mismatch",
        });
      }
      const written = await policy.setEnabled(input.projectId, input.enabled);
      if (!written.ok) {
        return outcome("failed", {
          operation: "reviewer-replay-policy",
          state: "blocked",
          reason: "policy_write_failed",
          errorCode: written.error.code,
        });
      }
      return outcome("success", {
        operation: "reviewer-replay-policy",
        state: input.enabled ? "enabled" : "disabled",
        projectId: input.projectId,
        revision: written.value.revision,
      });
    },
  });
}
