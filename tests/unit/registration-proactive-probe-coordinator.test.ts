import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createRegistrationProbeCoordinator,
  createRegistrationProbeRun,
  registrationProbeBranch,
  registrationProbeMarker,
  type RegistrationProbeAuthority,
  type RegistrationProbeJournalPort,
  type RegistrationProbePorts,
  type RegistrationProbeRun,
  type RegistrationProbeStartCommand,
} from "../../src/application/registration/index.js";
import type {
  RegistrationSetupActivationMarker,
  RegistrationSetupMergedConfigReceipt,
} from "../../src/application/registration/index.js";
import { trustedProjectConfigSchema } from "../../src/application/projects/index.js";
import { domainError, err, ok } from "../../src/domain/foundation/index.js";
import { projectSchema } from "../../src/domain/project/index.js";
import { sha256Digest, type Sha256Digest } from "../../src/domain/review/index.js";

function digest(value: string): Sha256Digest {
  const result = sha256Digest(value);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const project = projectSchema.parse({
  schemaVersion: 1,
  id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  displayName: "Sandbox",
  localRepositoryPath: "/tmp/agent-team-sandbox",
  defaultBranch: "main",
  workManagement: { provider: "linear", containerId: "team-1", projectId: "linear-project-1" },
  sourceControl: { provider: "github", repository: "owner/sandbox" },
});

const config = trustedProjectConfigSchema.parse({
  schemaVersion: 1,
  projectId: project.id,
  defaultBranch: project.defaultBranch,
  platforms: { workManagement: project.workManagement, sourceControl: project.sourceControl },
  projectRules: ["Run quality checks."],
  roleInstructions: { implementer: ["Stay in scope."] },
  commands: { quality: [{ executable: "pnpm", arguments: ["test"] }], visualReview: [] },
});

const setupSessionId = "setup-018f47d2";
const mergeCommitSha = "c".repeat(40);
const setupHeadSha = "d".repeat(40);
const configDigest = hex("config");
const commitSha = "f".repeat(40);
const prNumber = 501;
const changeRequestId = "PR_probe_501";
const now = "2026-08-06T00:00:00.000Z";

const activationMarker: RegistrationSetupActivationMarker = Object.freeze({
  schemaVersion: 1,
  source: "source_control_default_branch",
  setupSessionId,
  projectId: project.id,
  repository: project.sourceControl.repository,
  changeRequestId: "PR_setup_1",
  setupHeadSha,
  mergeCommitSha,
  authoritativeRevision: mergeCommitSha,
  defaultBranch: project.defaultBranch,
  configDigest,
  linearAuditIssueId: "LINEAR-AUDIT-1",
  gateEvidenceDigest: digest("gate"),
  auditReceiptsDigest: digest("audit"),
  approvalSource: "local_ui",
  approvalReferenceDigest: digest("approval-reference"),
  approvalConsumeOperationDigest: digest("consume-operation"),
  authorityDigest: hex("authority"),
  approvalNonceDigest: hex("nonce"),
});

const mergedConfigReceipt: RegistrationSetupMergedConfigReceipt = Object.freeze({
  schemaVersion: 1,
  source: "source_control_default_branch",
  projectId: project.id,
  repository: project.sourceControl.repository,
  changeRequestId: activationMarker.changeRequestId,
  setupHeadSha,
  mergeCommitSha,
  defaultBranch: project.defaultBranch,
  authoritativeRevision: mergeCommitSha,
  path: ".agent-team/project.json",
  configDigest,
  config,
});

function authorityFor(command: {
  readonly projectId?: string;
  readonly setupSessionId?: string;
  readonly registrationRevision?: number;
}): RegistrationProbeAuthority {
  return Object.freeze({
    schemaVersion: 1,
    source: "user_local_ui",
    projectId: (command.projectId ?? project.id) as typeof project.id,
    setupSessionId: command.setupSessionId ?? setupSessionId,
    registrationRevision: command.registrationRevision ?? 1,
  });
}

function baseCommand(runId: string, overrides: Partial<RegistrationProbeStartCommand> = {}) {
  return Object.freeze({
    project,
    setupSessionId,
    registrationRevision: 1,
    runId,
    worktreePath: `/tmp/agent-team-probes/${runId}`,
    gitRemote: "origin",
    linearWorkflowStateId: "state-backlog-1",
    authority: authorityFor({}),
    webhookBaseUrls: Object.freeze({
      github: "https://webhook.example.test",
      linear: "https://webhook.example.test",
    }),
    webhookSecrets: Object.freeze({
      github: new TextEncoder().encode("github-secret-0123456789"),
      linear: new TextEncoder().encode("linear-secret-0123456789"),
    }),
    ...overrides,
  }) satisfies RegistrationProbeStartCommand;
}

interface MutationCounts {
  linearCreate: number;
  linearCancel: number;
  gitCreateWorktree: number;
  gitStagePaths: number;
  gitCommit: number;
  gitPush: number;
  gitRemoveWorktree: number;
  filesWrite: number;
  prCreate: number;
  prClose: number;
  statusSet: number;
  webhookRun: number;
  branchDelete: number;
}

function zeroCounts(): MutationCounts {
  return {
    linearCreate: 0,
    linearCancel: 0,
    gitCreateWorktree: 0,
    gitStagePaths: 0,
    gitCommit: 0,
    gitPush: 0,
    gitRemoveWorktree: 0,
    filesWrite: 0,
    prCreate: 0,
    prClose: 0,
    statusSet: 0,
    webhookRun: 0,
    branchDelete: 0,
  };
}

function expectZeroMutations(counts: MutationCounts): void {
  expect(counts).toEqual(zeroCounts());
}

function createMemoryJournal(): RegistrationProbeJournalPort & {
  readonly map: Map<string, RegistrationProbeRun>;
} {
  const map = new Map<string, RegistrationProbeRun>();
  return {
    map,
    load: (runId) => Promise.resolve(ok(map.get(runId))),
    compareAndSwap: (runId, expectedRevision, next) => {
      const current = map.get(runId);
      const currentRevision = current?.revision ?? null;
      if (currentRevision !== expectedRevision) {
        return Promise.resolve(err(domainError("conflict")));
      }
      const saved: RegistrationProbeRun = Object.freeze({
        ...next,
        revision: (current?.revision ?? -1) + 1,
      });
      map.set(runId, saved);
      return Promise.resolve(ok(saved));
    },
    listActiveForProject: (projectId) =>
      Promise.resolve(
        ok(Object.freeze([...map.values()].filter((run) => run.projectId === projectId))),
      ),
  };
}

function seedRunAtPhase(
  journalMap: Map<string, RegistrationProbeRun>,
  runId: string,
  phase: RegistrationProbeRun["phase"],
  patch: Partial<RegistrationProbeRun> = {},
): void {
  const created = createRegistrationProbeRun({
    projectId: project.id,
    registrationRevision: 1,
    runId,
    worktreePath: `/tmp/agent-team-probes/${runId}`,
    activation: {
      setupSessionId,
      authoritativeRevision: mergeCommitSha,
      defaultBranch: project.defaultBranch,
      repository: project.sourceControl.repository,
      configDigest,
    },
  });
  if (!created.ok) throw new Error("fixture: invalid seeded run");
  const seeded: RegistrationProbeRun = Object.freeze({ ...created.value, phase, ...patch });
  journalMap.set(runId, seeded);
}

interface HarnessOptions {
  readonly activation?:
    "ok" | "missing" | "wrong_project" | "config_mismatch" | "revision_mismatch";
  readonly linearCapability?: "ok" | "read_only" | "not_cancelable" | "error";
  readonly githubCapability?: Partial<{
    permission: "admin" | "read_only";
    requiredCheckConfigured: boolean;
    reviewStatusSupported: boolean;
    ciWorkflowConfirmed: boolean;
    pushCapable: boolean;
    draftPullRequestCapable: boolean;
    closeCapable: boolean;
  }>;
  readonly githubCapabilityError?: boolean;
  readonly gitIdentityError?: boolean;
  readonly linearCreate?: "ok" | "fail";
  readonly linearRead?: "ok" | "mismatch" | "error";
  readonly gitCreateWorktree?: "ok" | "fail";
  readonly gitPush?: "ok" | "fail" | "unconfirmed";
  readonly prCreate?: "ok" | "fail" | "not_draft";
  readonly ciChecks?: "ok" | "pending" | "failure" | "empty" | "wrong_head";
  readonly statusSet?: "ok" | "fail";
  readonly statusReadback?: "ok" | "mismatch";
  readonly webhookGithub?: "ok" | "slow" | "transport_failed" | "wrong_provider" | "bad_digest";
  readonly webhookLinear?: "ok" | "slow" | "transport_failed" | "wrong_provider" | "bad_digest";
  readonly providerEventLinear?: "ok" | "missing" | "wrong_id" | "late";
  readonly providerEventGithub?: "ok" | "missing" | "wrong_sha" | "late";
  readonly linearCancel?: "ok" | "fail";
  readonly prClose?: "ok" | "fail";
  readonly branchDelete?: "ok" | "fail";
  readonly worktreeClean?: "ok" | "dirty";
  readonly linearRecovery?: "absent" | "found" | "error";
  readonly branchRecovery?: "absent" | "found" | "error";
  readonly prRecovery?: "absent" | "found" | "error";
}

function createHarness(
  runId: string,
  options: HarnessOptions = {},
  sharedJournal?: RegistrationProbeJournalPort & {
    readonly map: Map<string, RegistrationProbeRun>;
  },
): {
  readonly ports: RegistrationProbePorts;
  readonly counts: MutationCounts;
  readonly journal: RegistrationProbeJournalPort & {
    readonly map: Map<string, RegistrationProbeRun>;
  };
  readonly linearIssueId: string;
} {
  const counts = zeroCounts();
  const journal = sharedJournal ?? createMemoryJournal();
  const linearIssueId = `issue-${runId}`;
  const branch = registrationProbeBranch(runId);
  const marker = registrationProbeMarker(runId);
  let pushedThisCall = false;
  let providerEventLinearAttempt = 0;
  let providerEventGithubAttempt = 0;

  const activationMarkerForCommand: RegistrationSetupActivationMarker | undefined =
    options.activation === "missing"
      ? undefined
      : options.activation === "wrong_project"
        ? Object.freeze({
            ...activationMarker,
            projectId: "project_00000000-0000-1000-8000-000000000000" as typeof project.id,
          })
        : activationMarker;

  const mergedConfigReceiptForCommand: RegistrationSetupMergedConfigReceipt =
    options.activation === "config_mismatch"
      ? Object.freeze({ ...mergedConfigReceipt, configDigest: hex("tampered") })
      : options.activation === "revision_mismatch"
        ? Object.freeze({ ...mergedConfigReceipt, authoritativeRevision: "9".repeat(40) })
        : mergedConfigReceipt;

  const githubCapabilitySnapshot = Object.freeze({
    permission: "admin" as const,
    requiredCheckConfigured: true,
    reviewStatusSupported: true,
    ciWorkflowConfirmed: true,
    pushCapable: true,
    draftPullRequestCapable: true,
    closeCapable: true,
    ...options.githubCapability,
  });

  const ports: RegistrationProbePorts = {
    activation: {
      readActivation: () => Promise.resolve(ok(activationMarkerForCommand)),
    },
    mergedConfig: {
      read: () => Promise.resolve(ok(mergedConfigReceiptForCommand)),
    },
    linear: {
      readCapability: () => {
        if (options.linearCapability === "error")
          return Promise.resolve(err(domainError("unavailable")));
        return Promise.resolve(
          ok({
            readWrite: options.linearCapability !== "read_only",
            cancelable: options.linearCapability !== "not_cancelable",
          }),
        );
      },
      findByMarker: () => {
        if (options.linearRecovery === "found") {
          return Promise.resolve(ok({ issueId: linearIssueId, state: "open" as const }));
        }
        if (options.linearRecovery === "error")
          return Promise.resolve(err(domainError("unavailable")));
        return Promise.resolve(ok(undefined));
      },
      create: (command) => {
        counts.linearCreate += 1;
        if (options.linearCreate === "fail")
          return Promise.resolve(err(domainError("external_failure")));
        void command;
        return Promise.resolve(ok({ issueId: linearIssueId }));
      },
      read: (issueId) => {
        if (options.linearRead === "error") return Promise.resolve(err(domainError("unavailable")));
        return Promise.resolve(
          ok({
            issueId: options.linearRead === "mismatch" ? `${issueId}-other` : issueId,
            state: "open" as const,
          }),
        );
      },
      cancel: (issueId) => {
        counts.linearCancel += 1;
        if (options.linearCancel === "fail")
          return Promise.resolve(err(domainError("external_failure")));
        return Promise.resolve(ok({ issueId, state: "cancelled" as const }));
      },
    },
    githubCapability: {
      inspect: () => {
        if (options.githubCapabilityError === true)
          return Promise.resolve(err(domainError("unavailable")));
        return Promise.resolve(ok(githubCapabilitySnapshot));
      },
      findDraftPullRequestByHead: () => {
        if (options.prRecovery === "found") {
          return Promise.resolve(
            ok({
              changeRequestId,
              number: prNumber,
              headSha: commitSha,
              state: "open" as const,
              draft: true,
            }),
          );
        }
        if (options.prRecovery === "error") return Promise.resolve(err(domainError("unavailable")));
        return Promise.resolve(ok(undefined));
      },
    },
    sourceControl: {
      createDraftChangeRequest: (command) => {
        counts.prCreate += 1;
        if (options.prCreate === "fail")
          return Promise.resolve(err(domainError("external_failure")));
        return Promise.resolve(
          ok({
            id: changeRequestId,
            number: prNumber,
            url: `https://github.test/${project.sourceControl.repository}/pull/${String(prNumber)}`,
            state: "open" as const,
            draft: options.prCreate !== "not_draft",
            baseBranch: command.baseBranch,
            headBranch: command.headBranch,
            headSha: commitSha,
            mergeability: "mergeable" as const,
            autoMergeEnabled: false,
            updatedAt: now as never,
          }),
        );
      },
      getChangeRequest: () =>
        Promise.resolve(
          ok({
            id: changeRequestId,
            number: prNumber,
            url: `https://github.test/${project.sourceControl.repository}/pull/${String(prNumber)}`,
            state: "open" as const,
            draft: true,
            baseBranch: project.defaultBranch,
            headBranch: branch,
            headSha: commitSha,
            mergeability: "mergeable" as const,
            autoMergeEnabled: false,
            updatedAt: now as never,
          }),
        ),
      getCommitChecks: () => {
        if (options.ciChecks === "empty") {
          return Promise.resolve(
            ok({ headSha: commitSha, aggregate: "pending" as const, checks: [] }),
          );
        }
        const sha = options.ciChecks === "wrong_head" ? "9".repeat(40) : commitSha;
        const status =
          options.ciChecks === "pending" ? ("in_progress" as const) : ("completed" as const);
        const conclusion =
          options.ciChecks === "pending"
            ? null
            : options.ciChecks === "failure"
              ? ("failure" as const)
              : ("success" as const);
        return Promise.resolve(
          ok({
            headSha: sha,
            aggregate: conclusion === "success" ? ("success" as const) : ("pending" as const),
            checks: [{ name: "CI", status, conclusion }],
          }),
        );
      },
      getCommitStatuses: () => {
        if (options.statusReadback === "mismatch") {
          return Promise.resolve(
            ok({
              headSha: commitSha,
              statuses: [{ context: "agent-team/review", state: "pending" as const }],
            }),
          );
        }
        return Promise.resolve(
          ok({
            headSha: commitSha,
            statuses: [{ context: "agent-team/review", state: "success" as const }],
          }),
        );
      },
      setCommitStatus: () => {
        counts.statusSet += 1;
        if (options.statusSet === "fail")
          return Promise.resolve(err(domainError("external_failure")));
        return Promise.resolve(ok(undefined));
      },
      closeChangeRequest: () => {
        counts.prClose += 1;
        if (options.prClose === "fail")
          return Promise.resolve(err(domainError("external_failure")));
        return Promise.resolve(
          ok({
            id: changeRequestId,
            number: prNumber,
            url: `https://github.test/${project.sourceControl.repository}/pull/${String(prNumber)}`,
            state: "closed" as const,
            draft: true,
            baseBranch: project.defaultBranch,
            headBranch: branch,
            headSha: commitSha,
            mergeability: "unknown" as const,
            autoMergeEnabled: false,
            updatedAt: now as never,
          }),
        );
      },
    },
    git: {
      createWorktree: (command) => {
        counts.gitCreateWorktree += 1;
        if (options.gitCreateWorktree === "fail")
          return Promise.resolve(err(domainError("external_failure")));
        return Promise.resolve(
          ok({
            repositoryRoot: command.rootPath,
            path: command.path,
            branch: command.branch,
            headSha: mergeCommitSha,
          }),
        );
      },
      stagePaths: (worktree) => {
        counts.gitStagePaths += 1;
        return Promise.resolve(ok({ headSha: worktree.headSha, changes: [] }));
      },
      commit: (command) => {
        counts.gitCommit += 1;
        return Promise.resolve(ok({ sha: commitSha, branch: command.worktree.branch }));
      },
      inspectWorkingTree: () => {
        if (options.worktreeClean === "dirty") {
          return Promise.resolve(
            ok({
              headSha: commitSha,
              changes: [
                {
                  path: "dirty.txt",
                  kind: "modified" as const,
                  mode: "file" as const,
                  staged: false,
                },
              ],
            }),
          );
        }
        return Promise.resolve(ok({ headSha: commitSha, changes: [] }));
      },
      push: (worktree, remote) => {
        counts.gitPush += 1;
        pushedThisCall = true;
        if (options.gitPush === "fail")
          return Promise.resolve(err(domainError("external_failure")));
        return Promise.resolve(ok({ remote, branch: worktree.branch, sha: commitSha }));
      },
      removeWorktree: () => {
        counts.gitRemoveWorktree += 1;
        return Promise.resolve(ok(undefined));
      },
      inspectRepository: () => {
        if (options.gitIdentityError === true)
          return Promise.resolve(err(domainError("unavailable")));
        return Promise.resolve(
          ok({
            rootPath: project.localRepositoryPath,
            headSha: mergeCommitSha,
            branch: project.defaultBranch,
            clean: true,
          }),
        );
      },
      inspectRemoteBranch: () => {
        if (!pushedThisCall) {
          // Pre-mutation exact recovery/idempotency lookup, before any push in this call.
          if (options.branchRecovery === "found") return Promise.resolve(ok({ sha: commitSha }));
          if (options.branchRecovery === "error")
            return Promise.resolve(err(domainError("unavailable")));
          return Promise.resolve(ok(undefined));
        }
        // Post-push confirmation readback within this same call.
        if (options.gitPush === "unconfirmed") return Promise.resolve(ok(undefined));
        return Promise.resolve(ok({ sha: commitSha }));
      },
    },
    files: {
      writeProbeManifest: (command) => {
        counts.filesWrite += 1;
        return Promise.resolve(ok({ path: command.path, contentDigest: command.contentDigest }));
      },
    },
    webhook: {
      runSyntheticProbe: (request) => {
        counts.webhookRun += 1;
        const toggle =
          request.provider === "github" ? options.webhookGithub : options.webhookLinear;
        if (toggle === "transport_failed") {
          return Promise.resolve({ state: "failed" as const, reason: "transport_failed" as const });
        }
        if (toggle === "slow") {
          return Promise.resolve({
            state: "verified" as const,
            provider: request.provider,
            deliveryId: `delivery-${request.provider}-1`,
            latencyMs: 2_500,
            inboxSha256: hex(`${request.provider}-payload`),
          });
        }
        if (toggle === "wrong_provider") {
          return Promise.resolve({
            state: "verified" as const,
            provider: request.provider === "github" ? "linear" : "github",
            deliveryId: `delivery-${request.provider}-1`,
            latencyMs: 120,
            inboxSha256: hex(`${request.provider}-payload`),
          });
        }
        if (toggle === "bad_digest") {
          return Promise.resolve({
            state: "verified" as const,
            provider: request.provider,
            deliveryId: `delivery-${request.provider}-1`,
            latencyMs: 120,
            inboxSha256: "not-a-digest",
          });
        }
        return Promise.resolve({
          state: "verified" as const,
          provider: request.provider,
          deliveryId: `delivery-${request.provider}-1`,
          latencyMs: 120,
          inboxSha256: hex(`${request.provider}-payload`),
        });
      },
    },
    providerEvents: {
      findProviderEvent: (criterion) => {
        if (criterion.provider === "linear") {
          providerEventLinearAttempt += 1;
          if (options.providerEventLinear === "missing") return Promise.resolve(ok(undefined));
          if (options.providerEventLinear === "late" && providerEventLinearAttempt < 2) {
            return Promise.resolve(ok(undefined));
          }
          const remoteObjectId =
            options.providerEventLinear === "wrong_id" ? "wrong-issue" : linearIssueId;
          return Promise.resolve(
            ok({
              provider: "linear" as const,
              deliveryId: "provider-event-linear-1",
              eventType: "Issue",
              remoteObjectId,
              payloadSha256: hex("linear-provider-event"),
              streamKey: "stream-linear-1",
            }),
          );
        }
        providerEventGithubAttempt += 1;
        if (options.providerEventGithub === "missing") return Promise.resolve(ok(undefined));
        if (options.providerEventGithub === "late" && providerEventGithubAttempt < 2) {
          return Promise.resolve(ok(undefined));
        }
        const headSha = options.providerEventGithub === "wrong_sha" ? "9".repeat(40) : commitSha;
        return Promise.resolve(
          ok({
            provider: "github" as const,
            deliveryId: "provider-event-github-1",
            eventType: "pull_request",
            remoteObjectId: String(prNumber),
            headSha,
            payloadSha256: hex("github-provider-event"),
            streamKey: "stream-github-1",
          }),
        );
      },
    },
    branchCleanup: {
      deleteOwnedBranch: (command) => {
        counts.branchDelete += 1;
        if (options.branchDelete === "fail") return Promise.resolve(err(domainError("conflict")));
        void command;
        return Promise.resolve(ok({ state: "deleted" as const }));
      },
    },
    journal,
  };

  void marker;
  return { ports, counts, journal, linearIssueId };
}

const allowedWorktreeRoot = "/tmp/agent-team-probes/";

function fastPoll() {
  return { maxAttempts: 3, intervalMs: 0, wait: () => Promise.resolve() };
}

describe("registration proactive probe coordinator", () => {
  it("completes the full happy path with exact evidence and zero residual artifacts (AC-2)", async () => {
    const runId = "probe-happy-0001";
    const { ports, counts } = createHarness(runId);
    const coordinator = createRegistrationProbeCoordinator({
      ports,
      allowedWorktreeRoot,
      ciPoll: fastPoll(),
      statusPoll: fastPoll(),
      providerEventPoll: fastPoll(),
    });

    const outcome = await coordinator.start(baseCommand(runId));

    expect(outcome.state).toBe("verified");
    if (outcome.state !== "verified") return;
    expect(outcome.run.runId).toBe(runId);
    expect(outcome.run.branch).toBe(`agent-team/probe/${runId}`);
    expect(outcome.run.marker).toBe(`agent-team-registration-probe:${runId}`);
    expect(outcome.run.linear?.issueId).toBe(`issue-${runId}`);
    expect(outcome.run.draftPullRequest?.headSha).toBe(commitSha);
    expect(outcome.run.ci).toMatchObject({ checkName: "CI", conclusion: "success" });
    expect(outcome.run.status).toMatchObject({ context: "agent-team/review", state: "success" });
    expect(outcome.run.syntheticDeliveries).toHaveLength(2);
    expect(outcome.run.providerEvents).toHaveLength(2);
    expect(outcome.run.cleanup).toMatchObject({
      linearIssue: { state: "confirmed" },
      draftPullRequest: { state: "confirmed" },
      remoteBranch: { state: "confirmed" },
      localWorktree: { state: "confirmed" },
    });

    expect(counts.linearCreate).toBe(1);
    expect(counts.linearCancel).toBe(1);
    expect(counts.prCreate).toBe(1);
    expect(counts.prClose).toBe(1);
    expect(counts.branchDelete).toBe(1);
    expect(counts.gitRemoveWorktree).toBe(1);
  });

  // ---------------------------------------------------------------------------------------
  // AC-1: preflight is fail-closed and zero-mutation for every one of the 8 gates.
  // ---------------------------------------------------------------------------------------
  describe("preflight (AC-1): every gate fails closed with zero external mutation", () => {
    async function expectPreflightFailure(
      runId: string,
      options: HarnessOptions,
      reason: string,
      commandOverrides?: Partial<RegistrationProbeStartCommand>,
    ): Promise<void> {
      const { ports, counts } = createHarness(runId, options);
      const coordinator = createRegistrationProbeCoordinator({ ports, allowedWorktreeRoot });
      const outcome = await coordinator.start(baseCommand(runId, commandOverrides));
      expect(outcome).toEqual({ state: "incomplete", reason });
      expectZeroMutations(counts);
    }

    it("1. authority not bound to the exact project/session/revision -> authority_invalid", async () => {
      const runId = "probe-pre-authority";
      await expectPreflightFailure(runId, {}, "authority_invalid", {
        authority: authorityFor({ setupSessionId: "setup-different" }),
      });
    });

    it("2. O005 activation missing -> activation_not_ready", async () => {
      await expectPreflightFailure(
        "probe-pre-activation-missing",
        { activation: "missing" },
        "activation_not_ready",
      );
    });

    it("2. O005 activation bound to a different project -> activation_not_ready", async () => {
      await expectPreflightFailure(
        "probe-pre-activation-wrongproj",
        { activation: "wrong_project" },
        "activation_not_ready",
      );
    });

    it("2. merged-config digest mismatch (O005 config drift) -> activation_not_ready, zero effect", async () => {
      await expectPreflightFailure(
        "probe-pre-activation-configmismatch",
        { activation: "config_mismatch" },
        "activation_not_ready",
      );
    });

    it("2. merged-config authoritative revision mismatch (O005 rollback) -> activation_not_ready, zero effect", async () => {
      await expectPreflightFailure(
        "probe-pre-activation-revmismatch",
        { activation: "revision_mismatch" },
        "activation_not_ready",
      );
    });

    it("3. Linear capability missing read/write -> linear_capability_incomplete", async () => {
      await expectPreflightFailure(
        "probe-pre-linear-rw",
        { linearCapability: "read_only" },
        "linear_capability_incomplete",
      );
    });

    it("3. Linear capability missing cancel -> linear_capability_incomplete", async () => {
      await expectPreflightFailure(
        "probe-pre-linear-cancel",
        { linearCapability: "not_cancelable" },
        "linear_capability_incomplete",
      );
    });

    it("3. Linear capability read fails -> linear_capability_incomplete", async () => {
      await expectPreflightFailure(
        "probe-pre-linear-error",
        { linearCapability: "error" },
        "linear_capability_incomplete",
      );
    });

    it("4. GitHub required check not configured -> github_capability_incomplete", async () => {
      await expectPreflightFailure(
        "probe-pre-github-check",
        { githubCapability: { requiredCheckConfigured: false } },
        "github_capability_incomplete",
      );
    });

    it("4. GitHub review status unsupported -> github_capability_incomplete", async () => {
      await expectPreflightFailure(
        "probe-pre-github-status",
        { githubCapability: { reviewStatusSupported: false } },
        "github_capability_incomplete",
      );
    });

    it("4. GitHub permission is read-only -> github_capability_incomplete", async () => {
      await expectPreflightFailure(
        "probe-pre-github-perm",
        { githubCapability: { permission: "read_only" } },
        "github_capability_incomplete",
      );
    });

    it("5. GitHub push capability missing -> git_identity_incomplete", async () => {
      await expectPreflightFailure(
        "probe-pre-git-push",
        { githubCapability: { pushCapable: false } },
        "git_identity_incomplete",
      );
    });

    it("5. GitHub Draft PR capability missing -> git_identity_incomplete", async () => {
      await expectPreflightFailure(
        "probe-pre-git-draftpr",
        { githubCapability: { draftPullRequestCapable: false } },
        "git_identity_incomplete",
      );
    });

    it("5. GitHub close capability missing -> git_identity_incomplete", async () => {
      await expectPreflightFailure(
        "probe-pre-git-close",
        { githubCapability: { closeCapable: false } },
        "git_identity_incomplete",
      );
    });

    it("5. local repository identity unreadable -> git_identity_incomplete", async () => {
      await expectPreflightFailure(
        "probe-pre-git-identity",
        { gitIdentityError: true },
        "git_identity_incomplete",
      );
    });

    it("6. non-HTTPS, non-loopback webhook base URL -> runtime_configuration_invalid", async () => {
      await expectPreflightFailure("probe-pre-runtime-url", {}, "runtime_configuration_invalid", {
        webhookBaseUrls: {
          github: "http://webhook.example.test",
          linear: "https://webhook.example.test",
        },
      });
    });

    it("6. empty webhook secret -> runtime_configuration_invalid", async () => {
      await expectPreflightFailure(
        "probe-pre-runtime-secret",
        {},
        "runtime_configuration_invalid",
        {
          webhookSecrets: {
            github: new Uint8Array(0),
            linear: new TextEncoder().encode("ok-secret"),
          },
        },
      );
    });

    it("7. CI workflow not confirmed -> ci_workflow_unconfirmed", async () => {
      await expectPreflightFailure(
        "probe-pre-ci-workflow",
        { githubCapability: { ciWorkflowConfirmed: false } },
        "ci_workflow_unconfirmed",
      );
    });

    it("8. a non-terminal run already exists for the same project -> concurrent_run_exists", async () => {
      const runId = "probe-pre-concurrent";
      const otherRunId = "probe-pre-concurrent-other";
      const { ports, counts, journal } = createHarness(runId);
      seedRunAtPhase(journal.map, otherRunId, "linear_created");
      const coordinator = createRegistrationProbeCoordinator({ ports, allowedWorktreeRoot });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome).toEqual({ state: "incomplete", reason: "concurrent_run_exists" });
      expectZeroMutations(counts);
    });

    it("8. a prior verified run for the same project does not block a new one", async () => {
      const runId = "probe-pre-concurrent-ok";
      const otherRunId = "probe-pre-concurrent-ok-prior";
      const shared = createMemoryJournal();
      seedRunAtPhase(shared.map, otherRunId, "verified");
      const { ports } = createHarness(runId, {}, shared);
      const coordinator = createRegistrationProbeCoordinator({
        ports,
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
        providerEventPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("verified");
    });
  });

  // ---------------------------------------------------------------------------------------
  // AC-3: signature/delivery/latency separation between synthetic and provider-origin events.
  // ---------------------------------------------------------------------------------------
  describe("webhook synthetic delivery and provider-origin events (AC-3)", () => {
    it("webhook transport failure fails the probe but still runs full cleanup", async () => {
      const runId = "probe-webhook-transport";
      const { ports, counts } = createHarness(runId, { webhookGithub: "transport_failed" });
      const coordinator = createRegistrationProbeCoordinator({
        ports,
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("failed");
      if (outcome.state === "failed") {
        expect(outcome.stage).toBe("webhook_synthetic");
        expect(outcome.reason).toBe("webhook_transport_failed");
      }
      expect(counts.linearCancel).toBe(1);
      expect(counts.prClose).toBe(1);
      expect(counts.branchDelete).toBe(1);
      expect(counts.gitRemoveWorktree).toBe(1);
    });

    it("webhook ack latency over 2000ms fails as webhook_latency_exceeded", async () => {
      const runId = "probe-webhook-slow";
      const { ports } = createHarness(runId, { webhookGithub: "slow" });
      const coordinator = createRegistrationProbeCoordinator({
        ports,
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("failed");
      if (outcome.state === "failed") expect(outcome.reason).toBe("webhook_latency_exceeded");
    });

    it("webhook response claiming the wrong provider is rejected (header/provider mismatch)", async () => {
      const runId = "probe-webhook-wrongprovider";
      const { ports } = createHarness(runId, { webhookGithub: "wrong_provider" });
      const coordinator = createRegistrationProbeCoordinator({
        ports,
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("failed");
      if (outcome.state === "failed") expect(outcome.reason).toBe("webhook_response_mismatch");
    });

    it("webhook response with a malformed Inbox digest is rejected (raw-bytes verification)", async () => {
      const runId = "probe-webhook-baddigest";
      const { ports } = createHarness(runId, { webhookLinear: "bad_digest" });
      const coordinator = createRegistrationProbeCoordinator({
        ports,
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("failed");
      if (outcome.state === "failed") expect(outcome.reason).toBe("webhook_response_mismatch");
    });

    // O2: uniqueness is ordinarily guaranteed by W004's per-provider Inbox exact readback; this
    // proves the coordinator itself also fails closed if the two providers' synthetic deliveries
    // were ever to collide on the same Delivery ID.
    it("two providers reporting the same synthetic Delivery ID is rejected, not silently accepted", async () => {
      const runId = "probe-webhook-duplicate-delivery";
      const { ports } = createHarness(runId);
      const webhook = {
        runSyntheticProbe: (request: { readonly provider: "github" | "linear" }) =>
          Promise.resolve({
            state: "verified" as const,
            provider: request.provider,
            // Same Delivery ID for both providers -- this is exactly what must be rejected.
            deliveryId: "collided-delivery-id",
            latencyMs: 120,
            inboxSha256: hex(`${request.provider}-payload`),
          }),
      };
      const coordinator = createRegistrationProbeCoordinator({
        ports: { ...ports, webhook },
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("failed");
      if (outcome.state === "failed") {
        expect(outcome.stage).toBe("webhook_synthetic");
        expect(outcome.reason).toBe("webhook_response_mismatch");
      }
    });

    it("a late (but eventually correct) provider-origin event still verifies within the poll budget", async () => {
      const runId = "probe-provider-late";
      const { ports } = createHarness(runId, { providerEventLinear: "late" });
      const coordinator = createRegistrationProbeCoordinator({
        ports,
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
        providerEventPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("verified");
    });

    it("a provider-origin event that never arrives times out as provider_event_missing", async () => {
      const runId = "probe-provider-missing";
      const { ports } = createHarness(runId, { providerEventGithub: "missing" });
      const coordinator = createRegistrationProbeCoordinator({
        ports,
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
        providerEventPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("failed");
      if (outcome.state === "failed") {
        expect(outcome.stage).toBe("provider_event");
        expect(outcome.reason).toBe("provider_event_missing");
      }
    });

    it("a provider-origin event bound to the wrong remote issue id is rejected, not accepted (wrong Delivery target)", async () => {
      const runId = "probe-provider-wrongid";
      const { ports } = createHarness(runId, { providerEventLinear: "wrong_id" });
      const coordinator = createRegistrationProbeCoordinator({
        ports,
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
        providerEventPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("failed");
      if (outcome.state === "failed") expect(outcome.reason).toBe("provider_event_mismatch");
    });

    it("a provider-origin event bound to the wrong head SHA is rejected, not accepted", async () => {
      const runId = "probe-provider-wrongsha";
      const { ports } = createHarness(runId, { providerEventGithub: "wrong_sha" });
      const coordinator = createRegistrationProbeCoordinator({
        ports,
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
        providerEventPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("failed");
      if (outcome.state === "failed") expect(outcome.reason).toBe("provider_event_mismatch");
    });
  });

  // ---------------------------------------------------------------------------------------
  // AC-4: CI / Status exact head, fixed check name, terminal-only.
  // ---------------------------------------------------------------------------------------
  describe("CI and Status evidence (AC-4)", () => {
    it("CI still pending after the poll budget fails as ci_check_pending", async () => {
      const runId = "probe-ci-pending";
      const { ports } = createHarness(runId, { ciChecks: "pending" });
      const coordinator = createRegistrationProbeCoordinator({
        ports,
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("failed");
      if (outcome.state === "failed") expect(outcome.reason).toBe("ci_check_pending");
    });

    it("CI conclusion failure fails as ci_check_failed", async () => {
      const runId = "probe-ci-failure";
      const { ports } = createHarness(runId, { ciChecks: "failure" });
      const coordinator = createRegistrationProbeCoordinator({
        ports,
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("failed");
      if (outcome.state === "failed") expect(outcome.reason).toBe("ci_check_failed");
    });

    it("an empty check set (required check never appears) fails as ci_check_missing", async () => {
      const runId = "probe-ci-empty";
      const { ports } = createHarness(runId, { ciChecks: "empty" });
      const coordinator = createRegistrationProbeCoordinator({
        ports,
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("failed");
      if (outcome.state === "failed") expect(outcome.reason).toBe("ci_check_missing");
    });

    it("CI reported against a stale/old head SHA fails immediately as ci_check_wrong_head", async () => {
      const runId = "probe-ci-wronghead";
      const { ports } = createHarness(runId, { ciChecks: "wrong_head" });
      const coordinator = createRegistrationProbeCoordinator({
        ports,
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("failed");
      if (outcome.state === "failed") expect(outcome.reason).toBe("ci_check_wrong_head");
    });

    // F3: `find`-first would let an earlier successful "CI" check mask a second same-named
    // check's failure or incompleteness. Every check named "CI" must be terminal success.
    it("a second same-named CI check reporting failure is not masked by an earlier successful one", async () => {
      const runId = "probe-ci-duplicate-failure";
      const { ports } = createHarness(runId);
      const sourceControl = {
        ...ports.sourceControl,
        getCommitChecks: () =>
          Promise.resolve(
            ok({
              headSha: commitSha,
              aggregate: "pending" as const,
              checks: [
                { name: "CI", status: "completed" as const, conclusion: "success" as const },
                { name: "CI", status: "completed" as const, conclusion: "failure" as const },
              ],
            }),
          ),
      };
      const coordinator = createRegistrationProbeCoordinator({
        ports: { ...ports, sourceControl },
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("failed");
      if (outcome.state === "failed") expect(outcome.reason).toBe("ci_check_failed");
    });

    it("a second same-named CI check still in progress keeps polling rather than accepting the first success alone", async () => {
      const runId = "probe-ci-duplicate-pending";
      const { ports } = createHarness(runId);
      const sourceControl = {
        ...ports.sourceControl,
        getCommitChecks: () =>
          Promise.resolve(
            ok({
              headSha: commitSha,
              aggregate: "pending" as const,
              checks: [
                { name: "CI", status: "completed" as const, conclusion: "success" as const },
                { name: "CI", status: "in_progress" as const, conclusion: null },
              ],
            }),
          ),
      };
      const coordinator = createRegistrationProbeCoordinator({
        ports: { ...ports, sourceControl },
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("failed");
      if (outcome.state === "failed") expect(outcome.reason).toBe("ci_check_pending");
    });

    it("status set call failure fails as status_set_failed", async () => {
      const runId = "probe-status-setfail";
      const { ports } = createHarness(runId, { statusSet: "fail" });
      const coordinator = createRegistrationProbeCoordinator({
        ports,
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("failed");
      if (outcome.state === "failed") expect(outcome.reason).toBe("status_set_failed");
    });

    it("status readback never matches within the poll budget fails as status_readback_mismatch", async () => {
      const runId = "probe-status-mismatch";
      const { ports, counts } = createHarness(runId, { statusReadback: "mismatch" });
      const coordinator = createRegistrationProbeCoordinator({
        ports,
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("failed");
      if (outcome.state === "failed") expect(outcome.reason).toBe("status_readback_mismatch");
      expect(counts.statusSet).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------------------
  // AC-5: crash after intent, mutation success but response lost, unknown-outcome recovery.
  // ---------------------------------------------------------------------------------------
  describe("crash recovery and unknown-outcome handling (AC-5)", () => {
    it("Linear create: crash after intent but before mutation (proven absent) safely retries exactly once", async () => {
      const runId = "probe-crash-linear-absent";
      const { ports, counts, journal } = createHarness(runId, { linearRecovery: "absent" });
      seedRunAtPhase(journal.map, runId, "linear_mutation_started");
      const coordinator = createRegistrationProbeCoordinator({
        ports,
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
        providerEventPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("verified");
      expect(counts.linearCreate).toBe(1);
    });

    it("Linear create: mutation success but response lost is adopted via exact-marker recovery, never recreated", async () => {
      const runId = "probe-crash-linear-found";
      const { ports, counts, journal } = createHarness(runId, { linearRecovery: "found" });
      seedRunAtPhase(journal.map, runId, "linear_mutation_started");
      const coordinator = createRegistrationProbeCoordinator({
        ports,
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
        providerEventPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("verified");
      expect(counts.linearCreate).toBe(0);
    });

    it("Linear create: outcome cannot be proven either way -> cleanup_required, never recreated", async () => {
      const runId = "probe-crash-linear-unknown";
      const { ports, counts, journal } = createHarness(runId, { linearRecovery: "error" });
      seedRunAtPhase(journal.map, runId, "linear_mutation_started");
      const coordinator = createRegistrationProbeCoordinator({ ports, allowedWorktreeRoot });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("cleanup_required");
      expect(counts.linearCreate).toBe(0);
      if (outcome.state === "cleanup_required") {
        expect(outcome.run.cleanup.linearIssue.state).toBe("unknown");
      }
    });

    it("Branch push: crash after intent but before mutation (proven absent) safely retries exactly once", async () => {
      const runId = "probe-crash-branch-absent";
      const { ports, counts, journal } = createHarness(runId, { branchRecovery: "absent" });
      seedRunAtPhase(journal.map, runId, "branch_mutation_started", {
        linear: Object.freeze({ issueId: `issue-${runId}`, state: "created" as const }),
      });
      const coordinator = createRegistrationProbeCoordinator({
        ports,
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
        providerEventPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("verified");
      expect(counts.gitCreateWorktree).toBe(1);
      expect(counts.gitPush).toBe(1);
    });

    it("Branch push: mutation success but response lost is adopted via exact remote-head recovery, never re-pushed", async () => {
      const runId = "probe-crash-branch-found";
      const { ports, counts, journal } = createHarness(runId, { branchRecovery: "found" });
      seedRunAtPhase(journal.map, runId, "branch_mutation_started", {
        linear: Object.freeze({ issueId: `issue-${runId}`, state: "created" as const }),
      });
      const coordinator = createRegistrationProbeCoordinator({
        ports,
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
        providerEventPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("verified");
      expect(counts.gitCreateWorktree).toBe(0);
      expect(counts.gitPush).toBe(0);
    });

    it("Branch push: outcome cannot be proven either way -> cleanup_required, never re-pushed", async () => {
      const runId = "probe-crash-branch-unknown";
      const { ports, counts, journal } = createHarness(runId, { branchRecovery: "error" });
      seedRunAtPhase(journal.map, runId, "branch_mutation_started", {
        linear: Object.freeze({ issueId: `issue-${runId}`, state: "created" as const }),
      });
      const coordinator = createRegistrationProbeCoordinator({ ports, allowedWorktreeRoot });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("cleanup_required");
      expect(counts.gitCreateWorktree).toBe(0);
      expect(counts.gitPush).toBe(0);
    });

    it("mutation success but readback confirmation is lost still fails closed as branch_push_outcome_unknown", async () => {
      const runId = "probe-push-unconfirmed";
      const { ports, counts } = createHarness(runId, { gitPush: "unconfirmed" });
      const coordinator = createRegistrationProbeCoordinator({ ports, allowedWorktreeRoot });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("cleanup_required");
      expect(counts.gitPush).toBe(1);
    });

    it("Draft PR create: crash after intent but before mutation (proven absent) safely retries exactly once", async () => {
      const runId = "probe-crash-pr-absent";
      const { ports, counts, journal } = createHarness(runId, { prRecovery: "absent" });
      seedRunAtPhase(journal.map, runId, "draft_pr_mutation_started", {
        linear: Object.freeze({ issueId: `issue-${runId}`, state: "created" as const }),
        git: Object.freeze({ commitSha, pushedSha: commitSha }),
      });
      const coordinator = createRegistrationProbeCoordinator({
        ports,
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
        providerEventPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("verified");
      expect(counts.prCreate).toBe(1);
    });

    it("Draft PR create: mutation success but response lost is adopted via exact head recovery, never recreated", async () => {
      const runId = "probe-crash-pr-found";
      const { ports, counts, journal } = createHarness(runId, { prRecovery: "found" });
      seedRunAtPhase(journal.map, runId, "draft_pr_mutation_started", {
        linear: Object.freeze({ issueId: `issue-${runId}`, state: "created" as const }),
        git: Object.freeze({ commitSha, pushedSha: commitSha }),
      });
      const coordinator = createRegistrationProbeCoordinator({
        ports,
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
        providerEventPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("verified");
      expect(counts.prCreate).toBe(0);
    });

    it("Draft PR create: outcome cannot be proven either way -> cleanup_required, never recreated", async () => {
      const runId = "probe-crash-pr-unknown";
      const { ports, counts, journal } = createHarness(runId, { prRecovery: "error" });
      seedRunAtPhase(journal.map, runId, "draft_pr_mutation_started", {
        linear: Object.freeze({ issueId: `issue-${runId}`, state: "created" as const }),
        git: Object.freeze({ commitSha, pushedSha: commitSha }),
      });
      const coordinator = createRegistrationProbeCoordinator({ ports, allowedWorktreeRoot });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("cleanup_required");
      expect(counts.prCreate).toBe(0);
    });

    it("a duplicate call against an already-verified run replays the same outcome with zero new mutations", async () => {
      const runId = "probe-replay-verified";
      const shared = createMemoryJournal();
      const first = createHarness(runId, {}, shared);
      const coordinator1 = createRegistrationProbeCoordinator({
        ports: first.ports,
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
        providerEventPoll: fastPoll(),
      });
      const firstOutcome = await coordinator1.start(baseCommand(runId));
      expect(firstOutcome.state).toBe("verified");

      const second = createHarness(runId, {}, shared);
      const coordinator2 = createRegistrationProbeCoordinator({
        ports: second.ports,
        allowedWorktreeRoot,
      });
      const secondOutcome = await coordinator2.start(baseCommand(runId));
      expect(secondOutcome.state).toBe("verified");
      expectZeroMutations(second.counts);
    });
  });

  // ---------------------------------------------------------------------------------------
  // F2 (AC-5): resuming an in-flight run must re-earn the right to keep mutating -- a stale or
  // rotated authority, a different setup session, or drifted trusted config must all fail closed
  // before any further external mutation, exactly as a brand-new run would.
  // ---------------------------------------------------------------------------------------
  describe("resumed runs re-validate authority/session/config before further mutation (AC-5)", () => {
    it("rejects resuming with a setupSessionId that does not match how this run was created", async () => {
      const runId = "probe-resume-wrong-session";
      const shared = createMemoryJournal();
      // Seeded as if this run was originally created under a *different* setup session than the
      // one the harness's fixed `readActivation`/`mergedConfig` fakes represent as "current"
      // (the module-level `setupSessionId`); resuming with today's (unchanged, valid-looking)
      // command must still be rejected because it does not match the run's own origin.
      seedRunAtPhase(shared.map, runId, "linear_created", {
        linear: Object.freeze({ issueId: `issue-${runId}`, state: "created" as const }),
        activation: Object.freeze({
          setupSessionId: "setup-018f47d2-original-session",
          authoritativeRevision: mergeCommitSha,
          defaultBranch: project.defaultBranch,
          repository: project.sourceControl.repository,
          configDigest,
        }),
      });
      const { ports, counts } = createHarness(runId, {}, shared);
      const coordinator = createRegistrationProbeCoordinator({ ports, allowedWorktreeRoot });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome).toEqual({ state: "incomplete", reason: "activation_not_ready" });
      expectZeroMutations(counts);
    });

    it("rejects resuming with an authority that no longer matches the command (stale/rotated authority)", async () => {
      const runId = "probe-resume-bad-authority";
      const shared = createMemoryJournal();
      seedRunAtPhase(shared.map, runId, "linear_created", {
        linear: Object.freeze({ issueId: `issue-${runId}`, state: "created" as const }),
      });
      const { ports, counts } = createHarness(runId, {}, shared);
      const coordinator = createRegistrationProbeCoordinator({ ports, allowedWorktreeRoot });
      const outcome = await coordinator.start(
        baseCommand(runId, {
          authority: authorityFor({ setupSessionId: "setup-018f47d2-stale-authority" }),
        }),
      );
      expect(outcome).toEqual({ state: "incomplete", reason: "authority_invalid" });
      expectZeroMutations(counts);
    });

    it("rejects resuming when trusted config has drifted since the run was created (O005 config drift)", async () => {
      const runId = "probe-resume-config-drift";
      const shared = createMemoryJournal();
      seedRunAtPhase(shared.map, runId, "linear_created", {
        linear: Object.freeze({ issueId: `issue-${runId}`, state: "created" as const }),
      });
      const { ports, counts } = createHarness(runId, { activation: "config_mismatch" }, shared);
      const coordinator = createRegistrationProbeCoordinator({ ports, allowedWorktreeRoot });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome).toEqual({ state: "incomplete", reason: "activation_not_ready" });
      expectZeroMutations(counts);
    });

    it("rejects resuming when a fresh (internally-consistent) activation has rotated to a different authoritativeRevision than this run was created against", async () => {
      const runId = "probe-resume-rotated-activation";
      const shared = createMemoryJournal();
      seedRunAtPhase(shared.map, runId, "linear_created", {
        linear: Object.freeze({ issueId: `issue-${runId}`, state: "created" as const }),
      });
      const { ports, counts } = createHarness(runId, {}, shared);
      const rotatedRevision = "e".repeat(40);
      const rotatedMarker = Object.freeze({
        ...activationMarker,
        authoritativeRevision: rotatedRevision,
      });
      const rotatedConfig = Object.freeze({
        ...mergedConfigReceipt,
        authoritativeRevision: rotatedRevision,
      });
      const rotatedPorts: RegistrationProbePorts = {
        ...ports,
        activation: { readActivation: () => Promise.resolve(ok(rotatedMarker)) },
        mergedConfig: { read: () => Promise.resolve(ok(rotatedConfig)) },
      };
      const coordinator = createRegistrationProbeCoordinator({
        ports: rotatedPorts,
        allowedWorktreeRoot,
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome).toEqual({ state: "incomplete", reason: "activation_not_ready" });
      expectZeroMutations(counts);
    });

    it("still resumes normally when authority/session/config are unchanged", async () => {
      const runId = "probe-resume-ok";
      const shared = createMemoryJournal();
      seedRunAtPhase(shared.map, runId, "linear_created", {
        linear: Object.freeze({ issueId: `issue-${runId}`, state: "created" as const }),
      });
      const { ports } = createHarness(runId, {}, shared);
      const coordinator = createRegistrationProbeCoordinator({
        ports,
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
        providerEventPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("verified");
    });
  });

  // ---------------------------------------------------------------------------------------
  // AC-6: cleanup state machine — partial failure, ordering, and safe resume.
  // ---------------------------------------------------------------------------------------
  describe("cleanup state machine (AC-6)", () => {
    it("a Draft PR close failure still lets Linear cancel and worktree removal complete independently", async () => {
      const runId = "probe-cleanup-prfail";
      const { ports, counts } = createHarness(runId, { prClose: "fail" });
      const coordinator = createRegistrationProbeCoordinator({
        ports,
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
        providerEventPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("cleanup_required");
      if (outcome.state === "cleanup_required") {
        expect(outcome.run.cleanup.linearIssue.state).toBe("confirmed");
        expect(outcome.run.cleanup.draftPullRequest.state).toBe("failed");
        expect(outcome.run.cleanup.localWorktree.state).toBe("confirmed");
      }
      expect(counts.linearCancel).toBe(1);
      expect(counts.gitRemoveWorktree).toBe(1);
    });

    it("the remote branch is never deleted while the owning Draft PR is not confirmed closed (ordering guard)", async () => {
      const runId = "probe-cleanup-branchguard";
      const { ports, counts } = createHarness(runId, { prClose: "fail" });
      const coordinator = createRegistrationProbeCoordinator({
        ports,
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
        providerEventPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(counts.branchDelete).toBe(0);
      if (outcome.state === "cleanup_required") {
        expect(outcome.run.cleanup.remoteBranch.state).toBe("failed");
        expect(outcome.run.cleanup.remoteBranch.reason).toBe("cleanup_not_eligible");
      }
    });

    it("a foreign/collision branch delete failure is reported without blocking other cleanup", async () => {
      const runId = "probe-cleanup-branchcollision";
      const { ports, counts } = createHarness(runId, { branchDelete: "fail" });
      const coordinator = createRegistrationProbeCoordinator({
        ports,
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
        providerEventPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("cleanup_required");
      if (outcome.state === "cleanup_required") {
        expect(outcome.run.cleanup.remoteBranch.state).toBe("failed");
      }
      expect(counts.linearCancel).toBe(1);
      expect(counts.prClose).toBe(1);
      expect(counts.gitRemoveWorktree).toBe(1);
    });

    it("already-closed Draft PR and already-cancelled Linear issue readback is accepted as confirmed (idempotent recovery)", async () => {
      const runId = "probe-cleanup-idempotent";
      const { ports } = createHarness(runId);
      const coordinator = createRegistrationProbeCoordinator({
        ports,
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
        providerEventPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("verified");
      if (outcome.state === "verified") {
        expect(outcome.run.cleanup.linearIssue.reason).toBe("confirmed_cancelled");
        expect(outcome.run.cleanup.draftPullRequest.reason).toBe("confirmed_closed");
      }
    });

    it("a worktree that is not clean is never removed (safety guard), reported as cleanup_required", async () => {
      const runId = "probe-cleanup-dirty";
      const { ports, counts } = createHarness(runId, { worktreeClean: "dirty" });
      const coordinator = createRegistrationProbeCoordinator({
        ports,
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
        providerEventPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("cleanup_required");
      expect(counts.gitRemoveWorktree).toBe(0);
    });

    it("cleanup partial failure resumes on a later call and never redoes an already-confirmed item", async () => {
      const runId = "probe-cleanup-resume";
      const shared = createMemoryJournal();

      const firstAttempt = createHarness(runId, { prClose: "fail" }, shared);
      const coordinator1 = createRegistrationProbeCoordinator({
        ports: firstAttempt.ports,
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
        providerEventPoll: fastPoll(),
      });
      const firstOutcome = await coordinator1.start(baseCommand(runId));
      expect(firstOutcome.state).toBe("cleanup_required");
      expect(firstAttempt.counts.linearCancel).toBe(1);
      expect(firstAttempt.counts.prClose).toBe(1);
      expect(firstAttempt.counts.branchDelete).toBe(0);
      expect(firstAttempt.counts.gitRemoveWorktree).toBe(1);

      const secondAttempt = createHarness(runId, {}, shared);
      const coordinator2 = createRegistrationProbeCoordinator({
        ports: secondAttempt.ports,
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
        providerEventPoll: fastPoll(),
      });
      const secondOutcome = await coordinator2.start(baseCommand(runId));
      expect(secondOutcome.state).toBe("verified");
      // Already-confirmed items from the first attempt must not be redone.
      expect(secondAttempt.counts.linearCancel).toBe(0);
      expect(secondAttempt.counts.gitRemoveWorktree).toBe(0);
      // The previously-failed / not-yet-eligible items are retried exactly once.
      expect(secondAttempt.counts.prClose).toBe(1);
      expect(secondAttempt.counts.branchDelete).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------------------
  // F4 (AC-4 / AC-6): the harness already declares failure-injection switches for every probe
  // stage; each one must actually be exercised at least once, proving (a) the outcome's stage/
  // reason (or cleanup_required), (b) already-created artifacts are still cleaned up, and (c)
  // never-created artifacts are never mutated.
  // ---------------------------------------------------------------------------------------
  describe("every probe-stage failure injection proves exact cleanup (F4, AC-4/AC-6)", () => {
    it("Linear create failure (linearCreate: fail) leaves nothing else to clean up", async () => {
      const runId = "probe-inject-linearcreate-fail";
      const { ports, counts } = createHarness(runId, { linearCreate: "fail" });
      const coordinator = createRegistrationProbeCoordinator({ ports, allowedWorktreeRoot });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("cleanup_required");
      if (outcome.state === "cleanup_required") {
        expect(outcome.run.failure).toEqual({
          stage: "linear_create",
          reason: "linear_create_failed",
        });
        expect(outcome.run.cleanup.linearIssue.state).toBe("failed");
      }
      expect(counts.linearCreate).toBe(1);
      expect(counts.linearCancel).toBe(0);
      expect(counts.gitCreateWorktree).toBe(0);
      expect(counts.prCreate).toBe(0);
    });

    it("Linear create readback mismatch (linearRead: mismatch) is an unknown outcome, not accepted or recreated", async () => {
      const runId = "probe-inject-linearread-mismatch";
      const { ports, counts } = createHarness(runId, { linearRead: "mismatch" });
      const coordinator = createRegistrationProbeCoordinator({ ports, allowedWorktreeRoot });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("cleanup_required");
      if (outcome.state === "cleanup_required") {
        expect(outcome.run.failure).toEqual({
          stage: "linear_create",
          reason: "linear_create_outcome_unknown",
        });
        expect(outcome.run.cleanup.linearIssue.state).toBe("unknown");
      }
      expect(counts.linearCreate).toBe(1);
      expect(counts.gitCreateWorktree).toBe(0);
    });

    it("Linear create readback itself erroring (linearRead: error) is an unknown outcome", async () => {
      const runId = "probe-inject-linearread-error";
      const { ports, counts } = createHarness(runId, { linearRead: "error" });
      const coordinator = createRegistrationProbeCoordinator({ ports, allowedWorktreeRoot });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("cleanup_required");
      if (outcome.state === "cleanup_required") {
        expect(outcome.run.failure).toEqual({
          stage: "linear_create",
          reason: "linear_create_outcome_unknown",
        });
      }
      expect(counts.linearCreate).toBe(1);
      expect(counts.gitCreateWorktree).toBe(0);
    });

    it("Git worktree creation failure (gitCreateWorktree: fail) still cancels the already-created Linear issue", async () => {
      const runId = "probe-inject-worktree-fail";
      const { ports, counts } = createHarness(runId, { gitCreateWorktree: "fail" });
      const coordinator = createRegistrationProbeCoordinator({ ports, allowedWorktreeRoot });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("cleanup_required");
      if (outcome.state === "cleanup_required") {
        expect(outcome.run.failure).toEqual({
          stage: "branch_push",
          reason: "branch_push_failed",
        });
        expect(outcome.run.cleanup.linearIssue.state).toBe("confirmed");
      }
      expect(counts.linearCreate).toBe(1);
      expect(counts.linearCancel).toBe(1);
      expect(counts.prCreate).toBe(0);
      expect(counts.branchDelete).toBe(0);
      expect(counts.gitRemoveWorktree).toBe(0);
    });

    it("Git push failure (gitPush: fail) still cancels the already-created Linear issue", async () => {
      const runId = "probe-inject-push-fail";
      const { ports, counts } = createHarness(runId, { gitPush: "fail" });
      const coordinator = createRegistrationProbeCoordinator({ ports, allowedWorktreeRoot });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("cleanup_required");
      if (outcome.state === "cleanup_required") {
        expect(outcome.run.failure).toEqual({
          stage: "branch_push",
          reason: "branch_push_outcome_unknown",
        });
        expect(outcome.run.cleanup.remoteBranch.state).toBe("unknown");
      }
      expect(counts.gitCreateWorktree).toBe(1);
      expect(counts.linearCancel).toBe(1);
      expect(counts.prCreate).toBe(0);
      expect(counts.branchDelete).toBe(0);
      expect(counts.gitRemoveWorktree).toBe(0);
    });

    it("Draft PR create failure (prCreate: fail) still cancels Linear and removes the local worktree, but never touches the never-created PR's branch", async () => {
      const runId = "probe-inject-prcreate-fail";
      const { ports, counts } = createHarness(runId, { prCreate: "fail" });
      const coordinator = createRegistrationProbeCoordinator({
        ports,
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
        providerEventPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("cleanup_required");
      if (outcome.state === "cleanup_required") {
        expect(outcome.run.failure).toEqual({
          stage: "draft_pull_request",
          reason: "draft_pr_create_failed",
        });
        expect(outcome.run.cleanup.linearIssue.state).toBe("confirmed");
        expect(outcome.run.cleanup.draftPullRequest.state).toBe("failed");
        expect(outcome.run.cleanup.remoteBranch).toEqual({
          state: "failed",
          reason: "cleanup_not_eligible",
        });
        expect(outcome.run.cleanup.localWorktree.state).toBe("confirmed");
      }
      expect(counts.linearCancel).toBe(1);
      expect(counts.gitRemoveWorktree).toBe(1);
      expect(counts.prClose).toBe(0);
      expect(counts.branchDelete).toBe(0);
    });

    it("a created PR that is not draft=true is an unknown/leaked outcome, never accepted (AC-4, prCreate: not_draft)", async () => {
      const runId = "probe-inject-pr-not-draft";
      const { ports, counts } = createHarness(runId, { prCreate: "not_draft" });
      const coordinator = createRegistrationProbeCoordinator({
        ports,
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
        providerEventPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("cleanup_required");
      if (outcome.state === "cleanup_required") {
        expect(outcome.run.failure).toEqual({
          stage: "draft_pull_request",
          reason: "draft_pr_create_outcome_unknown",
        });
        expect(outcome.run.draftPullRequest).toBeUndefined();
        expect(outcome.run.cleanup.draftPullRequest.state).toBe("unknown");
        expect(outcome.run.cleanup.remoteBranch).toEqual({
          state: "failed",
          reason: "cleanup_not_eligible",
        });
        expect(outcome.run.cleanup.localWorktree.state).toBe("confirmed");
      }
      expect(counts.prCreate).toBe(1);
      expect(counts.prClose).toBe(0);
      expect(counts.branchDelete).toBe(0);
      expect(counts.linearCancel).toBe(1);
    });

    it("Linear cancel failure during cleanup (linearCancel: fail) does not block PR close, branch delete, or worktree removal", async () => {
      const runId = "probe-inject-linearcancel-fail";
      const { ports, counts } = createHarness(runId, { linearCancel: "fail" });
      const coordinator = createRegistrationProbeCoordinator({
        ports,
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
        providerEventPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("cleanup_required");
      if (outcome.state === "cleanup_required") {
        expect(outcome.run.cleanup.linearIssue.state).toBe("failed");
        expect(outcome.run.cleanup.draftPullRequest.state).toBe("confirmed");
        expect(outcome.run.cleanup.remoteBranch.state).toBe("confirmed");
        expect(outcome.run.cleanup.localWorktree.state).toBe("confirmed");
      }
      expect(counts.prClose).toBe(1);
      expect(counts.branchDelete).toBe(1);
      expect(counts.gitRemoveWorktree).toBe(1);
    });

    it("preflight fails closed with zero mutation when GitHub capability inspect itself errors (githubCapabilityError)", async () => {
      const runId = "probe-inject-githubcap-error";
      const { ports, counts } = createHarness(runId, { githubCapabilityError: true });
      const coordinator = createRegistrationProbeCoordinator({ ports, allowedWorktreeRoot });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome).toEqual({ state: "incomplete", reason: "github_capability_incomplete" });
      expectZeroMutations(counts);
    });
  });

  // ---------------------------------------------------------------------------------------
  // F1 (AC-5): a CAS conflict writing a cleanup `*_mutation_started` phase (a concurrent writer,
  // or a stale revision) must skip that cleanup item's external mutation entirely -- never send
  // cancel/close/delete/remove on a journal write we know did not durably win -- and must still
  // surface as `cleanup_required` rather than silently being treated as clean.
  // ---------------------------------------------------------------------------------------
  describe("a CAS conflict during cleanup skips the external mutation (F1, AC-5)", () => {
    function withCasFailureOn(
      underlying: ReturnType<typeof createMemoryJournal>,
      failOnPhase: RegistrationProbeRun["phase"],
    ): RegistrationProbeJournalPort & { readonly map: Map<string, RegistrationProbeRun> } {
      return {
        map: underlying.map,
        load: (runId, options) => underlying.load(runId, options),
        listActiveForProject: (projectId, options) =>
          underlying.listActiveForProject(projectId, options),
        compareAndSwap: (runId, expectedRevision, next, options) => {
          if (next.phase === failOnPhase) {
            return Promise.resolve(err(domainError("conflict")));
          }
          return underlying.compareAndSwap(runId, expectedRevision, next, options);
        },
      };
    }

    it("a CAS conflict writing cleanup_linear_mutation_started never calls Linear cancel", async () => {
      const runId = "probe-cas-cleanup-linear";
      const { ports, counts, journal } = createHarness(runId);
      const coordinator = createRegistrationProbeCoordinator({
        ports: { ...ports, journal: withCasFailureOn(journal, "cleanup_linear_mutation_started") },
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
        providerEventPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("cleanup_required");
      if (outcome.state === "cleanup_required") {
        expect(outcome.run.cleanup.linearIssue).toEqual({
          state: "unknown",
          reason: "cleanup_outcome_unknown",
        });
      }
      expect(counts.linearCancel).toBe(0);
      // Other cleanup items, whose own CAS writes were not intercepted, still complete normally.
      expect(counts.prClose).toBe(1);
      expect(counts.branchDelete).toBe(1);
      expect(counts.gitRemoveWorktree).toBe(1);
    });

    it("a CAS conflict writing cleanup_pr_mutation_started never calls Draft PR close", async () => {
      const runId = "probe-cas-cleanup-pr";
      const { ports, counts, journal } = createHarness(runId);
      const coordinator = createRegistrationProbeCoordinator({
        ports: { ...ports, journal: withCasFailureOn(journal, "cleanup_pr_mutation_started") },
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
        providerEventPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("cleanup_required");
      if (outcome.state === "cleanup_required") {
        expect(outcome.run.cleanup.draftPullRequest).toEqual({
          state: "unknown",
          reason: "cleanup_outcome_unknown",
        });
        // The branch must not be deleted while the PR's close outcome is unknown.
        expect(outcome.run.cleanup.remoteBranch.state).not.toBe("confirmed");
      }
      expect(counts.prClose).toBe(0);
      expect(counts.branchDelete).toBe(0);
      expect(counts.linearCancel).toBe(1);
      expect(counts.gitRemoveWorktree).toBe(1);
    });

    it("a CAS conflict writing cleanup_branch_mutation_started never calls branch delete", async () => {
      const runId = "probe-cas-cleanup-branch";
      const { ports, counts, journal } = createHarness(runId);
      const coordinator = createRegistrationProbeCoordinator({
        ports: { ...ports, journal: withCasFailureOn(journal, "cleanup_branch_mutation_started") },
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
        providerEventPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("cleanup_required");
      if (outcome.state === "cleanup_required") {
        expect(outcome.run.cleanup.remoteBranch).toEqual({
          state: "unknown",
          reason: "cleanup_outcome_unknown",
        });
      }
      expect(counts.branchDelete).toBe(0);
      expect(counts.linearCancel).toBe(1);
      expect(counts.prClose).toBe(1);
      expect(counts.gitRemoveWorktree).toBe(1);
    });

    it("a CAS conflict writing cleanup_worktree_mutation_started never calls worktree removal", async () => {
      const runId = "probe-cas-cleanup-worktree";
      const { ports, counts, journal } = createHarness(runId);
      const coordinator = createRegistrationProbeCoordinator({
        ports: {
          ...ports,
          journal: withCasFailureOn(journal, "cleanup_worktree_mutation_started"),
        },
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
        providerEventPoll: fastPoll(),
      });
      const outcome = await coordinator.start(baseCommand(runId));
      expect(outcome.state).toBe("cleanup_required");
      if (outcome.state === "cleanup_required") {
        expect(outcome.run.cleanup.localWorktree).toEqual({
          state: "unknown",
          reason: "cleanup_outcome_unknown",
        });
      }
      expect(counts.gitRemoveWorktree).toBe(0);
      expect(counts.linearCancel).toBe(1);
      expect(counts.prClose).toBe(1);
      expect(counts.branchDelete).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------------------
  // O4: two coordinators racing the reservation CAS for the very same brand-new run. Only one
  // may win; the other must back off with zero mutation rather than both proceeding.
  // ---------------------------------------------------------------------------------------
  describe("two coordinators racing to start the same brand-new run (O4, AC-5)", () => {
    it("exactly one coordinator wins the reservation; the other backs off with zero mutation", async () => {
      const runId = "probe-concurrent-race";
      const shared = createMemoryJournal();
      const first = createHarness(runId, {}, shared);
      const second = createHarness(runId, {}, shared);
      const coordinator1 = createRegistrationProbeCoordinator({
        ports: first.ports,
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
        providerEventPoll: fastPoll(),
      });
      const coordinator2 = createRegistrationProbeCoordinator({
        ports: second.ports,
        allowedWorktreeRoot,
        ciPoll: fastPoll(),
        statusPoll: fastPoll(),
        providerEventPoll: fastPoll(),
      });

      const [outcome1, outcome2] = await Promise.all([
        coordinator1.start(baseCommand(runId)),
        coordinator2.start(baseCommand(runId)),
      ]);

      const outcomes = [
        { outcome: outcome1, counts: first.counts },
        { outcome: outcome2, counts: second.counts },
      ];
      const winners = outcomes.filter(({ outcome }) => outcome.state === "verified");
      const losers = outcomes.filter(({ outcome }) => outcome.state === "incomplete");
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      const loser = losers[0];
      if (loser?.outcome.state === "incomplete") {
        expect(loser.outcome.reason).toBe("concurrent_run_exists");
        expectZeroMutations(loser.counts);
      }
    });
  });

  // ---------------------------------------------------------------------------------------
  // AC-7: layering — application never imports the CLI or a Node transport directly.
  // ---------------------------------------------------------------------------------------
  describe("layering (AC-7)", () => {
    it("the O006 application sources never reference src/cli", async () => {
      const { readFile } = await import("node:fs/promises");
      const files = [
        "src/application/registration/proactive-probe.ts",
        "src/application/registration/proactive-probe-model.ts",
        "src/application/ports/registration-proactive-probe.ts",
      ];
      for (const file of files) {
        const content = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
        expect(content).not.toMatch(/src\/cli/u);
        expect(content).not.toMatch(/from ["']\.\.\/\.\.\/cli/u);
      }
    });
  });
});
