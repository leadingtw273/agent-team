/**
 * C015c item 4: production composition root for `ReviewStatusCoordinator` and `AutoMergeGate`
 * (src/application/pipelines/merge-gate.ts). `ReviewStatusPorts.sourceControl` needs no adapter --
 * `GitHubAdapter` already satisfies `Pick<SourceControlPort, "getChangeRequest" |
 * "getCommitChecks" | "getCommitStatuses" | "setCommitStatus" | "appendChangeRequestComment">`
 * directly. `MergeGatePorts` needs that same slice *plus* `enableAutoMerge` and `git.
 * getEffectiveTreeDiff` (also satisfied directly by `LocalGitAdapter`) -- but `enableAutoMerge`
 * itself needs the O009d squash-merge fallback (see `buildMergeGateSourceControl` below), so it is
 * not a bare pass-through of `GitHubAdapter.enableAutoMerge`.
 *
 * E116cap: `MergeGatePorts` also needs `autoMergePause` (`AutoMergePauseQueryPort`,
 * application/ports/auto-merge-pause.ts) as of this ticket -- `buildAutoMergePauseQuery` below is
 * the thin read-only wrapper over the caller-supplied `FileAutoMergePauseStore` (the same store
 * instance `FileAutoMergePauseAdapter`, lifecycle-policy-adapter.ts, writes to), mirroring
 * `buildMergeGateSourceControl`'s own "adapt the concrete store/adapter to the exact port shape
 * this composition root needs" convention.
 */
import {
  GhTransport,
  GitHubAdapter,
  isSafeToSquashMergeDirectly,
  type GhJsonTransport,
  type GitHubMergeMutationObserver,
} from "../../adapters/github/index.js";
import { LocalGitAdapter } from "../../adapters/git/index.js";
import type { FileAutoMergePauseStore } from "../../adapters/dispatch/auto-merge-pause-store.js";
import {
  AutoMergeGate,
  ReviewStatusCoordinator,
  type MergeGateAutoMergeAttempt,
  type MergeGatePorts,
  type MergeMutationReceipt,
} from "../../application/pipelines/index.js";
import {
  createClock,
  domainError,
  err,
  ok,
  type Result,
  type DomainError,
  type Clock,
} from "../../domain/foundation/index.js";
import type {
  AutoMergePauseQueryPort,
  ChangeRequestRef,
  WorkManagementPort,
} from "../../application/ports/index.js";

export type StatusMergeCompositionBlockedReason = "github_authentication_unavailable";

export interface BuildStatusMergePipelinesOptions {
  readonly autoMergePauseStore: Pick<FileAutoMergePauseStore, "load">;
  readonly workManagement: Pick<WorkManagementPort, "getIssue">;
  readonly clock?: Clock;
  /** Injectable for tests; production defaults to a real `GhTransport`. */
  readonly githubTransport?: GhJsonTransport & Pick<GhTransport, "inspectAuthentication">;
}

/** E116cap: read-only `AutoMergePauseQueryPort` adapter over a `FileAutoMergePauseStore` -- see
 * this file's own header. A store read failure fails closed (`policy` stage,
 * `mergeFailure("policy", ...)` in merge-gate.ts) rather than defaulting to `paused: false`, which
 * would silently defeat the whole gate on exactly the failure mode it exists to be robust against.
 * `store` is `Pick<FileAutoMergePauseStore, "load">`, the same "Pick over a concrete class"
 * testability convention `FileAutoMergePauseAdapter` uses (lifecycle-policy-adapter.ts). */
export function buildAutoMergePauseQuery(
  store: Pick<FileAutoMergePauseStore, "load">,
): AutoMergePauseQueryPort {
  return Object.freeze({
    isPaused: async (
      request: Parameters<AutoMergePauseQueryPort["isPaused"]>[0],
      options: Parameters<AutoMergePauseQueryPort["isPaused"]>[1],
    ) => {
      const loaded = await store.load(request.project.id, options);
      if (!loaded.ok) return err(loaded.error);
      return ok(Object.freeze({ paused: loaded.value?.status.state === "paused" }));
    },
  });
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
 * is unambiguously safe attempt a direct `squashMergeChangeRequest`; on any other outcome, carry
 * the original `enableAutoMerge` error inside `mutation_failed` together with every transport-
 * boundary receipt -- the external behavior still fails closed without discarding audit. The
 * actual "is this safe" decision is the one piece that must never be allowed
 * to drift between the two implementations, so it is imported from `isSafeToSquashMergeDirectly`
 * (src/adapters/github/squash-merge-fallback.ts) rather than re-expressed here. See
 * tests/unit/squash-merge-fallback-parity.test.ts for the cross-implementation behavioral-parity
 * test the acceptance review asked for.
 *
 * C015t decision 1: this function is the *only* place that knows whether the fallback squash was
 * actually attempted and by whom -- so it is also the only place that can honestly distinguish
 * "this exact call performed the merge" (`outcome: "merged_directly"`) from "the change request was
 * already merged, by something else, by the time we looked" (`outcome: "merged_externally"`). That
 * distinction is *why* `MergeGatePorts.sourceControl.enableAutoMerge` no longer returns a bare
 * `ChangeRequestSnapshot` (see `MergeGateAutoMergeAttempt`'s own header, merge-gate-model.ts) --
 * `AutoMergeGate.enable()` itself never reverse-infers provenance from head-SHA equality; it only
 * ever forwards whatever this function decided.
 */
export function buildMergeGateSourceControl(
  github: GitHubAdapter,
  workManagement: Pick<WorkManagementPort, "getIssue">,
  clock: Clock = createClock(),
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
      externalIssueId: string,
      expectedWorkStatus?: "in_review",
    ): Promise<Result<MergeGateAutoMergeAttempt, DomainError>> => {
      const attempts: MergeMutationReceipt[] = [];
      const observer: GitHubMergeMutationObserver = {
        attempted: (kind, idempotencyKey) => {
          attempts.push({
            kind,
            idempotencyKey,
            attemptedAt: clock.now(),
            outcome: "outcome_unknown",
          });
        },
        settled: (kind, idempotencyKey, outcome) => {
          const index = attempts.findLastIndex(
            (attempt) => attempt.kind === kind && attempt.idempotencyKey === idempotencyKey,
          );
          if (index < 0) return;
          const current = attempts[index];
          if (current === undefined) return;
          attempts[index] = { ...current, outcome };
        },
      };
      const mutationHistory = (): readonly MergeMutationReceipt[] =>
        Object.freeze(attempts.map((attempt) => Object.freeze({ ...attempt })));
      const controllerMerged = (
        headSha: string,
      ): Result<MergeGateAutoMergeAttempt, DomainError> => {
        const mutations = mutationHistory();
        if (mutations.length === 0) return err(domainError("invariant_violation"));
        return ok({
          outcome: "merged_directly" as const,
          headSha,
          mutations: mutations as readonly [MergeMutationReceipt, ...MergeMutationReceipt[]],
        });
      };
      const mutationFailed = (
        stage: "authorization" | "auto_merge",
        error: DomainError,
      ): Result<MergeGateAutoMergeAttempt, DomainError> => {
        const mutations = mutationHistory();
        return ok({
          outcome: "mutation_failed" as const,
          stage,
          error,
          mutations,
        });
      };

      if (expectedWorkStatus !== undefined) {
        const authorization = await workManagement.getIssue(
          { project: reference.project, externalIssueId },
          options.signal === undefined ? {} : { signal: options.signal },
        );
        if (!authorization.ok) return mutationFailed("authorization", authorization.error);
        if (
          authorization.value.issue.projectId !== reference.project.id ||
          authorization.value.issue.externalId !== externalIssueId
        ) {
          return mutationFailed("authorization", domainError("conflict"));
        }
        if (authorization.value.workStatus === "canceled") {
          const current = await github.getChangeRequest(reference, options);
          return current.ok
            ? ok({
                outcome: "authorization_revoked" as const,
                changeRequest: current.value,
                mutations: mutationHistory(),
              })
            : mutationFailed("authorization", current.error);
        }
        if (authorization.value.workStatus !== expectedWorkStatus) {
          return mutationFailed("authorization", domainError("conflict"));
        }
      }

      const enabled = await github.enableAutoMerge(reference, expectedHeadSha, options, observer);
      if (enabled.ok) {
        // GitHub's own mutation can itself return an already-merged snapshot (idempotently
        // reporting reality rather than actually enabling anything) -- this call did not cause
        // that, so it is external, never "directly_merged".
        if (enabled.value.state === "merged") {
          return attempts.length === 0
            ? ok({ outcome: "merged_externally" as const, changeRequest: enabled.value })
            : controllerMerged(enabled.value.headSha);
        }
        return ok({
          outcome: "enabled" as const,
          changeRequest: enabled.value,
          mutations: mutationHistory(),
        });
      }

      const current = await github.getChangeRequest(reference, options);
      if (
        current.ok &&
        current.value.state === "merged" &&
        current.value.headSha.toLowerCase() === expectedHeadSha.toLowerCase()
      ) {
        // Someone/something else merged it between our first read and this fallback's own re-read
        // -- again, this call did not cause it.
        return attempts.length === 0
          ? ok({ outcome: "merged_externally" as const, changeRequest: current.value })
          : controllerMerged(current.value.headSha);
      }
      if (!isSafeToSquashMergeDirectly(current, expectedHeadSha)) {
        return mutationFailed("auto_merge", enabled.error);
      }
      // C035: the direct-squash fallback is a second, distinct GitHub mutation. Re-read Linear
      // again here instead of trusting AutoMergeGate's earlier authorization snapshot.
      const authorization = await workManagement.getIssue(
        { project: reference.project, externalIssueId },
        options.signal === undefined ? {} : { signal: options.signal },
      );
      if (!authorization.ok) return mutationFailed("authorization", authorization.error);
      if (
        authorization.value.issue.projectId !== reference.project.id ||
        authorization.value.issue.externalId !== externalIssueId
      ) {
        return mutationFailed("authorization", domainError("conflict"));
      }
      if (authorization.value.workStatus === "canceled") {
        return ok({
          outcome: "authorization_revoked" as const,
          changeRequest: current.value,
          mutations: mutationHistory(),
        });
      }
      if (authorization.value.workStatus === "completed") {
        return mutationFailed("authorization", domainError("conflict"));
      }
      if (
        expectedWorkStatus !== undefined &&
        authorization.value.workStatus !== expectedWorkStatus
      ) {
        return mutationFailed("authorization", domainError("conflict"));
      }
      const merged = await github.squashMergeChangeRequest(
        reference,
        expectedHeadSha,
        options,
        observer,
      );
      if (merged.ok) return controllerMerged(merged.value.headSha);
      const directReceipt = attempts.findLast((attempt) => attempt.kind === "direct_squash");
      return directReceipt?.outcome === "merged_directly"
        ? controllerMerged(expectedHeadSha)
        : mutationFailed("auto_merge", enabled.error);
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
    sourceControl: buildMergeGateSourceControl(
      github,
      options.workManagement,
      options.clock ?? createClock(),
    ),
    workManagement: options.workManagement,
    autoMergePause: buildAutoMergePauseQuery(options.autoMergePauseStore),
  });

  return Object.freeze({ state: "ready", value: Object.freeze({ reviewStatus, autoMergeGate }) });
}
