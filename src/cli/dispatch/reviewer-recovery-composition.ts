import { join } from "node:path";

import { LocalYamlCheckpointStore } from "../../adapters/checkpoint/index.js";
import { GitPreflight, LocalGitAdapter } from "../../adapters/git/index.js";
import { ReviewerRecoveryPipeline } from "../../application/pipelines/index.js";
import type { FileJobRepository } from "../../infrastructure/jobs/index.js";
import { buildClaudeRunner } from "./claude-factory.js";
import { FileJobUpdateAdapter } from "./pipeline-job-adapter.js";
import type { DispatchProviderConfig } from "./provider-config-store.js";
import { ReviewerRecoveryCheckpointAdapter } from "./reviewer-recovery-checkpoint.js";
import { FailClosedToolDecisionAdapter } from "./tool-decision.js";

export interface BuildReviewerRecoveryPipelineOptions {
  readonly agentTeamHome: string;
  readonly claudeConfig: DispatchProviderConfig["claude"];
  readonly jobs: Pick<FileJobRepository, "update">;
}

export type BuildReviewerRecoveryPipelineResult = Readonly<{
  state: "ready";
  value: ReviewerRecoveryPipeline;
}>;

/**
 * 不使用 GitHub API，故不需要 GitHub authentication 前置檢查——因此這裡沒有任何 `await`。
 * 保留 `Promise.resolve` 包裝（而非把函式簽名改成同步）是為了讓呼叫端
 * `buildResumeComposition` 的 `await buildReviewerRecoveryPipeline(...)` 維持不變，
 * 跟其他 composition builder（例如 `buildCiRecoveryPipeline`）的呼叫慣例一致。
 */
export function buildReviewerRecoveryPipeline(
  options: BuildReviewerRecoveryPipelineOptions,
): Promise<BuildReviewerRecoveryPipelineResult> {
  const git = new LocalGitAdapter();
  const pipeline = new ReviewerRecoveryPipeline({
    git,
    preflight: new GitPreflight(git),
    provider: buildClaudeRunner(options.claudeConfig),
    jobs: new FileJobUpdateAdapter(options.jobs),
    checkpoint: new ReviewerRecoveryCheckpointAdapter({
      store: new LocalYamlCheckpointStore(join(options.agentTeamHome, "state", "checkpoints")),
    }),
    toolDecisions: new FailClosedToolDecisionAdapter(),
  });
  return Promise.resolve(Object.freeze({ state: "ready", value: pipeline }));
}
