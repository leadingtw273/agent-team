import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import {
  domainError,
  parseInstant,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import { projectSchema } from "../../domain/project/index.js";
import {
  canonicalSerialize,
  createDiffDigest,
  sha256Digest,
  type EffectiveTreeChange,
  type Sha256Digest,
} from "../../domain/review/index.js";
import {
  serializeTrustedProjectConfig,
  trustedProjectConfigPath,
  trustedProjectConfigSchema,
} from "../projects/index.js";
import type { MutationOptions } from "../ports/index.js";
import {
  registrationSetupBranch,
  registrationSetupEvidenceCodes,
  registrationSetupReviewStatus,
  type RegistrationSetupAuditIntent,
  type RegistrationSetupAuditReceipt,
  type RegistrationSetupApprovalBinding,
  type RegistrationSetupBeginRequest,
  type RegistrationSetupEvidence,
  type RegistrationSetupExecutionLease,
  type RegistrationSetupFailureStage,
  type RegistrationSetupFinalApprovalReceipt,
  type RegistrationSetupFinalApprovalRequest,
  type RegistrationSetupFinalApprovalAuthority,
  type RegistrationSetupJournal,
  type RegistrationSetupJournalDraft,
  type RegistrationSetupMergeRequest,
  type RegistrationSetupOutcome,
  type RegistrationSetupPorts,
  type RegistrationSetupPreview,
  type RegistrationSetupPreviewInput,
  type RegistrationSetupPreviewResult,
  type RegistrationSetupSession,
  type RegistrationSetupSessionDraft,
  type RegistrationSetupSessionRequest,
} from "./setup-model.js";

const digestPattern = /^[0-9a-f]{64}$/u;
const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:@+-]{0,220}$/u;

function sameSha(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sameValue(left: unknown, right: unknown): boolean {
  const a = canonicalSerialize(left);
  const b = canonicalSerialize(right);
  return a.ok && b.ok && a.value === b.value;
}

function validPrefix(value: string): boolean {
  return identifierPattern.test(value);
}

function mutation(
  request: Readonly<{ idempotencyKeyPrefix: string; signal?: AbortSignal }>,
  step: string,
): MutationOptions {
  return {
    idempotencyKey: `${request.idempotencyKeyPrefix}:${step}`,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  };
}

function exactMutation(idempotencyKey: string, signal?: AbortSignal): MutationOptions {
  return { idempotencyKey, ...(signal === undefined ? {} : { signal }) };
}

function setupCommitMessage(operationKey: string): string {
  return [
    "chore(agent-team): add trusted project setup",
    "",
    `Agent-Team-Setup-Operation: ${operationKey}`,
  ].join("\n");
}

function fencedMutation(
  request: Readonly<{ idempotencyKeyPrefix: string; signal?: AbortSignal }>,
  step: string,
  lease: RegistrationSetupExecutionLease,
) {
  return { ...mutation(request, step), executionFence: lease.fence };
}

function withoutSessionRevision(session: RegistrationSetupSession): RegistrationSetupSessionDraft {
  const { revision, ...draft } = session;
  void revision;
  return draft;
}

function withoutJournalRevision(journal: RegistrationSetupJournal): RegistrationSetupJournalDraft {
  const { revision, ...draft } = journal;
  void revision;
  return draft;
}

function failed(
  stage: RegistrationSetupFailureStage,
  session?: RegistrationSetupSession,
): RegistrationSetupOutcome {
  return Object.freeze({
    state: "failed",
    stage,
    error: domainError(stage === "request" ? "invariant_violation" : "external_failure"),
    ...(session === undefined ? {} : { session }),
  });
}

function portFailure(
  stage: RegistrationSetupFailureStage,
  error: DomainError,
  session?: RegistrationSetupSession,
): RegistrationSetupOutcome {
  return Object.freeze({
    state: "failed",
    stage,
    error,
    ...(session === undefined ? {} : { session }),
  });
}

function validPreviewInput(input: RegistrationSetupPreviewInput): boolean {
  const raw = input as unknown as Readonly<Record<string, unknown>>;
  const project = projectSchema.safeParse(input.project);
  const config = trustedProjectConfigSchema.safeParse(input.config);
  return (
    raw["schemaVersion"] === 1 &&
    identifierPattern.test(input.setupSessionId) &&
    project.success &&
    config.success &&
    config.data.projectId === project.data.id &&
    config.data.defaultBranch === project.data.defaultBranch &&
    sameValue(config.data.platforms.workManagement, project.data.workManagement) &&
    sameValue(config.data.platforms.sourceControl, project.data.sourceControl) &&
    shaPattern.test(input.baseRevision) &&
    isAbsolute(input.worktreePath) &&
    raw["branch"] === registrationSetupBranch &&
    input.remote === "origin" &&
    identifierPattern.test(input.linearAuditIssueId)
  );
}

function requirementsDigest(input: RegistrationSetupPreviewInput) {
  return sha256Digest({
    schemaVersion: 1,
    kind: "registration_setup_requirements",
    projectId: input.project.id,
    defaultBranch: input.project.defaultBranch,
    trustedConfig: input.config,
    allowedPaths: [trustedProjectConfigPath],
    setupBranch: registrationSetupBranch,
    pullRequestStartsDraft: true,
    requiredReviewStatus: registrationSetupReviewStatus,
    mergeMethod: "squash",
    linearAuditIssueId: input.linearAuditIssueId,
    finalApprovalSources: ["local_ui", "current_user_conversation"],
  });
}

export function createRegistrationSetupPreview(
  input: RegistrationSetupPreviewInput,
): RegistrationSetupPreviewResult {
  if (!validPreviewInput(input)) {
    return Object.freeze({ ok: false, error: domainError("invariant_violation") });
  }
  const requirements = requirementsDigest(input);
  if (!requirements.ok) return requirements;
  const preview = sha256Digest({ ...input, requirementsDigest: requirements.value });
  if (!preview.ok) return preview;
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      ...input,
      project: projectSchema.parse(input.project),
      config: trustedProjectConfigSchema.parse(input.config),
      previewDigest: preview.value,
      requirementsDigest: requirements.value,
    }),
  });
}

function validatePreview(preview: RegistrationSetupPreview): boolean {
  const recreated = createRegistrationSetupPreview({
    schemaVersion: preview.schemaVersion,
    setupSessionId: preview.setupSessionId,
    project: preview.project,
    config: preview.config,
    baseRevision: preview.baseRevision,
    worktreePath: preview.worktreePath,
    branch: preview.branch,
    remote: preview.remote,
    linearAuditIssueId: preview.linearAuditIssueId,
  });
  return (
    recreated.ok &&
    recreated.value.previewDigest === preview.previewDigest &&
    recreated.value.requirementsDigest === preview.requirementsDigest
  );
}

function validPreviewConfirmation(request: RegistrationSetupBeginRequest): boolean {
  const token = request.confirmation;
  const raw = token as unknown as Readonly<Record<string, unknown>>;
  return (
    validatePreview(request.preview) &&
    validPrefix(request.idempotencyKeyPrefix) &&
    identifierPattern.test(token.tokenId) &&
    raw["explicit"] === true &&
    (raw["source"] === "local_ui" || raw["source"] === "current_user_conversation") &&
    token.setupSessionId === request.preview.setupSessionId &&
    token.projectId === request.preview.project.id &&
    token.previewDigest === request.preview.previewDigest
  );
}

function evidence(
  code: RegistrationSetupEvidence["code"],
  preview: RegistrationSetupPreview,
  binding: Readonly<{ headSha?: string; diffDigest?: Sha256Digest; changeRequestId?: string }> = {},
): RegistrationSetupEvidence {
  return Object.freeze({
    code,
    projectId: preview.project.id,
    setupSessionId: preview.setupSessionId,
    previewDigest: preview.previewDigest,
    requirementsDigest: preview.requirementsDigest,
    ...binding,
  });
}

function gitBlobObjectId(content: string, algorithm: "sha1" | "sha256"): string {
  const bytes = Buffer.from(content, "utf8");
  return createHash(algorithm)
    .update(`blob ${String(bytes.byteLength)}\0`, "utf8")
    .update(bytes)
    .digest("hex");
}

function isExactTrustedConfigDiff(
  changes: readonly EffectiveTreeChange[],
  canonicalContent: string,
): boolean {
  if (changes.length !== 1) return false;
  const change = changes[0];
  if (change === undefined) return false;
  const { before, after } = change;
  return (
    after !== null &&
    after.path === trustedProjectConfigPath &&
    after.mode === "100644" &&
    after.objectId.value === gitBlobObjectId(canonicalContent, after.objectId.algorithm) &&
    before === null
  );
}

function auditIntent(
  session: RegistrationSetupSession,
  destination: RegistrationSetupAuditIntent["destination"],
): RegistrationSetupAuditIntent | undefined {
  const gate = session.gateEvidenceReceipt;
  if (gate === undefined) return undefined;
  const body = [
    "Agent Team registration Setup PR is waiting for explicit user approval.",
    `project=${session.project.id}`,
    `setup_session=${session.setupSessionId}`,
    `preview_digest=${session.previewDigest}`,
    `change_request=${session.changeRequest.id}`,
    `head_sha=${session.headSha}`,
    `requirements_digest=${session.requirementsDigest}`,
    `diff_digest=${session.diffDigest}`,
    `linear_audit_issue=${session.linearAuditIssueId}`,
    `gate_evidence_digest=${gate.evidenceDigest}`,
    `review_evidence=${gate.reviewEvidenceUrl}`,
    "merge=squash",
    "authority=local UI or trusted current-user conversation only",
  ].join("\n");
  const bodyDigest = sha256Digest(body);
  if (!bodyDigest.ok) return undefined;
  return Object.freeze({
    schemaVersion: 1,
    destination,
    kind: "registration_setup_user_approval_required",
    setupSessionId: session.setupSessionId,
    projectId: session.project.id,
    repository: session.project.sourceControl.repository,
    linearAuditIssueId: session.linearAuditIssueId,
    changeRequestId: session.changeRequest.id,
    headSha: session.headSha,
    requirementsDigest: session.requirementsDigest,
    diffDigest: session.diffDigest,
    evidenceDigest: gate.evidenceDigest,
    body,
    bodyDigest: bodyDigest.value,
    idempotencyKey: `setup-audit:${session.setupSessionId}:${gate.evidenceDigest.slice(0, 16)}:${destination}`,
  });
}

function gateEvidenceMatches(session: RegistrationSetupSession): boolean {
  const receipt = session.gateEvidenceReceipt;
  if (receipt === undefined) return false;
  const { evidenceDigest, ...binding } = receipt;
  const recomputed = sha256Digest({
    kind: "registration_setup_gate_evidence",
    ...binding,
  });
  return (
    recomputed.ok &&
    recomputed.value === evidenceDigest &&
    receipt.projectId === session.project.id &&
    receipt.repository === session.project.sourceControl.repository &&
    receipt.changeRequestId === session.changeRequest.id &&
    sameSha(receipt.headSha, session.headSha) &&
    receipt.requirementsDigest === session.requirementsDigest &&
    receipt.diffDigest === session.diffDigest &&
    digestPattern.test(receipt.ciChecksDigest) &&
    receipt.reviewEvidenceUrl.length > 0 &&
    digestPattern.test(receipt.evidenceDigest)
  );
}

function auditReceiptMatches(
  session: RegistrationSetupSession,
  receipt: RegistrationSetupAuditReceipt | undefined,
  destination: RegistrationSetupAuditIntent["destination"],
): boolean {
  const expected = auditIntent(session, destination);
  if (receipt === undefined || expected === undefined) return false;
  const { kind, body, idempotencyKey, ...binding } = expected;
  void kind;
  void body;
  void idempotencyKey;
  const operationDigest = sha256Digest(expected.idempotencyKey);
  return (
    operationDigest.ok &&
    sameValue(binding, {
      schemaVersion: receipt.schemaVersion,
      destination: receipt.destination,
      setupSessionId: receipt.setupSessionId,
      projectId: receipt.projectId,
      repository: receipt.repository,
      linearAuditIssueId: receipt.linearAuditIssueId,
      changeRequestId: receipt.changeRequestId,
      headSha: receipt.headSha,
      requirementsDigest: receipt.requirementsDigest,
      diffDigest: receipt.diffDigest,
      evidenceDigest: receipt.evidenceDigest,
      bodyDigest: receipt.bodyDigest,
    }) &&
    receipt.idempotencyKeyDigest === operationDigest.value &&
    identifierPattern.test(receipt.externalCommentId) &&
    parseInstant(receipt.createdAt).ok
  );
}

function validSession(session: RegistrationSetupSession): boolean {
  const raw = session as unknown as Readonly<Record<string, unknown>>;
  const project = projectSchema.safeParse(session.project);
  const config = trustedProjectConfigSchema.safeParse(session.config);
  return (
    raw["schemaVersion"] === 1 &&
    Number.isSafeInteger(session.revision) &&
    session.revision >= 1 &&
    identifierPattern.test(session.setupSessionId) &&
    project.success &&
    config.success &&
    config.data.projectId === project.data.id &&
    config.data.defaultBranch === project.data.defaultBranch &&
    sameValue(config.data.platforms.workManagement, project.data.workManagement) &&
    sameValue(config.data.platforms.sourceControl, project.data.sourceControl) &&
    session.worktree.repositoryRoot === project.data.localRepositoryPath &&
    session.worktree.branch === registrationSetupBranch &&
    isAbsolute(session.worktree.path) &&
    sameSha(session.changeRequest.headSha, session.headSha) &&
    session.changeRequest.baseBranch === project.data.defaultBranch &&
    session.changeRequest.headBranch === registrationSetupBranch &&
    digestPattern.test(session.previewDigest) &&
    digestPattern.test(session.requirementsDigest) &&
    digestPattern.test(session.diffDigest) &&
    digestPattern.test(session.configDigest) &&
    shaPattern.test(session.headSha) &&
    identifierPattern.test(session.linearAuditIssueId) &&
    session.evidence.every(
      (item) =>
        registrationSetupEvidenceCodes.includes(item.code) &&
        item.projectId === project.data.id &&
        item.setupSessionId === session.setupSessionId &&
        item.previewDigest === session.previewDigest &&
        item.requirementsDigest === session.requirementsDigest,
    ) &&
    (session.phase === "ci_waiting" ||
      session.phase === "cancelled" ||
      gateEvidenceMatches(session)) &&
    (session.phase === "ci_waiting" ||
      session.phase === "cancelled" ||
      session.phase === "audit_pending" ||
      (session.audit?.pending === undefined &&
        auditReceiptMatches(session, session.audit?.linearReceipt, "linear") &&
        auditReceiptMatches(session, session.audit?.pullRequestReceipt, "pull_request"))) &&
    (session.phase !== "merge_authorized" ||
      (session.approvalReferenceDigest !== undefined &&
        digestPattern.test(session.approvalReferenceDigest) &&
        session.approvalNonceDigest !== undefined &&
        digestPattern.test(session.approvalNonceDigest) &&
        session.approvalAuthorityDigest !== undefined &&
        digestPattern.test(session.approvalAuthorityDigest) &&
        (session.approvalSource === "local_ui" ||
          session.approvalSource === "current_user_conversation"))) &&
    (session.phase !== "activated" ||
      (session.activatedRevisionSha !== undefined && shaPattern.test(session.activatedRevisionSha)))
  );
}

function finalApprovalMatches(
  approval: RegistrationSetupFinalApprovalRequest | undefined,
  session: RegistrationSetupSession,
): approval is RegistrationSetupFinalApprovalRequest {
  if (approval === undefined) return false;
  const rawApproval = approval as unknown as Readonly<Record<string, unknown>>;
  const expectedKeys = ["approvalId", "expectedSetupRevision", "userConfirmed"];
  if (Object.keys(approval).sort().join("\0") !== expectedKeys.join("\0")) return false;
  return (
    identifierPattern.test(approval.approvalId) &&
    rawApproval["userConfirmed"] === true &&
    approval.expectedSetupRevision ===
      (session.phase === "merge_authorized" ? session.revision - 1 : session.revision)
  );
}

function approvalReferenceDigest(approvalId: string) {
  return sha256Digest({
    schemaVersion: 1,
    kind: "registration_setup_approval_reference",
    approvalId,
  });
}

function approvalReceiptMatches(
  receipt: RegistrationSetupFinalApprovalReceipt,
  approval: RegistrationSetupFinalApprovalRequest,
  binding: RegistrationSetupApprovalBinding,
): boolean {
  const raw = receipt as unknown as Readonly<Record<string, unknown>>;
  return (
    raw["schemaVersion"] === 1 &&
    (raw["issuer"] === "local_ui" || raw["issuer"] === "current_user_conversation") &&
    receipt.approvalId === approval.approvalId &&
    receipt.setupSessionId === binding.setupSessionId &&
    receipt.setupSessionRevision === binding.setupSessionRevision &&
    receipt.projectId === binding.projectId &&
    receipt.previewDigest === binding.previewDigest &&
    receipt.changeRequestId === binding.changeRequestId &&
    sameSha(receipt.headSha, binding.headSha) &&
    receipt.requirementsDigest === binding.requirementsDigest &&
    receipt.diffDigest === binding.diffDigest &&
    receipt.linearAuditIssueId === binding.linearAuditIssueId &&
    receipt.gateEvidenceDigest === binding.gateEvidenceDigest &&
    digestPattern.test(receipt.authorityDigest) &&
    digestPattern.test(receipt.approvalNonceDigest) &&
    parseInstant(receipt.consumedAt).ok
  );
}

function approvalBinding(
  session: RegistrationSetupSession,
): RegistrationSetupApprovalBinding | undefined {
  const gateEvidenceDigest = session.gateEvidenceReceipt?.evidenceDigest;
  if (gateEvidenceDigest === undefined) return undefined;
  return Object.freeze({
    schemaVersion: 1,
    setupSessionId: session.setupSessionId,
    setupSessionRevision: session.revision,
    projectId: session.project.id,
    previewDigest: session.previewDigest,
    changeRequestId: session.changeRequest.id,
    headSha: session.headSha,
    requirementsDigest: session.requirementsDigest,
    diffDigest: session.diffDigest,
    linearAuditIssueId: session.linearAuditIssueId,
    gateEvidenceDigest,
  });
}

function bumped(
  session: RegistrationSetupSession,
  update: Partial<RegistrationSetupSession>,
): RegistrationSetupSession {
  return Object.freeze({ ...session, ...update, revision: session.revision + 1 });
}

export class RegistrationSetupCoordinator {
  constructor(readonly ports: RegistrationSetupPorts) {}

  async #runExclusive(
    setupSessionId: string,
    signal: AbortSignal | undefined,
    action: (lease: RegistrationSetupExecutionLease) => Promise<RegistrationSetupOutcome>,
  ): Promise<RegistrationSetupOutcome> {
    const exclusive = await this.ports.execution.runExclusive(
      setupSessionId,
      action,
      signal === undefined ? {} : { signal },
    );
    if (!exclusive.ok) return portFailure("session", exclusive.error);
    return exclusive.value.state === "in_progress"
      ? Object.freeze({ state: "in_progress", setupSessionId })
      : exclusive.value.value;
  }

  async #owned<Value>(
    lease: RegistrationSetupExecutionLease,
    operation: () => Promise<Result<Value, DomainError>>,
  ): Promise<Result<Value, DomainError>> {
    const before = await lease.assertOwnership();
    if (!before.ok) return before;
    const result = await operation();
    const after = await lease.assertOwnership();
    return after.ok ? result : after;
  }

  async #saveSession(
    current: RegistrationSetupSession,
    next: RegistrationSetupSession,
    request: RegistrationSetupSessionRequest,
    step: string,
    lease: RegistrationSetupExecutionLease,
  ): Promise<Result<RegistrationSetupSession, DomainError>> {
    const saved = await this.#owned(lease, () =>
      this.ports.sessions.save(
        current.revision,
        withoutSessionRevision(next),
        fencedMutation(request, step, lease),
      ),
    );
    if (!saved.ok) return saved;
    if (saved.value.durability === "confirmed") {
      return Object.freeze({ ok: true, value: saved.value.session });
    }
    const readBack = await this.#owned(lease, () =>
      this.ports.sessions.load(current.setupSessionId),
    );
    return readBack.ok &&
      readBack.value !== undefined &&
      sameValue(withoutSessionRevision(readBack.value), withoutSessionRevision(next))
      ? Object.freeze({ ok: true, value: readBack.value })
      : Object.freeze({ ok: false, error: domainError("external_failure") });
  }

  async begin(request: RegistrationSetupBeginRequest): Promise<RegistrationSetupOutcome> {
    if (
      !identifierPattern.test(request.preview.setupSessionId) ||
      !validPrefix(request.idempotencyKeyPrefix) ||
      !digestPattern.test(request.trustedAuthority.authorityDigest)
    ) {
      return failed("request");
    }
    return this.#runExclusive(request.preview.setupSessionId, request.signal, (lease) =>
      this.#beginExclusive(request, lease),
    );
  }

  async #beginExclusive(
    request: RegistrationSetupBeginRequest,
    lease: RegistrationSetupExecutionLease,
  ): Promise<RegistrationSetupOutcome> {
    if (!validPreviewConfirmation(request)) return failed("request");
    const existing = await this.#owned(lease, () =>
      this.ports.sessions.load(request.preview.setupSessionId),
    );
    if (!existing.ok) return portFailure("session", existing.error);
    if (existing.value !== undefined) {
      if (
        !validSession(existing.value) ||
        existing.value.previewDigest !== request.preview.previewDigest
      ) {
        return failed("session", existing.value);
      }
      return existing.value.phase === "ci_waiting"
        ? Object.freeze({ state: "ci_waiting", session: existing.value })
        : Object.freeze({
            state: "failed",
            stage: "session",
            error: domainError("conflict"),
            session: existing.value,
          });
    }
    const serialized = serializeTrustedProjectConfig(request.preview.config);
    if (!serialized.ok) return failed("request");
    const loadedJournal = await this.#owned(lease, () =>
      this.ports.journal.load(request.preview.setupSessionId),
    );
    if (!loadedJournal.ok) return portFailure("session", loadedJournal.error);
    let journal = loadedJournal.value;
    if (journal === undefined) {
      const confirmation = await this.#owned(lease, () =>
        this.ports.previewConfirmation.verify(
          request.confirmation,
          request.trustedAuthority.authorityDigest,
          mutation(request, "consume-preview-confirmation"),
        ),
      );
      if (!confirmation.ok) return portFailure("request", confirmation.error);
      if (confirmation.value.state !== "verified") return failed("request");
      const planned = await this.#owned(lease, () =>
        this.ports.journal.save(
          undefined,
          {
            schemaVersion: 1,
            setupSessionId: request.preview.setupSessionId,
            preview: request.preview,
            configDigest: serialized.value.contentDigest,
            completed: Object.freeze({}),
          },
          fencedMutation(request, "save-planned", lease),
        ),
      );
      if (!planned.ok) return portFailure("session", planned.error);
      if (planned.value.durability === "confirmed") {
        journal = planned.value.journal;
      } else {
        return failed("session");
      }
    }
    if (
      journal.preview.previewDigest !== request.preview.previewDigest ||
      journal.configDigest !== serialized.value.contentDigest
    ) {
      return failed("session");
    }

    const saveJournal = async (
      draft: RegistrationSetupJournalDraft,
      saveStep: string,
    ): Promise<RegistrationSetupJournal | undefined> => {
      const current = journal;
      if (current === undefined) return undefined;
      const saved = await this.#owned(lease, () =>
        this.ports.journal.save(current.revision, draft, fencedMutation(request, saveStep, lease)),
      );
      if (!saved.ok) return undefined;
      if (saved.value.durability === "confirmed") return saved.value.journal;
      return undefined;
    };
    const prepare = async (step: NonNullable<RegistrationSetupJournal["pending"]>["step"]) => {
      const current = journal;
      if (current === undefined) return false;
      if (current.pending !== undefined) return current.pending.step === step;
      const operationKey = `setup:${request.preview.setupSessionId}:${request.preview.previewDigest.slice(0, 16)}:${step}`;
      const saved = await saveJournal(
        { ...withoutJournalRevision(current), pending: { step, idempotencyKey: operationKey } },
        `journal-intent-${step}`,
      );
      if (saved === undefined) return false;
      journal = saved;
      return true;
    };
    const complete = async (
      step: NonNullable<RegistrationSetupJournal["pending"]>["step"],
      completed: RegistrationSetupJournal["completed"],
    ) => {
      const current = journal;
      if (current?.pending?.step !== step) return false;
      const { pending, ...draft } = withoutJournalRevision(current);
      void pending;
      const saved = await saveJournal({ ...draft, completed }, `journal-receipt-${step}`);
      if (saved === undefined) return false;
      journal = saved;
      return true;
    };

    if (journal.completed.worktree === undefined) {
      if (!(await prepare("worktree"))) return failed("session");
      const operationKey = journal.pending?.idempotencyKey;
      if (operationKey === undefined) return failed("session");
      const created = await this.#owned(lease, () =>
        this.ports.git.createWorktree(
          {
            rootPath: request.preview.project.localRepositoryPath,
            path: request.preview.worktreePath,
            branch: request.preview.branch,
            startPoint: request.preview.baseRevision,
          },
          exactMutation(operationKey, request.signal),
        ),
      );
      if (!created.ok) return portFailure("worktree", created.error);
      if (
        created.value.repositoryRoot !== request.preview.project.localRepositoryPath ||
        created.value.path !== request.preview.worktreePath ||
        created.value.branch !== registrationSetupBranch ||
        !sameSha(created.value.headSha, request.preview.baseRevision)
      )
        return failed("worktree");
      if (!(await complete("worktree", { ...journal.completed, worktree: created.value }))) {
        return failed("session");
      }
    }
    const worktree = journal.completed.worktree;
    if (worktree === undefined) return failed("session");

    if (journal.completed.write === undefined) {
      if (!(await prepare("write"))) return failed("session");
      const operationKey = journal.pending?.idempotencyKey;
      if (operationKey === undefined) return failed("session");
      const written = await this.#owned(lease, () =>
        this.ports.setupFiles.writeTrustedProjectConfig(
          {
            worktree,
            path: trustedProjectConfigPath,
            content: serialized.value.content,
            contentDigest: serialized.value.contentDigest,
          },
          exactMutation(operationKey, request.signal),
        ),
      );
      if (!written.ok) return portFailure("write", written.error);
      if (
        written.value.path !== trustedProjectConfigPath ||
        written.value.contentDigest !== serialized.value.contentDigest
      )
        return failed("write");
      if (!(await complete("write", { ...journal.completed, write: written.value }))) {
        return failed("session");
      }
    }

    if (journal.completed.stage === undefined) {
      let stagedReceipt: RegistrationSetupJournal["completed"]["stage"];
      if (journal.pending?.step === "stage") {
        const [observed, stagedDiff, file] = await Promise.all([
          this.#owned(lease, () => this.ports.git.inspectWorkingTree(worktree)),
          this.#owned(lease, () =>
            this.ports.git.getStagedTreeDiff(worktree, request.preview.baseRevision),
          ),
          this.#owned(lease, () =>
            this.ports.setupFiles.readTrustedProjectConfig({
              worktree,
              path: trustedProjectConfigPath,
            }),
          ),
        ]);
        if (!observed.ok) return portFailure("stage", observed.error);
        if (!stagedDiff.ok) return portFailure("stage", stagedDiff.error);
        if (!file.ok) return portFailure("stage", file.error);
        const stagedChange = observed.value.changes[0];
        const hasStagedChanges = observed.value.changes.some((change) => change.staged);
        if (hasStagedChanges) {
          if (
            !sameSha(observed.value.headSha, request.preview.baseRevision) ||
            observed.value.changes.length !== 1 ||
            stagedChange?.path !== trustedProjectConfigPath ||
            !stagedChange.staged ||
            file.value.contentDigest !== serialized.value.contentDigest ||
            file.value.content !== serialized.value.content ||
            !isExactTrustedConfigDiff(stagedDiff.value, serialized.value.content)
          ) {
            return failed("stage");
          }
          stagedReceipt = {
            headSha: observed.value.headSha,
            paths: [trustedProjectConfigPath],
          };
        } else if (stagedDiff.value.length !== 0) {
          return failed("stage");
        }
      }

      if (stagedReceipt === undefined) {
        const preflight = await this.#owned(lease, () =>
          this.ports.preflight.inspect(
            {
              worktree,
              declaredRegions: [{ path: ".agent-team", coverage: "subtree" }],
              expectedUntrackedPaths: [trustedProjectConfigPath],
            },
            request.signal === undefined ? {} : { signal: request.signal },
          ),
        );
        if (!preflight.ok) return portFailure("preflight", preflight.error);
        if (
          !preflight.value.allowed ||
          !preflight.value.scopeVerified ||
          !sameSha(preflight.value.headSha, request.preview.baseRevision) ||
          preflight.value.findings.length > 0 ||
          preflight.value.changedPaths.length !== 1 ||
          preflight.value.changedPaths[0] !== trustedProjectConfigPath
        ) {
          return failed("preflight");
        }
      }
      if (!(await prepare("stage"))) return failed("session");
      const operationKey = journal.pending?.idempotencyKey;
      if (operationKey === undefined) return failed("session");
      if (stagedReceipt === undefined) {
        const staged = await this.#owned(lease, () =>
          this.ports.git.stagePaths(
            worktree,
            [trustedProjectConfigPath],
            exactMutation(operationKey, request.signal),
          ),
        );
        if (!staged.ok) return portFailure("stage", staged.error);
        const stagedChange = staged.value.changes[0];
        if (
          !sameSha(staged.value.headSha, request.preview.baseRevision) ||
          staged.value.changes.length !== 1 ||
          stagedChange?.path !== trustedProjectConfigPath ||
          !stagedChange.staged
        )
          return failed("stage");
        const stagedDiff = await this.#owned(lease, () =>
          this.ports.git.getStagedTreeDiff(worktree, request.preview.baseRevision),
        );
        if (!stagedDiff.ok) return portFailure("stage", stagedDiff.error);
        if (!isExactTrustedConfigDiff(stagedDiff.value, serialized.value.content)) {
          return failed("stage");
        }
        stagedReceipt = { headSha: staged.value.headSha, paths: [trustedProjectConfigPath] };
      }
      if (
        !(await complete("stage", {
          ...journal.completed,
          stage: stagedReceipt,
        }))
      ) {
        return failed("session");
      }
    }

    if (journal.completed.commit === undefined) {
      if (!(await prepare("commit"))) return failed("session");
      const operationKey = journal.pending?.idempotencyKey;
      if (operationKey === undefined) return failed("session");
      const expectedMessage = setupCommitMessage(operationKey);
      let commitReceipt: Readonly<{ sha: string; branch: string }> | undefined;
      const observed = await this.#owned(lease, () => this.ports.git.inspectWorkingTree(worktree));
      if (!observed.ok) return portFailure("commit", observed.error);
      if (!sameSha(observed.value.headSha, request.preview.baseRevision)) {
        const [file, changes, commit] = await Promise.all([
          this.#owned(lease, () =>
            this.ports.setupFiles.readTrustedProjectConfig({
              worktree,
              path: trustedProjectConfigPath,
            }),
          ),
          this.#owned(lease, () =>
            this.ports.git.getEffectiveTreeDiff(
              { rootPath: request.preview.project.localRepositoryPath },
              request.preview.baseRevision,
              observed.value.headSha,
            ),
          ),
          this.#owned(lease, () =>
            this.ports.git.inspectCommit({ rootPath: worktree.path }, observed.value.headSha),
          ),
        ]);
        if (
          file.ok &&
          changes.ok &&
          commit.ok &&
          observed.value.changes.length === 0 &&
          file.value.contentDigest === serialized.value.contentDigest &&
          file.value.content === serialized.value.content &&
          isExactTrustedConfigDiff(changes.value, serialized.value.content) &&
          sameSha(commit.value.sha, observed.value.headSha) &&
          commit.value.parentShas.length === 1 &&
          sameSha(commit.value.parentShas[0] ?? "", request.preview.baseRevision) &&
          commit.value.message === expectedMessage
        ) {
          commitReceipt = { sha: observed.value.headSha, branch: registrationSetupBranch };
        } else {
          return failed("commit");
        }
      }
      if (commitReceipt === undefined) {
        const [stagedDiff, file] = await Promise.all([
          this.#owned(lease, () =>
            this.ports.git.getStagedTreeDiff(worktree, request.preview.baseRevision),
          ),
          this.#owned(lease, () =>
            this.ports.setupFiles.readTrustedProjectConfig({
              worktree,
              path: trustedProjectConfigPath,
            }),
          ),
        ]);
        const stagedChange = observed.value.changes[0];
        if (!stagedDiff.ok) return portFailure("commit", stagedDiff.error);
        if (!file.ok) return portFailure("commit", file.error);
        if (
          observed.value.changes.length !== 1 ||
          stagedChange?.path !== trustedProjectConfigPath ||
          !stagedChange.staged ||
          file.value.contentDigest !== serialized.value.contentDigest ||
          file.value.content !== serialized.value.content ||
          !isExactTrustedConfigDiff(stagedDiff.value, serialized.value.content)
        ) {
          return failed("commit");
        }
        const committed = await this.#owned(lease, () =>
          this.ports.git.commit(
            {
              worktree,
              message: expectedMessage,
              expectedStagedPaths: [trustedProjectConfigPath],
            },
            exactMutation(operationKey, request.signal),
          ),
        );
        if (!committed.ok) return portFailure("commit", committed.error);
        commitReceipt = committed.value;
      }
      if (commitReceipt.branch !== registrationSetupBranch || !shaPattern.test(commitReceipt.sha)) {
        return failed("commit");
      }
      const clean = await this.#owned(lease, () => this.ports.git.inspectWorkingTree(worktree));
      if (!clean.ok) return portFailure("commit", clean.error);
      if (!sameSha(clean.value.headSha, commitReceipt.sha) || clean.value.changes.length !== 0) {
        return failed("commit");
      }
      if (!(await complete("commit", { ...journal.completed, commit: commitReceipt }))) {
        return failed("session");
      }
    }
    const commitReceipt = journal.completed.commit;
    if (commitReceipt === undefined) return failed("session");

    if (journal.completed.push === undefined) {
      if (!(await prepare("push"))) return failed("session");
      const operationKey = journal.pending?.idempotencyKey;
      if (operationKey === undefined) return failed("session");
      const pushed = await this.#owned(lease, () =>
        this.ports.git.push(
          worktree,
          request.preview.remote,
          exactMutation(operationKey, request.signal),
        ),
      );
      if (!pushed.ok) return portFailure("push", pushed.error);
      if (
        pushed.value.remote !== request.preview.remote ||
        pushed.value.branch !== registrationSetupBranch ||
        !sameSha(pushed.value.sha, commitReceipt.sha)
      )
        return failed("push");
      if (!(await complete("push", { ...journal.completed, push: pushed.value }))) {
        return failed("session");
      }
    }
    const pushed = journal.completed.push;
    if (pushed === undefined) return failed("session");

    const draftCommand = {
      project: request.preview.project,
      title: "Configure Agent Team trusted project settings",
      body: [
        "Agent Team registration Setup PR.",
        `setup_session=${request.preview.setupSessionId}`,
        `preview_digest=${request.preview.previewDigest}`,
        `requirements_digest=${request.preview.requirementsDigest}`,
        `linear_audit_issue=${request.preview.linearAuditIssueId}`,
        "This PR has no fast path and requires CI, fresh review, and explicit user approval.",
      ].join("\n"),
      baseBranch: request.preview.project.defaultBranch,
      headBranch: registrationSetupBranch,
    };
    let draft;
    if (journal.completed.draftPullRequest === undefined) {
      if (!(await prepare("draft_pull_request"))) return failed("session");
      const operationKey = journal.pending?.idempotencyKey;
      if (operationKey === undefined) return failed("session");
      draft = await this.#owned(lease, () =>
        this.ports.sourceControl.createDraftChangeRequest(
          draftCommand,
          exactMutation(operationKey, request.signal),
        ),
      );
      if (!draft.ok) return portFailure("draft_pull_request", draft.error);
      if (
        draft.value.state !== "open" ||
        !draft.value.draft ||
        draft.value.baseBranch !== request.preview.project.defaultBranch ||
        draft.value.headBranch !== registrationSetupBranch ||
        !sameSha(draft.value.headSha, pushed.sha)
      )
        return failed("draft_pull_request");
      if (
        !(await complete("draft_pull_request", {
          ...journal.completed,
          draftPullRequest: { changeRequestId: draft.value.id, headSha: draft.value.headSha },
        }))
      )
        return failed("session");
    } else {
      const draftReceipt = journal.completed.draftPullRequest;
      draft = await this.#owned(lease, () =>
        this.ports.sourceControl.getChangeRequest({
          project: request.preview.project,
          changeRequestId: draftReceipt.changeRequestId,
        }),
      );
      if (!draft.ok) return portFailure("draft_pull_request", draft.error);
    }
    if (
      draft.value.state !== "open" ||
      !draft.value.draft ||
      !sameSha(draft.value.headSha, pushed.sha)
    )
      return failed("draft_pull_request");

    const diff = await this.#owned(lease, () =>
      this.ports.git.getEffectiveTreeDiff(
        { rootPath: request.preview.project.localRepositoryPath },
        request.preview.baseRevision,
        pushed.sha,
      ),
    );
    if (!diff.ok) return portFailure("diff", diff.error);
    if (!isExactTrustedConfigDiff(diff.value, serialized.value.content)) return failed("diff");
    const diffDigest = createDiffDigest(diff.value);
    if (!diffDigest.ok) return failed("diff");
    if (journal.completed.diff === undefined) {
      const saved = await saveJournal(
        {
          ...withoutJournalRevision(journal),
          completed: { ...journal.completed, diff: { digest: diffDigest.value } },
        },
        "journal-receipt-diff",
      );
      if (saved === undefined) return failed("session");
      journal = saved;
    } else if (journal.completed.diff.digest !== diffDigest.value) {
      return failed("diff");
    }

    const sessionDraft: RegistrationSetupSessionDraft = Object.freeze({
      schemaVersion: 1,
      phase: "ci_waiting",
      setupSessionId: request.preview.setupSessionId,
      project: request.preview.project,
      config: request.preview.config,
      baseRevision: request.preview.baseRevision,
      worktree,
      remote: request.preview.remote,
      previewDigest: request.preview.previewDigest,
      requirementsDigest: request.preview.requirementsDigest,
      diffDigest: diffDigest.value,
      configDigest: serialized.value.contentDigest,
      headSha: pushed.sha,
      changeRequest: draft.value,
      linearAuditIssueId: request.preview.linearAuditIssueId,
      evidence: Object.freeze([
        evidence("setup_worktree_created", request.preview),
        evidence("trusted_config_written", request.preview),
        evidence("setup_preflight_passed", request.preview),
        evidence("setup_commit_pushed", request.preview, { headSha: pushed.sha }),
        evidence("setup_draft_pr_created", request.preview, {
          headSha: pushed.sha,
          diffDigest: diffDigest.value,
          changeRequestId: draft.value.id,
        }),
      ]),
    });
    const saved = await this.#owned(lease, () =>
      this.ports.sessions.save(
        undefined,
        sessionDraft,
        fencedMutation(request, "save-created", lease),
      ),
    );
    if (!saved.ok) return portFailure("session", saved.error);
    let session = saved.value.session;
    if (saved.value.durability !== "confirmed") {
      const readBack = await this.#owned(lease, () =>
        this.ports.sessions.load(request.preview.setupSessionId),
      );
      if (
        !readBack.ok ||
        readBack.value === undefined ||
        !sameValue(withoutSessionRevision(readBack.value), sessionDraft)
      ) {
        return failed("session");
      }
      session = readBack.value;
    }
    return Object.freeze({ state: "ci_waiting", session });
  }

  async refresh(request: RegistrationSetupSessionRequest): Promise<RegistrationSetupOutcome> {
    if (
      !identifierPattern.test(request.setupSessionId) ||
      !validPrefix(request.idempotencyKeyPrefix)
    ) {
      return failed("request");
    }
    return this.#runExclusive(request.setupSessionId, request.signal, (lease) =>
      this.#refreshExclusive(request, lease),
    );
  }

  async #refreshExclusive(
    request: RegistrationSetupSessionRequest,
    lease: RegistrationSetupExecutionLease,
  ): Promise<RegistrationSetupOutcome> {
    const loaded = await this.#owned(lease, () => this.ports.sessions.load(request.setupSessionId));
    if (!loaded.ok) return portFailure("session", loaded.error);
    if (loaded.value === undefined) return Object.freeze({ state: "blocked", reason: "not_found" });
    const session = loaded.value;
    if (!validSession(session)) return failed("session", session);
    if (session.phase === "cancelled")
      return Object.freeze({ state: "blocked", reason: "cancelled" });
    if (session.phase === "activated") {
      return Object.freeze({
        state: "activated",
        session,
        revisionSha: session.activatedRevisionSha ?? "",
      });
    }
    if (session.phase === "merge_authorized")
      return Object.freeze({ state: "merge_pending", session });
    return this.#readGatesAndAdvance(session, request, lease);
  }

  async #readGatesAndAdvance(
    session: RegistrationSetupSession,
    request: RegistrationSetupSessionRequest,
    lease: RegistrationSetupExecutionLease,
  ): Promise<RegistrationSetupOutcome> {
    const reference = { project: session.project, changeRequestId: session.changeRequest.id };
    const current = await this.#owned(lease, () =>
      this.ports.sourceControl.getChangeRequest(reference),
    );
    if (!current.ok) return portFailure("change_request", current.error, session);
    if (
      current.value.state !== "open" ||
      current.value.baseBranch !== session.project.defaultBranch ||
      current.value.headBranch !== registrationSetupBranch ||
      !sameSha(current.value.headSha, session.headSha)
    ) {
      return failed("change_request", session);
    }
    let ready = current.value;
    if (ready.draft) {
      const marked = await this.#owned(lease, () =>
        this.ports.sourceControl.markChangeRequestReady(
          reference,
          session.headSha,
          mutation(request, "ready-for-review"),
        ),
      );
      if (!marked.ok) return portFailure("change_request", marked.error, session);
      if (
        marked.value.state !== "open" ||
        marked.value.draft ||
        !sameSha(marked.value.headSha, session.headSha)
      ) {
        return failed("change_request", session);
      }
      ready = marked.value;
    }
    const diff = await this.#owned(lease, () =>
      this.ports.git.getEffectiveTreeDiff(
        { rootPath: session.project.localRepositoryPath },
        session.baseRevision,
        session.headSha,
      ),
    );
    if (!diff.ok) return portFailure("diff", diff.error, session);
    const serialized = serializeTrustedProjectConfig(session.config);
    if (
      !serialized.ok ||
      serialized.value.contentDigest !== session.configDigest ||
      !isExactTrustedConfigDiff(diff.value, serialized.value.content)
    ) {
      return failed("diff", session);
    }
    const digest = createDiffDigest(diff.value);
    if (!digest.ok || digest.value !== session.diffDigest) return failed("diff", session);
    let working = session;
    if (working.gateEvidenceReceipt === undefined) {
      const gate = await this.#owned(lease, () =>
        this.ports.gateEvidence.read({
          project: working.project,
          changeRequestId: working.changeRequest.id,
          expectedHeadSha: working.headSha,
          requirementsDigest: working.requirementsDigest,
          diffDigest: working.diffDigest,
        }),
      );
      if (!gate.ok) return portFailure("checks", gate.error, working);
      if (gate.value.state === "not_ready") {
        const reason =
          gate.value.reason === "ci_pending"
            ? "pending"
            : gate.value.reason === "ci_failed"
              ? "ci_failed"
              : gate.value.reason === "review_pending"
                ? "review_pending"
                : "review_failed";
        return Object.freeze({ state: "not_ready", reason, session: working });
      }
      const preview: RegistrationSetupPreview = {
        schemaVersion: 1,
        setupSessionId: working.setupSessionId,
        project: working.project,
        config: working.config,
        baseRevision: working.baseRevision,
        worktreePath: working.worktree.path,
        branch: registrationSetupBranch,
        remote: working.remote,
        linearAuditIssueId: working.linearAuditIssueId,
        previewDigest: working.previewDigest,
        requirementsDigest: working.requirementsDigest,
      };
      const advanced = bumped(working, {
        phase: "audit_pending",
        changeRequest: ready,
        gateEvidenceReceipt: gate.value.receipt,
        audit: Object.freeze({}),
        evidence: Object.freeze([
          ...working.evidence,
          evidence("setup_ci_passed", preview, { headSha: working.headSha }),
          evidence("setup_fresh_review_passed", preview, {
            headSha: working.headSha,
            diffDigest: working.diffDigest,
            changeRequestId: working.changeRequest.id,
          }),
        ]),
      });
      const saved = await this.#saveSession(
        working,
        advanced,
        request,
        "save-gate-evidence",
        lease,
      );
      if (!saved.ok) return portFailure("session", saved.error, working);
      working = saved.value;
    }
    if (!gateEvidenceMatches(working)) return failed("checks", working);
    if (working.phase === "awaiting_user_approval") {
      return Object.freeze({ state: "awaiting_user_approval", session: working });
    }
    if (working.phase !== "audit_pending") return failed("audit", working);

    for (const destination of ["linear", "pull_request"] as const) {
      const receipt =
        destination === "linear" ? working.audit?.linearReceipt : working.audit?.pullRequestReceipt;
      if (receipt !== undefined) {
        if (!auditReceiptMatches(working, receipt, destination)) return failed("audit", working);
        continue;
      }
      const expected = auditIntent(working, destination);
      if (expected === undefined) return failed("audit", working);
      let pending = working.audit?.pending;
      if (pending === undefined) {
        const planned = bumped(working, {
          audit: Object.freeze({ ...working.audit, pending: expected }),
        });
        const saved = await this.#saveSession(
          working,
          planned,
          request,
          `save-audit-intent-${destination}`,
          lease,
        );
        if (!saved.ok) return portFailure("session", saved.error, working);
        working = saved.value;
        pending = working.audit?.pending;
      }
      if (pending === undefined || !sameValue(pending, expected)) return failed("audit", working);
      const published = await this.#owned(lease, () =>
        this.ports.audit.publish(pending, exactMutation(pending.idempotencyKey, request.signal)),
      );
      if (!published.ok) return portFailure("audit", published.error, working);
      if (!auditReceiptMatches(working, published.value, destination)) {
        return failed("audit", working);
      }
      const { pending: _pending, ...auditWithoutPending } = working.audit ?? {};
      void _pending;
      const completed = bumped(working, {
        audit: Object.freeze({
          ...auditWithoutPending,
          ...(destination === "linear"
            ? { linearReceipt: published.value }
            : { pullRequestReceipt: published.value }),
        }),
      });
      const saved = await this.#saveSession(
        working,
        completed,
        request,
        `save-audit-receipt-${destination}`,
        lease,
      );
      if (!saved.ok) return portFailure("session", saved.error, working);
      working = saved.value;
    }
    if (
      !auditReceiptMatches(working, working.audit?.linearReceipt, "linear") ||
      !auditReceiptMatches(working, working.audit?.pullRequestReceipt, "pull_request")
    ) {
      return Object.freeze({ state: "audit_pending", session: working });
    }
    const awaiting = bumped(working, { phase: "awaiting_user_approval" });
    const saved = await this.#saveSession(
      working,
      awaiting,
      request,
      "save-awaiting-approval",
      lease,
    );
    if (!saved.ok) return portFailure("session", saved.error, working);
    return Object.freeze({ state: "awaiting_user_approval", session: saved.value });
  }

  async authorizeMerge(
    request: RegistrationSetupMergeRequest,
    authority: RegistrationSetupFinalApprovalAuthority,
  ): Promise<RegistrationSetupOutcome> {
    const rawAuthority = authority as unknown as Readonly<Record<string, unknown>>;
    if (
      !identifierPattern.test(request.setupSessionId) ||
      !validPrefix(request.idempotencyKeyPrefix) ||
      !digestPattern.test(authority.authorityDigest) ||
      (rawAuthority["issuer"] !== "local_ui" &&
        rawAuthority["issuer"] !== "current_user_conversation")
    ) {
      return failed("request");
    }
    return this.#runExclusive(request.setupSessionId, request.signal, (lease) =>
      this.#authorizeMergeExclusive(request, authority, lease),
    );
  }

  /** B1 compatibility shim; authorizes only and never merges or activates. */
  approveAndMerge(
    request: RegistrationSetupMergeRequest,
    authority: RegistrationSetupFinalApprovalAuthority,
  ): Promise<RegistrationSetupOutcome> {
    return this.authorizeMerge(request, authority);
  }

  async #authorizeMergeExclusive(
    request: RegistrationSetupMergeRequest,
    authority: RegistrationSetupFinalApprovalAuthority,
    lease: RegistrationSetupExecutionLease,
  ): Promise<RegistrationSetupOutcome> {
    const loaded = await this.#owned(lease, () => this.ports.sessions.load(request.setupSessionId));
    if (!loaded.ok) return portFailure("session", loaded.error);
    if (loaded.value === undefined) return Object.freeze({ state: "blocked", reason: "not_found" });
    let session = loaded.value;
    if (!validSession(session)) return failed("session", session);
    if (session.phase === "cancelled")
      return Object.freeze({ state: "blocked", reason: "cancelled" });
    if (session.phase === "activated") {
      return Object.freeze({ state: "blocked", reason: "approval_replay" });
    }
    if (!finalApprovalMatches(request.approval, session)) {
      return Object.freeze({ state: "blocked", reason: "user_approval_invalid" });
    }
    if (session.phase !== "awaiting_user_approval" && session.phase !== "merge_authorized") {
      return Object.freeze({ state: "blocked", reason: "user_approval_invalid" });
    }
    const approval = request.approval;
    if (session.phase === "merge_authorized") {
      const referenceDigest = approvalReferenceDigest(approval.approvalId);
      if (!referenceDigest.ok || session.approvalReferenceDigest !== referenceDigest.value) {
        return Object.freeze({ state: "blocked", reason: "approval_replay" });
      }
    } else {
      const expectedBinding = approvalBinding(session);
      if (expectedBinding === undefined) return failed("approval", session);
      const consumed = await this.#owned(lease, () =>
        this.ports.finalApproval.verifyAndConsume(
          approval,
          expectedBinding,
          authority,
          mutation(request, "verify-consume-user-approval"),
        ),
      );
      if (!consumed.ok) return portFailure("approval", consumed.error, session);
      if (consumed.value.state !== "verified_and_consumed") {
        return Object.freeze({
          state: "blocked",
          reason: consumed.value.state === "replay" ? "approval_replay" : "user_approval_invalid",
        });
      }
      if (
        !approvalReceiptMatches(consumed.value.receipt, approval, expectedBinding) ||
        consumed.value.receipt.issuer !== authority.issuer ||
        consumed.value.receipt.authorityDigest !== authority.authorityDigest
      ) {
        return failed("approval", session);
      }
      const referenceDigest = approvalReferenceDigest(approval.approvalId);
      if (!referenceDigest.ok) return failed("approval", session);
      const authorized = bumped(session, {
        phase: "merge_authorized",
        approvalReferenceDigest: referenceDigest.value,
        approvalNonceDigest: consumed.value.receipt.approvalNonceDigest,
        approvalAuthorityDigest: consumed.value.receipt.authorityDigest,
        approvalSource: consumed.value.receipt.issuer,
        evidence: Object.freeze([
          ...session.evidence,
          Object.freeze({
            code: "setup_user_approval_consumed" as const,
            projectId: session.project.id,
            setupSessionId: session.setupSessionId,
            previewDigest: session.previewDigest,
            requirementsDigest: session.requirementsDigest,
            headSha: session.headSha,
            diffDigest: session.diffDigest,
            changeRequestId: session.changeRequest.id,
          }),
        ]),
      });
      const saved = await this.#owned(lease, () =>
        this.ports.sessions.save(
          session.revision,
          withoutSessionRevision(authorized),
          fencedMutation(request, "save-merge-authorized", lease),
        ),
      );
      if (!saved.ok) return portFailure("session", saved.error, session);
      if (saved.value.durability === "confirmed") {
        session = saved.value.session;
      } else {
        const readBack = await this.#owned(lease, () =>
          this.ports.sessions.load(session.setupSessionId),
        );
        if (
          !readBack.ok ||
          readBack.value === undefined ||
          !sameValue(withoutSessionRevision(readBack.value), withoutSessionRevision(authorized))
        )
          return failed("session", session);
        session = readBack.value;
      }
    }
    return Object.freeze({ state: "merge_pending", session });
  }

  async cancel(request: RegistrationSetupSessionRequest): Promise<RegistrationSetupOutcome> {
    if (
      !identifierPattern.test(request.setupSessionId) ||
      !validPrefix(request.idempotencyKeyPrefix)
    ) {
      return failed("request");
    }
    return this.#runExclusive(request.setupSessionId, request.signal, (lease) =>
      this.#cancelExclusive(request, lease),
    );
  }

  async #cancelExclusive(
    request: RegistrationSetupSessionRequest,
    lease: RegistrationSetupExecutionLease,
  ): Promise<RegistrationSetupOutcome> {
    const loaded = await this.#owned(lease, () => this.ports.sessions.load(request.setupSessionId));
    if (!loaded.ok) return portFailure("session", loaded.error);
    if (loaded.value === undefined) return Object.freeze({ state: "blocked", reason: "not_found" });
    const session = loaded.value;
    if (!validSession(session)) return failed("session", session);
    if (session.phase === "activated") {
      return Object.freeze({ state: "blocked", reason: "approval_replay" });
    }
    if (session.phase === "cancelled") {
      return Object.freeze({ state: "cancelled", session });
    }
    const cancelled = bumped(session, { phase: "cancelled" });
    const saved = await this.#owned(lease, () =>
      this.ports.sessions.save(
        session.revision,
        withoutSessionRevision(cancelled),
        fencedMutation(request, "save-cancelled", lease),
      ),
    );
    if (!saved.ok) return portFailure("session", saved.error, session);
    let cancelledSession = saved.value.session;
    if (saved.value.durability !== "confirmed") {
      const readBack = await this.#owned(lease, () =>
        this.ports.sessions.load(session.setupSessionId),
      );
      if (
        !readBack.ok ||
        readBack.value === undefined ||
        !sameValue(withoutSessionRevision(readBack.value), withoutSessionRevision(cancelled))
      )
        return failed("session", session);
      cancelledSession = readBack.value;
    }
    return Object.freeze({ state: "cancelled", session: cancelledSession });
  }
}
