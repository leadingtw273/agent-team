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

import {
  GhTransport,
  GitHubAdapter,
  type GhJsonTransport,
  type GhTextTransport,
} from "../../adapters/github/index.js";
import { GitPreflight, LocalGitAdapter } from "../../adapters/git/index.js";
import { LocalYamlCheckpointStore } from "../../adapters/checkpoint/index.js";
import { CiLogExcerptDiagnosticsSidecar } from "../../adapters/dispatch/ci-log-excerpt-diagnostics-sidecar.js";
import { CiRecoveryPipeline } from "../../application/pipelines/index.js";
import type { FileJobRepository } from "../../infrastructure/jobs/index.js";
import { buildCodexRunner } from "./codex-factory.js";
import { CiRecoveryCheckpointAdapter } from "./ci-recovery-checkpoint.js";
import { FileJobUpdateAdapter } from "./pipeline-job-adapter.js";
import { FailClosedToolDecisionAdapter } from "./tool-decision.js";
import type { DispatchProviderConfig } from "./provider-config-store.js";

export type CiRecoveryCompositionBlockedReason = "github_authentication_unavailable";

export interface BuildCiRecoveryPipelineOptions {
  readonly agentTeamHome: string;
  readonly codexConfig: DispatchProviderConfig["codex"];
  readonly jobs: Pick<FileJobRepository, "update">;
  /**
   * Injectable for tests; production defaults to a real `GhTransport`.
   *
   * C017b (D1): deliberately requires `GhTextTransport` (`requestText`) as well as
   * `GhJsonTransport`, not just the latter -- before this ticket, a test double implementing only
   * `GhJsonTransport` type-checked here just fine, and `ciLog.getFailedCheckLogExcerpts` would
   * then silently, permanently degrade to `available: false, reason: "log_transport_unavailable"`
   * for every call, with no type error, no test failure, and no runtime signal pointing at why --
   * exactly the "recovery flies blind" gap C017 was supposed to close, reintroduced one layer up.
   * Requiring `GhTextTransport` here forces every caller (including every test fixture) to prove
   * it can actually serve a job log before `ciLog` is ever considered "wired".
   */
  readonly githubTransport?: GhJsonTransport &
    GhTextTransport &
    Pick<GhTransport, "inspectAuthentication">;
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
  // C017: one GitHubAdapter instance serves both `sourceControl` (the pre-existing
  // `getCommitChecks`) and `ciLog` (the new `getFailedCheckLogExcerpts`) -- both are read-only
  // GitHub Checks/Actions capabilities on the same repository, no reason to construct twice.
  const github = new GitHubAdapter(githubTransport);

  const pipeline = new CiRecoveryPipeline({
    git,
    preflight: new GitPreflight(git),
    provider: buildCodexRunner(options.codexConfig),
    sourceControl: github,
    ciLog: github,
    jobs: new FileJobUpdateAdapter(options.jobs),
    checkpoint: new CiRecoveryCheckpointAdapter({
      store: new LocalYamlCheckpointStore(checkpointDirectory),
    }),
    toolDecisions: new FailClosedToolDecisionAdapter(),
    // C017b (D2): best-effort, content-free diagnostic -- see that adapter's own header and
    // `CiRecoveryObservabilityPort`'s header (ci-recovery-model.ts) for the full rationale.
    observability: new CiLogExcerptDiagnosticsSidecar({ agentTeamHome: options.agentTeamHome }),
  });

  return Object.freeze({ state: "ready", value: pipeline });
}
