import { isAbsolute } from "node:path";

import {
  createRegistrationSetupApplication,
  createUnwiredRegistrationSetupController,
  type RegistrationSetupControllerUseCase,
  type RegistrationSetupDraft,
  type RegistrationSetupDraftSourcePort,
  type RegistrationSetupConversationApprovalBridgePort,
  type RegistrationSetupConversationApprovalFacade,
} from "../../application/registration/index.js";
import type { Clock } from "../../domain/foundation/index.js";
import { GitPreflight, LocalGitAdapter } from "../git/index.js";
import { GitHubAdapter, type GhJsonTransport } from "../github/adapter.js";
import {
  FileLocalUiPreviewConfirmationAuthority,
  FileRegistrationSetupExecutionStore,
  FileRegistrationSetupFinalApprovalAuthority,
  FileRegistrationSetupJournalStore,
  FileRegistrationSetupSessionStore,
  LocalRegistrationSetupFileAdapter,
} from "./setup-durable.js";
import { HostRegistrationSetupDraftSource } from "./setup-draft-source.js";
import {
  RegistrationSetupAuditAdapter,
  type LinearAuditCommentWriter,
  type PullRequestAuditCommentWriter,
} from "./setup-audit.js";
import { SourceControlRegistrationSetupGateEvidence } from "./setup-evidence.js";
import { FileRegistrationSetupActivationRegistry } from "./setup-activation.js";
import { GitHubRegistrationMergedConfigReadBackAdapter } from "./merged-config.js";
import { domainError, err, ok } from "../../domain/foundation/index.js";

export interface CreateProductionRegistrationSetupCompositionOptions {
  readonly stateRoot: string;
  /** Direct production-host draft; snapshotted behind HostRegistrationSetupDraftSource. */
  readonly draft?: RegistrationSetupDraft;
  /** Dynamic production-host source. Mutually exclusive with `draft`. */
  readonly draftSource?: RegistrationSetupDraftSourcePort;
  /** Explicit so tests and hosts cannot silently fall through to live `gh`. */
  readonly githubTransport?: GhJsonTransport;
  /** Explicit narrow audit transports; there is no live/default fallback. */
  readonly linearAuditWriter?: LinearAuditCommentWriter;
  readonly pullRequestAuditWriter?: PullRequestAuditCommentWriter;
  /** Host-owned verifier/bridge; never exposed through the UI request parser. */
  readonly conversationApprovalBridge?: RegistrationSetupConversationApprovalBridgePort;
  readonly localGit?: LocalGitAdapter;
  readonly clock?: Clock;
}

export interface ProductionRegistrationSetupComposition {
  readonly controller: RegistrationSetupControllerUseCase;
  readonly conversationApproval?: RegistrationSetupConversationApprovalFacade;
  readonly wiring: Readonly<{
    state: "ready" | "configuration_incomplete";
    durableState: "w1_file_stores" | "unwired";
    mergedConfigReadBack: "w2_github_authoritative" | "unwired";
    merge: "w3b2_controller_squash" | "w3b_unwired";
    audit: "w3b1_receipts" | "unwired";
    conversationApproval: "w3b1_host_capability" | "unwired";
    activation: "w3b2_project_index" | "w3b_unwired";
  }>;
}

const incompleteWiring = Object.freeze({
  state: "configuration_incomplete" as const,
  durableState: "unwired" as const,
  mergedConfigReadBack: "unwired" as const,
  merge: "w3b_unwired" as const,
  audit: "unwired" as const,
  conversationApproval: "unwired" as const,
  activation: "w3b_unwired" as const,
});

/**
 * O009d: `enableAutoMerge` (GitHub GraphQL `enablePullRequestAutoMerge`) structurally fails on
 * real GitHub with "Pull request is in clean status" (UNPROCESSABLE) once the PR is already
 * fully mergeable -- and the O005 setup flow only ever reaches this call after CI and review are
 * both green, so this path is *always* hit on real GitHub, never just an occasional edge case
 * (confirmed by direct repro against a real repository with `allow_auto_merge` already enabled).
 * `enableAutoMerge`'s failure is opaque here (the shared `GhTransport` masks HTTP-error detail
 * into a generic domain error code), so this fallback does not try to distinguish "clean status"
 * from any other failure -- it re-reads current state itself and only proceeds to a direct
 * squash merge if that state is unambiguously safe to merge (open, non-draft, mergeable, exact
 * expected head). If either `enableAutoMerge` or the direct-merge fallback path itself is not
 * attempted (state unsafe) or fails, the *original* `enableAutoMerge` error is returned -- this
 * fallback never invents a new failure reason of its own.
 *
 * Exported (rather than an inline closure) specifically so this decision logic -- distinct from,
 * and layered on top of, `GitHubAdapter.enableAutoMerge`/`squashMergeChangeRequest`'s own
 * individually-contract-tested correctness -- can be unit tested directly against a scripted
 * `GhJsonTransport`, without needing to drive a real git repository or the full O005 session
 * state machine just to reach this one branch.
 */
export function createGitHubSquashMergePort(
  github: GitHubAdapter,
): import("../../application/registration/index.js").RegistrationSetupSquashMergePort {
  return Object.freeze({
    enable: async (
      command: Parameters<
        import("../../application/registration/index.js").RegistrationSetupSquashMergePort["enable"]
      >[0],
      mutation: Parameters<
        import("../../application/registration/index.js").RegistrationSetupSquashMergePort["enable"]
      >[1],
    ) => {
      const rawCommand = command as unknown as Readonly<Record<string, unknown>>;
      if (rawCommand["mergeMethod"] !== "SQUASH") {
        return err(domainError("invariant_violation"));
      }
      const reference = { project: command.project, changeRequestId: command.changeRequestId };
      const current = await github.getChangeRequest(reference, mutation);
      if (!current.ok) return current;
      if (current.value.headSha.toLowerCase() !== command.expectedHeadSha.toLowerCase()) {
        return err(domainError("conflict"));
      }
      if (current.value.state === "merged") {
        return ok({ state: "merged" as const, snapshot: current.value });
      }
      if (current.value.state === "open" && current.value.autoMergeEnabled) {
        return ok({ state: "auto_merge_enabled" as const, snapshot: current.value });
      }
      const enabled = await github.enableAutoMerge(reference, command.expectedHeadSha, mutation);
      if (enabled.ok) {
        return ok({
          state:
            enabled.value.state === "merged"
              ? ("merged" as const)
              : ("auto_merge_enabled" as const),
          snapshot: enabled.value,
        });
      }
      const fallbackCurrent = await github.getChangeRequest(reference, mutation);
      if (
        !fallbackCurrent.ok ||
        fallbackCurrent.value.state !== "open" ||
        fallbackCurrent.value.draft ||
        fallbackCurrent.value.mergeability !== "mergeable" ||
        fallbackCurrent.value.headSha.toLowerCase() !== command.expectedHeadSha.toLowerCase()
      ) {
        return enabled;
      }
      const merged = await github.squashMergeChangeRequest(
        reference,
        command.expectedHeadSha,
        mutation,
      );
      return merged.ok ? ok({ state: "merged" as const, snapshot: merged.value }) : enabled;
    },
  });
}

/**
 * Explicit W3A production assembly. The returned controller has no merge method;
 * the full coordinator and SourceControl mutation object remain closure-private.
 */
export function createProductionRegistrationSetupComposition(
  options: CreateProductionRegistrationSetupCompositionOptions,
): ProductionRegistrationSetupComposition {
  let draftSource = options.draftSource;
  if (draftSource === undefined && options.draft !== undefined) {
    draftSource = new HostRegistrationSetupDraftSource(options.draft);
  }
  if (
    !isAbsolute(options.stateRoot) ||
    draftSource === undefined ||
    (options.draft !== undefined && options.draftSource !== undefined) ||
    options.githubTransport === undefined ||
    options.linearAuditWriter === undefined ||
    options.pullRequestAuditWriter === undefined
  ) {
    return Object.freeze({
      controller: createUnwiredRegistrationSetupController(),
      wiring: incompleteWiring,
    });
  }

  const git = options.localGit ?? new LocalGitAdapter();
  const previewConfirmation = new FileLocalUiPreviewConfirmationAuthority(
    options.stateRoot,
    options.clock,
  );
  const journal = new FileRegistrationSetupJournalStore(options.stateRoot);
  const execution = new FileRegistrationSetupExecutionStore(options.stateRoot);
  const sessionStore = new FileRegistrationSetupSessionStore(options.stateRoot);
  const finalApproval = new FileRegistrationSetupFinalApprovalAuthority(
    options.stateRoot,
    options.clock,
  );
  const github = new GitHubAdapter(options.githubTransport);
  const sourceControl = Object.freeze({
    createDraftChangeRequest: github.createDraftChangeRequest.bind(github),
    getChangeRequest: github.getChangeRequest.bind(github),
    getCommitChecks: github.getCommitChecks.bind(github),
    getCommitStatuses: github.getCommitStatuses.bind(github),
    markChangeRequestReady: github.markChangeRequestReady.bind(github),
  });
  const gateEvidence = new SourceControlRegistrationSetupGateEvidence(
    Object.freeze({
      getCommitChecks: github.getCommitChecks.bind(github),
      getCommitStatuses: github.getCommitStatuses.bind(github),
    }),
  );
  const audit = new RegistrationSetupAuditAdapter(
    options.linearAuditWriter,
    options.pullRequestAuditWriter,
  );
  const squashMerge = createGitHubSquashMergePort(github);
  const mergedConfig = new GitHubRegistrationMergedConfigReadBackAdapter(options.githubTransport);
  const activationRegistry = new FileRegistrationSetupActivationRegistry(
    options.stateRoot,
    undefined,
    sessionStore,
    finalApproval,
  );
  const coordinatorPorts = {
    git,
    preflight: new GitPreflight(git),
    previewConfirmation,
    setupFiles: new LocalRegistrationSetupFileAdapter(),
    sourceControl,
    gateEvidence,
    audit,
    journal,
    execution,
    sessions: sessionStore,
    finalApproval,
    squashMerge,
    mergedConfig,
    activationRegistry,
  };
  const application = createRegistrationSetupApplication({
    coordinatorPorts,
    controllerPorts: {
      stateRoot: options.stateRoot,
      draftSource,
      git,
      sessions: sessionStore,
      previewConfirmation,
      finalApproval,
    },
    ...(options.conversationApprovalBridge === undefined
      ? {}
      : { conversationApprovalBridge: options.conversationApprovalBridge }),
  });

  return Object.freeze({
    controller: application.controller,
    ...(application.conversationApproval === undefined
      ? {}
      : { conversationApproval: application.conversationApproval }),
    wiring: Object.freeze({
      state: "ready" as const,
      durableState: "w1_file_stores" as const,
      mergedConfigReadBack: "w2_github_authoritative" as const,
      merge: "w3b2_controller_squash" as const,
      audit: "w3b1_receipts" as const,
      conversationApproval:
        options.conversationApprovalBridge === undefined
          ? ("unwired" as const)
          : ("w3b1_host_capability" as const),
      activation: "w3b2_project_index" as const,
    }),
  });
}
