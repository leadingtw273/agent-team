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
  readonly issuer: "local_ui";
  readonly uiSessionDigest: string;
  readonly approvalNonceDigest: string;
  readonly consumedAt: string;
}

export interface RegistrationSetupTrustedAuthority {
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
  "ci_waiting" | "awaiting_user_approval" | "merge_authorized" | "activated" | "cancelled";

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
  readonly evidence: readonly RegistrationSetupEvidence[];
  readonly approvalReferenceDigest?: Sha256Digest;
  readonly approvalNonceDigest?: string;
  readonly approvalSessionDigest?: string;
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
  readonly authoritativeRevision: string;
  readonly defaultBranch: string;
  readonly configDigest: string;
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

export interface RegistrationSetupAuditIntent {
  readonly destination: "linear" | "pull_request";
  readonly kind: "registration_setup_user_approval_required";
  readonly body: string;
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
    trustedAuthorityDigest: string,
    options: MutationOptions,
  ): AsyncPortResult<
    | Readonly<{ state: "issued"; grant: RegistrationSetupFinalApprovalGrant }>
    | Readonly<{ state: "rejected" | "unknown" }>
  >;
  /** Atomically verifies issuer/session/bindings and consumes the one-shot local UI grant. */
  verifyAndConsume(
    request: RegistrationSetupFinalApprovalRequest,
    expectedBinding: RegistrationSetupApprovalBinding,
    trustedAuthorityDigest: string,
    options: MutationOptions,
  ): AsyncPortResult<
    | Readonly<{ state: "verified_and_consumed"; receipt: RegistrationSetupFinalApprovalReceipt }>
    | Readonly<{ state: "replay" | "rejected" | "unknown" }>
  >;
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
    | "enableAutoMerge"
  >;
  readonly journal: RegistrationSetupJournalPort;
  readonly execution: RegistrationSetupExecutionPort;
  readonly sessions: RegistrationSetupSessionPort;
  readonly finalApproval: RegistrationSetupFinalApprovalAuthorityPort;
  readonly mergedConfig: RegistrationSetupMergedConfigReadBackPort;
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
  | "approval"
  | "merge"
  | "merge_readback"
  | "trusted_config_readback"
  | "activation";

export type RegistrationSetupOutcome =
  | Readonly<{ state: "in_progress"; setupSessionId: string }>
  | Readonly<{ state: "ci_waiting"; session: RegistrationSetupSession }>
  | Readonly<{
      state: "not_ready";
      reason: "pending" | "ci_failed" | "review_pending" | "review_failed";
      session: RegistrationSetupSession;
    }>
  | Readonly<{
      state: "awaiting_user_approval";
      session: RegistrationSetupSession;
      auditIntents: readonly RegistrationSetupAuditIntent[];
    }>
  | Readonly<{ state: "merge_pending"; session: RegistrationSetupSession }>
  | Readonly<{ state: "activated"; session: RegistrationSetupSession; revisionSha: string }>
  | Readonly<{
      state: "blocked";
      reason: "not_found" | "cancelled" | "user_approval_invalid" | "approval_replay";
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
