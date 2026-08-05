import { isAbsolute } from "node:path";

import {
  RegistrationSetupController,
  RegistrationSetupCoordinator,
  HostRegistrationSetupConversationApprovalFacade,
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
    merge: "w3b_unwired";
    audit: "w3b1_receipts" | "unwired";
    conversationApproval: "w3b1_host_capability" | "unwired";
    activation: "w3b_unwired";
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
    options.pullRequestAuditWriter === undefined ||
    options.conversationApprovalBridge === undefined
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
  const sessions = new FileRegistrationSetupSessionStore(options.stateRoot);
  const finalApproval = new FileRegistrationSetupFinalApprovalAuthority(
    options.stateRoot,
    options.clock,
  );
  const sourceControl = new GitHubAdapter(options.githubTransport);
  const gateEvidence = new SourceControlRegistrationSetupGateEvidence(sourceControl);
  const audit = new RegistrationSetupAuditAdapter(
    options.linearAuditWriter,
    options.pullRequestAuditWriter,
  );
  const coordinator = new RegistrationSetupCoordinator({
    git,
    preflight: new GitPreflight(git),
    previewConfirmation,
    setupFiles: new LocalRegistrationSetupFileAdapter(),
    sourceControl,
    gateEvidence,
    audit,
    journal,
    execution,
    sessions,
    finalApproval,
  });

  return Object.freeze({
    controller: new RegistrationSetupController({
      stateRoot: options.stateRoot,
      draftSource,
      git,
      coordinator,
      sessions,
      previewConfirmation,
      finalApproval,
    }),
    conversationApproval: new HostRegistrationSetupConversationApprovalFacade({
      coordinator,
      bridge: options.conversationApprovalBridge,
    }),
    wiring: Object.freeze({
      state: "ready" as const,
      durableState: "w1_file_stores" as const,
      mergedConfigReadBack: "unwired" as const,
      merge: "w3b_unwired" as const,
      audit: "w3b1_receipts" as const,
      conversationApproval: "w3b1_host_capability" as const,
      activation: "w3b_unwired" as const,
    }),
  });
}
