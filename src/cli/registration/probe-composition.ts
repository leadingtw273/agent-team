import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  FileRegistrationSetupActivationRegistry,
  FileRegistrationSetupFinalApprovalAuthority,
  FileRegistrationSetupSessionStore,
  GitHubRegistrationMergedConfigReadBackAdapter,
  RegistrationProbeBranchCleanupAdapter,
  RegistrationProbeFileAdapter,
  RegistrationProbeGitAdapter,
  RegistrationProbeGitHubCapabilityAdapter,
  RegistrationProbeLinearAdapter,
  RegistrationProbeProviderEventAdapter,
  RegistrationProbeWebhookAdapter,
  FileRegistrationProbeJournalStore,
} from "../../adapters/registration/index.js";
import { GitHubAdapter, GhTransport, type GhJsonTransport } from "../../adapters/github/index.js";
import {
  LinearGraphqlTransport,
  LinearMutationClient,
  LinearReadModel,
} from "../../adapters/linear/index.js";
import { createClock, type Clock } from "../../domain/foundation/index.js";
import { DurableInbox } from "../../infrastructure/events/index.js";
import {
  createRegistrationProbeCoordinator,
  type RegistrationProbeCoordinatorUseCase,
  type RegistrationProbeStartCommand,
} from "../../application/registration/index.js";
import type { WebhookRuntimeTransport } from "../probe/index.js";
import {
  buildRegistrationProbeAuthority,
  deterministicRegistrationProbeRunId,
  fixedRegistrationRevision,
} from "./authority.js";
import { defaultRegistrationDraftPath, loadHostRegistrationSetupDraft } from "./draft-store.js";
import {
  defaultRegistrationProbeConfigPath,
  loadHostRegistrationProbeConfig,
} from "./probe-config-store.js";
import { readLinearApiKey, readSecretFile } from "./secrets.js";

export type RegistrationProbeCompositionBlockedReason =
  | "draft_unavailable"
  | "probe_config_unavailable"
  | "linear_api_key_missing"
  | "github_authentication_unavailable"
  | "webhook_secret_unavailable"
  | "activation_not_found";

export interface RegistrationProbeCompositionReady {
  readonly coordinator: RegistrationProbeCoordinatorUseCase;
  readonly command: RegistrationProbeStartCommand;
  readonly journal: Pick<FileRegistrationProbeJournalStore, "listActiveForProject" | "load">;
}

export type BuildRegistrationProbeCompositionResult =
  | Readonly<{ state: "ready"; value: RegistrationProbeCompositionReady }>
  | Readonly<{ state: "blocked"; reason: RegistrationProbeCompositionBlockedReason }>;

type ProbeGithubTransport = GhJsonTransport &
  Pick<GhTransport, "inspectAuthentication" | "inspectRepositoryCapabilities" | "requestVoid">;

export interface BuildRegistrationProbeCompositionOptions {
  readonly agentTeamHome: string;
  readonly projectId: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly githubTransport?: ProbeGithubTransport;
  readonly linearFetch?: typeof fetch;
  readonly webhookTransport?: WebhookRuntimeTransport;
  readonly clock?: Clock;
  readonly createDeliveryId?: () => string;
  readonly ciPoll?: Parameters<typeof createRegistrationProbeCoordinator>[0]["ciPoll"];
  readonly statusPoll?: Parameters<typeof createRegistrationProbeCoordinator>[0]["statusPoll"];
  readonly providerEventPoll?: Parameters<
    typeof createRegistrationProbeCoordinator
  >[0]["providerEventPoll"];
}

/**
 * Production composition root for `registration probe *`. Every port implementation below is one
 * of the already-existing, already-tested O006 production adapters (proactive-probe-*.ts) --
 * this only assembles them, in the same fail-closed short-circuit order as
 * buildRegistrationSetupComposition: draft -> probe config -> LINEAR_API_KEY -> gh auth -> the
 * two webhook secret files -> the local activation registry (real, already-existing production
 * read path -- src/adapters/registration/setup-activation.ts), which supplies the
 * `setupSessionId` this CLI itself never invents.
 */
export async function buildRegistrationProbeComposition(
  options: BuildRegistrationProbeCompositionOptions,
): Promise<BuildRegistrationProbeCompositionResult> {
  const agentTeamHome = options.agentTeamHome;
  const draftPath = defaultRegistrationDraftPath(agentTeamHome, options.projectId);
  const draft = await loadHostRegistrationSetupDraft(draftPath, options.projectId);
  if (!draft.ok) {
    return Object.freeze({ state: "blocked", reason: "draft_unavailable" });
  }

  const probeConfigPath = defaultRegistrationProbeConfigPath(agentTeamHome, options.projectId);
  const probeConfig = await loadHostRegistrationProbeConfig(probeConfigPath);
  if (!probeConfig.ok) {
    return Object.freeze({ state: "blocked", reason: "probe_config_unavailable" });
  }

  const linearApiKey = readLinearApiKey(options.environment);
  if (!linearApiKey.ok) {
    return Object.freeze({ state: "blocked", reason: "linear_api_key_missing" });
  }

  const githubTransport = options.githubTransport ?? new GhTransport();
  const authentication = await githubTransport.inspectAuthentication();
  if (!authentication.ok) {
    return Object.freeze({ state: "blocked", reason: "github_authentication_unavailable" });
  }

  const githubSecret = await readSecretFile(
    join(agentTeamHome, "secrets", "github-webhook-secret"),
  );
  const linearSecret = await readSecretFile(
    join(agentTeamHome, "secrets", "linear-webhook-secret"),
  );
  if (!githubSecret.ok || !linearSecret.ok) {
    return Object.freeze({ state: "blocked", reason: "webhook_secret_unavailable" });
  }

  const stateRoot = join(agentTeamHome, "state");
  const sessionStore = new FileRegistrationSetupSessionStore(stateRoot);
  const activationRegistry = new FileRegistrationSetupActivationRegistry(
    stateRoot,
    undefined,
    sessionStore,
    new FileRegistrationSetupFinalApprovalAuthority(stateRoot),
  );
  // Two distinct, already-existing O005 read paths, both over the same stateRoot: the registry
  // resolves --project -> setupSessionId (project-keyed index); the session store's own
  // readActivation (setupSessionId-keyed) is the exact RegistrationSetupSessionPort surface the
  // O006 coordinator's own preflight re-reads and re-verifies independently -- see
  // RegistrationProbePorts.activation in proactive-probe.ts.
  const activation = await activationRegistry.read(draft.value.project.id);
  if (!activation.ok || activation.value === undefined) {
    return Object.freeze({ state: "blocked", reason: "activation_not_found" });
  }

  const linearTransport = new LinearGraphqlTransport({
    apiKey: linearApiKey.value,
    ...(options.linearFetch === undefined ? {} : { fetch: options.linearFetch }),
  });
  const linearReadModel = new LinearReadModel(linearTransport);
  const linearMutationClient = new LinearMutationClient(linearTransport, linearReadModel);
  const clock = options.clock ?? createClock();
  const journalDirectory = join(agentTeamHome, "state", "registration-probe", "journal");
  const allowedWorktreeRoot = join(agentTeamHome, "state", "registration-probe", "worktrees");
  const journal = new FileRegistrationProbeJournalStore(journalDirectory);
  const inbox = new DurableInbox(join(agentTeamHome, "state", "inbox"));

  const ports = {
    activation: { readActivation: sessionStore.readActivation.bind(sessionStore) },
    mergedConfig: new GitHubRegistrationMergedConfigReadBackAdapter(githubTransport),
    linear: new RegistrationProbeLinearAdapter(
      linearReadModel,
      linearMutationClient,
      linearTransport,
    ),
    githubCapability: new RegistrationProbeGitHubCapabilityAdapter(githubTransport),
    sourceControl: new GitHubAdapter(githubTransport),
    git: new RegistrationProbeGitAdapter(),
    files: new RegistrationProbeFileAdapter(),
    webhook: new RegistrationProbeWebhookAdapter({
      ...(options.webhookTransport === undefined ? {} : { transport: options.webhookTransport }),
      inbox,
      clock,
      createDeliveryId: options.createDeliveryId ?? (() => randomUUID()),
    }),
    providerEvents: new RegistrationProbeProviderEventAdapter(inbox),
    branchCleanup: new RegistrationProbeBranchCleanupAdapter(githubTransport),
    journal,
  };

  const runId = deterministicRegistrationProbeRunId(
    draft.value.project.id,
    fixedRegistrationRevision,
  );
  const command: RegistrationProbeStartCommand = Object.freeze({
    project: draft.value.project,
    setupSessionId: activation.value.setupSessionId,
    registrationRevision: fixedRegistrationRevision,
    runId,
    worktreePath: join(allowedWorktreeRoot, runId),
    gitRemote: probeConfig.value.gitRemote,
    linearWorkflowStateId: probeConfig.value.linearWorkflowStateId,
    authority: buildRegistrationProbeAuthority(
      draft.value.project.id,
      activation.value.setupSessionId,
      fixedRegistrationRevision,
    ),
    webhookBaseUrls: probeConfig.value.webhookBaseUrls,
    webhookSecrets: Object.freeze({
      github: githubSecret.value,
      linear: linearSecret.value,
    }),
  });

  const coordinator = createRegistrationProbeCoordinator({
    ports,
    allowedWorktreeRoot,
    ...(options.ciPoll === undefined ? {} : { ciPoll: options.ciPoll }),
    ...(options.statusPoll === undefined ? {} : { statusPoll: options.statusPoll }),
    ...(options.providerEventPoll === undefined
      ? {}
      : { providerEventPoll: options.providerEventPoll }),
  });

  return Object.freeze({ state: "ready", value: Object.freeze({ coordinator, command, journal }) });
}
