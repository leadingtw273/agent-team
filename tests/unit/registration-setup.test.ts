import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  RegistrationSetupCoordinator,
  createRegistrationSetupApplication,
  createRegistrationSetupPreview,
  type RegistrationSetupPorts,
  type RegistrationSetupJournal,
  type RegistrationSetupJournalStep,
  type RegistrationSetupFinalApprovalReceipt,
  type RegistrationSetupExecutionLease,
  type RegistrationSetupSession,
} from "../../src/application/registration/index.js";
import {
  serializeTrustedProjectConfig,
  trustedProjectConfigPath,
  trustedProjectConfigSchema,
} from "../../src/application/projects/index.js";
import { domainError, err, ok } from "../../src/domain/foundation/index.js";
import { projectSchema } from "../../src/domain/project/index.js";
import type {
  ChangeRequestSnapshot,
  CommitChecksSnapshot,
  CommitStatusesSnapshot,
} from "../../src/application/ports/index.js";
import { sha256Digest } from "../../src/domain/review/index.js";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const now = "2026-08-05T12:00:00.000Z";
const project = projectSchema.parse({
  schemaVersion: 1,
  id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  displayName: "Sandbox",
  localRepositoryPath: "/tmp/sandbox",
  defaultBranch: "main",
  workManagement: { provider: "linear", containerId: "workspace", projectId: "linear-project" },
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
const serializedConfig = serializeTrustedProjectConfig(config);
if (!serializedConfig.ok) throw new Error(serializedConfig.error.code);
const configDigest = serializedConfig.value.contentDigest;
const configContent = serializedConfig.value.content;
const uiSessionDigest = "1".repeat(64);
const approvalNonceDigest = "2".repeat(64);
function digest(value: string) {
  const result = sha256Digest(value);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
const previewResult = createRegistrationSetupPreview({
  schemaVersion: 1,
  setupSessionId: "setup-session-1",
  project,
  config,
  baseRevision: baseSha,
  worktreePath: "/tmp/setup-worktree",
  branch: "agent-team/setup",
  remote: "origin",
  linearAuditIssueId: "LINEAR-AUDIT-1",
});
if (!previewResult.ok) throw new Error(previewResult.error.code);
const preview = previewResult.value;

function changeRequest(overrides: Partial<ChangeRequestSnapshot> = {}): ChangeRequestSnapshot {
  return {
    id: "PR_node_1",
    number: 42,
    url: "https://github.test/owner/sandbox/pull/42",
    state: "open",
    draft: true,
    baseBranch: "main",
    headBranch: "agent-team/setup",
    headSha,
    mergeability: "mergeable",
    autoMergeEnabled: false,
    updatedAt: now as ChangeRequestSnapshot["updatedAt"],
    ...overrides,
  };
}

function checks(
  aggregate: CommitChecksSnapshot["aggregate"] = "success",
  sha = headSha,
): CommitChecksSnapshot {
  return {
    headSha: sha,
    aggregate,
    checks: [
      {
        name: "quality",
        status: "completed",
        conclusion: aggregate === "success" ? "success" : "failure",
      },
    ],
  };
}

function statuses(
  state: "pending" | "success" | "failure" = "success",
  sha = headSha,
): CommitStatusesSnapshot {
  return {
    headSha: sha,
    statuses: [{ context: "agent-team/review", state, targetUrl: "https://review.test/evidence" }],
  };
}

interface HarnessOptions {
  readonly fail?: "worktree" | "write" | "merge" | "activation";
  readonly mergeFailOnce?: boolean;
  readonly mergeReceiptSaveCrash?: boolean;
  readonly ci?: CommitChecksSnapshot;
  readonly review?: CommitStatusesSnapshot;
  readonly driftDiff?: boolean;
  readonly driftHead?: boolean;
  readonly mergePendingDrift?: "gate" | "head" | "diff";
  readonly recoveryDiffAttack?: "extra" | "mode" | "rename" | "symlink" | "submodule" | "object";
  readonly barrierStep?: RegistrationSetupJournalStep;
  readonly mergedReadBack?: boolean;
  readonly approvalAuthority?: "mismatch" | "replay" | "rejected" | "unknown" | "unavailable";
  readonly crashAfter?: RegistrationSetupJournalStep;
  readonly consumeSessionSaveCrash?: boolean;
  readonly unknownJournalDurability?: boolean;
  readonly unknownSessionDurability?: boolean;
  readonly activationReceipt?:
    | "wrong_source"
    | "wrong_setup_session"
    | "wrong_project"
    | "wrong_revision"
    | "wrong_branch"
    | "wrong_digest"
    | "wrong_session"
    | "wrong_authority"
    | "wrong_nonce";
  readonly activationIndexFailOnce?: boolean;
  readonly ownershipLossAt?: number;
  readonly journalIntentSaveFail?: RegistrationSetupJournalStep;
  readonly ownershipLossAfterEffect?: RegistrationSetupJournalStep;
  readonly mergedConfigReadBack?:
    "unavailable" | "config_drift" | "wrong_branch" | "wrong_revision" | "wrong_source";
  readonly auditFailure?: "linear" | "pull_request";
  readonly auditReceiptSaveCrash?: "linear" | "pull_request";
}

function harness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  const sessions = new Map<string, RegistrationSetupSession>();
  const journals = new Map<string, RegistrationSetupJournal>();
  let diffReads = 0;
  let localHeadSha = baseSha;
  let stagedConfig = false;
  let lastCommitMessage = "";
  let injectedCrash = false;
  let injectedConsumeSaveCrash = false;
  let injectedAuditReceiptSaveCrash = false;
  let injectedMergeFailure = false;
  let injectedMergeReceiptSaveCrash = false;
  let activationMarker:
    | import("../../src/application/registration/index.js").RegistrationSetupActivationMarker
    | undefined;
  let activationIndex:
    | import("../../src/application/registration/index.js").RegistrationSetupActivationMarker
    | undefined;
  let injectedActivationIndexFailure = false;
  let consumedApprovalOperation: string | undefined;
  let consumedApprovalReceipt: RegistrationSetupFinalApprovalReceipt | undefined;
  const publishedAudit = new Map<
    string,
    Awaited<ReturnType<RegistrationSetupPorts["audit"]["publish"]>>
  >();
  let executing = false;
  let executionEpoch = 0;
  let ownershipAssertions = 0;
  let barrierUsed = false;
  let releaseBarrier = (): void => undefined;
  let announceBarrier = (): void => undefined;
  const barrierReached = new Promise<void>((resolveBarrier) => {
    announceBarrier = resolveBarrier;
  });
  const barrierRelease = new Promise<void>((resolveBarrier) => {
    releaseBarrier = resolveBarrier;
  });
  const pauseAtBarrier = async (step: RegistrationSetupJournalStep): Promise<void> => {
    if (options.barrierStep !== step || barrierUsed) return;
    barrierUsed = true;
    announceBarrier();
    await barrierRelease;
  };
  const mutationKeys: Readonly<{ step: string; key: string }>[] = [];
  let current = changeRequest();
  const blobBytes = Buffer.from(configContent, "utf8");
  const configObjectId = createHash("sha1")
    .update(`blob ${String(blobBytes.byteLength)}\0`, "utf8")
    .update(blobBytes)
    .digest("hex");
  const treeDiff = (drift = false) => {
    const trusted = {
      before:
        options.recoveryDiffAttack === "rename"
          ? {
              path: ".agent-team/renamed-from.json",
              mode: "100644" as const,
              objectId: { algorithm: "sha1" as const, value: "d".repeat(40) },
            }
          : null,
      after: {
        path: trustedProjectConfigPath,
        mode:
          options.recoveryDiffAttack === "mode"
            ? ("100755" as const)
            : options.recoveryDiffAttack === "symlink"
              ? ("120000" as const)
              : options.recoveryDiffAttack === "submodule"
                ? ("160000" as const)
                : ("100644" as const),
        objectId: {
          algorithm: "sha1" as const,
          value: drift || options.recoveryDiffAttack === "object" ? "d".repeat(40) : configObjectId,
        },
      },
    };
    return options.recoveryDiffAttack === "extra"
      ? [
          trusted,
          {
            before: null,
            after: {
              path: ".agent-team/evil",
              mode: "100644" as const,
              objectId: { algorithm: "sha1" as const, value: "f".repeat(40) },
            },
          },
        ]
      : [trusted];
  };
  const ports: RegistrationSetupPorts = {
    execution: {
      runExclusive: async (_setupSessionId, action) => {
        if (executing) return ok({ state: "in_progress" as const });
        executing = true;
        executionEpoch += 1;
        const lease: RegistrationSetupExecutionLease = {
          fence: {
            schemaVersion: 1,
            setupSessionId: preview.setupSessionId,
            epoch: executionEpoch,
            lockIdentity: {
              device: 1,
              inode: 1,
              generation: "00000000-0000-4000-8000-000000000001",
              ownerDigest: preview.previewDigest,
              changeEpoch: "1",
            },
            ownerDigest: preview.previewDigest,
          },
          assertOwnershipSync: () =>
            (options.ownershipLossAt !== undefined &&
              ownershipAssertions >= options.ownershipLossAt) ||
            (options.ownershipLossAfterEffect !== undefined &&
              calls.includes(options.ownershipLossAfterEffect))
              ? err(domainError("conflict"))
              : ok(undefined),
          assertOwnership: () => {
            ownershipAssertions += 1;
            return Promise.resolve(
              (options.ownershipLossAt !== undefined &&
                ownershipAssertions >= options.ownershipLossAt) ||
                (options.ownershipLossAfterEffect !== undefined &&
                  calls.includes(options.ownershipLossAfterEffect))
                ? err(domainError("conflict"))
                : ok(undefined),
            );
          },
        };
        try {
          return ok({ state: "completed" as const, value: await action(lease) });
        } finally {
          executing = false;
        }
      },
    },
    git: {
      createWorktree: async (_command, mutationOptions) => {
        calls.push("worktree");
        mutationKeys.push({ step: "worktree", key: mutationOptions.idempotencyKey });
        await pauseAtBarrier("worktree");
        return options.fail === "worktree"
          ? err(domainError("external_failure"))
          : ok({
              repositoryRoot: project.localRepositoryPath,
              path: preview.worktreePath,
              branch: preview.branch,
              headSha: baseSha,
            });
      },
      stagePaths: async (_worktree, paths, mutationOptions) => {
        calls.push("stage");
        mutationKeys.push({ step: "stage", key: mutationOptions.idempotencyKey });
        await pauseAtBarrier("stage");
        stagedConfig = true;
        return ok({
          headSha: baseSha,
          changes: paths.map((path) => ({
            path,
            kind: "untracked" as const,
            mode: "file" as const,
            staged: true,
          })),
        });
      },
      commit: async (command, mutationOptions) => {
        calls.push("commit");
        mutationKeys.push({ step: "commit", key: mutationOptions.idempotencyKey });
        await pauseAtBarrier("commit");
        localHeadSha = headSha;
        stagedConfig = false;
        lastCommitMessage = command.message;
        return ok({ sha: headSha, branch: preview.branch });
      },
      inspectWorkingTree: () =>
        Promise.resolve(
          ok({
            headSha: localHeadSha,
            changes: stagedConfig
              ? [
                  {
                    path: trustedProjectConfigPath,
                    kind: "untracked" as const,
                    mode: "file" as const,
                    staged: true,
                  },
                ]
              : [],
          }),
        ),
      push: async (_worktree, _remote, mutationOptions) => {
        calls.push("push");
        mutationKeys.push({ step: "push", key: mutationOptions.idempotencyKey });
        await pauseAtBarrier("push");
        return ok({ remote: "origin", branch: preview.branch, sha: headSha });
      },
      getEffectiveTreeDiff: () => {
        calls.push("diff");
        diffReads += 1;
        return Promise.resolve(
          ok(
            treeDiff(
              (options.driftDiff === true && diffReads > 1) ||
                (options.mergePendingDrift === "diff" && calls.includes("save:merge_pending")),
            ),
          ),
        );
      },
      getStagedTreeDiff: () =>
        Promise.resolve(
          ok(
            stagedConfig
              ? [
                  {
                    before: null,
                    after: {
                      path: trustedProjectConfigPath,
                      mode: "100644" as const,
                      objectId: { algorithm: "sha1" as const, value: configObjectId },
                    },
                  },
                ]
              : [],
          ),
        ),
      inspectCommit: () =>
        Promise.resolve(
          ok({
            sha: localHeadSha,
            treeSha: "e".repeat(40),
            parentShas: [baseSha],
            message: lastCommitMessage,
          }),
        ),
    },
    preflight: {
      inspect: () => {
        calls.push("preflight");
        return Promise.resolve(
          ok({
            headSha: baseSha,
            allowed: true,
            scopeVerified: true,
            changedPaths: [trustedProjectConfigPath],
            findings: [],
          }),
        );
      },
    },
    previewConfirmation: {
      verify: () => {
        calls.push("preview-confirmation");
        return Promise.resolve(ok({ state: "verified" as const }));
      },
    },
    setupFiles: {
      writeTrustedProjectConfig: async (command, mutationOptions) => {
        calls.push("write");
        mutationKeys.push({ step: "write", key: mutationOptions.idempotencyKey });
        await pauseAtBarrier("write");
        return options.fail === "write"
          ? err(domainError("external_failure"))
          : ok({ path: command.path, contentDigest: command.contentDigest });
      },
      readTrustedProjectConfig: () =>
        Promise.resolve(
          ok({
            path: trustedProjectConfigPath,
            content: configContent,
            contentDigest: configDigest,
          }),
        ),
    },
    sourceControl: {
      createDraftChangeRequest: async (_command, mutationOptions) => {
        calls.push("draft-pr");
        mutationKeys.push({ step: "draft_pull_request", key: mutationOptions.idempotencyKey });
        await pauseAtBarrier("draft_pull_request");
        return ok(current);
      },
      getChangeRequest: () => {
        calls.push("pr-read");
        if (
          options.driftHead ||
          (options.mergePendingDrift === "head" && calls.includes("save:merge_pending"))
        )
          return Promise.resolve(ok(changeRequest({ headSha: "f".repeat(40) })));
        if (options.mergedReadBack && current.autoMergeEnabled)
          current = changeRequest({ state: "merged", draft: false, autoMergeEnabled: true });
        return Promise.resolve(ok(current));
      },
      getCommitChecks: () => {
        calls.push("ci-read");
        return Promise.resolve(ok(options.ci ?? checks()));
      },
      getCommitStatuses: () => {
        calls.push("review-read");
        return Promise.resolve(ok(options.review ?? statuses()));
      },
      markChangeRequestReady: () => {
        calls.push("ready");
        current = changeRequest({ draft: false });
        return Promise.resolve(ok(current));
      },
    },
    gateEvidence: {
      read: (command) => {
        calls.push("ci-read", "review-read");
        if (options.mergePendingDrift === "gate" && calls.includes("save:merge_pending")) {
          return Promise.resolve(
            ok({ state: "not_ready" as const, reason: "review_failed" as const }),
          );
        }
        const ci = options.ci ?? checks();
        const review = options.review ?? statuses();
        if (ci.headSha !== command.expectedHeadSha || review.headSha !== command.expectedHeadSha) {
          return Promise.resolve(err(domainError("conflict")));
        }
        if (ci.aggregate !== "success") {
          return Promise.resolve(
            ok({
              state: "not_ready" as const,
              reason: ci.aggregate === "pending" ? ("ci_pending" as const) : ("ci_failed" as const),
            }),
          );
        }
        const matches = review.statuses.filter((item) => item.context === "agent-team/review");
        const currentReview = matches[0];
        if (
          matches.length !== 1 ||
          currentReview?.state !== "success" ||
          currentReview.targetUrl === undefined
        ) {
          return Promise.resolve(
            ok({
              state: "not_ready" as const,
              reason:
                currentReview?.state === "pending" || currentReview === undefined
                  ? ("review_pending" as const)
                  : ("review_failed" as const),
            }),
          );
        }
        const receiptBinding = {
          schemaVersion: 1 as const,
          source: "source_control" as const,
          projectId: command.project.id,
          repository: command.project.sourceControl.repository,
          changeRequestId: command.changeRequestId,
          headSha: command.expectedHeadSha,
          requirementsDigest: command.requirementsDigest,
          diffDigest: command.diffDigest,
          ciChecksDigest: "3".repeat(64) as typeof preview.requirementsDigest,
          reviewContext: "agent-team/review" as const,
          reviewEvidenceUrl: currentReview.targetUrl,
        };
        const evidenceDigest = sha256Digest({
          kind: "registration_setup_gate_evidence",
          ...receiptBinding,
        });
        if (!evidenceDigest.ok) return Promise.resolve(evidenceDigest);
        return Promise.resolve(
          ok({
            state: "ready" as const,
            receipt: { ...receiptBinding, evidenceDigest: evidenceDigest.value },
          }),
        );
      },
    },
    audit: {
      publish: (intent) => {
        const existing = publishedAudit.get(intent.idempotencyKey);
        if (existing !== undefined) return Promise.resolve(existing);
        if (options.auditFailure === intent.destination) {
          return Promise.resolve(err(domainError("unavailable")));
        }
        calls.push(`audit-${intent.destination}`);
        const operationDigest = sha256Digest(intent.idempotencyKey);
        if (!operationDigest.ok) return Promise.resolve(operationDigest);
        const { kind: _kind, body: _body, idempotencyKey: _key, ...binding } = intent;
        void _kind;
        void _body;
        void _key;
        const result = ok({
          ...binding,
          externalCommentId: `${intent.destination}-comment-1`,
          idempotencyKeyDigest: operationDigest.value,
          createdAt: now,
          reused: false,
        });
        publishedAudit.set(intent.idempotencyKey, result);
        return Promise.resolve(result);
      },
    },
    journal: {
      load: (sessionId) => Promise.resolve(ok(journals.get(sessionId))),
      save: (expectedRevision, draft) => {
        const currentJournal = journals.get(draft.setupSessionId);
        if (
          (expectedRevision === undefined && currentJournal !== undefined) ||
          (expectedRevision !== undefined && currentJournal?.revision !== expectedRevision)
        ) {
          return Promise.resolve(err(domainError("conflict")));
        }
        calls.push(
          currentJournal === undefined
            ? "journal:planned"
            : draft.pending === undefined
              ? "journal:receipt"
              : `journal:intent:${draft.pending.step}`,
        );
        if (
          options.journalIntentSaveFail !== undefined &&
          draft.pending?.step === options.journalIntentSaveFail &&
          currentJournal?.pending === undefined
        ) {
          return Promise.resolve(err(domainError("external_failure")));
        }
        if (
          !injectedCrash &&
          options.crashAfter !== undefined &&
          currentJournal?.pending?.step === options.crashAfter &&
          draft.pending === undefined
        ) {
          injectedCrash = true;
          return Promise.resolve(err(domainError("external_failure")));
        }
        const journal = { ...draft, revision: (currentJournal?.revision ?? 0) + 1 };
        journals.set(draft.setupSessionId, journal);
        return Promise.resolve(
          ok({
            durability:
              options.unknownJournalDurability && draft.pending !== undefined
                ? ("unknown" as const)
                : ("confirmed" as const),
            journal,
          }),
        );
      },
    },
    sessions: {
      load: (sessionId) => Promise.resolve(ok(sessions.get(sessionId))),
      save: (_expectedRevision, draft) => {
        const currentSession = sessions.get(draft.setupSessionId);
        if (
          options.mergeReceiptSaveCrash === true &&
          !injectedMergeReceiptSaveCrash &&
          currentSession?.phase === "merge_pending" &&
          currentSession.mergeReceipt === undefined &&
          draft.mergeReceipt !== undefined
        ) {
          injectedMergeReceiptSaveCrash = true;
          return Promise.resolve(err(domainError("external_failure")));
        }
        if (
          options.auditReceiptSaveCrash !== undefined &&
          !injectedAuditReceiptSaveCrash &&
          currentSession?.audit?.pending?.destination === options.auditReceiptSaveCrash &&
          draft.audit?.pending === undefined
        ) {
          injectedAuditReceiptSaveCrash = true;
          return Promise.resolve(err(domainError("external_failure")));
        }
        if (
          options.consumeSessionSaveCrash === true &&
          draft.phase === "merge_authorized" &&
          !injectedConsumeSaveCrash
        ) {
          injectedConsumeSaveCrash = true;
          return Promise.resolve(err(domainError("external_failure")));
        }
        const session = {
          ...draft,
          revision: (sessions.get(draft.setupSessionId)?.revision ?? 0) + 1,
        };
        calls.push(`save:${draft.phase}`);
        sessions.set(session.setupSessionId, session);
        return Promise.resolve(
          ok({
            durability: options.unknownSessionDurability
              ? ("unknown" as const)
              : ("confirmed" as const),
            session,
          }),
        );
      },
      activate: (expectedRevision, draft, revisionSha) => {
        calls.push("activate");
        if (options.fail === "activation")
          return Promise.resolve(err(domainError("external_failure")));
        const currentSession = sessions.get(draft.setupSessionId);
        if (currentSession?.revision !== expectedRevision) {
          return Promise.resolve(err(domainError("conflict")));
        }
        const session = { ...draft, revision: expectedRevision + 1 };
        const auditReceiptsDigest = sha256Digest({
          kind: "registration_setup_audit_receipts",
          linear: session.audit?.linearReceipt,
          pullRequest: session.audit?.pullRequestReceipt,
        });
        if (!auditReceiptsDigest.ok || session.mergedConfigReceipt === undefined) {
          return Promise.resolve(err(domainError("invariant_violation")));
        }
        const marker = {
          schemaVersion: 1 as const,
          source: "source_control_default_branch" as const,
          setupSessionId: session.setupSessionId,
          projectId: session.project.id,
          repository: session.project.sourceControl.repository,
          changeRequestId: session.changeRequest.id,
          setupHeadSha: session.headSha,
          mergeCommitSha: session.mergedConfigReceipt.mergeCommitSha,
          authoritativeRevision: revisionSha,
          defaultBranch: session.project.defaultBranch,
          configDigest: session.configDigest,
          linearAuditIssueId: session.linearAuditIssueId,
          gateEvidenceDigest: session.gateEvidenceReceipt?.evidenceDigest ?? digest("missing-gate"),
          auditReceiptsDigest: auditReceiptsDigest.value,
          approvalSource: session.approvalSource ?? ("local_ui" as const),
          approvalReferenceDigest: session.approvalReferenceDigest ?? digest("missing-approval"),
          authorityDigest: session.approvalAuthorityDigest ?? digest("missing-authority"),
          approvalNonceDigest: session.approvalNonceDigest ?? digest("missing-nonce"),
        };
        activationMarker =
          options.activationReceipt === "wrong_authority"
            ? { ...marker, authorityDigest: digest("other-authority") }
            : options.activationReceipt === "wrong_nonce"
              ? { ...marker, approvalNonceDigest: digest("other-nonce") }
              : marker;
        sessions.set(session.setupSessionId, session);
        return Promise.resolve(
          ok({ durability: "confirmed" as const, session, marker: activationMarker }),
        );
      },
      readActivation: () => Promise.resolve(ok(activationMarker)),
    },
    finalApproval: {
      issue: () =>
        Promise.resolve(
          ok({
            state: "issued" as const,
            grant: { approvalId: "approval-grant-1", expiresAt: now },
          }),
        ),
      verifyAndConsume: (request, expectedBinding, _authority, mutationOptions) => {
        calls.push("verify-consume-approval");
        if (options.approvalAuthority === "unavailable") {
          return Promise.resolve(err(domainError("unavailable")));
        }
        if (options.approvalAuthority === "replay") {
          return Promise.resolve(ok({ state: "replay" as const }));
        }
        if (options.approvalAuthority === "rejected" || options.approvalAuthority === "unknown") {
          return Promise.resolve(ok({ state: options.approvalAuthority }));
        }
        if (consumedApprovalOperation !== undefined) {
          return Promise.resolve(
            consumedApprovalOperation === mutationOptions.idempotencyKey &&
              consumedApprovalReceipt !== undefined
              ? ok({ state: "verified_and_consumed" as const, receipt: consumedApprovalReceipt })
              : ok({ state: "replay" as const }),
          );
        }
        consumedApprovalOperation = mutationOptions.idempotencyKey;
        consumedApprovalReceipt = {
          schemaVersion: 1 as const,
          issuer: "local_ui" as const,
          approvalId: request.approvalId,
          setupSessionId: expectedBinding.setupSessionId,
          setupSessionRevision: expectedBinding.setupSessionRevision,
          projectId: expectedBinding.projectId,
          previewDigest: expectedBinding.previewDigest,
          changeRequestId: expectedBinding.changeRequestId,
          headSha:
            options.approvalAuthority === "mismatch" ? "f".repeat(40) : expectedBinding.headSha,
          requirementsDigest: expectedBinding.requirementsDigest,
          diffDigest: expectedBinding.diffDigest,
          authorityDigest: uiSessionDigest,
          linearAuditIssueId: expectedBinding.linearAuditIssueId,
          gateEvidenceDigest: expectedBinding.gateEvidenceDigest,
          approvalNonceDigest,
          consumedAt: now,
        };
        return Promise.resolve(
          ok({ state: "verified_and_consumed" as const, receipt: consumedApprovalReceipt }),
        );
      },
      readConsumed: (approvalReference) => {
        calls.push("approval-ledger-read");
        if (consumedApprovalReceipt === undefined || consumedApprovalOperation === undefined) {
          return Promise.resolve(ok(undefined));
        }
        const reference = sha256Digest({
          schemaVersion: 1,
          kind: "registration_setup_approval_reference",
          approvalId: consumedApprovalReceipt.approvalId,
        });
        return Promise.resolve(
          reference.ok && reference.value === approvalReference
            ? ok({
                receipt: consumedApprovalReceipt,
                consumeOperationDigest: digest(consumedApprovalOperation),
              })
            : ok(undefined),
        );
      },
    },
    squashMerge: {
      enable: (_command, mutationOptions) => {
        if (current.state === "merged" || current.autoMergeEnabled) {
          return Promise.resolve(
            ok({
              state:
                current.state === "merged" ? ("merged" as const) : ("auto_merge_enabled" as const),
              snapshot: current,
            }),
          );
        }
        calls.push("merge");
        mutationKeys.push({ step: "merge", key: mutationOptions.idempotencyKey });
        if (options.fail === "merge" || (options.mergeFailOnce === true && !injectedMergeFailure)) {
          injectedMergeFailure = true;
          return Promise.resolve(err(domainError("external_failure")));
        }
        current = changeRequest({ draft: false, autoMergeEnabled: true });
        return Promise.resolve(ok({ state: "auto_merge_enabled" as const, snapshot: current }));
      },
    },
    mergedConfig: {
      read: () => {
        calls.push("merged-config-read");
        const mergeCommitSha = "c".repeat(40);
        const receipt = {
          schemaVersion: 1 as const,
          source: "source_control_default_branch" as const,
          projectId: project.id,
          repository: project.sourceControl.repository,
          changeRequestId: current.id,
          setupHeadSha: headSha,
          mergeCommitSha,
          defaultBranch: project.defaultBranch,
          authoritativeRevision: mergeCommitSha,
          path: trustedProjectConfigPath,
          configDigest,
          config,
        };
        if (options.mergedConfigReadBack === "unavailable") {
          return Promise.resolve(err(domainError("unavailable")));
        }
        return Promise.resolve(
          ok({
            ...receipt,
            ...(options.mergedConfigReadBack === "config_drift"
              ? { configDigest: digest("drift") }
              : {}),
            ...(options.mergedConfigReadBack === "wrong_branch" ? { defaultBranch: "other" } : {}),
            ...(options.mergedConfigReadBack === "wrong_revision"
              ? { authoritativeRevision: "d".repeat(40) }
              : {}),
            ...(options.mergedConfigReadBack === "wrong_source"
              ? { source: "local" as never }
              : {}),
          }),
        );
      },
    },
    activationRegistry: {
      publish: (marker) => {
        calls.push("publish-activation-index");
        if (options.activationIndexFailOnce === true && !injectedActivationIndexFailure) {
          injectedActivationIndexFailure = true;
          return Promise.resolve(err(domainError("external_failure")));
        }
        if (options.fail === "activation")
          return Promise.resolve(err(domainError("external_failure")));
        if (
          activationIndex !== undefined &&
          JSON.stringify(activationIndex) !== JSON.stringify(marker)
        ) {
          return Promise.resolve(err(domainError("conflict")));
        }
        const state = activationIndex === undefined ? ("confirmed" as const) : ("reused" as const);
        activationIndex = marker;
        return Promise.resolve(ok({ state, marker }));
      },
      read: () => Promise.resolve(ok(activationIndex)),
    },
  };
  const coordinator = new RegistrationSetupCoordinator(ports);
  const application = createRegistrationSetupApplication({
    coordinatorPorts: ports,
    controllerPorts: {
      stateRoot: "/tmp/agent-team-registration-setup-unit",
      git: {
        inspectRepository: () => Promise.resolve(err(domainError("unavailable"))),
      },
      sessions: ports.sessions,
      previewConfirmation: {
        ...ports.previewConfirmation,
        issue: () => Promise.resolve(ok({ state: "rejected" as const })),
      },
      finalApproval: ports.finalApproval,
    },
  });
  return {
    coordinator,
    approveAndMerge: (
      request: import("../../src/application/registration/index.js").RegistrationSetupMergeRequest,
      authority: import("../../src/application/registration/index.js").RegistrationSetupFinalApprovalAuthority,
    ) =>
      application.controller.approveAndMergeLocalUi(
        {
          setupSessionId: request.setupSessionId,
          approvalId: request.approval?.approvalId ?? "invalid",
          expectedSetupRevision: request.approval?.expectedSetupRevision ?? 0,
          idempotencyKeyPrefix: request.idempotencyKeyPrefix,
        },
        { authorityDigest: authority.authorityDigest },
      ),
    calls,
    sessions,
    journals,
    mutationKeys,
    barrierReached,
    releaseBarrier,
  };
}

function confirmation(overrides: Record<string, unknown> = {}) {
  return {
    source: "local_ui" as const,
    explicit: true as const,
    tokenId: "preview-token-1",
    setupSessionId: preview.setupSessionId,
    projectId: project.id,
    previewDigest: preview.previewDigest,
    ...overrides,
  };
}

async function prepared(test = harness()) {
  const result = await test.coordinator.begin({
    preview,
    trustedAuthority,
    confirmation: confirmation(),
    idempotencyKeyPrefix: "setup:1",
  });
  if (result.state !== "ci_waiting") throw new Error(`unexpected ${result.state}`);
  return { ...test, session: result.session };
}

function approval(session: RegistrationSetupSession, overrides: Record<string, unknown> = {}) {
  return {
    approvalId: "approval-grant-1",
    userConfirmed: true as const,
    expectedSetupRevision: session.revision,
    ...overrides,
  };
}

const trustedAuthority = { issuer: "local_ui" as const, authorityDigest: uiSessionDigest };

describe("O005 registration Setup PR flow", () => {
  it("keeps coordinator capabilities private and exposes no raw merge extractor", async () => {
    const test = harness();
    const publicApi = await import("../../src/application/registration/index.js");
    expect(Object.keys(test.coordinator)).toEqual([]);
    expect(Reflect.ownKeys(test.coordinator)).toEqual([]);
    expect(test.coordinator).not.toHaveProperty("ports");
    expect(test.coordinator).not.toHaveProperty("approveAndMerge");
    expect(test.coordinator).not.toHaveProperty("enableAutoMerge");
    expect(test.coordinator).not.toHaveProperty("activate");
    expect(publicApi).not.toHaveProperty("createRegistrationSetupControllerMergeOperation");
  });

  it("serializes trusted config deterministically and rejects recognizable secrets", () => {
    const first = serializeTrustedProjectConfig(config);
    const second = serializeTrustedProjectConfig({ ...config });
    expect(first).toEqual(second);
    if (!first.ok) throw new Error(first.error.code);
    expect(first.value.contentDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      serializeTrustedProjectConfig({
        ...config,
        projectRules: ["Authorization: Bearer github_pat_abcdefghijklmnopqrstuvwxyz123456"],
      }),
    ).toMatchObject({ ok: false, error: { code: "invariant_violation" } });
  });

  it("rejects preview token drift before any mutation", async () => {
    const test = harness();
    const result = await test.coordinator.begin({
      preview,
      trustedAuthority,
      confirmation: confirmation({ previewDigest: "0".repeat(64) }),
      idempotencyKeyPrefix: "setup:drift",
    });
    expect(result).toMatchObject({ state: "failed", stage: "request" });
    expect(test.calls).toEqual([]);
  });

  it.each(["worktree", "write"] as const)("fails closed at %s", async (fail) => {
    const test = harness({ fail });
    const result = await test.coordinator.begin({
      preview,
      trustedAuthority,
      confirmation: confirmation(),
      idempotencyKeyPrefix: `setup:${fail}`,
    });
    expect(result).toMatchObject({ state: "failed", stage: fail });
    expect(test.calls).not.toContain("draft-pr");
  });

  it("writes only trusted config and creates a Draft PR bound to pushed Head", async () => {
    const test = await prepared();
    expect(test.session.changeRequest).toMatchObject({ draft: true, headSha });
    expect(test.session.evidence.map((item) => item.code)).toEqual([
      "setup_worktree_created",
      "trusted_config_written",
      "setup_preflight_passed",
      "setup_commit_pushed",
      "setup_draft_pr_created",
    ]);
    expect(test.calls).toEqual(
      expect.arrayContaining(["write", "preflight", "stage", "commit", "push", "draft-pr"]),
    );
  });

  it("replays begin idempotently without duplicating Git or SCM mutations", async () => {
    const test = await prepared();
    const mutationCount = test.calls.length;
    const replay = await test.coordinator.begin({
      preview,
      trustedAuthority,
      confirmation: confirmation(),
      idempotencyKeyPrefix: "setup:replay",
    });
    expect(replay).toMatchObject({ state: "ci_waiting" });
    expect(test.calls).toHaveLength(mutationCount);
  });

  it("durably checkpoints the planned journal before the first side effect", async () => {
    const test = await prepared();
    expect(test.calls.indexOf("journal:planned")).toBeLessThan(test.calls.indexOf("worktree"));
    expect(test.calls.indexOf("journal:intent:worktree")).toBeLessThan(
      test.calls.indexOf("worktree"),
    );
  });

  it("stops before the first side effect when execution ownership is lost during read-back", async () => {
    const test = harness({ ownershipLossAt: 2 });
    await expect(
      test.coordinator.begin({
        preview,
        trustedAuthority,
        confirmation: confirmation(),
        idempotencyKeyPrefix: "setup:ownership-loss",
      }),
    ).resolves.toMatchObject({ state: "failed", stage: "session", error: { code: "conflict" } });
    expect(test.calls).not.toContain("preview-confirmation");
    expect(test.calls).not.toContain("worktree");
  });

  it("never performs a mutation when persisting its journal intent fails", async () => {
    const test = harness({ journalIntentSaveFail: "worktree" });
    await expect(
      test.coordinator.begin({
        preview,
        trustedAuthority,
        confirmation: confirmation(),
        idempotencyKeyPrefix: "setup:intent-save-failure",
      }),
    ).resolves.toMatchObject({ state: "failed", stage: "session" });
    expect(test.calls).toContain("journal:intent:worktree");
    expect(test.calls).not.toContain("worktree");
  });

  it("does not persist a receipt or start the next step after ownership is lost post-mutation", async () => {
    const test = harness({ ownershipLossAfterEffect: "worktree" });
    await expect(
      test.coordinator.begin({
        preview,
        trustedAuthority,
        confirmation: confirmation(),
        idempotencyKeyPrefix: "setup:post-mutation-owner-loss",
      }),
    ).resolves.toMatchObject({ state: "failed", stage: "worktree", error: { code: "conflict" } });
    expect(test.journals.get(preview.setupSessionId)?.pending).toMatchObject({ step: "worktree" });
    expect(test.calls).not.toContain("write");
  });

  it.each([
    ["worktree", "worktree"],
    ["write", "write"],
    ["stage", "stage"],
    ["commit", "commit"],
    ["push", "push"],
    ["draft_pull_request", "draft-pr"],
  ] as const)(
    "keeps a second coordinator out while %s is between read-back and receipt",
    async (barrierStep, effectName) => {
      const test = harness({ barrierStep });
      const request = {
        preview,
        trustedAuthority,
        confirmation: confirmation(),
        idempotencyKeyPrefix: `concurrent:${barrierStep}`,
      };
      const first = test.coordinator.begin(request);
      await test.barrierReached;

      await expect(test.coordinator.begin(request)).resolves.toEqual({
        state: "in_progress",
        setupSessionId: preview.setupSessionId,
      });
      expect(test.calls.filter((call) => call === effectName)).toHaveLength(1);

      test.releaseBarrier();
      await expect(first).resolves.toMatchObject({ state: "ci_waiting" });
      expect(test.calls.filter((call) => call === effectName)).toHaveLength(1);
    },
  );

  it.each(["worktree", "write", "stage", "commit", "push", "draft_pull_request"] as const)(
    "recovers after a crash between %s and its journal receipt",
    async (crashAfter) => {
      const test = harness({ crashAfter });
      const request = {
        preview,
        trustedAuthority,
        confirmation: confirmation(),
        idempotencyKeyPrefix: `crash:${crashAfter}`,
      };
      await expect(test.coordinator.begin(request)).resolves.toMatchObject({
        state: "failed",
        stage: "session",
      });
      expect(test.journals.get(preview.setupSessionId)?.pending).toMatchObject({
        step: crashAfter,
        idempotencyKey: test.mutationKeys.findLast((entry) => entry.step === crashAfter)?.key,
      });
      await expect(test.coordinator.begin(request)).resolves.toMatchObject({ state: "ci_waiting" });
      const keys = test.mutationKeys
        .filter((entry) => entry.step === crashAfter)
        .map((entry) => entry.key);
      expect(new Set(keys).size).toBe(1);
      expect(test.sessions.size).toBe(1);
      expect(test.calls.filter((call) => call === "commit")).toHaveLength(1);
    },
  );

  it.each(["extra", "mode", "rename", "symlink", "submodule", "object"] as const)(
    "rejects %s effective-tree drift while recovering a committed pending step",
    async (recoveryDiffAttack) => {
      const test = harness({ crashAfter: "commit", recoveryDiffAttack });
      const request = {
        preview,
        trustedAuthority,
        confirmation: confirmation(),
        idempotencyKeyPrefix: `recovery:${recoveryDiffAttack}`,
      };
      await expect(test.coordinator.begin(request)).resolves.toMatchObject({
        state: "failed",
        stage: "session",
      });
      await expect(test.coordinator.begin(request)).resolves.toMatchObject({
        state: "failed",
        stage: "commit",
      });
      expect(test.calls).not.toContain("push");
      expect(test.calls).not.toContain("draft-pr");
    },
  );

  it("does not start a provider side effect after unknown intent publication", async () => {
    const test = harness({ unknownJournalDurability: true });
    await expect(
      test.coordinator.begin({
        preview,
        trustedAuthority,
        confirmation: confirmation(),
        idempotencyKeyPrefix: "unknown:journal",
      }),
    ).resolves.toMatchObject({ state: "failed", stage: "session" });
    expect(test.journals.get(preview.setupSessionId)?.completed).toEqual({});
    const providerEffects = new Set(["worktree", "write", "stage", "commit", "push", "draft-pr"]);
    expect(test.calls.filter((call) => providerEffects.has(call))).toEqual([]);
  });

  it("resolves unknown merge-authorization durability only through authoritative read-back", async () => {
    const test = await prepared(harness({ unknownSessionDurability: true, mergedReadBack: true }));
    const ready = await test.coordinator.refresh({
      setupSessionId: preview.setupSessionId,
      idempotencyKeyPrefix: "unknown:session:refresh",
    });
    if (ready.state !== "awaiting_user_approval") throw new Error("not ready");
    await expect(
      test.coordinator.authorizeMerge(
        {
          setupSessionId: preview.setupSessionId,
          approval: approval(ready.session),
          idempotencyKeyPrefix: "unknown:session:merge",
        },
        trustedAuthority,
      ),
    ).resolves.toMatchObject({ state: "merge_pending" });
    expect(test.calls).not.toContain("merge");
    expect(test.calls).not.toContain("activate");
  });

  it.each([
    ["pending", checks("pending"), statuses("success")],
    ["ci_failed", checks("failure"), statuses("success")],
    ["review_pending", checks("success"), statuses("pending")],
    ["review_failed", checks("success"), statuses("failure")],
  ] as const)("blocks authoritative gate state %s", async (reason, ci, review) => {
    const test = await prepared(harness({ ci, review }));
    const result = await test.coordinator.refresh({
      setupSessionId: preview.setupSessionId,
      idempotencyKeyPrefix: `refresh:${reason}`,
    });
    expect(result).toMatchObject({ state: "not_ready", reason });
    expect(test.calls).not.toContain("consume-approval");
    expect(test.calls).not.toContain("audit-linear");
    expect(test.calls).not.toContain("audit-pull_request");
  });

  it("requires review status for the exact Head and blocks Head or diff drift", async () => {
    for (const options of [
      { review: statuses("success", "f".repeat(40)) },
      { driftHead: true },
      { driftDiff: true },
    ]) {
      const test = await prepared(harness(options));
      const result = await test.coordinator.refresh({
        setupSessionId: preview.setupSessionId,
        idempotencyKeyPrefix: "refresh:drift",
      });
      expect(result.state).toBe("failed");
      expect(test.calls).not.toContain("consume-approval");
    }
  });

  it("persists typed audit receipts only after CI and fresh review succeed", async () => {
    const test = await prepared();
    const result = await test.coordinator.refresh({
      setupSessionId: preview.setupSessionId,
      idempotencyKeyPrefix: "refresh:green",
    });
    expect(result).toMatchObject({ state: "awaiting_user_approval" });
    if (result.state !== "awaiting_user_approval") return;
    expect(result.session.audit?.pending).toBeUndefined();
    expect(result.session.audit?.linearReceipt).toMatchObject({ destination: "linear" });
    expect(result.session.audit?.pullRequestReceipt).toMatchObject({
      destination: "pull_request",
    });
    expect(test.calls.indexOf("save:audit_pending")).toBeLessThan(
      test.calls.indexOf("audit-linear"),
    );
  });

  it.each(["linear", "pull_request"] as const)(
    "fails closed in audit_pending when %s receipt is unknown",
    async (auditFailure) => {
      const test = await prepared(harness({ auditFailure }));
      const result = await test.coordinator.refresh({
        setupSessionId: preview.setupSessionId,
        idempotencyKeyPrefix: `refresh:audit-failure:${auditFailure}`,
      });
      expect(result).toMatchObject({
        state: "failed",
        stage: "audit",
        session: { phase: "audit_pending" },
      });
      expect(test.calls).not.toContain("verify-consume-approval");
      expect(test.calls).not.toContain("merge");
      expect(test.calls).not.toContain("activate");
    },
  );

  it.each(["linear", "pull_request"] as const)(
    "recovers the same %s comment after publish-before-receipt crash",
    async (auditReceiptSaveCrash) => {
      const test = await prepared(harness({ auditReceiptSaveCrash }));
      const request = {
        setupSessionId: preview.setupSessionId,
        idempotencyKeyPrefix: `refresh:audit-crash:${auditReceiptSaveCrash}`,
      };
      await expect(test.coordinator.refresh(request)).resolves.toMatchObject({
        state: "failed",
        stage: "session",
        session: { phase: "audit_pending" },
      });
      await expect(test.coordinator.refresh(request)).resolves.toMatchObject({
        state: "awaiting_user_approval",
      });
      expect(test.calls.filter((call) => call === `audit-${auditReceiptSaveCrash}`)).toHaveLength(
        1,
      );
      expect(test.calls).not.toContain("merge");
      expect(test.calls).not.toContain("activate");
    },
  );

  it("rejects missing, wrong-session, replayed, and external-text approvals", async () => {
    const test = await prepared();
    const ready = await test.coordinator.refresh({
      setupSessionId: preview.setupSessionId,
      idempotencyKeyPrefix: "refresh:approval",
    });
    if (ready.state !== "awaiting_user_approval") throw new Error("not ready");
    for (const token of [
      undefined,
      approval(ready.session, { setupSessionId: "other" }),
      approval(ready.session, { issuer: "local_ui" }),
    ]) {
      const result = await test.coordinator.authorizeMerge(
        {
          setupSessionId: preview.setupSessionId,
          ...(token === undefined ? {} : { approval: token }),
          idempotencyKeyPrefix: "merge:invalid",
        },
        trustedAuthority,
      );
      expect(result).toMatchObject({ state: "blocked", reason: "user_approval_invalid" });
    }
    expect(test.calls).not.toContain("merge");
  });

  it.each(["mismatch", "replay", "rejected", "unknown", "unavailable"] as const)(
    "rejects final approval authority outcome %s",
    async (approvalAuthority) => {
      const test = await prepared(harness({ approvalAuthority }));
      const ready = await test.coordinator.refresh({
        setupSessionId: preview.setupSessionId,
        idempotencyKeyPrefix: "refresh:authority",
      });
      if (ready.state !== "awaiting_user_approval") throw new Error("not ready");
      const result = await test.coordinator.authorizeMerge(
        {
          setupSessionId: preview.setupSessionId,
          approval: approval(ready.session),
          idempotencyKeyPrefix: "merge:authority",
        },
        trustedAuthority,
      );
      expect(result.state === "blocked" || result.state === "failed").toBe(true);
      expect(test.calls).not.toContain("merge");
      expect(test.calls).not.toContain("activate");
    },
  );

  it("does not activate on merge failure or missing authoritative merged read-back", async () => {
    for (const options of [{ fail: "merge" as const }, {}]) {
      const test = await prepared(harness(options));
      const ready = await test.coordinator.refresh({
        setupSessionId: preview.setupSessionId,
        idempotencyKeyPrefix: "refresh:merge",
      });
      if (ready.state !== "awaiting_user_approval") throw new Error("not ready");
      const result = await test.coordinator.authorizeMerge(
        {
          setupSessionId: preview.setupSessionId,
          approval: approval(ready.session),
          idempotencyKeyPrefix: "merge:once",
        },
        trustedAuthority,
      );
      expect(["failed", "merge_pending"]).toContain(result.state);
      expect(test.calls).not.toContain("activate");
    }
  });

  it("durably authorizes merge without invoking B2 merge or activation", async () => {
    const test = await prepared(harness({ mergedReadBack: true }));
    const ready = await test.coordinator.refresh({
      setupSessionId: preview.setupSessionId,
      idempotencyKeyPrefix: "refresh:success",
    });
    if (ready.state !== "awaiting_user_approval") throw new Error("not ready");
    const result = await test.coordinator.authorizeMerge(
      {
        setupSessionId: preview.setupSessionId,
        approval: approval(ready.session),
        idempotencyKeyPrefix: "merge:success",
      },
      trustedAuthority,
    );
    expect(result).toMatchObject({
      state: "merge_pending",
      session: { phase: "merge_authorized" },
    });
    expect(JSON.stringify(result)).not.toContain("approval-grant-1");
    expect(test.calls).not.toContain("merge");
    expect(test.calls).not.toContain("merged-config-read");
    expect(test.calls).not.toContain("activate");
  });

  it.each([
    "unavailable",
    "config_drift",
    "wrong_branch",
    "wrong_revision",
    "wrong_source",
  ] as const)("leaves B2 merged-config read-back %s unreachable", async (mergedConfigReadBack) => {
    const test = await prepared(harness({ mergedReadBack: true, mergedConfigReadBack }));
    const ready = await test.coordinator.refresh({
      setupSessionId: preview.setupSessionId,
      idempotencyKeyPrefix: "refresh:readback",
    });
    if (ready.state !== "awaiting_user_approval") throw new Error("not ready");
    const result = await test.coordinator.authorizeMerge(
      {
        setupSessionId: preview.setupSessionId,
        approval: approval(ready.session),
        idempotencyKeyPrefix: "merge:readback",
      },
      trustedAuthority,
    );
    expect(result).toMatchObject({ state: "merge_pending" });
    expect(test.calls).not.toContain("merged-config-read");
    expect(test.calls).not.toContain("activate");
  });

  it.each([
    "wrong_source",
    "wrong_setup_session",
    "wrong_project",
    "wrong_revision",
    "wrong_branch",
    "wrong_digest",
    "wrong_session",
  ] as const)("leaves B2 activation receipt path %s unreachable", async (activationReceipt) => {
    const test = await prepared(harness({ mergedReadBack: true, activationReceipt }));
    const ready = await test.coordinator.refresh({
      setupSessionId: preview.setupSessionId,
      idempotencyKeyPrefix: `refresh:activation:${activationReceipt}`,
    });
    if (ready.state !== "awaiting_user_approval") throw new Error("not ready");
    await expect(
      test.coordinator.authorizeMerge(
        {
          setupSessionId: preview.setupSessionId,
          approval: approval(ready.session),
          idempotencyKeyPrefix: `merge:activation:${activationReceipt}`,
        },
        trustedAuthority,
      ),
    ).resolves.toMatchObject({ state: "merge_pending" });
    expect(test.calls).not.toContain("activate");
  });

  it("revalidates the same durable merge authorization operation without invoking merge", async () => {
    const test = await prepared(harness({ mergeFailOnce: true, mergedReadBack: true }));
    const ready = await test.coordinator.refresh({
      setupSessionId: preview.setupSessionId,
      idempotencyKeyPrefix: "refresh:recover",
    });
    if (ready.state !== "awaiting_user_approval") throw new Error("not ready");
    const token = approval(ready.session);
    await expect(
      test.coordinator.authorizeMerge(
        {
          setupSessionId: preview.setupSessionId,
          approval: token,
          idempotencyKeyPrefix: "merge:fail",
        },
        trustedAuthority,
      ),
    ).resolves.toMatchObject({ state: "merge_pending" });
    await expect(
      test.coordinator.authorizeMerge(
        {
          setupSessionId: preview.setupSessionId,
          approval: token,
          idempotencyKeyPrefix: "merge:fail",
        },
        trustedAuthority,
      ),
    ).resolves.toMatchObject({ state: "merge_pending" });
    expect(test.calls.filter((call) => call === "verify-consume-approval")).toHaveLength(2);
    expect(test.calls).not.toContain("merge");
  });

  it("recovers the durable approval receipt after consume succeeds but session save crashes", async () => {
    const test = await prepared(harness({ consumeSessionSaveCrash: true, mergedReadBack: true }));
    const ready = await test.coordinator.refresh({
      setupSessionId: preview.setupSessionId,
      idempotencyKeyPrefix: "refresh:consume-window",
    });
    if (ready.state !== "awaiting_user_approval") throw new Error("not ready");
    const token = approval(ready.session);
    const request = {
      setupSessionId: preview.setupSessionId,
      approval: token,
      idempotencyKeyPrefix: "merge:consume-window",
    };
    await expect(test.coordinator.authorizeMerge(request, trustedAuthority)).resolves.toMatchObject(
      { state: "failed", stage: "session" },
    );
    await expect(test.coordinator.authorizeMerge(request, trustedAuthority)).resolves.toMatchObject(
      { state: "merge_pending" },
    );
    expect(test.calls.filter((call) => call === "verify-consume-approval")).toHaveLength(2);
  });

  it("rejects a different consume operation after the consume/session-save crash window", async () => {
    const test = await prepared(harness({ consumeSessionSaveCrash: true }));
    const ready = await test.coordinator.refresh({
      setupSessionId: preview.setupSessionId,
      idempotencyKeyPrefix: "refresh:consume-replay",
    });
    if (ready.state !== "awaiting_user_approval") throw new Error("not ready");
    const token = approval(ready.session);
    await test.coordinator.authorizeMerge(
      {
        setupSessionId: preview.setupSessionId,
        approval: token,
        idempotencyKeyPrefix: "merge:consume-first",
      },
      trustedAuthority,
    );
    await expect(
      test.coordinator.authorizeMerge(
        {
          setupSessionId: preview.setupSessionId,
          approval: token,
          idempotencyKeyPrefix: "merge:consume-other",
        },
        trustedAuthority,
      ),
    ).resolves.toMatchObject({ state: "blocked", reason: "approval_replay" });
    expect(test.calls).not.toContain("merge");
  });

  it("rejects a different operation after authorization is durable", async () => {
    const test = await prepared(harness({ mergedReadBack: true }));
    const ready = await test.coordinator.refresh({
      setupSessionId: preview.setupSessionId,
      idempotencyKeyPrefix: "refresh:replay",
    });
    if (ready.state !== "awaiting_user_approval") throw new Error("not ready");
    const token = approval(ready.session);
    await test.coordinator.authorizeMerge(
      {
        setupSessionId: preview.setupSessionId,
        approval: token,
        idempotencyKeyPrefix: "merge:first",
      },
      trustedAuthority,
    );
    const replay = await test.coordinator.authorizeMerge(
      {
        setupSessionId: preview.setupSessionId,
        approval: token,
        idempotencyKeyPrefix: "merge:replay",
      },
      trustedAuthority,
    );
    expect(replay).toMatchObject({ state: "blocked", reason: "approval_replay" });
    expect(test.calls.filter((call) => call === "verify-consume-approval")).toHaveLength(2);
    expect(test.calls).not.toContain("activate");
  });

  it("rejects another authority when recovering a durable authorization", async () => {
    const test = await prepared();
    const ready = await test.coordinator.refresh({
      setupSessionId: preview.setupSessionId,
      idempotencyKeyPrefix: "refresh:wrong-recovery-authority",
    });
    if (ready.state !== "awaiting_user_approval") throw new Error("not ready");
    const token = approval(ready.session);
    const request = {
      setupSessionId: preview.setupSessionId,
      approval: token,
      idempotencyKeyPrefix: "merge:wrong-recovery-authority",
    };
    await expect(test.coordinator.authorizeMerge(request, trustedAuthority)).resolves.toMatchObject(
      {
        state: "merge_pending",
      },
    );
    await expect(
      test.coordinator.authorizeMerge(request, {
        issuer: "current_user_conversation",
        authorityDigest: "9".repeat(64),
      }),
    ).resolves.toMatchObject({ state: "blocked", reason: "user_approval_invalid" });
    expect(test.calls.filter((call) => call === "save:merge_authorized")).toHaveLength(1);
    expect(test.calls).not.toContain("merge");
    expect(test.calls).not.toContain("activate");
  });

  it("persists merge intent before controller-only SQUASH and activates only after W2 read-back", async () => {
    const test = await prepared(harness({ mergedReadBack: true }));
    const ready = await test.coordinator.refresh({
      setupSessionId: preview.setupSessionId,
      idempotencyKeyPrefix: "refresh:b2-happy",
    });
    if (ready.state !== "awaiting_user_approval") throw new Error("not ready");
    const result = await test.approveAndMerge(
      {
        setupSessionId: preview.setupSessionId,
        approval: approval(ready.session),
        idempotencyKeyPrefix: "merge:b2-happy",
      },
      trustedAuthority,
    );
    expect(result).toMatchObject({ state: "activated", revisionSha: "c".repeat(40) });
    const intent = test.calls.indexOf("save:merge_pending");
    const merge = test.calls.indexOf("merge");
    const readBack = test.calls.indexOf("merged-config-read");
    const marker = test.calls.indexOf("activate");
    const index = test.calls.indexOf("publish-activation-index");
    expect(intent).toBeGreaterThan(-1);
    expect(intent).toBeLessThan(merge);
    expect(merge).toBeLessThan(readBack);
    expect(readBack).toBeLessThan(marker);
    expect(marker).toBeLessThan(index);
    const mergeMutations = test.mutationKeys.filter((item) => item.step === "merge");
    expect(mergeMutations).toHaveLength(1);
    expect(mergeMutations[0]?.key).toMatch(/^setup-merge:/u);
  });

  it.each(["wrong_authority", "wrong_nonce"] as const)(
    "fails closed when the activation marker has a valid-format %s substitution",
    async (activationReceipt) => {
      const test = await prepared(harness({ mergedReadBack: true, activationReceipt }));
      const ready = await test.coordinator.refresh({
        setupSessionId: preview.setupSessionId,
        idempotencyKeyPrefix: `refresh:b2:${activationReceipt}`,
      });
      if (ready.state !== "awaiting_user_approval") throw new Error("not ready");
      await expect(
        test.approveAndMerge(
          {
            setupSessionId: preview.setupSessionId,
            approval: approval(ready.session),
            idempotencyKeyPrefix: `merge:b2:${activationReceipt}`,
          },
          trustedAuthority,
        ),
      ).resolves.toMatchObject({ state: "failed", stage: "activation" });
      expect(test.calls).not.toContain("publish-activation-index");
    },
  );

  it("returns merge_pending without W2 or activation while GitHub is not merged", async () => {
    const test = await prepared(harness());
    const ready = await test.coordinator.refresh({
      setupSessionId: preview.setupSessionId,
      idempotencyKeyPrefix: "refresh:b2-pending",
    });
    if (ready.state !== "awaiting_user_approval") throw new Error("not ready");
    await expect(
      test.approveAndMerge(
        {
          setupSessionId: preview.setupSessionId,
          approval: approval(ready.session),
          idempotencyKeyPrefix: "merge:b2-pending",
        },
        trustedAuthority,
      ),
    ).resolves.toMatchObject({ state: "merge_pending" });
    expect(test.calls).not.toContain("merged-config-read");
    expect(test.calls).not.toContain("activate");
    expect(test.calls).not.toContain("publish-activation-index");
  });

  it("reuses the durable merge operation after a pre-response failure", async () => {
    const test = await prepared(harness({ mergeFailOnce: true, mergedReadBack: true }));
    const ready = await test.coordinator.refresh({
      setupSessionId: preview.setupSessionId,
      idempotencyKeyPrefix: "refresh:b2-retry",
    });
    if (ready.state !== "awaiting_user_approval") throw new Error("not ready");
    const request = {
      setupSessionId: preview.setupSessionId,
      approval: approval(ready.session),
      idempotencyKeyPrefix: "merge:b2-retry",
    };
    await expect(test.approveAndMerge(request, trustedAuthority)).resolves.toMatchObject({
      state: "failed",
      stage: "merge",
    });
    await expect(test.approveAndMerge(request, trustedAuthority)).resolves.toMatchObject({
      state: "activated",
    });
    const mergeKeys = test.mutationKeys
      .filter((item) => item.step === "merge")
      .map((item) => item.key);
    expect(mergeKeys).toHaveLength(2);
    expect(new Set(mergeKeys).size).toBe(1);
    expect(test.calls.filter((call) => call === "save:merge_pending")).toHaveLength(2);
  });

  it("reads authoritative merge state before retrying a response-lost mutation", async () => {
    const test = await prepared(harness({ mergeReceiptSaveCrash: true, mergedReadBack: true }));
    const ready = await test.coordinator.refresh({
      setupSessionId: preview.setupSessionId,
      idempotencyKeyPrefix: "refresh:b2-response-lost",
    });
    if (ready.state !== "awaiting_user_approval") throw new Error("not ready");
    const request = {
      setupSessionId: preview.setupSessionId,
      approval: approval(ready.session),
      idempotencyKeyPrefix: "merge:b2-response-lost",
    };
    await expect(test.approveAndMerge(request, trustedAuthority)).resolves.toMatchObject({
      state: "failed",
      stage: "session",
    });
    await expect(test.approveAndMerge(request, trustedAuthority)).resolves.toMatchObject({
      state: "activated",
    });
    expect(test.calls.filter((call) => call === "merge")).toHaveLength(1);
    expect(test.mutationKeys.filter((item) => item.step === "merge")).toHaveLength(1);
  });

  it.each(["gate", "head", "diff"] as const)(
    "revalidates %s after durable merge intent and before the mutation",
    async (mergePendingDrift) => {
      const test = await prepared(harness({ mergePendingDrift }));
      const ready = await test.coordinator.refresh({
        setupSessionId: preview.setupSessionId,
        idempotencyKeyPrefix: `refresh:merge-pending-${mergePendingDrift}`,
      });
      if (ready.state !== "awaiting_user_approval") throw new Error("not ready");
      await expect(
        test.approveAndMerge(
          {
            setupSessionId: preview.setupSessionId,
            approval: approval(ready.session),
            idempotencyKeyPrefix: `merge:merge-pending-${mergePendingDrift}`,
          },
          trustedAuthority,
        ),
      ).resolves.toMatchObject({ state: "failed", stage: "merge" });
      expect(test.calls.filter((call) => call === "merge")).toHaveLength(0);
      expect(test.mutationKeys.filter((item) => item.step === "merge")).toHaveLength(0);
    },
  );

  it("repairs only the project index after a W1-marker-to-index crash", async () => {
    const test = await prepared(harness({ mergedReadBack: true, activationIndexFailOnce: true }));
    const ready = await test.coordinator.refresh({
      setupSessionId: preview.setupSessionId,
      idempotencyKeyPrefix: "refresh:index-crash",
    });
    if (ready.state !== "awaiting_user_approval") throw new Error("not ready");
    const request = {
      setupSessionId: preview.setupSessionId,
      approval: approval(ready.session),
      idempotencyKeyPrefix: "merge:index-crash",
    };
    await expect(test.approveAndMerge(request, trustedAuthority)).resolves.toMatchObject({
      state: "failed",
      stage: "activation",
    });
    expect(test.calls.filter((call) => call === "activate")).toHaveLength(1);
    expect(test.calls.filter((call) => call === "merge")).toHaveLength(1);
    await expect(test.approveAndMerge(request, trustedAuthority)).resolves.toMatchObject({
      state: "activated",
    });
    expect(test.calls.filter((call) => call === "activate")).toHaveLength(1);
    expect(test.calls.filter((call) => call === "merge")).toHaveLength(1);
    expect(test.calls.filter((call) => call === "publish-activation-index")).toHaveLength(2);
  });

  it.each([
    "unavailable",
    "config_drift",
    "wrong_branch",
    "wrong_revision",
    "wrong_source",
  ] as const)("fails closed for W2 authoritative read-back %s", async (mergedConfigReadBack) => {
    const test = await prepared(harness({ mergedReadBack: true, mergedConfigReadBack }));
    const ready = await test.coordinator.refresh({
      setupSessionId: preview.setupSessionId,
      idempotencyKeyPrefix: `refresh:w2:${mergedConfigReadBack}`,
    });
    if (ready.state !== "awaiting_user_approval") throw new Error("not ready");
    await expect(
      test.approveAndMerge(
        {
          setupSessionId: preview.setupSessionId,
          approval: approval(ready.session),
          idempotencyKeyPrefix: `merge:w2:${mergedConfigReadBack}`,
        },
        trustedAuthority,
      ),
    ).resolves.toMatchObject({ state: "failed", stage: "trusted_config_readback" });
    expect(test.calls).not.toContain("activate");
    expect(test.calls).not.toContain("publish-activation-index");
  });

  it("cancels fail-closed and never resumes mutations", async () => {
    const test = await prepared();
    await test.coordinator.cancel({
      setupSessionId: preview.setupSessionId,
      idempotencyKeyPrefix: "cancel:1",
    });
    const result = await test.coordinator.refresh({
      setupSessionId: preview.setupSessionId,
      idempotencyKeyPrefix: "refresh:cancelled",
    });
    expect(result).toMatchObject({ state: "blocked", reason: "cancelled" });
  });
});
