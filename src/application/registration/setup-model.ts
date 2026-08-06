import type { DomainError, Result } from "../../domain/foundation/index.js";
import type { Project } from "../../domain/project/index.js";
import type { Sha256Digest } from "../../domain/review/index.js";
import type { TrustedProjectConfig } from "../projects/index.js";
import type {
  AsyncPortResult,
  ChangeRequestSnapshot,
  GitPort,
  GitWorktree,
  MutationOptions,
  ReadOptions,
  SourceControlPort,
} from "../ports/index.js";
import type { ImplementerPreflightPort } from "../pipelines/implementer-model.js";

export const registrationSetupBranch = "agent-team/setup" as const;
export const registrationSetupReviewStatus = "agent-team/review" as const;

export interface RegistrationSetupPreviewInput {
  readonly schemaVersion: 1;
  readonly setupSessionId: string;
  readonly project: Project;
  readonly config: TrustedProjectConfig;
  readonly baseRevision: string;
  readonly worktreePath: string;
  readonly branch: typeof registrationSetupBranch;
  readonly remote: string;
  readonly linearAuditIssueId: string;
}

export interface RegistrationSetupPreview extends RegistrationSetupPreviewInput {
  readonly previewDigest: Sha256Digest;
  readonly requirementsDigest: Sha256Digest;
}

export type RegistrationSetupApprovalSource = "local_ui" | "current_user_conversation";

export interface RegistrationSetupPreviewConfirmation {
  readonly source: RegistrationSetupApprovalSource;
  readonly explicit: true;
  readonly tokenId: string;
  readonly setupSessionId: string;
  readonly projectId: Project["id"];
  readonly previewDigest: Sha256Digest;
}

export type RegistrationSetupPreviewConfirmationBinding = Omit<
  RegistrationSetupPreviewConfirmation,
  "source" | "explicit" | "tokenId"
>;

export interface RegistrationSetupPreviewConfirmationGrant {
  readonly confirmation: RegistrationSetupPreviewConfirmation;
  readonly expiresAt: string;
}

export interface RegistrationSetupApprovalBinding {
  readonly schemaVersion: 1;
  readonly setupSessionId: string;
  readonly setupSessionRevision: number;
  readonly projectId: Project["id"];
  readonly previewDigest: Sha256Digest;
  readonly changeRequestId: string;
  readonly headSha: string;
  readonly requirementsDigest: Sha256Digest;
  readonly diffDigest: Sha256Digest;
  readonly linearAuditIssueId: string;
  readonly gateEvidenceDigest: Sha256Digest;
}

export interface RegistrationSetupFinalApprovalRequest {
  readonly approvalId: string;
  readonly userConfirmed: true;
  readonly expectedSetupRevision: number;
}

export interface RegistrationSetupFinalApprovalGrant {
  readonly approvalId: string;
  readonly expiresAt: string;
}

export interface RegistrationSetupFinalApprovalReceipt extends RegistrationSetupApprovalBinding {
  readonly schemaVersion: 1;
  readonly approvalId: string;
  readonly issuer: RegistrationSetupApprovalSource;
  readonly authorityDigest: string;
  readonly approvalNonceDigest: string;
  readonly consumedAt: string;
}

export interface RegistrationSetupConsumedApprovalAnchor {
  readonly receipt: RegistrationSetupFinalApprovalReceipt;
  /** Digest of the durable consume operation stored only in the approval ledger. */
  readonly consumeOperationDigest: Sha256Digest;
}

export interface RegistrationSetupTrustedAuthority {
  readonly authorityDigest: string;
}

export interface RegistrationSetupFinalApprovalAuthority {
  readonly issuer: RegistrationSetupApprovalSource;
  readonly authorityDigest: string;
}

export const registrationSetupEvidenceCodes = [
  "setup_worktree_created",
  "trusted_config_written",
  "setup_preflight_passed",
  "setup_commit_pushed",
  "setup_draft_pr_created",
  "setup_ci_passed",
  "setup_fresh_review_passed",
  "setup_user_approval_consumed",
  "setup_merge_verified",
  "trusted_config_activated",
] as const;

export type RegistrationSetupEvidenceCode = (typeof registrationSetupEvidenceCodes)[number];

export interface RegistrationSetupEvidence {
  readonly code: RegistrationSetupEvidenceCode;
  readonly projectId: Project["id"];
  readonly setupSessionId: string;
  readonly previewDigest: Sha256Digest;
  readonly requirementsDigest: Sha256Digest;
  readonly headSha?: string;
  readonly diffDigest?: Sha256Digest;
  readonly changeRequestId?: string;
}

export type RegistrationSetupPhase =
  | "ci_waiting"
  | "audit_pending"
  | "awaiting_user_approval"
  | "merge_authorized"
  | "merge_pending"
  | "activated"
  | "cancelled";

export interface RegistrationSetupSession {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly phase: RegistrationSetupPhase;
  readonly setupSessionId: string;
  readonly project: Project;
  readonly config: TrustedProjectConfig;
  readonly baseRevision: string;
  readonly worktree: GitWorktree;
  readonly remote: string;
  readonly previewDigest: Sha256Digest;
  readonly requirementsDigest: Sha256Digest;
  readonly diffDigest: Sha256Digest;
  readonly configDigest: string;
  readonly headSha: string;
  readonly changeRequest: ChangeRequestSnapshot;
  readonly linearAuditIssueId: string;
  readonly gateEvidenceReceipt?: RegistrationSetupGateEvidenceReceipt;
  readonly audit?: RegistrationSetupAuditState;
  readonly evidence: readonly RegistrationSetupEvidence[];
  readonly approvalReferenceDigest?: Sha256Digest;
  readonly approvalConsumeOperationDigest?: Sha256Digest;
  readonly approvalNonceDigest?: string;
  readonly approvalAuthorityDigest?: string;
  readonly approvalSource?: RegistrationSetupApprovalSource;
  readonly approvalSetupRevision?: number;
  readonly mergeIntent?: RegistrationSetupMergeIntent;
  readonly mergeReceipt?: RegistrationSetupMergeReceipt;
  readonly mergedConfigReceipt?: RegistrationSetupMergedConfigReceipt;
  readonly activatedRevisionSha?: string;
}

export type RegistrationSetupSessionDraft = Omit<RegistrationSetupSession, "revision">;

export type RegistrationSetupJournalStep =
  "worktree" | "write" | "stage" | "commit" | "push" | "draft_pull_request";

export interface RegistrationSetupJournalIntent {
  readonly step: RegistrationSetupJournalStep;
  readonly idempotencyKey: string;
}

export interface RegistrationSetupJournalCompleted {
  readonly worktree?: GitWorktree;
  readonly write?: Readonly<{ path: string; contentDigest: string }>;
  readonly stage?: Readonly<{ headSha: string; paths: readonly string[] }>;
  readonly commit?: Readonly<{ sha: string; branch: string }>;
  readonly push?: Readonly<{ remote: string; branch: string; sha: string }>;
  readonly draftPullRequest?: Readonly<{ changeRequestId: string; headSha: string }>;
  readonly diff?: Readonly<{ digest: Sha256Digest }>;
}

export interface RegistrationSetupJournal {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly setupSessionId: string;
  readonly preview: RegistrationSetupPreview;
  readonly configDigest: string;
  readonly pending?: RegistrationSetupJournalIntent;
  readonly completed: RegistrationSetupJournalCompleted;
}

export type RegistrationSetupJournalDraft = Omit<RegistrationSetupJournal, "revision">;

export interface RegistrationSetupActivationMarker {
  readonly schemaVersion: 1;
  readonly source: "source_control_default_branch";
  readonly setupSessionId: string;
  readonly projectId: Project["id"];
  readonly repository: string;
  readonly changeRequestId: string;
  readonly setupHeadSha: string;
  readonly mergeCommitSha: string;
  readonly authoritativeRevision: string;
  readonly defaultBranch: string;
  readonly configDigest: string;
  readonly linearAuditIssueId: string;
  readonly gateEvidenceDigest: Sha256Digest;
  readonly auditReceiptsDigest: Sha256Digest;
  readonly approvalSource: RegistrationSetupApprovalSource;
  readonly approvalReferenceDigest: Sha256Digest;
  readonly approvalConsumeOperationDigest: Sha256Digest;
  readonly authorityDigest: string;
  readonly approvalNonceDigest: string;
}

export interface RegistrationSetupMergeIntent {
  readonly schemaVersion: 1;
  readonly projectId: Project["id"];
  readonly repository: string;
  readonly changeRequestId: string;
  readonly expectedHeadSha: string;
  readonly mergeMethod: "SQUASH";
  readonly idempotencyKey: string;
  readonly mergeIntentDigest: Sha256Digest;
}

export interface RegistrationSetupMergeReceipt extends Omit<
  RegistrationSetupMergeIntent,
  "idempotencyKey"
> {
  readonly state: "auto_merge_enabled" | "merged";
  readonly idempotencyKeyDigest: Sha256Digest;
}

export interface RegistrationSetupSquashMergePort {
  enable(
    command: Readonly<{
      project: Project;
      changeRequestId: string;
      expectedHeadSha: string;
      mergeMethod: "SQUASH";
      mergeIntentDigest: Sha256Digest;
    }>,
    options: MutationOptions,
  ): AsyncPortResult<
    Readonly<{
      state: "auto_merge_enabled" | "merged";
      snapshot: ChangeRequestSnapshot;
    }>
  >;
}

export interface RegistrationSetupActivationRegistryPort {
  publish(
    marker: RegistrationSetupActivationMarker,
    options: MutationOptions,
  ): AsyncPortResult<
    Readonly<{ state: "confirmed" | "reused"; marker: RegistrationSetupActivationMarker }>
  >;
  read(
    projectId: Project["id"],
    options?: ReadOptions,
  ): AsyncPortResult<RegistrationSetupActivationMarker | undefined>;
}

export interface RegistrationSetupExecutionFence {
  readonly schemaVersion: 1;
  readonly setupSessionId: string;
  readonly epoch: number;
  readonly lockIdentity: Readonly<{
    readonly device: number;
    readonly inode: number;
    readonly generation: string;
    readonly ownerDigest: Sha256Digest;
    readonly changeEpoch: string;
  }>;
  readonly ownerDigest: Sha256Digest;
}

export interface RegistrationSetupExecutionLease {
  readonly fence: RegistrationSetupExecutionFence;
  assertOwnershipSync(): Result<void, DomainError>;
  assertOwnership(): AsyncPortResult<void>;
}

export interface RegistrationSetupFencedMutationOptions extends MutationOptions {
  readonly executionFence: RegistrationSetupExecutionFence;
}

export interface RegistrationSetupGateEvidenceCommand {
  readonly project: Project;
  readonly changeRequestId: string;
  readonly expectedHeadSha: string;
  readonly requirementsDigest: Sha256Digest;
  readonly diffDigest: Sha256Digest;
}

export interface RegistrationSetupGateEvidenceReceipt {
  readonly schemaVersion: 1;
  readonly source: "source_control";
  readonly projectId: Project["id"];
  readonly repository: string;
  readonly changeRequestId: string;
  readonly headSha: string;
  readonly requirementsDigest: Sha256Digest;
  readonly diffDigest: Sha256Digest;
  readonly ciChecksDigest: Sha256Digest;
  readonly reviewContext: typeof registrationSetupReviewStatus;
  readonly reviewEvidenceUrl: string;
  readonly evidenceDigest: Sha256Digest;
}

export interface RegistrationSetupGateEvidencePort {
  read(
    command: RegistrationSetupGateEvidenceCommand,
    options?: ReadOptions,
  ): AsyncPortResult<
    | Readonly<{ state: "ready"; receipt: RegistrationSetupGateEvidenceReceipt }>
    | Readonly<{
        state: "not_ready";
        reason: "ci_pending" | "ci_failed" | "review_pending" | "review_failed";
      }>
  >;
}

export interface RegistrationSetupAuditIntent {
  readonly schemaVersion: 1;
  readonly destination: "linear" | "pull_request";
  readonly kind: "registration_setup_user_approval_required";
  readonly setupSessionId: string;
  readonly projectId: Project["id"];
  readonly repository: string;
  readonly linearAuditIssueId: string;
  readonly changeRequestId: string;
  readonly headSha: string;
  readonly requirementsDigest: Sha256Digest;
  readonly diffDigest: Sha256Digest;
  readonly evidenceDigest: Sha256Digest;
  readonly body: string;
  readonly bodyDigest: Sha256Digest;
  readonly idempotencyKey: string;
}

export interface RegistrationSetupAuditReceipt extends Omit<
  RegistrationSetupAuditIntent,
  "kind" | "body" | "idempotencyKey"
> {
  readonly externalCommentId: string;
  readonly idempotencyKeyDigest: Sha256Digest;
  readonly createdAt: string;
  readonly reused: boolean;
}

export interface RegistrationSetupAuditState {
  readonly pending?: RegistrationSetupAuditIntent;
  readonly linearReceipt?: RegistrationSetupAuditReceipt;
  readonly pullRequestReceipt?: RegistrationSetupAuditReceipt;
}

export interface RegistrationSetupAuditPort {
  publish(
    intent: RegistrationSetupAuditIntent,
    options: MutationOptions,
  ): AsyncPortResult<RegistrationSetupAuditReceipt>;
}

declare const conversationCapabilityBrand: unique symbol;
export interface RegistrationSetupConversationHostCapability {
  readonly [conversationCapabilityBrand]: true;
}

export interface RegistrationSetupConversationApprovalBridgePort {
  issue(
    binding: RegistrationSetupApprovalBinding,
    hostCapability: RegistrationSetupConversationHostCapability,
    options: MutationOptions,
  ): AsyncPortResult<
    | Readonly<{ state: "issued"; grant: RegistrationSetupFinalApprovalGrant }>
    | Readonly<{ state: "rejected" | "unknown" }>
  >;
  resolveAuthority(
    hostCapability: RegistrationSetupConversationHostCapability,
    options?: ReadOptions,
  ): AsyncPortResult<RegistrationSetupFinalApprovalAuthority>;
}

export interface RegistrationSetupFilePort {
  writeTrustedProjectConfig(
    command: Readonly<{
      worktree: GitWorktree;
      path: string;
      content: string;
      contentDigest: string;
    }>,
    options: MutationOptions,
  ): AsyncPortResult<Readonly<{ path: string; contentDigest: string }>>;
  readTrustedProjectConfig(
    command: Readonly<{ worktree: GitWorktree; path: string }>,
    options?: ReadOptions,
  ): AsyncPortResult<Readonly<{ path: string; content: string; contentDigest: string }>>;
}

export interface RegistrationSetupPreviewConfirmationPort {
  /** Verifies that the version-bound confirmation was issued by the current local user surface. */
  verify(
    token: RegistrationSetupPreviewConfirmation,
    trustedAuthorityDigest: string,
    options: MutationOptions,
  ): AsyncPortResult<Readonly<{ state: "verified" | "rejected" }>>;
}

export interface RegistrationSetupPreviewConfirmationAuthorityPort extends RegistrationSetupPreviewConfirmationPort {
  issue(
    binding: RegistrationSetupPreviewConfirmationBinding,
    trustedAuthorityDigest: string,
    options: MutationOptions,
  ): AsyncPortResult<
    | Readonly<{ state: "issued"; grant: RegistrationSetupPreviewConfirmationGrant }>
    | Readonly<{ state: "rejected" | "unknown" }>
  >;
}

export interface RegistrationSetupSessionPort {
  load(
    setupSessionId: string,
    options?: ReadOptions,
  ): AsyncPortResult<RegistrationSetupSession | undefined>;
  save(
    expectedRevision: number | undefined,
    session: RegistrationSetupSessionDraft,
    options: RegistrationSetupFencedMutationOptions,
  ): AsyncPortResult<
    Readonly<{ durability: "confirmed" | "unknown"; session: RegistrationSetupSession }>
  >;
  /** Atomically persists the activated phase and trusted/active registration marker. */
  activate(
    expectedRevision: number,
    session: RegistrationSetupSessionDraft,
    revisionSha: string,
    options: RegistrationSetupFencedMutationOptions,
  ): AsyncPortResult<
    Readonly<{
      durability: "confirmed" | "unknown";
      session: RegistrationSetupSession;
      marker: RegistrationSetupActivationMarker;
    }>
  >;
  readActivation(
    setupSessionId: string,
    options?: ReadOptions,
  ): AsyncPortResult<RegistrationSetupActivationMarker | undefined>;
}

export interface RegistrationSetupJournalPort {
  load(
    setupSessionId: string,
    options?: ReadOptions,
  ): AsyncPortResult<RegistrationSetupJournal | undefined>;
  save(
    expectedRevision: number | undefined,
    journal: RegistrationSetupJournalDraft,
    options: RegistrationSetupFencedMutationOptions,
  ): AsyncPortResult<
    Readonly<{ durability: "confirmed" | "unknown"; journal: RegistrationSetupJournal }>
  >;
}

export interface RegistrationSetupExecutionPort {
  /** Holds one cross-process owner across read-back, mutation, and durable receipt persistence. */
  runExclusive<Value>(
    setupSessionId: string,
    action: (lease: RegistrationSetupExecutionLease) => Promise<Value>,
    options?: ReadOptions,
  ): Promise<
    Result<
      Readonly<{ state: "completed"; value: Value }> | Readonly<{ state: "in_progress" }>,
      DomainError
    >
  >;
}

export interface RegistrationSetupFinalApprovalAuthorityPort {
  /** Server-side only: creates a durable grant bound to trusted UI authority and setup state. */
  issue(
    binding: RegistrationSetupApprovalBinding,
    authority: RegistrationSetupFinalApprovalAuthority,
    options: MutationOptions,
  ): AsyncPortResult<
    | Readonly<{ state: "issued"; grant: RegistrationSetupFinalApprovalGrant }>
    | Readonly<{ state: "rejected" | "unknown" }>
  >;
  /** Atomically verifies issuer/session/bindings and consumes the one-shot local UI grant. */
  verifyAndConsume(
    request: RegistrationSetupFinalApprovalRequest,
    expectedBinding: RegistrationSetupApprovalBinding,
    authority: RegistrationSetupFinalApprovalAuthority,
    options: MutationOptions,
  ): AsyncPortResult<
    | Readonly<{ state: "verified_and_consumed"; receipt: RegistrationSetupFinalApprovalReceipt }>
    | Readonly<{ state: "replay" | "rejected" | "unknown" }>
  >;
  /** Read-only recovery anchor from the independent approval ledger. */
  readConsumed(
    approvalReferenceDigest: Sha256Digest,
    options?: ReadOptions,
  ): AsyncPortResult<RegistrationSetupConsumedApprovalAnchor | undefined>;
}

export interface RegistrationSetupMergedConfigReceipt {
  readonly schemaVersion: 1;
  readonly source: "source_control_default_branch";
  readonly projectId: Project["id"];
  readonly repository: string;
  readonly changeRequestId: string;
  readonly setupHeadSha: string;
  readonly mergeCommitSha: string;
  readonly defaultBranch: string;
  readonly authoritativeRevision: string;
  readonly path: string;
  readonly configDigest: string;
  readonly config: TrustedProjectConfig;
}

export interface RegistrationSetupMergedConfigReadBackPort {
  /** Must read the remote SCM default branch at its authoritative revision, never a local ref. */
  read(
    command: Readonly<{
      project: Project;
      changeRequestId: string;
      expectedHeadSha: string;
      defaultBranch: string;
      path: string;
    }>,
    options?: ReadOptions,
  ): AsyncPortResult<RegistrationSetupMergedConfigReceipt>;
}

export interface RegistrationSetupPorts {
  readonly git: Pick<
    GitPort,
    | "createWorktree"
    | "stagePaths"
    | "commit"
    | "inspectWorkingTree"
    | "push"
    | "getEffectiveTreeDiff"
    | "getStagedTreeDiff"
    | "inspectCommit"
  >;
  readonly preflight: ImplementerPreflightPort;
  readonly previewConfirmation: RegistrationSetupPreviewConfirmationPort;
  readonly setupFiles: RegistrationSetupFilePort;
  readonly sourceControl: Pick<
    SourceControlPort,
    | "createDraftChangeRequest"
    | "getChangeRequest"
    | "getCommitChecks"
    | "getCommitStatuses"
    | "markChangeRequestReady"
  >;
  readonly gateEvidence: RegistrationSetupGateEvidencePort;
  readonly audit: RegistrationSetupAuditPort;
  readonly journal: RegistrationSetupJournalPort;
  readonly execution: RegistrationSetupExecutionPort;
  readonly sessions: RegistrationSetupSessionPort;
  readonly finalApproval: RegistrationSetupFinalApprovalAuthorityPort;
  readonly squashMerge: RegistrationSetupSquashMergePort;
  readonly mergedConfig: RegistrationSetupMergedConfigReadBackPort;
  readonly activationRegistry: RegistrationSetupActivationRegistryPort;
}

export interface RegistrationSetupBeginRequest {
  readonly preview: RegistrationSetupPreview;
  readonly confirmation: RegistrationSetupPreviewConfirmation;
  readonly trustedAuthority: RegistrationSetupTrustedAuthority;
  readonly idempotencyKeyPrefix: string;
  readonly signal?: AbortSignal;
}

export interface RegistrationSetupSessionRequest {
  readonly setupSessionId: string;
  readonly idempotencyKeyPrefix: string;
  readonly signal?: AbortSignal;
}

export interface RegistrationSetupMergeRequest extends RegistrationSetupSessionRequest {
  readonly approval?: RegistrationSetupFinalApprovalRequest;
}

export type RegistrationSetupFailureStage =
  | "request"
  | "session"
  | "worktree"
  | "write"
  | "preflight"
  | "stage"
  | "commit"
  | "push"
  | "draft_pull_request"
  | "diff"
  | "change_request"
  | "checks"
  | "review"
  | "audit"
  | "approval"
  | "merge"
  | "merge_readback"
  | "trusted_config_readback"
  | "activation";

export type RegistrationSetupOutcome =
  | Readonly<{ state: "in_progress"; setupSessionId: string }>
  | Readonly<{ state: "ci_waiting"; session: RegistrationSetupSession }>
  | Readonly<{ state: "audit_pending"; session: RegistrationSetupSession }>
  | Readonly<{
      state: "not_ready";
      reason: "pending" | "ci_failed" | "review_pending" | "review_failed";
      session: RegistrationSetupSession;
    }>
  | Readonly<{
      state: "awaiting_user_approval";
      session: RegistrationSetupSession;
    }>
  | Readonly<{ state: "merge_pending"; session: RegistrationSetupSession }>
  | Readonly<{ state: "activated"; session: RegistrationSetupSession; revisionSha: string }>
  | Readonly<{
      state: "blocked";
      reason:
        | "not_found"
        | "cancelled"
        | "user_approval_invalid"
        | "approval_replay"
        | "resume_not_available";
    }>
  | Readonly<{
      state: "cancelled";
      session: RegistrationSetupSession;
    }>
  | Readonly<{
      state: "failed";
      stage: RegistrationSetupFailureStage;
      error: DomainError;
      session?: RegistrationSetupSession;
    }>;

export type RegistrationSetupPreviewResult = Result<
  RegistrationSetupPreview,
  DomainError<"invariant_violation">
>;
