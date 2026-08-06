import type {
  RegistrationProbeProviderEventEvidence,
  RegistrationProbeWebhookProvider,
} from "../registration/proactive-probe-model.js";
import type { AsyncPortResult, MutationOptions, ReadOptions } from "./common.js";
import type { GitPort, GitRepositoryRef, GitWorktree } from "./git.js";
import type { SourceControlPort } from "./source-control.js";

/**
 * Narrow O006 ports. Every mutation here must be preceded by a durable
 * `mutation_started` journal write by the coordinator; these ports never search by
 * name/pattern and never accept provider-origin text as an instruction.
 */

export interface RegistrationProbeLinearTarget {
  readonly teamId: string;
  readonly projectId: string;
  readonly workflowStateId: string;
}

export interface RegistrationProbeLinearCapability {
  readonly readWrite: boolean;
  readonly cancelable: boolean;
}

export interface RegistrationProbeLinearCreateCommand {
  readonly target: RegistrationProbeLinearTarget;
  readonly marker: string;
  readonly title: string;
  readonly body: string;
}

export interface RegistrationProbeLinearIssueSnapshot {
  readonly issueId: string;
  readonly state: "open" | "cancelled";
}

export interface RegistrationProbeLinearPort {
  readCapability(
    target: RegistrationProbeLinearTarget,
    options?: ReadOptions,
  ): AsyncPortResult<RegistrationProbeLinearCapability>;
  /** Exact-marker recovery lookup; never a fuzzy title search. */
  findByMarker(
    target: RegistrationProbeLinearTarget,
    marker: string,
    options?: ReadOptions,
  ): AsyncPortResult<RegistrationProbeLinearIssueSnapshot | undefined>;
  create(
    command: RegistrationProbeLinearCreateCommand,
    options: MutationOptions,
  ): AsyncPortResult<Readonly<{ issueId: string }>>;
  read(
    issueId: string,
    options?: ReadOptions,
  ): AsyncPortResult<RegistrationProbeLinearIssueSnapshot>;
  cancel(
    issueId: string,
    options: MutationOptions,
  ): AsyncPortResult<RegistrationProbeLinearIssueSnapshot>;
}

export interface RegistrationProbeGitHubCapabilitySnapshot {
  readonly permission: "admin" | "read_only";
  readonly requiredCheckConfigured: boolean;
  readonly reviewStatusSupported: boolean;
  readonly ciWorkflowConfirmed: boolean;
  readonly pushCapable: boolean;
  readonly draftPullRequestCapable: boolean;
  readonly closeCapable: boolean;
}

export interface RegistrationProbeGitHubCapabilityPort {
  inspect(
    target: Readonly<{ repository: string; defaultBranch: string }>,
    options?: ReadOptions,
  ): AsyncPortResult<RegistrationProbeGitHubCapabilitySnapshot>;
  /** Exact head+branch+marker recovery lookup; never a fuzzy title search. */
  findDraftPullRequestByHead(
    target: Readonly<{ repository: string; headBranch: string }>,
    marker: string,
    options?: ReadOptions,
  ): AsyncPortResult<
    | Readonly<{
        changeRequestId: string;
        number: number;
        headSha: string;
        state: "open" | "closed" | "merged";
        draft: boolean;
      }>
    | undefined
  >;
}

export type RegistrationProbeSourceControlPort = Pick<
  SourceControlPort,
  | "createDraftChangeRequest"
  | "getChangeRequest"
  | "getCommitChecks"
  | "getCommitStatuses"
  | "setCommitStatus"
  | "closeChangeRequest"
>;

export interface RegistrationProbeGitPort extends Pick<
  GitPort,
  | "createWorktree"
  | "stagePaths"
  | "commit"
  | "inspectWorkingTree"
  | "push"
  | "removeWorktree"
  | "inspectRepository"
> {
  /** Reads the remote's current head for the branch without mutating anything. */
  inspectRemoteBranch(
    repository: GitRepositoryRef,
    remote: string,
    branch: string,
    options?: ReadOptions,
  ): AsyncPortResult<Readonly<{ sha: string }> | undefined>;
}

export interface RegistrationWebhookProbeRequest {
  readonly provider: RegistrationProbeWebhookProvider;
  readonly baseUrl: string;
  readonly secret: Uint8Array;
}

export type RegistrationWebhookProbeFailureReason =
  | "invalid_request"
  | "transport_failed"
  | "response_too_slow"
  | "runtime_rejected"
  | "response_mismatch"
  | "inbox_missing"
  | "inbox_mismatch";

export type RegistrationWebhookProbeOutcome =
  | Readonly<{
      state: "verified";
      provider: RegistrationProbeWebhookProvider;
      deliveryId: string;
      latencyMs: number;
      inboxSha256: string;
    }>
  | Readonly<{
      state: "failed";
      reason: RegistrationWebhookProbeFailureReason;
    }>;

export interface RegistrationWebhookProbePort {
  runSyntheticProbe(
    request: RegistrationWebhookProbeRequest,
  ): Promise<RegistrationWebhookProbeOutcome>;
}

export interface RegistrationProbeProviderEventCriteria {
  readonly provider: RegistrationProbeWebhookProvider;
  readonly remoteObjectId: string;
  readonly headSha?: string;
}

export interface RegistrationProbeProviderEventPort {
  /**
   * Reads durable Inbox observations only; never polling readback, a synthetic delivery, or
   * config presence standing in for a genuine provider-origin event.
   */
  findProviderEvent(
    criteria: RegistrationProbeProviderEventCriteria,
    options?: ReadOptions,
  ): AsyncPortResult<RegistrationProbeProviderEventEvidence | undefined>;
}

export interface RegistrationProbeBranchCleanupCommand {
  readonly repository: string;
  readonly branch: string;
  readonly marker: string;
  readonly expectedHeadSha: string;
}

export interface RegistrationProbeBranchCleanupPort {
  /**
   * Deletes only the exact branch recorded in the run journal. Callers must have already
   * proven the owning Draft PR is closed/unmerged; this port never searches by pattern.
   */
  deleteOwnedBranch(
    command: RegistrationProbeBranchCleanupCommand,
    options: MutationOptions,
  ): AsyncPortResult<Readonly<{ state: "deleted" | "not_found" }>>;
}

export interface RegistrationProbeWorktreeInspectionPort {
  /** Confirms the worktree path is clean and rooted under the allowed probe temp root. */
  isEligibleForRemoval(worktree: GitWorktree, allowedRoot: string): boolean;
}

export interface RegistrationProbeFilePort {
  /** Writes only a deterministic, secret-free manifest under `.agent-team/probes/<runId>.json`. */
  writeProbeManifest(
    command: Readonly<{
      worktree: GitWorktree;
      path: string;
      content: string;
      contentDigest: string;
    }>,
    options: MutationOptions,
  ): AsyncPortResult<Readonly<{ path: string; contentDigest: string }>>;
}
