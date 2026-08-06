import {
  domainError,
  err,
  ok,
  parseIdentifier,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import type { Project } from "../../domain/project/index.js";
import type { AsyncPortResult, ReadOptions } from "../ports/index.js";

/** Fixed, bounded prefixes for exact-owned probe artifacts. Never derived from provider text. */
export const registrationProbeBranchPrefix = "agent-team/probe/" as const;
export const registrationProbeMarkerPrefix = "agent-team-registration-probe:" as const;

export const registrationProbeRequiredCheckName = "CI" as const;
export const registrationProbeReviewStatusContext = "agent-team/review" as const;
export const registrationProbeMaximumWebhookAckMs = 2_000;

const runIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,254}$/u;
const shaPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const branchPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u;
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/u;
const worktreePathPattern = /^\/[^\0]{1,4096}$/u;

export function isValidRegistrationProbeRunId(runId: string): boolean {
  return typeof runId === "string" && runId.length <= 64 && runIdPattern.test(runId);
}

export function registrationProbeBranch(runId: string): string {
  return `${registrationProbeBranchPrefix}${runId}`;
}

export function registrationProbeMarker(runId: string): string {
  return `${registrationProbeMarkerPrefix}${runId}`;
}

function isValidBranchName(value: string): boolean {
  return (
    branchPattern.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.endsWith(".") &&
    !value.endsWith("/") &&
    !value.endsWith(".lock")
  );
}

function isValidRepository(value: string): boolean {
  const parts = value.split("/");
  return (
    repositoryPattern.test(value) &&
    parts.length === 2 &&
    parts.every((part) => part !== "." && part !== "..")
  );
}

export interface RegistrationProbeActivationContext {
  readonly setupSessionId: string;
  readonly authoritativeRevision: string;
  readonly defaultBranch: string;
  readonly repository: string;
  readonly configDigest: string;
}

function isValidActivationContext(value: RegistrationProbeActivationContext): boolean {
  return (
    identifierPattern.test(value.setupSessionId) &&
    shaPattern.test(value.authoritativeRevision) &&
    isValidBranchName(value.defaultBranch) &&
    isValidRepository(value.repository) &&
    digestPattern.test(value.configDigest)
  );
}

export const registrationProbeCleanupKinds = [
  "linearIssue",
  "draftPullRequest",
  "remoteBranch",
  "localWorktree",
] as const;
export type RegistrationProbeCleanupKind = (typeof registrationProbeCleanupKinds)[number];

export const registrationProbeCleanupStates = ["pending", "confirmed", "unknown", "failed"] as const;
export type RegistrationProbeCleanupState = (typeof registrationProbeCleanupStates)[number];

/** Fixed reason codes only; never a provider raw message. */
export const registrationProbeCleanupReasons = [
  "not_created",
  "confirmed_cancelled",
  "confirmed_closed",
  "confirmed_deleted",
  "confirmed_removed",
  "cleanup_not_eligible",
  "cleanup_ownership_mismatch",
  "cleanup_failed",
  "cleanup_outcome_unknown",
] as const;
export type RegistrationProbeCleanupReason = (typeof registrationProbeCleanupReasons)[number];

export interface RegistrationProbeCleanupItem {
  readonly state: RegistrationProbeCleanupState;
  readonly reason: RegistrationProbeCleanupReason;
}

export interface RegistrationProbeCleanup {
  readonly linearIssue: RegistrationProbeCleanupItem;
  readonly draftPullRequest: RegistrationProbeCleanupItem;
  readonly remoteBranch: RegistrationProbeCleanupItem;
  readonly localWorktree: RegistrationProbeCleanupItem;
}

function initialCleanupItem(): RegistrationProbeCleanupItem {
  return Object.freeze({ state: "pending" as const, reason: "not_created" as const });
}

function initialCleanup(): RegistrationProbeCleanup {
  return Object.freeze({
    linearIssue: initialCleanupItem(),
    draftPullRequest: initialCleanupItem(),
    remoteBranch: initialCleanupItem(),
    localWorktree: initialCleanupItem(),
  });
}

export const registrationProbePhases = [
  "reserved",
  "linear_mutation_started",
  "linear_created",
  "branch_mutation_started",
  "branch_pushed",
  "draft_pr_mutation_started",
  "draft_pr_created",
  "ci_verified",
  "status_mutation_started",
  "status_verified",
  "webhook_synthetic_verified",
  "provider_event_verified",
  "cleanup_linear_mutation_started",
  "cleanup_pr_mutation_started",
  "cleanup_branch_mutation_started",
  "cleanup_worktree_mutation_started",
  "verified",
  "incomplete",
  "cleanup_required",
  "failed",
] as const;
export type RegistrationProbePhase = (typeof registrationProbePhases)[number];

export const registrationProbeTerminalCleanPhases = ["verified", "incomplete"] as const;

export function isTerminalCleanPhase(phase: RegistrationProbePhase): boolean {
  return (registrationProbeTerminalCleanPhases as readonly RegistrationProbePhase[]).includes(phase);
}

export interface RegistrationProbeLinearEvidence {
  readonly issueId: string;
  readonly state: "created";
}

export interface RegistrationProbeGitEvidence {
  readonly commitSha: string;
  readonly pushedSha: string;
}

export interface RegistrationProbeDraftPullRequestEvidence {
  readonly changeRequestId: string;
  readonly number: number;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly headSha: string;
}

export interface RegistrationProbeCiEvidence {
  readonly checkName: typeof registrationProbeRequiredCheckName;
  readonly headSha: string;
  readonly conclusion: "success";
}

export interface RegistrationProbeStatusEvidence {
  readonly context: typeof registrationProbeReviewStatusContext;
  readonly headSha: string;
  readonly state: "success";
}

export const registrationProbeWebhookProviders = ["github", "linear"] as const;
export type RegistrationProbeWebhookProvider = (typeof registrationProbeWebhookProviders)[number];

export interface RegistrationProbeSyntheticDeliveryEvidence {
  readonly provider: RegistrationProbeWebhookProvider;
  readonly deliveryId: string;
  readonly latencyMs: number;
  readonly inboxSha256: string;
}

export interface RegistrationProbeProviderEventEvidence {
  readonly provider: RegistrationProbeWebhookProvider;
  readonly deliveryId: string;
  readonly eventType: string;
  readonly remoteObjectId: string;
  readonly headSha?: string;
  readonly payloadSha256: string;
  readonly streamKey: string;
}

export const registrationProbeStages = [
  "preflight",
  "linear_create",
  "branch_push",
  "draft_pull_request",
  "ci_check",
  "status",
  "webhook_synthetic",
  "provider_event",
  "cleanup",
] as const;
export type RegistrationProbeStage = (typeof registrationProbeStages)[number];

/** Fixed failure reason codes only; never a provider raw message. */
export const registrationProbeFailureReasons = [
  "linear_create_failed",
  "linear_create_outcome_unknown",
  "branch_push_failed",
  "branch_push_outcome_unknown",
  "draft_pr_create_failed",
  "draft_pr_create_outcome_unknown",
  "ci_check_missing",
  "ci_check_pending",
  "ci_check_failed",
  "ci_check_wrong_head",
  "status_set_failed",
  "status_readback_mismatch",
  "webhook_transport_failed",
  "webhook_response_mismatch",
  "webhook_latency_exceeded",
  "provider_event_missing",
  "provider_event_mismatch",
  "interrupted",
] as const;
export type RegistrationProbeFailureReason = (typeof registrationProbeFailureReasons)[number];

export const registrationProbePreflightReasons = [
  "authority_invalid",
  "activation_not_ready",
  "linear_capability_incomplete",
  "github_capability_incomplete",
  "git_identity_incomplete",
  "runtime_configuration_invalid",
  "ci_workflow_unconfirmed",
  "concurrent_run_exists",
] as const;
export type RegistrationProbePreflightReason = (typeof registrationProbePreflightReasons)[number];

export interface RegistrationProbeRun {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly phase: RegistrationProbePhase;
  readonly projectId: Project["id"];
  readonly registrationRevision: number;
  readonly runId: string;
  readonly branch: string;
  readonly marker: string;
  readonly worktreePath: string;
  readonly activation: RegistrationProbeActivationContext;
  readonly cleanup: RegistrationProbeCleanup;
  readonly linear?: RegistrationProbeLinearEvidence;
  readonly git?: RegistrationProbeGitEvidence;
  readonly draftPullRequest?: RegistrationProbeDraftPullRequestEvidence;
  readonly ci?: RegistrationProbeCiEvidence;
  readonly status?: RegistrationProbeStatusEvidence;
  readonly syntheticDeliveries?: readonly RegistrationProbeSyntheticDeliveryEvidence[];
  readonly providerEvents?: readonly RegistrationProbeProviderEventEvidence[];
  readonly failure?: Readonly<{
    stage: RegistrationProbeStage;
    reason: RegistrationProbeFailureReason;
  }>;
}

export type RegistrationProbeRunMutation = Omit<RegistrationProbeRun, "revision">;

export interface CreateRegistrationProbeRunInput {
  readonly projectId: string;
  readonly registrationRevision: number;
  readonly runId: string;
  readonly worktreePath: string;
  readonly activation: RegistrationProbeActivationContext;
}

export function createRegistrationProbeRun(
  input: CreateRegistrationProbeRunInput,
): Result<RegistrationProbeRun, DomainError<"invalid_identifier">> {
  const projectId = parseIdentifier("project", input.projectId);
  if (
    !projectId.ok ||
    !isValidRegistrationProbeRunId(input.runId) ||
    !Number.isSafeInteger(input.registrationRevision) ||
    input.registrationRevision < 0 ||
    !worktreePathPattern.test(input.worktreePath) ||
    input.worktreePath.includes("..") ||
    !isValidActivationContext(input.activation)
  ) {
    return err(domainError("invalid_identifier"));
  }
  return ok(
    Object.freeze({
      schemaVersion: 1 as const,
      revision: 0,
      phase: "reserved" as const,
      projectId: projectId.value,
      registrationRevision: input.registrationRevision,
      runId: input.runId,
      branch: registrationProbeBranch(input.runId),
      marker: registrationProbeMarker(input.runId),
      worktreePath: input.worktreePath,
      activation: Object.freeze({ ...input.activation }),
      cleanup: initialCleanup(),
    }),
  );
}

export interface RegistrationProbeJournalPort {
  load(runId: string, options?: ReadOptions): AsyncPortResult<RegistrationProbeRun | undefined>;
  /** `expectedRevision === null` reserves a brand-new run; otherwise a strict CAS advance. */
  compareAndSwap(
    runId: string,
    expectedRevision: number | null,
    next: RegistrationProbeRunMutation,
    options?: ReadOptions,
  ): AsyncPortResult<RegistrationProbeRun>;
  /** Runs for a project that are not yet fully resolved (verified/incomplete). */
  listActiveForProject(
    projectId: Project["id"],
    options?: ReadOptions,
  ): AsyncPortResult<readonly RegistrationProbeRun[]>;
}

export type RegistrationProbeOutcome =
  | Readonly<{ state: "verified"; run: RegistrationProbeRun }>
  | Readonly<{
      state: "incomplete";
      reason: RegistrationProbePreflightReason;
      run?: RegistrationProbeRun;
    }>
  | Readonly<{ state: "cleanup_required"; run: RegistrationProbeRun }>
  | Readonly<{
      state: "failed";
      stage: RegistrationProbeStage;
      reason: RegistrationProbeFailureReason;
      run: RegistrationProbeRun;
    }>;

export const registrationProbeAuthoritySources = ["user_local_ui", "user_conversation"] as const;
export type RegistrationProbeAuthoritySource = (typeof registrationProbeAuthoritySources)[number];

/**
 * Structural proof of a manual Full Revalidation trigger, bound to the exact project, setup
 * session, and registration revision. Never satisfied by startup, O002 scan, or reconcile.
 */
export interface RegistrationProbeAuthority {
  readonly schemaVersion: 1;
  readonly source: RegistrationProbeAuthoritySource;
  readonly projectId: Project["id"];
  readonly setupSessionId: string;
  readonly registrationRevision: number;
}

export function registrationProbeAuthorityMatches(
  authority: RegistrationProbeAuthority,
  projectId: Project["id"],
  setupSessionId: string,
  registrationRevision: number,
): boolean {
  return (
    authority.schemaVersion === 1 &&
    (registrationProbeAuthoritySources as readonly string[]).includes(authority.source) &&
    authority.projectId === projectId &&
    authority.setupSessionId === setupSessionId &&
    authority.registrationRevision === registrationRevision
  );
}
