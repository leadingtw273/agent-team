import type { Instant } from "../../domain/foundation/index.js";
import type { Issue, Project } from "../../domain/project/index.js";
import type { AgentCondition, WorkStatus } from "../../domain/workflow/index.js";
import type { AsyncPortResult, MutationOptions, ReadOptions } from "./common.js";

export interface WorkManagementIssueRef {
  readonly project: Project;
  readonly externalIssueId: string;
}

export interface WorkManagementIssueSnapshot {
  readonly issue: Issue;
  readonly workStatus: WorkStatus;
  /** Provider workflow-state id used only for exact lifecycle/recovery identity. */
  readonly workStatusStateId?: string;
  readonly agentCondition?: AgentCondition;
  readonly archivedAt?: Instant;
  readonly trashed?: boolean;
  readonly updatedAt: Instant;
  readonly revision: string;
}

export interface WorkManagementIssueQuery {
  readonly project: Project;
  readonly workStatuses?: readonly WorkStatus[];
  readonly updatedAfter?: Instant;
}

export interface CreateWorkManagementIssueCommand {
  readonly project: Project;
  readonly issue: Omit<Issue, "schemaVersion" | "id" | "projectId" | "externalId">;
}

export interface WorkManagementComment {
  readonly id: string;
  readonly body: string;
  readonly createdAt: Instant;
}

export interface WorkManagementArtifact {
  readonly filename: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly content: Uint8Array;
}

export interface WorkManagementArtifactReceipt {
  readonly externalId: string;
  readonly url: string;
  readonly sha256: string;
}

export interface WorkManagementPort {
  createIssue(
    command: CreateWorkManagementIssueCommand,
    options: MutationOptions,
  ): AsyncPortResult<WorkManagementIssueSnapshot>;
  getIssue(
    reference: WorkManagementIssueRef,
    options?: ReadOptions,
  ): AsyncPortResult<WorkManagementIssueSnapshot>;
  listIssues(
    query: WorkManagementIssueQuery,
    options?: ReadOptions,
  ): AsyncPortResult<readonly WorkManagementIssueSnapshot[]>;
  listComments(
    reference: WorkManagementIssueRef,
    options?: ReadOptions,
  ): AsyncPortResult<readonly WorkManagementComment[]>;
  setWorkStatus(
    reference: WorkManagementIssueRef,
    status: WorkStatus,
    options: MutationOptions,
  ): AsyncPortResult<WorkManagementIssueSnapshot>;
  setAgentCondition(
    reference: WorkManagementIssueRef,
    condition: AgentCondition,
    options: MutationOptions,
  ): AsyncPortResult<WorkManagementIssueSnapshot>;
  clearAgentCondition(
    reference: WorkManagementIssueRef,
    options: MutationOptions,
  ): AsyncPortResult<WorkManagementIssueSnapshot>;
  appendComment(
    reference: WorkManagementIssueRef,
    body: string,
    options: MutationOptions,
  ): AsyncPortResult<WorkManagementComment>;
  uploadArtifact(
    reference: WorkManagementIssueRef,
    artifact: WorkManagementArtifact,
    options: MutationOptions,
  ): AsyncPortResult<WorkManagementArtifactReceipt>;
}
