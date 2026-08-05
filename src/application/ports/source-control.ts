import type { Instant } from "../../domain/foundation/index.js";
import type { Project } from "../../domain/project/index.js";
import type { AsyncPortResult, MutationOptions, ReadOptions } from "./common.js";

export interface SourceControlRepositoryRef {
  readonly project: Project;
}

export interface ChangeRequestRef extends SourceControlRepositoryRef {
  readonly changeRequestId: string;
}

export interface ChangeRequestSnapshot {
  readonly id: string;
  readonly number: number;
  readonly url: string;
  readonly state: "open" | "closed" | "merged";
  readonly draft: boolean;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly headSha: string;
  readonly mergeability: "mergeable" | "conflicting" | "unknown";
  readonly autoMergeEnabled: boolean;
  readonly updatedAt: Instant;
}

export interface CreateDraftChangeRequestCommand extends SourceControlRepositoryRef {
  readonly title: string;
  readonly body: string;
  readonly baseBranch: string;
  readonly headBranch: string;
}

export interface CommitCheck {
  readonly name: string;
  readonly status: "queued" | "in_progress" | "completed";
  readonly conclusion: "success" | "failure" | "cancelled" | "skipped" | null;
  readonly url?: string;
}

export interface CommitChecksSnapshot {
  readonly headSha: string;
  readonly aggregate: "pending" | "success" | "failure";
  readonly checks: readonly CommitCheck[];
}

export interface CommitStatusCommand extends SourceControlRepositoryRef {
  readonly headSha: string;
  readonly context: string;
  readonly state: "pending" | "success" | "failure" | "error";
  readonly description: string;
  readonly targetUrl?: string;
}

export interface CommitStatus {
  readonly context: string;
  readonly state: "pending" | "success" | "failure" | "error";
  readonly description?: string;
  readonly targetUrl?: string;
}

export interface CommitStatusesSnapshot {
  readonly headSha: string;
  readonly statuses: readonly CommitStatus[];
}

export interface ChangeRequestCommentCommand {
  readonly changeRequest: ChangeRequestRef;
  readonly expectedHeadSha: string;
  readonly kind: "review_evidence" | "automation";
  readonly body: string;
}

export interface ChangeRequestCommentReceipt {
  readonly id: string;
  readonly url: string;
  readonly createdAt: Instant;
}

export interface SourceControlPort {
  getChangeRequest(
    reference: ChangeRequestRef,
    options?: ReadOptions,
  ): AsyncPortResult<ChangeRequestSnapshot>;
  createDraftChangeRequest(
    command: CreateDraftChangeRequestCommand,
    options: MutationOptions,
  ): AsyncPortResult<ChangeRequestSnapshot>;
  getCommitChecks(
    repository: SourceControlRepositoryRef,
    headSha: string,
    options?: ReadOptions,
  ): AsyncPortResult<CommitChecksSnapshot>;
  getCommitStatuses(
    repository: SourceControlRepositoryRef,
    headSha: string,
    options?: ReadOptions,
  ): AsyncPortResult<CommitStatusesSnapshot>;
  setCommitStatus(command: CommitStatusCommand, options: MutationOptions): AsyncPortResult<void>;
  appendChangeRequestComment(
    command: ChangeRequestCommentCommand,
    options: MutationOptions,
  ): AsyncPortResult<ChangeRequestCommentReceipt>;
  markChangeRequestReady(
    reference: ChangeRequestRef,
    expectedHeadSha: string,
    options: MutationOptions,
  ): AsyncPortResult<ChangeRequestSnapshot>;
  enableAutoMerge(
    reference: ChangeRequestRef,
    expectedHeadSha: string,
    options: MutationOptions,
  ): AsyncPortResult<ChangeRequestSnapshot>;
  closeChangeRequest(
    reference: ChangeRequestRef,
    options: MutationOptions,
  ): AsyncPortResult<ChangeRequestSnapshot>;
}
