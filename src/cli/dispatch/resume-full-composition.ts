/**
 * C015c item 2: bundles the four GitHub-auth-gated compositions `runResumeCycle`
 * (resume-composition.ts) needs -- `CiRecoveryPipeline` (C006), `ReviewerPipeline` (C007),
 * `ReviewStatusCoordinator`/`AutoMergeGate` (C008), `LifecyclePipeline` (C009) -- behind one
 * overridable seam, the same convention `implementer-composition.ts`'s own
 * `BuildImplementerPipelineResult` already established. Kept separate from resume-composition.ts
 * itself so that file's pure state-machine logic (already thoroughly unit tested against fakes)
 * stays free of GitHub-authentication wiring concerns.
 */
import { GhTransport, GitHubAdapter } from "../../adapters/github/index.js";
import type { FileJobProgressStore } from "../../adapters/dispatch/job-progress-store.js";
import type { LinearMutationClient } from "../../adapters/linear/write.js";
import type { LinearReadModel } from "../../adapters/linear/read.js";
import type { FileJobRepository } from "../../infrastructure/jobs/index.js";
import type { ResumeCycleDependencies } from "./resume-composition.js";
import { buildCiRecoveryPipeline } from "./ci-recovery-composition.js";
import { buildReviewerPipeline } from "./reviewer-composition.js";
import { buildStatusMergePipelines } from "./status-merge-composition.js";
import { buildLifecyclePipeline } from "./lifecycle-composition.js";
import type { DispatchProviderConfig } from "./provider-config-store.js";

export type ResumeCompositionBlockedReason = "github_authentication_unavailable";

export interface BuildResumeCompositionOptions {
  readonly agentTeamHome: string;
  readonly claudeConfig: DispatchProviderConfig["claude"];
  readonly jobs: Pick<FileJobRepository, "update">;
  readonly readModel: LinearReadModel;
  readonly mutationClient: Pick<
    LinearMutationClient,
    "observeGithubMerge" | "setAgentCondition" | "appendComment"
  >;
  readonly teamId: string;
  readonly linearProjectId: string;
  readonly progress: FileJobProgressStore;
}

export type ResumePipelineComposition = Pick<
  ResumeCycleDependencies,
  "sourceControl" | "ciRecovery" | "reviewer" | "reviewStatus" | "autoMerge" | "lifecycle"
>;

export type BuildResumeCompositionResult =
  | Readonly<{ state: "ready"; value: ResumePipelineComposition }>
  | Readonly<{ state: "blocked"; reason: ResumeCompositionBlockedReason }>;

export async function buildResumeComposition(
  options: BuildResumeCompositionOptions,
): Promise<BuildResumeCompositionResult> {
  const ciRecovery = await buildCiRecoveryPipeline({
    agentTeamHome: options.agentTeamHome,
    claudeConfig: options.claudeConfig,
    jobs: options.jobs,
  });
  if (ciRecovery.state !== "ready") {
    return Object.freeze({ state: "blocked", reason: ciRecovery.reason });
  }
  const reviewer = await buildReviewerPipeline({
    agentTeamHome: options.agentTeamHome,
    claudeConfig: options.claudeConfig,
    jobs: options.jobs,
  });
  if (reviewer.state !== "ready") {
    return Object.freeze({ state: "blocked", reason: reviewer.reason });
  }
  const statusMerge = await buildStatusMergePipelines({});
  if (statusMerge.state !== "ready") {
    return Object.freeze({ state: "blocked", reason: statusMerge.reason });
  }
  const lifecycle = buildLifecyclePipeline({
    readModel: options.readModel,
    mutationClient: options.mutationClient,
    teamId: options.teamId,
    linearProjectId: options.linearProjectId,
    progress: options.progress,
  });

  return Object.freeze({
    state: "ready",
    value: Object.freeze({
      sourceControl: new GitHubAdapter(new GhTransport()),
      ciRecovery: ciRecovery.value,
      reviewer: reviewer.value,
      reviewStatus: statusMerge.value.reviewStatus,
      autoMerge: statusMerge.value.autoMergeGate,
      lifecycle,
    }),
  });
}
