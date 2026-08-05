import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

import { projectSchema, type Project } from "../../domain/project/index.js";
import type { TrustedProjectConfig } from "../projects/index.js";
import { serializeTrustedProjectConfig, trustedProjectConfigSchema } from "../projects/index.js";
import type { AsyncPortResult, GitPort, ReadOptions } from "../ports/index.js";
import { createRegistrationSetupPreview, type RegistrationSetupCoordinator } from "./setup.js";
import {
  registrationSetupBranch,
  type RegistrationSetupApprovalBinding,
  type RegistrationSetupConversationApprovalBridgePort,
  type RegistrationSetupConversationHostCapability,
  type RegistrationSetupFinalApprovalAuthorityPort,
  type RegistrationSetupOutcome,
  type RegistrationSetupPreview,
  type RegistrationSetupPreviewConfirmationAuthorityPort,
  type RegistrationSetupSession,
  type RegistrationSetupSessionPort,
  type RegistrationSetupTrustedAuthority,
} from "./setup-model.js";

const digestPattern = /^[0-9a-f]{64}$/u;
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:@+-]{0,220}$/u;
export const registrationSetupPreviewConfirmationPhrase = "CREATE SETUP DRAFT PR" as const;
export const registrationSetupFinalApprovalPhrase = "APPROVE SETUP MERGE" as const;

export interface RegistrationSetupDraft {
  readonly project: Project;
  readonly config: TrustedProjectConfig;
  readonly linearAuditIssueId: string;
}

/** The host owns this source; request payloads never populate it. */
export interface RegistrationSetupDraftSourcePort {
  load(options?: ReadOptions): AsyncPortResult<RegistrationSetupDraft>;
}

export type RegistrationSetupControllerContext = RegistrationSetupTrustedAuthority;

export interface RegistrationSetupControllerEvidence {
  readonly code:
    | "draft_source_unwired"
    | "production_dependencies_unwired"
    | "draft_source_unavailable"
    | "draft_invalid"
    | "linear_audit_issue_invalid"
    | "local_repository_unavailable"
    | "default_branch_mismatch"
    | "working_tree_not_clean"
    | "merge_w3b_unwired"
    | "audit_w3b_unwired"
    | "activation_w3b_unwired"
    | "conversation_approval_w3b_unwired";
  readonly message: string;
}

export interface RegistrationSetupPreviewSummary {
  readonly setupSessionId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly repository: string;
  readonly defaultBranch: string;
  readonly baseRevision: string;
  readonly previewDigest: string;
  readonly requirementsDigest: string;
  readonly linearAuditIssueId: string;
}

export type RegistrationSetupControllerReadModel = Readonly<{
  state:
    | "configuration_incomplete"
    | "preview_ready"
    | "ci_waiting"
    | "audit_pending"
    | "checks_pending"
    | "awaiting_user_approval";
  evidence: readonly RegistrationSetupControllerEvidence[];
  nextStep: string;
  preview?: RegistrationSetupPreviewSummary;
  session?: Readonly<{
    setupSessionId: string;
    revision: number;
    phase: RegistrationSetupSession["phase"];
    pullRequestUrl: string;
    changeRequestId: string;
    headSha: string;
    diffDigest: string;
    ciPassed: boolean;
    freshReviewPassed: boolean;
  }>;
}>;

export type RegistrationSetupControllerActionResult =
  | RegistrationSetupControllerReadModel
  | Readonly<{
      state: "preview_confirmation_issued";
      setupSessionId: string;
      previewDigest: string;
      tokenId: string;
      expiresAt: string;
    }>
  | Readonly<{
      state: "approval_intent_issued";
      setupSessionId: string;
      expectedSetupRevision: number;
      approvalId: string;
      expiresAt: string;
      mergeState: "configuration_incomplete";
    }>
  | RegistrationSetupOutcome;

export interface RegistrationSetupConfirmPreviewCommand {
  readonly setupSessionId: string;
  readonly previewDigest: string;
  readonly confirmation: string;
  readonly idempotencyKey: string;
}

export interface RegistrationSetupStartCommand {
  readonly setupSessionId: string;
  readonly previewDigest: string;
  readonly tokenId: string;
  readonly idempotencyKeyPrefix: string;
}

export interface RegistrationSetupRefreshCommand {
  readonly setupSessionId: string;
  readonly idempotencyKeyPrefix: string;
}

export interface RegistrationSetupApprovalIntentCommand extends RegistrationSetupRefreshCommand {
  readonly expectedSetupRevision: number;
  readonly confirmation: string;
  readonly idempotencyKey: string;
}

export interface RegistrationSetupControllerUseCase {
  read(
    context: RegistrationSetupControllerContext,
    options?: ReadOptions,
  ): Promise<RegistrationSetupControllerReadModel>;
  confirmPreview(
    command: RegistrationSetupConfirmPreviewCommand,
    context: RegistrationSetupControllerContext,
  ): Promise<RegistrationSetupControllerActionResult>;
  start(
    command: RegistrationSetupStartCommand,
    context: RegistrationSetupControllerContext,
  ): Promise<RegistrationSetupControllerActionResult>;
  refresh(
    command: RegistrationSetupRefreshCommand,
    context: RegistrationSetupControllerContext,
  ): Promise<RegistrationSetupControllerActionResult>;
  issueLocalUiApprovalIntent(
    command: RegistrationSetupApprovalIntentCommand,
    context: RegistrationSetupControllerContext,
  ): Promise<RegistrationSetupControllerActionResult>;
}

export interface RegistrationSetupControllerPorts {
  readonly stateRoot: string;
  readonly draftSource?: RegistrationSetupDraftSourcePort;
  readonly git: Pick<GitPort, "inspectRepository">;
  readonly coordinator: Pick<RegistrationSetupCoordinator, "begin" | "refresh">;
  readonly sessions: Pick<RegistrationSetupSessionPort, "load">;
  readonly previewConfirmation: RegistrationSetupPreviewConfirmationAuthorityPort;
  readonly finalApproval: RegistrationSetupFinalApprovalAuthorityPort;
}

export interface RegistrationSetupConversationApprovalFacade {
  issueConversationApprovalIntent(
    command: RegistrationSetupApprovalIntentCommand,
    hostCapability: RegistrationSetupConversationHostCapability,
  ): Promise<RegistrationSetupControllerActionResult>;
}

export interface RegistrationSetupConversationApprovalFacadePorts {
  readonly coordinator: Pick<RegistrationSetupCoordinator, "refresh">;
  readonly bridge: RegistrationSetupConversationApprovalBridgePort;
}

const w3bEvidence = Object.freeze([
  Object.freeze({
    code: "merge_w3b_unwired" as const,
    message: "合併能力留待 W3B；本頁不會執行 merge。",
  }),
  Object.freeze({
    code: "activation_w3b_unwired" as const,
    message: "可信設定啟用與 loader gate 留待 W3B。",
  }),
]);

function validContext(context: RegistrationSetupControllerContext): boolean {
  return digestPattern.test(context.authorityDigest);
}

function incomplete(
  evidence: RegistrationSetupControllerEvidence,
): RegistrationSetupControllerReadModel {
  return Object.freeze({
    state: "configuration_incomplete",
    evidence: Object.freeze([evidence, ...w3bEvidence]),
    nextStep: "完成 server-side Setup draft source 與本機依賴接線後重新整理。",
  });
}

function sessionSummary(session: RegistrationSetupSession) {
  const evidence = new Set(session.evidence.map((item) => item.code));
  return Object.freeze({
    setupSessionId: session.setupSessionId,
    revision: session.revision,
    phase: session.phase,
    pullRequestUrl: session.changeRequest.url,
    changeRequestId: session.changeRequest.id,
    headSha: session.headSha,
    diffDigest: session.diffDigest,
    linearAuditIssueId: session.linearAuditIssueId,
    gateEvidenceDigest: session.gateEvidenceReceipt?.evidenceDigest,
    ciPassed: evidence.has("setup_ci_passed"),
    freshReviewPassed: evidence.has("setup_fresh_review_passed"),
  });
}

function previewSummary(preview: RegistrationSetupPreview): RegistrationSetupPreviewSummary {
  return Object.freeze({
    setupSessionId: preview.setupSessionId,
    projectId: preview.project.id,
    projectName: preview.project.displayName,
    repository: preview.project.sourceControl.repository,
    defaultBranch: preview.project.defaultBranch,
    baseRevision: preview.baseRevision,
    previewDigest: preview.previewDigest,
    requirementsDigest: preview.requirementsDigest,
    linearAuditIssueId: preview.linearAuditIssueId,
  });
}

function readModel(
  preview: RegistrationSetupPreview,
  session?: RegistrationSetupSession,
): RegistrationSetupControllerReadModel {
  if (session === undefined) {
    return Object.freeze({
      state: "preview_ready",
      evidence: w3bEvidence,
      nextStep: `輸入 ${registrationSetupPreviewConfirmationPhrase} 取得一次性確認後建立 Draft PR。`,
      preview: previewSummary(preview),
    });
  }
  const state =
    session.phase === "awaiting_user_approval"
      ? "awaiting_user_approval"
      : session.phase === "ci_waiting"
        ? "ci_waiting"
        : session.phase === "audit_pending"
          ? "audit_pending"
          : "checks_pending";
  return Object.freeze({
    state,
    evidence: w3bEvidence,
    nextStep:
      state === "awaiting_user_approval"
        ? "可簽發本機 UI 核可 intent；W3A 不會合併。"
        : "重新讀取同一 Head 的 CI 與 agent-team/review 狀態。",
    preview: previewSummary(preview),
    session: sessionSummary(session),
  });
}

function operationIsValid(value: string): boolean {
  return value.trim().length > 0 && value.length <= 500 && !/[\u0000\r\n]/u.test(value);
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

export class RegistrationSetupController implements RegistrationSetupControllerUseCase {
  readonly #stateRoot: string;
  readonly #ports: RegistrationSetupControllerPorts;

  constructor(ports: RegistrationSetupControllerPorts) {
    if (!isAbsolute(ports.stateRoot)) throw new TypeError("state_root_must_be_absolute");
    this.#stateRoot = resolve(ports.stateRoot);
    this.#ports = ports;
  }

  async #preview(
    context: RegistrationSetupControllerContext,
    options: ReadOptions = {},
  ): Promise<RegistrationSetupPreview | RegistrationSetupControllerReadModel> {
    if (!validContext(context)) {
      return incomplete({ code: "draft_invalid", message: "本機 UI authority 無效。" });
    }
    if (this.#ports.draftSource === undefined) {
      return incomplete({
        code: "draft_source_unwired",
        message: "尚未注入 server-side Registration Setup draft source。",
      });
    }
    const draft = await this.#ports.draftSource.load(options);
    if (!draft.ok) {
      return incomplete({
        code: "draft_source_unavailable",
        message: "無法讀取 server-side Registration Setup draft。",
      });
    }
    const project = projectSchema.safeParse(draft.value.project);
    const config = trustedProjectConfigSchema.safeParse(draft.value.config);
    const serialized = serializeTrustedProjectConfig(draft.value.config);
    if (
      !project.success ||
      !config.success ||
      !serialized.ok ||
      typeof draft.value.linearAuditIssueId !== "string" ||
      !identifierPattern.test(draft.value.linearAuditIssueId)
    ) {
      return incomplete({
        code:
          typeof draft.value.linearAuditIssueId !== "string" ||
          !identifierPattern.test(draft.value.linearAuditIssueId)
            ? "linear_audit_issue_invalid"
            : "draft_invalid",
        message: "Server-side Setup draft 或 Linear audit issue 未通過 schema。",
      });
    }
    const repository = await this.#ports.git.inspectRepository(
      { rootPath: project.data.localRepositoryPath },
      options,
    );
    if (!repository.ok) {
      return incomplete({
        code: "local_repository_unavailable",
        message: "無法從 LocalGit read-back 目標 repository。",
      });
    }
    if (repository.value.branch !== project.data.defaultBranch) {
      return incomplete({
        code: "default_branch_mismatch",
        message: "本機 repository 不在設定的 default branch。",
      });
    }
    if (!repository.value.clean) {
      return incomplete({
        code: "working_tree_not_clean",
        message: "本機 repository 工作樹不乾淨；不建立 Setup worktree。",
      });
    }
    const seed = [
      project.data.id,
      repository.value.headSha.toLowerCase(),
      serialized.value.contentDigest,
      draft.value.linearAuditIssueId,
    ].join("\0");
    const setupSessionId = `setup-${createHash("sha256").update(seed, "utf8").digest("hex")}`;
    const preview = createRegistrationSetupPreview({
      schemaVersion: 1,
      setupSessionId,
      project: project.data,
      config: config.data,
      baseRevision: repository.value.headSha,
      worktreePath: join(this.#stateRoot, "registration-setup", "worktrees", setupSessionId),
      branch: registrationSetupBranch,
      remote: "origin",
      linearAuditIssueId: draft.value.linearAuditIssueId,
    });
    return preview.ok
      ? preview.value
      : incomplete({ code: "draft_invalid", message: "無法建立可信 Setup preview。" });
  }

  async read(context: RegistrationSetupControllerContext, options: ReadOptions = {}) {
    const preview = await this.#preview(context, options);
    if (!("previewDigest" in preview)) return preview;
    const loaded = await this.#ports.sessions.load(preview.setupSessionId, options);
    if (!loaded.ok) {
      return incomplete({
        code: "draft_source_unavailable",
        message: "無法 read-back durable Setup session。",
      });
    }
    return readModel(preview, loaded.value);
  }

  async confirmPreview(
    command: RegistrationSetupConfirmPreviewCommand,
    context: RegistrationSetupControllerContext,
  ): Promise<RegistrationSetupControllerActionResult> {
    if (
      command.confirmation !== registrationSetupPreviewConfirmationPhrase ||
      !identifierPattern.test(command.setupSessionId) ||
      !digestPattern.test(command.previewDigest) ||
      !operationIsValid(command.idempotencyKey) ||
      !validContext(context)
    ) {
      return incomplete({ code: "draft_invalid", message: "Preview 明確確認無效。" });
    }
    const preview = await this.#preview(context);
    if (
      !("previewDigest" in preview) ||
      preview.setupSessionId !== command.setupSessionId ||
      preview.previewDigest !== command.previewDigest
    ) {
      return incomplete({ code: "draft_invalid", message: "Preview 已漂移，舊確認已失效。" });
    }
    const issued = await this.#ports.previewConfirmation.issue(
      {
        setupSessionId: preview.setupSessionId,
        projectId: preview.project.id,
        previewDigest: preview.previewDigest,
      },
      context.authorityDigest,
      { idempotencyKey: command.idempotencyKey },
    );
    return issued.ok && issued.value.state === "issued"
      ? Object.freeze({
          state: "preview_confirmation_issued",
          setupSessionId: preview.setupSessionId,
          previewDigest: preview.previewDigest,
          tokenId: issued.value.grant.confirmation.tokenId,
          expiresAt: issued.value.grant.expiresAt,
        })
      : incomplete({ code: "draft_invalid", message: "無法簽發 durable preview 確認。" });
  }

  async start(
    command: RegistrationSetupStartCommand,
    context: RegistrationSetupControllerContext,
  ): Promise<RegistrationSetupControllerActionResult> {
    if (
      !identifierPattern.test(command.setupSessionId) ||
      !identifierPattern.test(command.tokenId) ||
      !digestPattern.test(command.previewDigest) ||
      !operationIsValid(command.idempotencyKeyPrefix) ||
      !validContext(context)
    ) {
      return incomplete({ code: "draft_invalid", message: "Setup start request 無效。" });
    }
    const preview = await this.#preview(context);
    if (
      !("previewDigest" in preview) ||
      preview.setupSessionId !== command.setupSessionId ||
      preview.previewDigest !== command.previewDigest
    ) {
      return incomplete({ code: "draft_invalid", message: "Preview 已漂移，禁止建立 Draft PR。" });
    }
    return this.#ports.coordinator.begin({
      preview,
      confirmation: {
        source: "local_ui",
        explicit: true,
        tokenId: command.tokenId,
        setupSessionId: preview.setupSessionId,
        projectId: preview.project.id,
        previewDigest: preview.previewDigest,
      },
      trustedAuthority: context,
      idempotencyKeyPrefix: command.idempotencyKeyPrefix,
    });
  }

  async refresh(
    command: RegistrationSetupRefreshCommand,
    context: RegistrationSetupControllerContext,
  ): Promise<RegistrationSetupControllerActionResult> {
    if (
      !identifierPattern.test(command.setupSessionId) ||
      !operationIsValid(command.idempotencyKeyPrefix) ||
      !validContext(context)
    ) {
      return incomplete({ code: "draft_invalid", message: "Refresh request 無效。" });
    }
    const preview = await this.#preview(context);
    if (!("previewDigest" in preview) || preview.setupSessionId !== command.setupSessionId) {
      return incomplete({
        code: "draft_invalid",
        message: "Server-side Setup draft 已缺失或漂移，禁止 refresh side effect。",
      });
    }
    return this.#ports.coordinator.refresh(command);
  }

  async issueLocalUiApprovalIntent(
    command: RegistrationSetupApprovalIntentCommand,
    context: RegistrationSetupControllerContext,
  ): Promise<RegistrationSetupControllerActionResult> {
    if (
      command.confirmation !== registrationSetupFinalApprovalPhrase ||
      !Number.isSafeInteger(command.expectedSetupRevision) ||
      command.expectedSetupRevision <= 0 ||
      !operationIsValid(command.idempotencyKey) ||
      !validContext(context)
    ) {
      return incomplete({ code: "draft_invalid", message: "本機 UI approval intent 無效。" });
    }
    const refreshed = await this.refresh(command, context);
    if (
      refreshed.state !== "awaiting_user_approval" ||
      refreshed.session === undefined ||
      !("gateEvidenceReceipt" in refreshed.session)
    ) {
      return refreshed;
    }
    const session = refreshed.session;
    if (session.revision !== command.expectedSetupRevision) {
      return incomplete({
        code: "draft_invalid",
        message: "Setup revision 已漂移，核可 intent 失效。",
      });
    }
    const binding = approvalBinding(session);
    if (binding === undefined) {
      return incomplete({ code: "draft_invalid", message: "Gate evidence receipt 缺失。" });
    }
    const issued = await this.#ports.finalApproval.issue(
      binding,
      { issuer: "local_ui", authorityDigest: context.authorityDigest },
      { idempotencyKey: command.idempotencyKey },
    );
    return issued.ok && issued.value.state === "issued"
      ? Object.freeze({
          state: "approval_intent_issued",
          setupSessionId: session.setupSessionId,
          expectedSetupRevision: session.revision,
          approvalId: issued.value.grant.approvalId,
          expiresAt: issued.value.grant.expiresAt,
          mergeState: "configuration_incomplete",
        })
      : incomplete({
          code: "draft_invalid",
          message: "無法簽發 durable local-UI approval intent。",
        });
  }
}

export function createUnwiredRegistrationSetupController(
  message = "Registration Setup production dependencies 尚未完整注入。",
): RegistrationSetupControllerUseCase {
  const model = incomplete({ code: "production_dependencies_unwired", message });
  return Object.freeze({
    read: () => Promise.resolve(model),
    confirmPreview: () => Promise.resolve(model),
    start: () => Promise.resolve(model),
    refresh: () => Promise.resolve(model),
    issueLocalUiApprovalIntent: () => Promise.resolve(model),
  });
}

/** Host-only façade. HTTP, CLI, PR, and Linear payload parsers never receive its capability. */
export class HostRegistrationSetupConversationApprovalFacade implements RegistrationSetupConversationApprovalFacade {
  readonly #ports: RegistrationSetupConversationApprovalFacadePorts;

  constructor(ports: RegistrationSetupConversationApprovalFacadePorts) {
    this.#ports = ports;
  }

  async issueConversationApprovalIntent(
    command: RegistrationSetupApprovalIntentCommand,
    hostCapability: RegistrationSetupConversationHostCapability,
  ): Promise<RegistrationSetupControllerActionResult> {
    if (
      command.confirmation !== registrationSetupFinalApprovalPhrase ||
      !identifierPattern.test(command.setupSessionId) ||
      !Number.isSafeInteger(command.expectedSetupRevision) ||
      command.expectedSetupRevision <= 0 ||
      !operationIsValid(command.idempotencyKey) ||
      !operationIsValid(command.idempotencyKeyPrefix)
    ) {
      return incomplete({ code: "draft_invalid", message: "Conversation approval intent 無效。" });
    }
    const refreshed = await this.#ports.coordinator.refresh(command);
    if (refreshed.state !== "awaiting_user_approval") return refreshed;
    if (refreshed.session.revision !== command.expectedSetupRevision) {
      return incomplete({ code: "draft_invalid", message: "Setup revision 已漂移。" });
    }
    const binding = approvalBinding(refreshed.session);
    if (binding === undefined) {
      return incomplete({ code: "draft_invalid", message: "Gate evidence receipt 缺失。" });
    }
    const issued = await this.#ports.bridge.issue(binding, hostCapability, {
      idempotencyKey: command.idempotencyKey,
    });
    return issued.ok && issued.value.state === "issued"
      ? Object.freeze({
          state: "approval_intent_issued",
          setupSessionId: refreshed.session.setupSessionId,
          expectedSetupRevision: refreshed.session.revision,
          approvalId: issued.value.grant.approvalId,
          expiresAt: issued.value.grant.expiresAt,
          mergeState: "configuration_incomplete",
        })
      : incomplete({
          code: "draft_invalid",
          message: "Host conversation capability 無法簽發 durable approval intent。",
        });
  }
}
