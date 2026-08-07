/**
 * C015c item 3b: production composition root for `CiRecoveryPipeline`
 * (src/application/pipelines/ci-recovery.ts), mirroring `implementer-composition.ts` (C015b) and
 * `reviewer-composition.ts` (C015c item 3): the same fail-closed GitHub-authentication-first
 * prerequisite chain, and the same two ports that need no adapter at all -- `LocalGitAdapter`
 * (satisfies `Pick<GitPort, "stagePaths" | "commit" | "inspectWorkingTree" | "push">` directly) and
 * `GitPreflight` (already *is* a drop-in `ImplementerPreflightPort`, the exact same confirmed fit
 * `implementer-composition.ts` already established and reused here rather than re-derived).
 */
import { join } from "node:path";

import { GhTransport, GitHubAdapter, type GhJsonTransport } from "../../adapters/github/index.js";
import { GitPreflight, LocalGitAdapter } from "../../adapters/git/index.js";
import { LocalYamlCheckpointStore } from "../../adapters/checkpoint/index.js";
import { CiRecoveryPipeline } from "../../application/pipelines/index.js";
import type { FileJobRepository } from "../../infrastructure/jobs/index.js";
import { buildClaudeRunner } from "./claude-factory.js";
import { CiRecoveryCheckpointAdapter } from "./ci-recovery-checkpoint.js";
import { FileJobUpdateAdapter } from "./pipeline-job-adapter.js";
import { FailClosedToolDecisionAdapter } from "./tool-decision.js";
import type { DispatchProviderConfig } from "./provider-config-store.js";

export type CiRecoveryCompositionBlockedReason = "github_authentication_unavailable";

export interface BuildCiRecoveryPipelineOptions {
  readonly agentTeamHome: string;
  readonly claudeConfig: DispatchProviderConfig["claude"];
  readonly jobs: Pick<FileJobRepository, "update">;
  /** Injectable for tests; production defaults to a real `GhTransport`. */
  readonly githubTransport?: GhJsonTransport & Pick<GhTransport, "inspectAuthentication">;
}

export type BuildCiRecoveryPipelineResult =
  | Readonly<{ state: "ready"; value: CiRecoveryPipeline }>
  | Readonly<{ state: "blocked"; reason: CiRecoveryCompositionBlockedReason }>;

export async function buildCiRecoveryPipeline(
  options: BuildCiRecoveryPipelineOptions,
): Promise<BuildCiRecoveryPipelineResult> {
  const githubTransport = options.githubTransport ?? new GhTransport();
  const authentication = await githubTransport.inspectAuthentication();
  if (!authentication.ok) {
    return Object.freeze({ state: "blocked", reason: "github_authentication_unavailable" });
  }

  const git = new LocalGitAdapter();
  const checkpointDirectory = join(options.agentTeamHome, "state", "checkpoints");

  const pipeline = new CiRecoveryPipeline({
    git,
    preflight: new GitPreflight(git),
    provider: buildClaudeRunner(options.claudeConfig),
    sourceControl: new GitHubAdapter(githubTransport),
    jobs: new FileJobUpdateAdapter(options.jobs),
    checkpoint: new CiRecoveryCheckpointAdapter({
      store: new LocalYamlCheckpointStore(checkpointDirectory),
    }),
    toolDecisions: new FailClosedToolDecisionAdapter(),
  });

  return Object.freeze({ state: "ready", value: pipeline });
}
