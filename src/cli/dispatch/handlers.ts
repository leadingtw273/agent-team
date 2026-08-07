/**
 * C015a: CLI handler for `agent-team run --project <id> [--dry-run]`. Mirrors the exact shape
 * `createRegistrationProbeHandlers` (src/cli/registration/probe-handlers.ts) already established:
 * a fixed per-reason Traditional-Chinese message table for every `blocked` composition reason
 * (missing config -> exit code 3, zero external calls -- program.ts's `outcomeExitCode` maps
 * `state:"blocked"` to `cliExitCodes.blocked` unconditionally), and a `buildComposition` override
 * hook so tests can inject a fake composition without touching any real file/network.
 *
 * C015b item 5: once a candidate is genuinely `kind:"dispatched"` (never in `--dry-run`, which
 * stays zero-mutation/zero-pipeline exactly as C015a left it), this same process drives the
 * `ImplementerPipeline` to completion (`ci_waiting`/`paused`/`failed`) before this command exits
 * -- there is no separate "start the pipeline" step or background process. Only `role ===
 * "implementer"` candidates are driven; other roles' pipelines (reviewer, integration, ...) are
 * not this ticket's job, so a dispatched non-implementer job is reported as `dispatched` with
 * `pipeline: "not_applicable_role"`, exactly like before this ticket existed.
 */
import { randomUUID } from "node:crypto";

import type { CliHandlers } from "../program.js";
import { LocalGitAdapter } from "../../adapters/git/index.js";
import { LeaseCoordinator } from "../../application/leases/index.js";
import type { ImplementerPipelineOutcome } from "../../application/pipelines/index.js";
import { createClock, type Clock } from "../../domain/foundation/index.js";
import {
  buildDispatchComposition,
  dispatchOnce,
  type BuildDispatchCompositionResult,
  type DispatchCompositionBlockedReason,
} from "./composition.js";
import { InMemoryJobRepository, InMemoryLeaseRepository } from "./ephemeral-ports.js";
import { buildImplementerPipelineRequest } from "./implementer-request.js";
import {
  buildImplementerPipeline,
  type BuildImplementerPipelineResult,
} from "./implementer-composition.js";
import {
  buildJobProgressStore,
  resumableStageKinds,
  runResumeCycle,
  type ResumeJobOutcome,
} from "./resume-composition.js";
import {
  buildResumeComposition,
  type BuildResumeCompositionResult,
} from "./resume-full-composition.js";

export interface CreateDispatchCliHandlersOptions {
  readonly agentTeamHome: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Injectable for tests; production defaults to the real `buildDispatchComposition`. */
  readonly buildComposition?: (
    options: Parameters<typeof buildDispatchComposition>[0],
  ) => Promise<BuildDispatchCompositionResult>;
  /** Injectable for tests (deterministic assertions); production defaults to a fresh random id
   * per invocation. This value is not a convention C015b needs to reconstruct -- it is durably
   * recorded on the persisted `Lease` itself (`Lease.holderId`), so C015b can always discover the
   * exact holder of an active lease by reading the lease file back. */
  readonly generateHolderId?: () => string;
  /** Injectable for tests; production defaults to the real `buildImplementerPipeline`. */
  readonly buildImplementerPipeline?: (
    options: Parameters<typeof buildImplementerPipeline>[0],
  ) => Promise<BuildImplementerPipelineResult>;
  /** C015c item 2: injectable for tests; production defaults to the real `buildResumeComposition`
   * (the GitHub-auth-gated bundle of CiRecovery/Reviewer/ReviewStatus+AutoMerge/Lifecycle). */
  readonly buildResumeComposition?: (
    options: Parameters<typeof buildResumeComposition>[0],
  ) => Promise<BuildResumeCompositionResult>;
  readonly clock?: Clock;
}

const implementerCompositionBlockedMessages: Readonly<Record<string, string>> = Object.freeze({
  github_authentication_unavailable: "GitHub CLI（gh）未通過身分驗證，無法建立 Draft PR。",
});

type DispatchHandlers = Pick<CliHandlers, "run">;

const blockedMessages: Readonly<Record<DispatchCompositionBlockedReason, string>> = Object.freeze({
  draft_unavailable:
    "找不到有效的 Setup draft 檔（${AGENT_TEAM_HOME}/config/registration/<projectId>.draft.json），或格式不符 schema。",
  linear_api_key_missing: "缺少 LINEAR_API_KEY 環境變數。",
  routing_config_unavailable:
    "找不到有效的 Model Routing 設定檔（${AGENT_TEAM_HOME}/config/dispatch/routing.json），或格式不符 schema。",
  provider_config_unavailable:
    "找不到有效的 Provider 設定檔（${AGENT_TEAM_HOME}/config/dispatch/providers.json），或格式不符 schema。",
  invalid_registry_entry: "專案設定物件本身不符合 Project schema。",
  trusted_config_missing: "專案 repository 內找不到 .agent-team/project.json。",
  trusted_config_unavailable: "讀取專案 repository 內 .agent-team/project.json 失敗。",
  trusted_config_invalid: "專案 repository 內 .agent-team/project.json 格式不符 schema。",
  secret_in_trusted_config: ".agent-team/project.json 內偵測到疑似機密內容，拒絕載入。",
  project_id_mismatch: "Draft 內的 project id 與 repository 內信任設定不一致。",
  default_branch_mismatch: "Draft 內的 defaultBranch 與 repository 內信任設定不一致。",
  platform_mismatch:
    "Draft 內的 workManagement／sourceControl 設定與 repository 內信任設定不一致。",
  activation_missing: "此 project 尚未完成 Registration Setup activation。",
  activation_unavailable: "讀取 Registration Setup activation 記錄失敗。",
  activation_invalid: "Registration Setup activation 記錄格式不符 schema。",
  registry_conflict: "此 project 與其他已註冊專案的 id／repository 衝突。",
});

function outcome(state: "success" | "failed" | "blocked", payload: unknown) {
  return Object.freeze({ state, message: JSON.stringify(payload) });
}

function pipelineOutcomePayload(
  outcome: ImplementerPipelineOutcome,
): Readonly<Record<string, unknown>> {
  switch (outcome.state) {
    case "ci_waiting":
      return Object.freeze({
        pipeline: "ci_waiting",
        changeRequestUrl: outcome.changeRequest.url,
        commitSha: outcome.commit.sha,
        ...(outcome.providerSessionId === undefined
          ? {}
          : { providerSessionId: outcome.providerSessionId }),
      });
    case "paused":
      return Object.freeze({
        pipeline: "paused",
        pauseReason: outcome.reason,
        ...(outcome.checkpointId === undefined ? {} : { checkpointId: outcome.checkpointId }),
        ...(outcome.toolSummary === undefined ? {} : { toolSummary: outcome.toolSummary }),
      });
    case "failed":
      return Object.freeze({ pipeline: "failed", stage: outcome.stage, error: outcome.error });
  }
}

export function createDispatchCliHandlers(
  options: CreateDispatchCliHandlersOptions,
): DispatchHandlers {
  const generateHolderId = options.generateHolderId ?? (() => `cli-dispatch:${randomUUID()}`);
  const clock = options.clock ?? createClock();
  const buildPipelineComposition = options.buildImplementerPipeline ?? buildImplementerPipeline;

  return Object.freeze({
    async run(input) {
      if (input.projectId === undefined || input.projectId.trim().length === 0) {
        return outcome("blocked", {
          operation: "dispatch_run",
          state: "blocked",
          reason: "project_id_required",
          message: "run 需要 --project <project-id>。",
        });
      }
      const build = await (options.buildComposition ?? buildDispatchComposition)({
        agentTeamHome: options.agentTeamHome,
        projectId: input.projectId,
        ...(options.environment === undefined ? {} : { environment: options.environment }),
      });
      if (build.state !== "ready") {
        return outcome("blocked", {
          operation: "dispatch_run",
          state: "blocked",
          reason: build.reason,
          message: blockedMessages[build.reason],
        });
      }

      const holderId = generateHolderId();
      const dryRun = input.dryRun === true;

      // C015c item 2: resume any of this project's own ci_waiting-or-later jobs *before*
      // considering a fresh dispatch -- never in `--dry-run`, which must stay zero-mutation/
      // zero-network exactly as C015a/b left it (real GitHub/Linear calls happen inside
      // `runResumeCycle`). A single `run` invocation either resumes existing work or dispatches
      // new work, never both -- the next invocation picks up whichever is still outstanding.
      if (!dryRun) {
        const progress = buildJobProgressStore(options.agentTeamHome);
        const existingProgress = await progress.listForProject(build.value.project.id);
        if (!existingProgress.ok) {
          return outcome("failed", {
            operation: "dispatch_run",
            state: "blocked",
            projectId: input.projectId,
            reason: "job_progress_read_failed",
            message: "讀取本機 job 進度索引失敗（外部/檔案系統故障，非設定缺失，可重試）。",
            error: existingProgress.error,
          });
        }
        const resumable = existingProgress.value.filter((record) =>
          resumableStageKinds.has(record.stage.kind),
        );
        if (resumable.length > 0) {
          const resumeComposition = await (
            options.buildResumeComposition ?? buildResumeComposition
          )({
            agentTeamHome: options.agentTeamHome,
            claudeConfig: build.value.claude.config,
            jobs: build.value.jobs,
            readModel: build.value.discovery.readModel,
            mutationClient: build.value.discovery.mutationClient,
            teamId: build.value.discovery.teamId,
            linearProjectId: build.value.discovery.linearProjectId,
            progress,
          });
          if (resumeComposition.state !== "ready") {
            return outcome("blocked", {
              operation: "dispatch_run",
              state: "blocked",
              projectId: input.projectId,
              reason: resumeComposition.reason,
              message: implementerCompositionBlockedMessages[resumeComposition.reason],
            });
          }
          const cycle = await runResumeCycle({
            progress,
            jobRepository: build.value.jobs,
            leases: new LeaseCoordinator(build.value.leases),
            sourceControl: resumeComposition.value.sourceControl,
            readModel: build.value.discovery.readModel,
            teamId: build.value.discovery.teamId,
            linearProjectId: build.value.discovery.linearProjectId,
            project: build.value.project,
            trustedConfig: build.value.trustedConfig,
            ciRecovery: resumeComposition.value.ciRecovery,
            reviewer: resumeComposition.value.reviewer,
            reviewStatus: resumeComposition.value.reviewStatus,
            autoMerge: resumeComposition.value.autoMerge,
            lifecycle: resumeComposition.value.lifecycle,
            clock,
            holderId,
          });
          if (!cycle.ok) {
            return outcome("failed", {
              operation: "dispatch_run",
              state: "blocked",
              projectId: input.projectId,
              reason: "resume_cycle_failed",
              message: "恢復既有工作流程時發生非預期錯誤。",
              error: cycle.error,
            });
          }
          return outcome(
            cycle.value.some((job) => job.outcome === "failed") ? "failed" : "success",
            {
              operation: "dispatch_run",
              state: "resumed",
              projectId: input.projectId,
              resumed: cycle.value satisfies readonly ResumeJobOutcome[],
            },
          );
        }
      }

      const ports = dryRun
        ? {
            leases: new LeaseCoordinator(new InMemoryLeaseRepository()),
            jobs: new InMemoryJobRepository(),
          }
        : { leases: new LeaseCoordinator(build.value.leases), jobs: build.value.jobs };

      const dispatchOnceOutcome = await dispatchOnce(build.value, ports, holderId);
      if (dispatchOnceOutcome.outcome === "discovery_failed") {
        return outcome("failed", {
          operation: "dispatch_run",
          state: "blocked",
          projectId: input.projectId,
          reason: "discovery_failed",
          message: "讀取 Linear 待執行工單失敗（外部呼叫故障，非設定缺失，可重試）。",
          error: dispatchOnceOutcome.error,
        });
      }
      const { result, candidates, discoverySkipped } = dispatchOnceOutcome;
      const candidateSummaries = candidates.map((candidate) => ({
        issueId: candidate.issue.id,
        externalId: candidate.issue.externalId,
        title: candidate.issue.title,
        agentRole: candidate.issue.agentRole,
        priority: candidate.issue.priority,
        readyAt: candidate.readyAt,
        stage: candidate.stage,
        workKind: candidate.workKind,
      }));

      if (dryRun) {
        return outcome("success", {
          operation: "dispatch_run",
          state: "dry_run",
          projectId: input.projectId,
          result,
          discoverySkipped,
          candidateSummaries,
        });
      }

      switch (result.kind) {
        case "dispatched": {
          const dispatchedPayload = {
            operation: "dispatch_run",
            state: "dispatched",
            projectId: input.projectId,
            jobId: result.job.id,
            issueId: result.job.issueId,
            leaseId: result.lease.id,
            holderId,
            skipped: result.skipped,
            discoverySkipped,
          };

          // C015b item 5 scope boundary: only implementer-role work drives a pipeline here.
          // Reviewer/integration/etc. pipelines are separate, unbuilt C-series tickets.
          if (result.decision.candidate.role !== "implementer") {
            return outcome("success", {
              ...dispatchedPayload,
              pipeline: "not_applicable_role",
            });
          }

          const issue = candidates.find(
            (candidate) => candidate.issue.id === result.job.issueId,
          )?.issue;
          const model = result.decision.model?.candidate.model;
          if (issue === undefined || model === undefined) {
            return outcome("failed", {
              ...dispatchedPayload,
              pipeline: "failed",
              pipelineReason: "implementer_request_invalid",
            });
          }

          const pipelineComposition = await buildPipelineComposition({
            agentTeamHome: options.agentTeamHome,
            claudeConfig: build.value.claude.config,
          });
          if (pipelineComposition.state !== "ready") {
            return outcome("failed", {
              ...dispatchedPayload,
              pipeline: "blocked",
              pipelineReason: pipelineComposition.reason,
              message: implementerCompositionBlockedMessages[pipelineComposition.reason],
            });
          }

          // The worktree must be pinned to a real, resolved revision -- never the branch name
          // itself (see implementer-request.ts's own comment on `baseRevision`). A fresh
          // `LocalGitAdapter` here (rather than reaching into `pipelineComposition.value.ports.git`)
          // is deliberate: `ImplementerPipelinePorts.git` is narrowed to
          // `Pick<GitPort,"createWorktree"|"stagePaths"|"commit"|"inspectWorkingTree"|"push">`,
          // which does not include `inspectRepository` -- `LocalGitAdapter` is a stateless CLI
          // wrapper, so constructing a second instance is cheap and does not duplicate any state.
          const repository = await new LocalGitAdapter().inspectRepository({
            rootPath: build.value.project.localRepositoryPath,
          });
          if (!repository.ok) {
            return outcome("failed", {
              ...dispatchedPayload,
              pipeline: "failed",
              pipelineReason: "base_revision_unavailable",
              error: repository.error,
            });
          }

          const request = buildImplementerPipelineRequest({
            job: result.job,
            issue,
            project: build.value.project,
            trustedConfig: build.value.trustedConfig,
            model,
            agentTeamHome: options.agentTeamHome,
            clock,
            baseRevision: repository.value.headSha,
          });
          if (!request.ok) {
            return outcome("failed", {
              ...dispatchedPayload,
              pipeline: "failed",
              pipelineReason: "implementer_request_invalid",
              error: request.error,
            });
          }

          const pipelineOutcome = await pipelineComposition.value.run(request.value);
          return outcome(pipelineOutcome.state === "failed" ? "failed" : "success", {
            ...dispatchedPayload,
            ...pipelineOutcomePayload(pipelineOutcome),
          });
        }
        case "waiting":
          return outcome("success", {
            operation: "dispatch_run",
            state: "waiting",
            projectId: input.projectId,
            reason: result.reason,
            skipped: result.skipped,
            discoverySkipped,
          });
        case "blocked":
          return outcome("failed", {
            operation: "dispatch_run",
            state: "blocked",
            projectId: input.projectId,
            reason: result.reason,
            skipped: result.skipped,
            discoverySkipped,
          });
      }
    },
  });
}
