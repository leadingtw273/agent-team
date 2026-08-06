import { createHash } from "node:crypto";

import type { DomainError, Result } from "../../domain/foundation/index.js";
import { err, ok } from "../../domain/foundation/index.js";
import type { Project } from "../../domain/project/index.js";
import { trustedProjectConfigPath } from "../projects/index.js";
import type {
  MutationOptions,
  ReadOptions,
  RegistrationProbeBranchCleanupPort,
  RegistrationProbeFilePort,
  RegistrationProbeGitHubCapabilityPort,
  RegistrationProbeGitPort,
  RegistrationProbeLinearPort,
  RegistrationProbeLinearTarget,
  RegistrationProbeProviderEventPort,
  RegistrationProbeSourceControlPort,
  RegistrationWebhookProbePort,
} from "../ports/index.js";
import type {
  RegistrationSetupMergedConfigReadBackPort,
  RegistrationSetupSessionPort,
} from "./setup-model.js";
import {
  createRegistrationProbeRun,
  isTerminalCleanPhase,
  registrationProbeCleanupKinds,
  registrationProbeMaximumWebhookAckMs,
  registrationProbeRequiredCheckName,
  registrationProbeReviewStatusContext,
  registrationProbeAuthorityMatches,
  type RegistrationProbeActivationContext,
  type RegistrationProbeAuthority,
  type RegistrationProbeCleanup,
  type RegistrationProbeCleanupItem,
  type RegistrationProbeCleanupKind,
  type RegistrationProbeFailureReason,
  type RegistrationProbeJournalPort,
  type RegistrationProbeOutcome,
  type RegistrationProbePreflightReason,
  type RegistrationProbeProviderEventEvidence,
  type RegistrationProbeRun,
  type RegistrationProbeRunMutation,
  type RegistrationProbeStage,
} from "./proactive-probe-model.js";

export * from "./proactive-probe-model.js";

export interface RegistrationProbePorts {
  readonly activation: Pick<RegistrationSetupSessionPort, "readActivation">;
  readonly mergedConfig: RegistrationSetupMergedConfigReadBackPort;
  readonly linear: RegistrationProbeLinearPort;
  readonly githubCapability: RegistrationProbeGitHubCapabilityPort;
  readonly sourceControl: RegistrationProbeSourceControlPort;
  readonly git: RegistrationProbeGitPort;
  readonly files: RegistrationProbeFilePort;
  readonly webhook: RegistrationWebhookProbePort;
  readonly providerEvents: RegistrationProbeProviderEventPort;
  readonly branchCleanup: RegistrationProbeBranchCleanupPort;
  readonly journal: RegistrationProbeJournalPort;
}

export interface RegistrationProbePollOptions {
  readonly maxAttempts: number;
  readonly intervalMs: number;
  readonly wait: (ms: number) => Promise<void>;
}

const defaultPoll: RegistrationProbePollOptions = Object.freeze({
  maxAttempts: 1,
  intervalMs: 0,
  wait: () => Promise.resolve(),
});

export interface RegistrationProbeCoordinatorOptions {
  readonly ports: RegistrationProbePorts;
  readonly allowedWorktreeRoot: string;
  readonly ciPoll?: RegistrationProbePollOptions;
  readonly statusPoll?: RegistrationProbePollOptions;
  readonly providerEventPoll?: RegistrationProbePollOptions;
}

export interface RegistrationProbeStartCommand {
  readonly project: Project;
  readonly setupSessionId: string;
  readonly registrationRevision: number;
  readonly runId: string;
  readonly worktreePath: string;
  readonly gitRemote: string;
  readonly linearWorkflowStateId: string;
  readonly authority: RegistrationProbeAuthority;
  readonly webhookBaseUrls: Readonly<{ github: string; linear: string }>;
  readonly webhookSecrets: Readonly<{ github: Uint8Array; linear: Uint8Array }>;
  readonly signal?: AbortSignal;
}

export interface RegistrationProbeCoordinatorUseCase {
  start(command: RegistrationProbeStartCommand): Promise<RegistrationProbeOutcome>;
}

function readOptionsFrom(command: Readonly<{ signal?: AbortSignal }>): ReadOptions {
  return command.signal === undefined ? {} : { signal: command.signal };
}

function mutationOptionsFor(
  command: Readonly<{ signal?: AbortSignal }>,
  idempotencyKey: string,
): MutationOptions {
  return command.signal === undefined
    ? { idempotencyKey }
    : { idempotencyKey, signal: command.signal };
}

function allowedRuntimeBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const loopback = ["127.0.0.1", "::1", "[::1]", "localhost"].includes(url.hostname);
    return (
      (url.protocol === "https:" || (url.protocol === "http:" && loopback)) &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      (url.pathname === "/" || url.pathname === "")
    );
  } catch {
    return false;
  }
}

interface PreflightSuccess {
  readonly activation: RegistrationProbeActivationContext;
  readonly linearTarget: RegistrationProbeLinearTarget;
}

async function runPreflight(
  command: RegistrationProbeStartCommand,
  ports: RegistrationProbePorts,
): Promise<Result<PreflightSuccess, RegistrationProbePreflightReason>> {
  const readOptions = readOptionsFrom(command);

  if (
    !registrationProbeAuthorityMatches(
      command.authority,
      command.project.id,
      command.setupSessionId,
      command.registrationRevision,
    )
  ) {
    return err("authority_invalid");
  }

  const marker = await ports.activation.readActivation(command.setupSessionId, readOptions);
  if (!marker.ok || marker.value?.projectId !== command.project.id) {
    return err("activation_not_ready");
  }

  const mergedConfig = await ports.mergedConfig.read(
    {
      project: command.project,
      changeRequestId: marker.value.changeRequestId,
      expectedHeadSha: marker.value.setupHeadSha,
      defaultBranch: marker.value.defaultBranch,
      path: trustedProjectConfigPath,
    },
    readOptions,
  );
  if (
    !mergedConfig.ok ||
    mergedConfig.value.configDigest !== marker.value.configDigest ||
    mergedConfig.value.repository !== command.project.sourceControl.repository ||
    mergedConfig.value.repository !== marker.value.repository ||
    mergedConfig.value.defaultBranch !== marker.value.defaultBranch ||
    mergedConfig.value.changeRequestId !== marker.value.changeRequestId ||
    mergedConfig.value.authoritativeRevision !== marker.value.authoritativeRevision
  ) {
    return err("activation_not_ready");
  }

  const linearTarget: RegistrationProbeLinearTarget = Object.freeze({
    teamId: command.project.workManagement.containerId,
    projectId: command.project.workManagement.projectId,
    workflowStateId: command.linearWorkflowStateId,
  });
  const linearCapability = await ports.linear.readCapability(linearTarget, readOptions);
  if (
    !linearCapability.ok ||
    !linearCapability.value.readWrite ||
    !linearCapability.value.cancelable
  ) {
    return err("linear_capability_incomplete");
  }

  const githubTarget = Object.freeze({
    repository: command.project.sourceControl.repository,
    defaultBranch: command.project.defaultBranch,
  });
  const githubCapability = await ports.githubCapability.inspect(githubTarget, readOptions);
  if (
    !githubCapability.ok ||
    githubCapability.value.permission !== "admin" ||
    !githubCapability.value.requiredCheckConfigured ||
    !githubCapability.value.reviewStatusSupported
  ) {
    return err("github_capability_incomplete");
  }
  if (
    !githubCapability.value.pushCapable ||
    !githubCapability.value.draftPullRequestCapable ||
    !githubCapability.value.closeCapable
  ) {
    return err("git_identity_incomplete");
  }
  const repositoryIdentity = await ports.git.inspectRepository(
    { rootPath: command.project.localRepositoryPath },
    readOptions,
  );
  if (!repositoryIdentity.ok) return err("git_identity_incomplete");

  if (
    !allowedRuntimeBaseUrl(command.webhookBaseUrls.github) ||
    !allowedRuntimeBaseUrl(command.webhookBaseUrls.linear) ||
    command.webhookSecrets.github.byteLength === 0 ||
    command.webhookSecrets.linear.byteLength === 0
  ) {
    return err("runtime_configuration_invalid");
  }

  if (!githubCapability.value.ciWorkflowConfirmed) return err("ci_workflow_unconfirmed");

  const active = await ports.journal.listActiveForProject(command.project.id, readOptions);
  if (!active.ok || active.value.some((run) => !isTerminalCleanPhase(run.phase))) {
    return err("concurrent_run_exists");
  }

  return ok(
    Object.freeze({
      activation: Object.freeze({
        setupSessionId: marker.value.setupSessionId,
        authoritativeRevision: mergedConfig.value.authoritativeRevision,
        defaultBranch: marker.value.defaultBranch,
        repository: marker.value.repository,
        configDigest: marker.value.configDigest,
      }),
      linearTarget,
    }),
  );
}

function withoutRevision(run: RegistrationProbeRun): RegistrationProbeRunMutation {
  const { revision, ...rest } = run;
  void revision;
  return rest;
}

function cleanupItem(
  state: RegistrationProbeCleanupItem["state"],
  reason: RegistrationProbeCleanupItem["reason"],
): RegistrationProbeCleanupItem {
  return Object.freeze({ state, reason });
}

function withCleanupItem(
  cleanup: RegistrationProbeCleanup,
  kind: RegistrationProbeCleanupKind,
  item: RegistrationProbeCleanupItem,
): RegistrationProbeCleanup {
  return Object.freeze({ ...cleanup, [kind]: item });
}

function stableDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

class ProbeJournal {
  #run: RegistrationProbeRun;
  readonly #port: RegistrationProbeJournalPort;
  readonly #readOptions: ReadOptions;

  constructor(
    run: RegistrationProbeRun,
    port: RegistrationProbeJournalPort,
    readOptions: ReadOptions,
  ) {
    this.#run = run;
    this.#port = port;
    this.#readOptions = readOptions;
  }

  get current(): RegistrationProbeRun {
    return this.#run;
  }

  async persist(
    next: RegistrationProbeRunMutation,
  ): Promise<Result<RegistrationProbeRun, DomainError>> {
    const saved = await this.#port.compareAndSwap(
      this.#run.runId,
      this.#run.revision,
      next,
      this.#readOptions,
    );
    if (!saved.ok) return saved;
    this.#run = saved.value;
    return ok(saved.value);
  }
}

const thrownAsExternalFailure: DomainError<"external_failure"> = Object.freeze({
  kind: "domain_error",
  code: "external_failure",
  category: "external",
  message: "The external operation failed.",
  retryable: false,
});

/** Every stage catches thrown errors from ports and treats them as an ordinary port failure. */
async function safely<Value>(
  operation: () => Promise<Result<Value, DomainError>>,
): Promise<Result<Value, DomainError>> {
  try {
    return await operation();
  } catch {
    return err(thrownAsExternalFailure);
  }
}

interface StageOutcome {
  readonly failure?: Readonly<{
    stage: RegistrationProbeStage;
    reason: RegistrationProbeFailureReason;
  }>;
}

async function ensureLinearIssue(
  journal: ProbeJournal,
  ports: RegistrationProbePorts,
  command: RegistrationProbeStartCommand,
  linearTarget: RegistrationProbeLinearTarget,
): Promise<StageOutcome> {
  const run = journal.current;
  if (run.linear !== undefined) return {};
  const readOptions = readOptionsFrom(command);

  if (run.phase === "linear_mutation_started") {
    const recovered = await safely(() =>
      ports.linear.findByMarker(linearTarget, run.marker, readOptions),
    );
    if (!recovered.ok) {
      await journal.persist(
        withFailure(run, "linear_create", "linear_create_outcome_unknown", {
          cleanupKind: "linearIssue",
          cleanupItem: cleanupItem("unknown", "cleanup_outcome_unknown"),
        }),
      );
      return { failure: { stage: "linear_create", reason: "linear_create_outcome_unknown" } };
    }
    if (recovered.value !== undefined) {
      await journal.persist({
        ...withoutRevision(run),
        phase: "linear_created",
        linear: Object.freeze({ issueId: recovered.value.issueId, state: "created" as const }),
      });
      return {};
    }
    // Proven absent: fall through and attempt the create below.
  }

  const started = await journal.persist({
    ...withoutRevision(run),
    phase: "linear_mutation_started",
  });
  if (!started.ok) {
    return { failure: { stage: "linear_create", reason: "linear_create_outcome_unknown" } };
  }

  const created = await safely(() =>
    ports.linear.create(
      {
        target: linearTarget,
        marker: run.marker,
        title: `Agent Team 主動 Probe：${run.runId}`,
        body: run.marker,
      },
      mutationOptionsFor(command, `registration-probe:${run.runId}:linear-create`),
    ),
  );
  if (!created.ok) {
    await journal.persist(
      withFailure(journal.current, "linear_create", "linear_create_failed", {
        cleanupKind: "linearIssue",
        cleanupItem: cleanupItem("failed", "cleanup_failed"),
      }),
    );
    return { failure: { stage: "linear_create", reason: "linear_create_failed" } };
  }

  const readBack = await safely(() => ports.linear.read(created.value.issueId, readOptions));
  if (!readBack.ok || readBack.value.issueId !== created.value.issueId) {
    await journal.persist(
      withFailure(journal.current, "linear_create", "linear_create_outcome_unknown", {
        cleanupKind: "linearIssue",
        cleanupItem: cleanupItem("unknown", "cleanup_outcome_unknown"),
      }),
    );
    return { failure: { stage: "linear_create", reason: "linear_create_outcome_unknown" } };
  }

  await journal.persist({
    ...withoutRevision(journal.current),
    phase: "linear_created",
    linear: Object.freeze({ issueId: created.value.issueId, state: "created" as const }),
  });
  return {};
}

function probeManifestContent(run: RegistrationProbeRun): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      runId: run.runId,
      marker: run.marker,
      projectId: run.projectId,
    },
    null,
    2,
  );
}

async function ensureGitPush(
  journal: ProbeJournal,
  ports: RegistrationProbePorts,
  command: RegistrationProbeStartCommand,
  activation: RegistrationProbeActivationContext,
): Promise<StageOutcome> {
  const run = journal.current;
  if (run.git !== undefined) return {};
  const readOptions = readOptionsFrom(command);
  const repository = { rootPath: command.project.localRepositoryPath };

  if (run.phase === "branch_mutation_started") {
    const remoteHead = await safely(() =>
      ports.git.inspectRemoteBranch(repository, command.gitRemote, run.branch, readOptions),
    );
    if (!remoteHead.ok) {
      await journal.persist(
        withFailure(run, "branch_push", "branch_push_outcome_unknown", {
          cleanupKind: "remoteBranch",
          cleanupItem: cleanupItem("unknown", "cleanup_outcome_unknown"),
        }),
      );
      return { failure: { stage: "branch_push", reason: "branch_push_outcome_unknown" } };
    }
    if (remoteHead.value !== undefined) {
      await journal.persist({
        ...withoutRevision(run),
        phase: "branch_pushed",
        git: Object.freeze({ commitSha: remoteHead.value.sha, pushedSha: remoteHead.value.sha }),
      });
      return {};
    }
    // Proven absent: fall through and attempt the full worktree/commit/push flow below.
  }

  const started = await journal.persist({
    ...withoutRevision(run),
    phase: "branch_mutation_started",
  });
  if (!started.ok) {
    return { failure: { stage: "branch_push", reason: "branch_push_outcome_unknown" } };
  }

  const worktree = await safely(() =>
    ports.git.createWorktree(
      {
        rootPath: command.project.localRepositoryPath,
        path: run.worktreePath,
        branch: run.branch,
        startPoint: activation.defaultBranch,
      },
      mutationOptionsFor(command, `registration-probe:${run.runId}:worktree`),
    ),
  );
  if (!worktree.ok) {
    await journal.persist(
      withFailure(journal.current, "branch_push", "branch_push_failed", {
        cleanupKind: "remoteBranch",
        cleanupItem: cleanupItem("failed", "cleanup_failed"),
      }),
    );
    return { failure: { stage: "branch_push", reason: "branch_push_failed" } };
  }

  const manifestPath = `.agent-team/probes/${run.runId}.json`;
  const content = probeManifestContent(run);
  const contentDigest = stableDigest(content);
  const written = await safely(() =>
    ports.files.writeProbeManifest(
      { worktree: worktree.value, path: manifestPath, content, contentDigest },
      mutationOptionsFor(command, `registration-probe:${run.runId}:write`),
    ),
  );
  if (!written.ok) {
    return failGitPush(journal, "branch_push_failed");
  }
  const staged = await safely(() =>
    ports.git.stagePaths(
      worktree.value,
      [manifestPath],
      mutationOptionsFor(command, `registration-probe:${run.runId}:stage`),
    ),
  );
  if (!staged.ok) return failGitPush(journal, "branch_push_failed");
  const committed = await safely(() =>
    ports.git.commit(
      {
        worktree: worktree.value,
        message: `agent-team: ${run.marker}`,
        expectedStagedPaths: [manifestPath],
      },
      mutationOptionsFor(command, `registration-probe:${run.runId}:commit`),
    ),
  );
  if (!committed.ok) return failGitPush(journal, "branch_push_failed");
  const pushed = await safely(() =>
    ports.git.push(
      worktree.value,
      command.gitRemote,
      mutationOptionsFor(command, `registration-probe:${run.runId}:push`),
    ),
  );
  if (!pushed.ok) return failGitPush(journal, "branch_push_outcome_unknown");

  const remoteHeadBack = await safely(() =>
    ports.git.inspectRemoteBranch(repository, command.gitRemote, run.branch, readOptions),
  );
  if (!remoteHeadBack.ok || remoteHeadBack.value?.sha !== committed.value.sha) {
    return failGitPush(journal, "branch_push_outcome_unknown");
  }

  await journal.persist({
    ...withoutRevision(journal.current),
    phase: "branch_pushed",
    git: Object.freeze({ commitSha: committed.value.sha, pushedSha: remoteHeadBack.value.sha }),
  });
  return {};
}

async function failGitPush(
  journal: ProbeJournal,
  reason: Extract<
    RegistrationProbeFailureReason,
    "branch_push_failed" | "branch_push_outcome_unknown"
  >,
): Promise<StageOutcome> {
  await journal.persist(
    withFailure(journal.current, "branch_push", reason, {
      cleanupKind: "remoteBranch",
      cleanupItem:
        reason === "branch_push_outcome_unknown"
          ? cleanupItem("unknown", "cleanup_outcome_unknown")
          : cleanupItem("failed", "cleanup_failed"),
    }),
  );
  return { failure: { stage: "branch_push", reason } };
}

function withFailure(
  run: RegistrationProbeRun,
  stage: RegistrationProbeStage,
  reason: RegistrationProbeFailureReason,
  cleanupPatch?: Readonly<{
    cleanupKind: RegistrationProbeCleanupKind;
    cleanupItem: RegistrationProbeCleanupItem;
  }>,
): RegistrationProbeRunMutation {
  const base = withoutRevision(run);
  return {
    ...base,
    phase: "failed",
    failure: Object.freeze({ stage, reason }),
    cleanup:
      cleanupPatch === undefined
        ? base.cleanup
        : withCleanupItem(base.cleanup, cleanupPatch.cleanupKind, cleanupPatch.cleanupItem),
  };
}

async function ensureDraftPullRequest(
  journal: ProbeJournal,
  ports: RegistrationProbePorts,
  command: RegistrationProbeStartCommand,
  activation: RegistrationProbeActivationContext,
): Promise<StageOutcome> {
  const run = journal.current;
  if (run.draftPullRequest !== undefined) return {};
  if (run.git === undefined)
    return { failure: { stage: "draft_pull_request", reason: "draft_pr_create_failed" } };
  const readOptions = readOptionsFrom(command);
  const repository = activation.repository;

  if (run.phase === "draft_pr_mutation_started") {
    const recovered = await safely(() =>
      ports.githubCapability.findDraftPullRequestByHead(
        { repository, headBranch: run.branch },
        run.marker,
        readOptions,
      ),
    );
    if (!recovered.ok) {
      await journal.persist(
        withFailure(run, "draft_pull_request", "draft_pr_create_outcome_unknown", {
          cleanupKind: "draftPullRequest",
          cleanupItem: cleanupItem("unknown", "cleanup_outcome_unknown"),
        }),
      );
      return {
        failure: { stage: "draft_pull_request", reason: "draft_pr_create_outcome_unknown" },
      };
    }
    if (recovered.value !== undefined) {
      await journal.persist({
        ...withoutRevision(run),
        phase: "draft_pr_created",
        draftPullRequest: Object.freeze({
          changeRequestId: recovered.value.changeRequestId,
          number: recovered.value.number,
          baseBranch: activation.defaultBranch,
          headBranch: run.branch,
          headSha: recovered.value.headSha,
        }),
      });
      return {};
    }
  }

  const started = await journal.persist({
    ...withoutRevision(run),
    phase: "draft_pr_mutation_started",
  });
  if (!started.ok) {
    return { failure: { stage: "draft_pull_request", reason: "draft_pr_create_outcome_unknown" } };
  }

  const created = await safely(() =>
    ports.sourceControl.createDraftChangeRequest(
      {
        project: command.project,
        title: `Agent Team 主動 Probe：${run.runId}`,
        body: run.marker,
        baseBranch: activation.defaultBranch,
        headBranch: run.branch,
      },
      mutationOptionsFor(command, `registration-probe:${run.runId}:draft-pr`),
    ),
  );
  if (!created.ok) {
    await journal.persist(
      withFailure(journal.current, "draft_pull_request", "draft_pr_create_failed", {
        cleanupKind: "draftPullRequest",
        cleanupItem: cleanupItem("failed", "cleanup_failed"),
      }),
    );
    return { failure: { stage: "draft_pull_request", reason: "draft_pr_create_failed" } };
  }
  if (
    !created.value.draft ||
    created.value.state !== "open" ||
    created.value.headBranch !== run.branch ||
    created.value.baseBranch !== activation.defaultBranch
  ) {
    await journal.persist(
      withFailure(journal.current, "draft_pull_request", "draft_pr_create_outcome_unknown", {
        cleanupKind: "draftPullRequest",
        cleanupItem: cleanupItem("unknown", "cleanup_outcome_unknown"),
      }),
    );
    return { failure: { stage: "draft_pull_request", reason: "draft_pr_create_outcome_unknown" } };
  }

  await journal.persist({
    ...withoutRevision(journal.current),
    phase: "draft_pr_created",
    draftPullRequest: Object.freeze({
      changeRequestId: created.value.id,
      number: created.value.number,
      baseBranch: created.value.baseBranch,
      headBranch: created.value.headBranch,
      headSha: created.value.headSha,
    }),
  });
  return {};
}

async function ensureCiChecked(
  journal: ProbeJournal,
  ports: RegistrationProbePorts,
  command: RegistrationProbeStartCommand,
  poll: RegistrationProbePollOptions,
): Promise<StageOutcome> {
  const run = journal.current;
  if (run.ci !== undefined) return {};
  const draftPr = run.draftPullRequest;
  if (draftPr === undefined) return { failure: { stage: "ci_check", reason: "ci_check_missing" } };
  const readOptions = readOptionsFrom(command);
  let everObservedRequiredCheck = false;

  for (let attempt = 0; attempt < poll.maxAttempts; attempt += 1) {
    if (attempt > 0) await poll.wait(poll.intervalMs);
    const checks = await safely(() =>
      ports.sourceControl.getCommitChecks(
        { project: command.project },
        draftPr.headSha,
        readOptions,
      ),
    );
    if (!checks.ok) continue;
    if (checks.value.headSha !== draftPr.headSha) {
      await journal.persist(withFailure(run, "ci_check", "ci_check_wrong_head"));
      return { failure: { stage: "ci_check", reason: "ci_check_wrong_head" } };
    }
    const required = checks.value.checks.find(
      (check) => check.name === registrationProbeRequiredCheckName,
    );
    if (required === undefined) continue;
    everObservedRequiredCheck = true;
    if (required.status !== "completed") continue;
    if (required.conclusion !== "success") {
      await journal.persist(withFailure(journal.current, "ci_check", "ci_check_failed"));
      return { failure: { stage: "ci_check", reason: "ci_check_failed" } };
    }
    await journal.persist({
      ...withoutRevision(journal.current),
      phase: "ci_verified",
      ci: Object.freeze({
        checkName: registrationProbeRequiredCheckName,
        headSha: draftPr.headSha,
        conclusion: "success" as const,
      }),
    });
    return {};
  }

  const reason: RegistrationProbeFailureReason = everObservedRequiredCheck
    ? "ci_check_pending"
    : "ci_check_missing";
  await journal.persist(withFailure(journal.current, "ci_check", reason));
  return { failure: { stage: "ci_check", reason } };
}

async function ensureStatusVerified(
  journal: ProbeJournal,
  ports: RegistrationProbePorts,
  command: RegistrationProbeStartCommand,
  poll: RegistrationProbePollOptions,
): Promise<StageOutcome> {
  const run = journal.current;
  if (run.status !== undefined) return {};
  const draftPr = run.draftPullRequest;
  if (draftPr === undefined) return { failure: { stage: "status", reason: "status_set_failed" } };
  const readOptions = readOptionsFrom(command);

  const started = await journal.persist({
    ...withoutRevision(run),
    phase: "status_mutation_started",
  });
  if (!started.ok) return { failure: { stage: "status", reason: "status_readback_mismatch" } };

  const set = await safely(() =>
    ports.sourceControl.setCommitStatus(
      {
        project: command.project,
        headSha: draftPr.headSha,
        context: registrationProbeReviewStatusContext,
        state: "success",
        description: "agent-team registration probe",
      },
      mutationOptionsFor(command, `registration-probe:${run.runId}:status`),
    ),
  );
  if (!set.ok) {
    await journal.persist(withFailure(journal.current, "status", "status_set_failed"));
    return { failure: { stage: "status", reason: "status_set_failed" } };
  }

  for (let attempt = 0; attempt < poll.maxAttempts; attempt += 1) {
    if (attempt > 0) await poll.wait(poll.intervalMs);
    const statuses = await safely(() =>
      ports.sourceControl.getCommitStatuses(
        { project: command.project },
        draftPr.headSha,
        readOptions,
      ),
    );
    if (!statuses.ok || statuses.value.headSha !== draftPr.headSha) continue;
    const match = statuses.value.statuses.find(
      (status) => status.context === registrationProbeReviewStatusContext,
    );
    if (match?.state === "success") {
      await journal.persist({
        ...withoutRevision(journal.current),
        phase: "status_verified",
        status: Object.freeze({
          context: registrationProbeReviewStatusContext,
          headSha: draftPr.headSha,
          state: "success" as const,
        }),
      });
      return {};
    }
  }

  await journal.persist(withFailure(journal.current, "status", "status_readback_mismatch"));
  return { failure: { stage: "status", reason: "status_readback_mismatch" } };
}

async function ensureWebhookSynthetic(
  journal: ProbeJournal,
  ports: RegistrationProbePorts,
  command: RegistrationProbeStartCommand,
): Promise<StageOutcome> {
  const run = journal.current;
  if (run.syntheticDeliveries !== undefined) return {};

  const deliveries: {
    provider: "github" | "linear";
    deliveryId: string;
    latencyMs: number;
    inboxSha256: string;
  }[] = [];
  for (const provider of ["github", "linear"] as const) {
    const outcome = await ports.webhook.runSyntheticProbe({
      provider,
      baseUrl: command.webhookBaseUrls[provider],
      secret: command.webhookSecrets[provider],
    });
    if (
      outcome.state !== "verified" ||
      outcome.provider !== provider ||
      outcome.deliveryId.length === 0 ||
      outcome.latencyMs < 0 ||
      outcome.latencyMs > registrationProbeMaximumWebhookAckMs ||
      !/^[a-f0-9]{64}$/u.test(outcome.inboxSha256)
    ) {
      const reason: RegistrationProbeFailureReason =
        (outcome.state === "failed" && outcome.reason === "response_too_slow") ||
        (outcome.state === "verified" && outcome.latencyMs > registrationProbeMaximumWebhookAckMs)
          ? "webhook_latency_exceeded"
          : outcome.state === "failed" && outcome.reason === "transport_failed"
            ? "webhook_transport_failed"
            : "webhook_response_mismatch";
      await journal.persist(withFailure(journal.current, "webhook_synthetic", reason));
      return { failure: { stage: "webhook_synthetic", reason } };
    }
    deliveries.push({
      provider,
      deliveryId: outcome.deliveryId,
      latencyMs: outcome.latencyMs,
      inboxSha256: outcome.inboxSha256,
    });
  }

  await journal.persist({
    ...withoutRevision(journal.current),
    phase: "webhook_synthetic_verified",
    syntheticDeliveries: Object.freeze(
      deliveries.map((delivery) => Object.freeze({ ...delivery })),
    ),
  });
  return {};
}

async function ensureProviderEvents(
  journal: ProbeJournal,
  ports: RegistrationProbePorts,
  command: RegistrationProbeStartCommand,
  poll: RegistrationProbePollOptions,
): Promise<StageOutcome> {
  const run = journal.current;
  if (run.providerEvents !== undefined) return {};
  const linearIssueId = run.linear?.issueId;
  const draftPr = run.draftPullRequest;
  if (linearIssueId === undefined || draftPr === undefined) {
    return { failure: { stage: "provider_event", reason: "provider_event_missing" } };
  }
  const readOptions = readOptionsFrom(command);

  const criteria: readonly {
    provider: "github" | "linear";
    remoteObjectId: string;
    headSha?: string;
  }[] = [
    { provider: "linear", remoteObjectId: linearIssueId },
    { provider: "github", remoteObjectId: String(draftPr.number), headSha: draftPr.headSha },
  ];

  const evidence: RegistrationProbeProviderEventEvidence[] = [];
  for (const criterion of criteria) {
    let matched: RegistrationProbeProviderEventEvidence | undefined;
    let mismatch = false;
    for (let attempt = 0; attempt < poll.maxAttempts; attempt += 1) {
      if (attempt > 0) await poll.wait(poll.intervalMs);
      const event = await safely(() =>
        ports.providerEvents.findProviderEvent(criterion, readOptions),
      );
      if (!event.ok || event.value === undefined) continue;
      if (
        event.value.provider !== criterion.provider ||
        event.value.remoteObjectId !== criterion.remoteObjectId ||
        (criterion.headSha !== undefined && event.value.headSha !== criterion.headSha)
      ) {
        // A wrong provider/remote-id/SHA event was actually observed: fail fast rather than
        // keep polling, since it will never self-correct into the exact expected event.
        mismatch = true;
        break;
      }
      matched = event.value;
      break;
    }
    if (mismatch) {
      await journal.persist(
        withFailure(journal.current, "provider_event", "provider_event_mismatch"),
      );
      return { failure: { stage: "provider_event", reason: "provider_event_mismatch" } };
    }
    if (matched === undefined) {
      await journal.persist(
        withFailure(journal.current, "provider_event", "provider_event_missing"),
      );
      return { failure: { stage: "provider_event", reason: "provider_event_missing" } };
    }
    evidence.push(matched);
  }

  await journal.persist({
    ...withoutRevision(journal.current),
    phase: "provider_event_verified",
    providerEvents: Object.freeze(evidence.map((item) => Object.freeze({ ...item }))),
  });
  return {};
}

async function runCleanup(
  journal: ProbeJournal,
  ports: RegistrationProbePorts,
  command: RegistrationProbeStartCommand,
  activation: RegistrationProbeActivationContext,
  allowedWorktreeRoot: string,
): Promise<void> {
  const readOptions = readOptionsFrom(command);
  let run = journal.current;

  // 1. Linear issue cancellation.
  if (run.linear !== undefined && run.cleanup.linearIssue.state !== "confirmed") {
    const linearIssueId = run.linear.issueId;
    const started = await journal.persist({
      ...withoutRevision(run),
      phase: "cleanup_linear_mutation_started",
    });
    run = started.ok ? started.value : run;
    const cancelled = await safely(() =>
      ports.linear.cancel(
        linearIssueId,
        mutationOptionsFor(command, `registration-probe:${run.runId}:linear-cancel`),
      ),
    );
    const item =
      cancelled.ok && cancelled.value.state === "cancelled"
        ? cleanupItem("confirmed", "confirmed_cancelled")
        : cleanupItem("failed", "cleanup_failed");
    const persisted = await journal.persist({
      ...withoutRevision(run),
      cleanup: withCleanupItem(run.cleanup, "linearIssue", item),
    });
    run = persisted.ok ? persisted.value : run;
  }

  // 2. Draft PR close.
  if (run.draftPullRequest !== undefined && run.cleanup.draftPullRequest.state !== "confirmed") {
    const changeRequestId = run.draftPullRequest.changeRequestId;
    const started = await journal.persist({
      ...withoutRevision(run),
      phase: "cleanup_pr_mutation_started",
    });
    run = started.ok ? started.value : run;
    const closed = await safely(() =>
      ports.sourceControl.closeChangeRequest(
        { project: command.project, changeRequestId },
        mutationOptionsFor(command, `registration-probe:${run.runId}:pr-close`),
      ),
    );
    const item =
      closed.ok && closed.value.state === "closed" && !closed.value.autoMergeEnabled
        ? cleanupItem("confirmed", "confirmed_closed")
        : cleanupItem("failed", "cleanup_failed");
    const persisted = await journal.persist({
      ...withoutRevision(run),
      cleanup: withCleanupItem(run.cleanup, "draftPullRequest", item),
    });
    run = persisted.ok ? persisted.value : run;
  }

  // 3. Remote branch deletion — only once the PR is confirmed closed/unmerged.
  if (run.git !== undefined && run.cleanup.remoteBranch.state !== "confirmed") {
    if (run.cleanup.draftPullRequest.state !== "confirmed") {
      const persisted = await journal.persist({
        ...withoutRevision(run),
        cleanup: withCleanupItem(
          run.cleanup,
          "remoteBranch",
          cleanupItem("failed", "cleanup_not_eligible"),
        ),
      });
      run = persisted.ok ? persisted.value : run;
    } else {
      const pushedSha = run.git.pushedSha;
      const started = await journal.persist({
        ...withoutRevision(run),
        phase: "cleanup_branch_mutation_started",
      });
      run = started.ok ? started.value : run;
      const deleted = await safely(() =>
        ports.branchCleanup.deleteOwnedBranch(
          {
            repository: activation.repository,
            branch: run.branch,
            marker: run.marker,
            expectedHeadSha: pushedSha,
          },
          mutationOptionsFor(command, `registration-probe:${run.runId}:branch-delete`),
        ),
      );
      const item = deleted.ok
        ? cleanupItem("confirmed", "confirmed_deleted")
        : cleanupItem("failed", "cleanup_failed");
      const persisted = await journal.persist({
        ...withoutRevision(run),
        cleanup: withCleanupItem(run.cleanup, "remoteBranch", item),
      });
      run = persisted.ok ? persisted.value : run;
    }
  }

  // 4. Local worktree removal — only under the allowed probe temp root, and only when clean.
  if (run.git !== undefined && run.cleanup.localWorktree.state !== "confirmed") {
    if (!run.worktreePath.startsWith(allowedWorktreeRoot)) {
      const persisted = await journal.persist({
        ...withoutRevision(run),
        cleanup: withCleanupItem(
          run.cleanup,
          "localWorktree",
          cleanupItem("failed", "cleanup_not_eligible"),
        ),
      });
      run = persisted.ok ? persisted.value : run;
    } else {
      const gitEvidence = run.git;
      const started = await journal.persist({
        ...withoutRevision(run),
        phase: "cleanup_worktree_mutation_started",
      });
      run = started.ok ? started.value : run;
      const worktree = Object.freeze({
        repositoryRoot: command.project.localRepositoryPath,
        path: run.worktreePath,
        branch: run.branch,
        headSha: gitEvidence.commitSha,
      });
      const inspected = await safely(() => ports.git.inspectWorkingTree(worktree, readOptions));
      let removedOk = false;
      if (inspected.ok && inspected.value.changes.length === 0) {
        const removed = await safely(() =>
          ports.git.removeWorktree(
            worktree,
            mutationOptionsFor(command, `registration-probe:${run.runId}:worktree-remove`),
          ),
        );
        removedOk = removed.ok;
      }
      const item = removedOk
        ? cleanupItem("confirmed", "confirmed_removed")
        : cleanupItem("failed", "cleanup_failed");
      const persisted = await journal.persist({
        ...withoutRevision(run),
        cleanup: withCleanupItem(run.cleanup, "localWorktree", item),
      });
      run = persisted.ok ? persisted.value : run;
    }
  }
}

function finalize(run: RegistrationProbeRun): RegistrationProbeOutcome {
  const residual = registrationProbeCleanupKinds.some((kind) => {
    const state = run.cleanup[kind].state;
    return state === "unknown" || state === "failed";
  });
  if (residual) return { state: "cleanup_required", run };
  if (run.failure !== undefined) {
    return { state: "failed", stage: run.failure.stage, reason: run.failure.reason, run };
  }
  return { state: "verified", run };
}

export function createRegistrationProbeCoordinator(
  options: RegistrationProbeCoordinatorOptions,
): RegistrationProbeCoordinatorUseCase {
  const ports = options.ports;
  const ciPoll = options.ciPoll ?? defaultPoll;
  const statusPoll = options.statusPoll ?? defaultPoll;
  const providerEventPoll = options.providerEventPoll ?? defaultPoll;

  return Object.freeze({
    async start(command: RegistrationProbeStartCommand): Promise<RegistrationProbeOutcome> {
      const readOptions = readOptionsFrom(command);
      const existing = await ports.journal.load(command.runId, readOptions);
      if (
        existing.ok &&
        existing.value !== undefined &&
        (existing.value.projectId !== command.project.id ||
          existing.value.registrationRevision !== command.registrationRevision)
      ) {
        return { state: "incomplete", reason: "concurrent_run_exists" };
      }

      if (
        existing.ok &&
        existing.value !== undefined &&
        isTerminalCleanPhase(existing.value.phase)
      ) {
        return finalize(existing.value);
      }

      let run: RegistrationProbeRun;
      let activation: RegistrationProbeActivationContext;
      if (existing.ok && existing.value !== undefined) {
        run = existing.value;
        activation = run.activation;
      } else {
        const preflight = await runPreflight(command, ports);
        if (!preflight.ok) return { state: "incomplete", reason: preflight.error };
        const created = createRegistrationProbeRun({
          projectId: command.project.id,
          registrationRevision: command.registrationRevision,
          runId: command.runId,
          worktreePath: command.worktreePath,
          activation: preflight.value.activation,
        });
        if (!created.ok) return { state: "incomplete", reason: "runtime_configuration_invalid" };
        const reserved = await ports.journal.compareAndSwap(
          command.runId,
          null,
          withoutRevision(created.value),
          readOptions,
        );
        if (!reserved.ok) return { state: "incomplete", reason: "concurrent_run_exists" };
        run = reserved.value;
        activation = preflight.value.activation;
      }

      const journal = new ProbeJournal(run, ports.journal, readOptions);
      const linearTarget: RegistrationProbeLinearTarget = Object.freeze({
        teamId: command.project.workManagement.containerId,
        projectId: command.project.workManagement.projectId,
        workflowStateId: command.linearWorkflowStateId,
      });

      const steps: (() => Promise<StageOutcome>)[] = [
        () => ensureLinearIssue(journal, ports, command, linearTarget),
        () => ensureGitPush(journal, ports, command, activation),
        () => ensureDraftPullRequest(journal, ports, command, activation),
        () => ensureCiChecked(journal, ports, command, ciPoll),
        () => ensureStatusVerified(journal, ports, command, statusPoll),
        () => ensureWebhookSynthetic(journal, ports, command),
        () => ensureProviderEvents(journal, ports, command, providerEventPoll),
      ];

      for (const step of steps) {
        const outcome = await step();
        if (outcome.failure !== undefined) break;
      }

      await runCleanup(journal, ports, command, activation, options.allowedWorktreeRoot);
      return finalize(journal.current);
    },
  });
}
