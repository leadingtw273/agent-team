/**
 * C015b item 4b: production composition root for `ImplementerPipeline`
 * (src/application/pipelines/implementer.ts) -- the one place that wires all six
 * `ImplementerPipelinePorts` together for a genuine (non-dry-run) `agent-team run`. Mirrors the
 * fail-closed-prerequisite-chain convention `probe-composition.ts`/`setup-composition.ts` already
 * established (GitHub auth verified before anything else is constructed).
 *
 * Two ports need no adapter at all, confirmed by direct structural comparison before writing this
 * file (not assumed): `GitPreflight` (src/adapters/git/preflight.ts) already *is* a drop-in
 * `ImplementerPreflightPort` -- its request/response shapes are field-for-field identical, the
 * same technique `tests/integration/implementer-pipeline.test.ts` already proves by using it
 * unmodified. `LocalGitAdapter` already satisfies the pipeline's `Pick<GitPort,...>` slice
 * directly. The other two ports (`ScopeOverrunCheckpointPort`, `ProviderToolDecisionPort`) do need
 * real adapters -- see scope-checkpoint.ts/tool-decision.ts for why and what judgment calls they
 * make.
 */
import { join } from "node:path";

import { GhTransport, GitHubAdapter, type GhJsonTransport } from "../../adapters/github/index.js";
import { GitPreflight, LocalGitAdapter } from "../../adapters/git/index.js";
import { LocalYamlCheckpointStore } from "../../adapters/checkpoint/index.js";
import { ImplementerPipeline } from "../../application/pipelines/index.js";
import { buildClaudeRunner } from "./claude-factory.js";
import { ScopeOverrunCheckpointAdapter } from "./scope-checkpoint.js";
import { FailClosedToolDecisionAdapter } from "./tool-decision.js";
import type { DispatchProviderConfig } from "./provider-config-store.js";

export type ImplementerCompositionBlockedReason = "github_authentication_unavailable";

export interface BuildImplementerPipelineOptions {
  readonly agentTeamHome: string;
  readonly claudeConfig: DispatchProviderConfig["claude"];
  /** Injectable for tests (same convention as `probe-composition.ts`'s `githubTransport`);
   * production defaults to a real `GhTransport`. */
  readonly githubTransport?: GhJsonTransport & Pick<GhTransport, "inspectAuthentication">;
}

export type BuildImplementerPipelineResult =
  | Readonly<{ state: "ready"; value: ImplementerPipeline }>
  | Readonly<{ state: "blocked"; reason: ImplementerCompositionBlockedReason }>;

export async function buildImplementerPipeline(
  options: BuildImplementerPipelineOptions,
): Promise<BuildImplementerPipelineResult> {
  const githubTransport = options.githubTransport ?? new GhTransport();
  const authentication = await githubTransport.inspectAuthentication();
  if (!authentication.ok) {
    return Object.freeze({ state: "blocked", reason: "github_authentication_unavailable" });
  }

  const git = new LocalGitAdapter();
  const checkpointDirectory = join(options.agentTeamHome, "state", "checkpoints");

  const pipeline = new ImplementerPipeline({
    git,
    preflight: new GitPreflight(git),
    provider: buildClaudeRunner(options.claudeConfig),
    sourceControl: new GitHubAdapter(githubTransport),
    scopeCheckpoint: new ScopeOverrunCheckpointAdapter({
      store: new LocalYamlCheckpointStore(checkpointDirectory),
    }),
    toolDecisions: new FailClosedToolDecisionAdapter(),
  });

  return Object.freeze({ state: "ready", value: pipeline });
}
