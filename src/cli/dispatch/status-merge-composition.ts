/**
 * C015c item 4: production composition root for `ReviewStatusCoordinator` and `AutoMergeGate`
 * (src/application/pipelines/merge-gate.ts). `ReviewStatusPorts.sourceControl` needs no adapter --
 * `GitHubAdapter` already satisfies `Pick<SourceControlPort, "getChangeRequest" |
 * "getCommitChecks" | "getCommitStatuses" | "setCommitStatus" | "appendChangeRequestComment">`
 * directly. `MergeGatePorts` needs that same slice *plus* `enableAutoMerge` and `git.
 * getEffectiveTreeDiff` (also satisfied directly by `LocalGitAdapter`) -- but `enableAutoMerge`
 * itself needs the O009d squash-merge fallback (see `buildMergeGateSourceControl` below), so it is
 * not a bare pass-through of `GitHubAdapter.enableAutoMerge`.
 */
import {
  GhTransport,
  GitHubAdapter,
  isSafeToSquashMergeDirectly,
  type GhJsonTransport,
} from "../../adapters/github/index.js";
import { LocalGitAdapter } from "../../adapters/git/index.js";
import {
  AutoMergeGate,
  ReviewStatusCoordinator,
  type MergeGatePorts,
} from "../../application/pipelines/index.js";
import { ok, type Result, type DomainError } from "../../domain/foundation/index.js";
import type { ChangeRequestRef, ChangeRequestSnapshot } from "../../application/ports/index.js";

export type StatusMergeCompositionBlockedReason = "github_authentication_unavailable";

export interface BuildStatusMergePipelinesOptions {
  /** Injectable for tests; production defaults to a real `GhTransport`. */
  readonly githubTransport?: GhJsonTransport & Pick<GhTransport, "inspectAuthentication">;
}

export interface StatusMergePipelines {
  readonly reviewStatus: ReviewStatusCoordinator;
  readonly autoMergeGate: AutoMergeGate;
}

export type BuildStatusMergePipelinesResult =
  | Readonly<{ state: "ready"; value: StatusMergePipelines }>
  | Readonly<{ state: "blocked"; reason: StatusMergeCompositionBlockedReason }>;

/**
 * O009d: `enableAutoMerge` (GitHub GraphQL `enablePullRequestAutoMerge`) structurally fails on real
 * GitHub with "Pull request is in clean status" once a PR is already fully mergeable -- and
 * `AutoMergeGate.enable()` is only ever called after CI and review are both green, so this path is
 * always hit on real GitHub, never an occasional edge case. This mirrors
 * `createGitHubSquashMergePort`'s exact fallback (src/adapters/registration/setup-composition.ts):
 * try `enableAutoMerge` first; on failure, re-read the change request; only if that re-read state
 * is unambiguously safe attempt a direct `squashMergeChangeRequest`; on any other outcome, return
 * the *original* `enableAutoMerge` error untouched -- this fallback never invents a new failure
 * reason of its own. The outer wrapper is built fresh here (rather than reused) because it targets
 * `SourceControlPort.enableAutoMerge`'s own return shape (`ChangeRequestSnapshot`), not
 * `RegistrationSetupSquashMergePort`'s custom state union -- but the actual "is this safe" decision
 * is the one piece that must never be allowed to drift between the two implementations, so it is
 * imported from `isSafeToSquashMergeDirectly` (src/adapters/github/squash-merge-fallback.ts)
 * rather than re-expressed here. See tests/unit/squash-merge-fallback-parity.test.ts for the
 * cross-implementation behavioral-parity test the acceptance review asked for.
 */
export function buildMergeGateSourceControl(
  github: GitHubAdapter,
): MergeGatePorts["sourceControl"] {
  return Object.freeze({
    getChangeRequest: github.getChangeRequest.bind(github),
    getCommitChecks: github.getCommitChecks.bind(github),
    getCommitStatuses: github.getCommitStatuses.bind(github),
    setCommitStatus: github.setCommitStatus.bind(github),
    appendChangeRequestComment: github.appendChangeRequestComment.bind(github),
    enableAutoMerge: async (
      reference: ChangeRequestRef,
      expectedHeadSha: string,
      options: Parameters<MergeGatePorts["sourceControl"]["enableAutoMerge"]>[2],
    ): Promise<Result<ChangeRequestSnapshot, DomainError>> => {
      const enabled = await github.enableAutoMerge(reference, expectedHeadSha, options);
      if (enabled.ok) return enabled;

      const current = await github.getChangeRequest(reference, options);
      if (!isSafeToSquashMergeDirectly(current, expectedHeadSha)) {
        return enabled;
      }
      const merged = await github.squashMergeChangeRequest(reference, expectedHeadSha, options);
      return merged.ok ? ok(merged.value) : enabled;
    },
  });
}

export async function buildStatusMergePipelines(
  options: BuildStatusMergePipelinesOptions,
): Promise<BuildStatusMergePipelinesResult> {
  const githubTransport = options.githubTransport ?? new GhTransport();
  const authentication = await githubTransport.inspectAuthentication();
  if (!authentication.ok) {
    return Object.freeze({ state: "blocked", reason: "github_authentication_unavailable" });
  }

  const github = new GitHubAdapter(githubTransport);
  const reviewStatus = new ReviewStatusCoordinator({
    sourceControl: {
      getChangeRequest: github.getChangeRequest.bind(github),
      getCommitChecks: github.getCommitChecks.bind(github),
      getCommitStatuses: github.getCommitStatuses.bind(github),
      setCommitStatus: github.setCommitStatus.bind(github),
      appendChangeRequestComment: github.appendChangeRequestComment.bind(github),
    },
  });
  const autoMergeGate = new AutoMergeGate({
    git: new LocalGitAdapter(),
    sourceControl: buildMergeGateSourceControl(github),
  });

  return Object.freeze({ state: "ready", value: Object.freeze({ reviewStatus, autoMergeGate }) });
}
