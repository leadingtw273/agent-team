/**
 * C015c item 3: production composition root for `ReviewerPipeline`
 * (src/application/pipelines/reviewer.ts), mirroring `implementer-composition.ts` (C015b) exactly:
 * the same fail-closed GitHub-authentication-first prerequisite chain, the same "confirm structural
 * fit before writing an adapter" discipline. Three ports need no adapter at all: `LocalGitAdapter`
 * already satisfies `Pick<GitPort, "inspectWorktree" | "inspectWorkingTree" |
 * "getEffectiveTreeDiff">` directly (it implements the full `GitPort`); `GitHubAdapter` already
 * satisfies `Pick<SourceControlPort, "getChangeRequest" | "getCommitChecks" |
 * "markChangeRequestReady">` directly (it implements the full `SourceControlPort`);
 * `LocalReviewerEvidenceIntegrity` (src/adapters/evidence/local.ts) already *is* a drop-in
 * `ReviewerEvidenceIntegrityPort`, zero-arg constructor.
 *
 * `codeReviewer`/`visualReviewer` both point at the same `ClaudeRunner` instance --
 * `ProviderRunRequest.role` (not which field the pipeline reads from) is what actually selects
 * the reviewer persona/tool allowlist at request time (`ClaudeRunner`'s own `toolsForRole`,
 * confirmed in C015b), so a single runner genuinely serves both roles; there is no second CLI
 * account or model config in this ticket's scope to point a second instance at.
 */
import { join } from "node:path";

import { GhTransport, GitHubAdapter, type GhJsonTransport } from "../../adapters/github/index.js";
import { LocalGitAdapter } from "../../adapters/git/index.js";
import { LocalYamlCheckpointStore } from "../../adapters/checkpoint/index.js";
import { LocalReviewerEvidenceIntegrity } from "../../adapters/evidence/index.js";
import { ReviewerPipeline } from "../../application/pipelines/index.js";
import type { FileJobRepository } from "../../infrastructure/jobs/index.js";
import { buildClaudeRunner } from "./claude-factory.js";
import { FileJobUpdateAdapter } from "./pipeline-job-adapter.js";
import { ReviewerCheckpointAdapter } from "./reviewer-checkpoint.js";
import { FailClosedToolDecisionAdapter } from "./tool-decision.js";
import type { DispatchProviderConfig } from "./provider-config-store.js";

export type ReviewerCompositionBlockedReason = "github_authentication_unavailable";

export interface BuildReviewerPipelineOptions {
  readonly agentTeamHome: string;
  readonly claudeConfig: DispatchProviderConfig["claude"];
  readonly jobs: FileJobRepository;
  /** Injectable for tests (same convention as `implementer-composition.ts`); production defaults
   * to a real `GhTransport`. */
  readonly githubTransport?: GhJsonTransport & Pick<GhTransport, "inspectAuthentication">;
}

export type BuildReviewerPipelineResult =
  | Readonly<{ state: "ready"; value: ReviewerPipeline }>
  | Readonly<{ state: "blocked"; reason: ReviewerCompositionBlockedReason }>;

export async function buildReviewerPipeline(
  options: BuildReviewerPipelineOptions,
): Promise<BuildReviewerPipelineResult> {
  const githubTransport = options.githubTransport ?? new GhTransport();
  const authentication = await githubTransport.inspectAuthentication();
  if (!authentication.ok) {
    return Object.freeze({ state: "blocked", reason: "github_authentication_unavailable" });
  }

  const checkpointDirectory = join(options.agentTeamHome, "state", "checkpoints");
  const runner = buildClaudeRunner(options.claudeConfig);

  const pipeline = new ReviewerPipeline({
    git: new LocalGitAdapter(),
    sourceControl: new GitHubAdapter(githubTransport),
    codeReviewer: runner,
    visualReviewer: runner,
    toolDecisions: new FailClosedToolDecisionAdapter(),
    evidenceIntegrity: new LocalReviewerEvidenceIntegrity(),
    jobs: new FileJobUpdateAdapter(options.jobs),
    checkpoint: new ReviewerCheckpointAdapter({
      store: new LocalYamlCheckpointStore(checkpointDirectory),
    }),
  });

  return Object.freeze({ state: "ready", value: pipeline });
}
