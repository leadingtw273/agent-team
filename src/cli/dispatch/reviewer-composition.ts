/**
 * C015c item 3 / E102-2: production composition root for `ReviewerPipeline`
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
 * E102-2 closes the gap C015c's original header disclosed and this file's own history confirms:
 * `codeReviewer`/`visualReviewer` used to both point at the very same `ClaudeRunner` instance,
 * because at the time there was no second CLI account/model config in scope to point a second
 * instance at. There now is: `GeminiRunner` (src/adapters/providers/gemini/runner.ts, S003) is the
 * real visual-review provider -- `supportsVisualInput: true`, and its `start()` refuses (
 * `permission_denied`) any role other than `"visual_reviewer"`, so it structurally cannot serve
 * the code-reviewer role even by mistake. `codeReviewer` stays wired to `ClaudeRunner` (Claude has
 * no visual capability and was never a candidate for the visual role); `visualReviewer` is wired
 * to a `GeminiRunner` built from `options.geminiConfig` -- but **only when that config is
 * present**. When it is absent, `visualReviewer` is left `undefined`, never silently defaulted
 * back to the `ClaudeRunner` instance: `ReviewerPipelinePorts.visualReviewer` is already optional
 * (reviewer-model.ts), and `ReviewerPipeline.run()` already fails closed
 * (`stage:"request"`/`invariant_violation`) the moment a job's `reviewRequirement` needs
 * `visual_reviewer` and finds that port missing (reviewer.ts, untouched by this ticket) --
 * `code_review`-only jobs never consult `visualReviewer` at all (`requiredReviewerRoles`,
 * reviewer-policy.ts), so they are unaffected by whether `gemini` config exists. This composition
 * therefore never needs its own "blocked" state for a missing `gemini` key: the fail-closed
 * behaviour is enforced once, per-request, by the engine that already owns per-role role
 * dispatch -- duplicating it here would only risk the two disagreeing.
 */
import { join } from "node:path";

import { GhTransport, GitHubAdapter, type GhJsonTransport } from "../../adapters/github/index.js";
import { LocalGitAdapter } from "../../adapters/git/index.js";
import { LocalYamlCheckpointStore } from "../../adapters/checkpoint/index.js";
import { LocalReviewerEvidenceIntegrity } from "../../adapters/evidence/index.js";
import { ReviewerPipeline } from "../../application/pipelines/index.js";
import type { FileJobRepository } from "../../infrastructure/jobs/index.js";
import { buildClaudeRunner } from "./claude-factory.js";
import { buildGeminiRunner } from "./gemini-factory.js";
import { FileJobUpdateAdapter } from "./pipeline-job-adapter.js";
import { ReviewerCheckpointAdapter } from "./reviewer-checkpoint.js";
import { FailClosedToolDecisionAdapter } from "./tool-decision.js";
import type { DispatchProviderConfig } from "./provider-config-store.js";

export type ReviewerCompositionBlockedReason = "github_authentication_unavailable";

export interface BuildReviewerPipelineOptions {
  readonly agentTeamHome: string;
  readonly claudeConfig: DispatchProviderConfig["claude"];
  /** Optional -- absent means this host has no real visual-review provider configured.
   * `visualReviewer` is then left unwired (`undefined`), never substituted with the
   * `ClaudeRunner` built from `claudeConfig`; see this file's own header for why that is the
   * engine's fail-closed job, not this composition's. */
  readonly geminiConfig?: DispatchProviderConfig["gemini"];
  readonly jobs: Pick<FileJobRepository, "update">;
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
  const codeReviewer = buildClaudeRunner(options.claudeConfig);
  const visualReviewer =
    options.geminiConfig === undefined ? undefined : buildGeminiRunner(options.geminiConfig);

  const pipeline = new ReviewerPipeline({
    git: new LocalGitAdapter(),
    sourceControl: new GitHubAdapter(githubTransport),
    codeReviewer,
    ...(visualReviewer === undefined ? {} : { visualReviewer }),
    toolDecisions: new FailClosedToolDecisionAdapter(),
    evidenceIntegrity: new LocalReviewerEvidenceIntegrity(),
    jobs: new FileJobUpdateAdapter(options.jobs),
    checkpoint: new ReviewerCheckpointAdapter({
      store: new LocalYamlCheckpointStore(checkpointDirectory),
    }),
  });

  return Object.freeze({ state: "ready", value: pipeline });
}
