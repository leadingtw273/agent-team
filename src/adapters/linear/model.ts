import {
  domainError,
  err,
  ok,
  parseInstant,
  type DomainError,
  type Instant,
  type Result,
} from "../../domain/foundation/index.js";
import {
  agentRoleSchema,
  reviewRequirementSchema,
  type AgentRole,
  type Priority,
  type ReviewRequirement,
} from "../../domain/project/index.js";
import {
  agentStatuses,
  blockingReasons,
  createAgentCondition,
  workStatuses,
  type AgentCondition,
  type AgentStatus,
  type BlockingReason,
  type WorkStatus,
} from "../../domain/workflow/index.js";

export interface LinearNamedRecord {
  readonly id: string;
  readonly name: string;
}

export interface LinearTeamRecord extends LinearNamedRecord {
  readonly key: string;
}

export interface LinearWorkflowStateRecord extends LinearNamedRecord {
  readonly type: string;
}

export interface LinearLabelRecord extends LinearNamedRecord {
  readonly isGroup: boolean;
  readonly parentId: string | null;
}

export interface LinearIssueRecord {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly description: string | null;
  readonly priority: number;
  readonly updatedAt: string;
  readonly archivedAt?: string | null;
  readonly trashed?: boolean;
  readonly teamId: string;
  readonly projectId: string | null;
  readonly stateId: string;
  readonly labelIds: readonly string[];
}

export interface LinearRelationRecord {
  readonly id: string;
  readonly type: string;
  readonly relatedIssueId: string;
  readonly relatedIssueIdentifier: string;
  readonly direction: "outbound" | "inbound";
}

export interface LinearCommentRecord {
  readonly id: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface LinearLabelGroupCatalog<Value extends string> {
  readonly groupId: string;
  readonly valueByLabelId: Readonly<Record<string, Value>>;
  readonly labelIdByValue: Readonly<Record<Value, string>>;
}

export interface LinearReadCatalog {
  readonly workStatusByStateId: Readonly<Record<string, WorkStatus>>;
  readonly stateIdByWorkStatus: Readonly<Record<WorkStatus, string>>;
  readonly agentRole: LinearLabelGroupCatalog<AgentRole>;
  readonly reviewRequirement: LinearLabelGroupCatalog<ReviewRequirement>;
  readonly agentStatus: LinearLabelGroupCatalog<AgentStatus>;
  readonly blockingReason: LinearLabelGroupCatalog<BlockingReason>;
}

export interface LinearProjectContext {
  readonly team: LinearTeamRecord;
  readonly project: LinearNamedRecord;
  readonly catalog: LinearReadCatalog;
}

export interface LinearIssueSnapshot {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly description?: string;
  readonly priority?: Priority;
  readonly updatedAt: Instant;
  readonly archivedAt?: Instant;
  readonly trashed?: boolean;
  readonly teamId: string;
  readonly projectId: string;
  readonly workStatus: WorkStatus;
  readonly stateId?: string;
  readonly agentRole?: AgentRole;
  readonly reviewRequirement?: ReviewRequirement;
  readonly agentCondition?: AgentCondition;
  readonly otherLabelIds: readonly string[];
  readonly relations: readonly LinearRelationRecord[];
  readonly comments: readonly {
    readonly id: string;
    readonly body: string;
    readonly createdAt: Instant;
  }[];
}

export const linearWorkStatusNames = {
  backlog: "待辦",
  ready: "待執行",
  requires_manual: "需人工",
  in_progress: "進行中",
  in_review: "審查中",
  completed: "已完成",
  canceled: "已取消",
} as const satisfies Readonly<Record<WorkStatus, string>>;

export const linearAgentRoleNames = {
  team_lead: "團隊管理者",
  implementer: "開發工程師",
  code_reviewer: "代碼審查者",
  visual_reviewer: "視覺審查者",
  integration_engineer: "整合工程師",
} as const satisfies Readonly<Record<AgentRole, string>>;

export const linearReviewRequirementNames = {
  code_review: "代碼審查",
  visual_review: "視覺審查",
  dual_review: "雙重審查",
} as const satisfies Readonly<Record<ReviewRequirement, string>>;

export const linearAgentStatusNames = {
  queued: "排隊中",
  executing: "執行中",
  waiting: "等待中",
  paused: "已暫停",
  blocked: "已阻塞",
} as const satisfies Readonly<Record<AgentStatus, string>>;

export const linearBlockingReasonNames = {
  waiting_dependency: "等待依賴",
  weekly_quota_exhausted: "週額度不足",
  five_hour_limit: "5 小時額度限制",
  quota_unknown: "額度資訊無法確認",
  dangerous_operation_approval: "等待危險操作核可",
  integration_failure: "整合異常",
  merge_conflict: "合併衝突",
  change_request_closed: "變更請求已關閉",
  unknown_error: "未知錯誤",
} as const satisfies Readonly<Record<BlockingReason, string>>;

const labelGroups = {
  agentRole: {
    groupName: "Agent 角色",
    values: linearAgentRoleNames,
    keys: agentRoleSchema.options,
  },
  reviewRequirement: {
    groupName: "審查需求",
    values: linearReviewRequirementNames,
    keys: reviewRequirementSchema.options,
  },
  agentStatus: { groupName: "Agent 狀態", values: linearAgentStatusNames, keys: agentStatuses },
  blockingReason: {
    groupName: "阻塞原因",
    values: linearBlockingReasonNames,
    keys: blockingReasons,
  },
} as const;

function fail<Value>(): Result<Value, DomainError> {
  return err(domainError("external_failure"));
}

function uniqueIds(records: readonly { readonly id: string }[]): boolean {
  return new Set(records.map((record) => record.id)).size === records.length;
}

function buildStatusCatalog(
  states: readonly LinearWorkflowStateRecord[],
): Result<Pick<LinearReadCatalog, "workStatusByStateId" | "stateIdByWorkStatus">, DomainError> {
  if (!uniqueIds(states)) return fail();
  const byStateId: Record<string, WorkStatus> = Object.create(null) as Record<string, WorkStatus>;
  const byStatus = Object.create(null) as Record<WorkStatus, string>;
  for (const status of workStatuses) {
    const matches = states.filter((state) => state.name === linearWorkStatusNames[status]);
    if (matches.length !== 1 || matches[0] === undefined) return fail();
    byStateId[matches[0].id] = status;
    byStatus[status] = matches[0].id;
  }
  return ok(
    Object.freeze({
      workStatusByStateId: Object.freeze(byStateId),
      stateIdByWorkStatus: Object.freeze(byStatus),
    }),
  );
}

function buildLabelGroup<Value extends string>(
  labels: readonly LinearLabelRecord[],
  definition: {
    readonly groupName: string;
    readonly values: Readonly<Record<Value, string>>;
    readonly keys: readonly Value[];
  },
): Result<LinearLabelGroupCatalog<Value>, DomainError> {
  const groups = labels.filter((label) => label.isGroup && label.name === definition.groupName);
  if (groups.length !== 1 || groups[0] === undefined) return fail();
  const group = groups[0];
  const children = labels.filter((label) => !label.isGroup && label.parentId === group.id);
  const allowedNames = new Set(definition.keys.map((key) => definition.values[key]));
  if (children.some((child) => !allowedNames.has(child.name))) return fail();

  const valueByLabelId: Record<string, Value> = Object.create(null) as Record<string, Value>;
  const labelIdByValue = Object.create(null) as Record<Value, string>;
  for (const key of definition.keys) {
    const matches = children.filter((label) => label.name === definition.values[key]);
    if (matches.length !== 1 || matches[0] === undefined) return fail();
    valueByLabelId[matches[0].id] = key;
    labelIdByValue[key] = matches[0].id;
  }
  if (children.length !== definition.keys.length) return fail();
  return ok(
    Object.freeze({
      groupId: group.id,
      valueByLabelId: Object.freeze(valueByLabelId),
      labelIdByValue: Object.freeze(labelIdByValue),
    }),
  );
}

export function buildLinearReadCatalog(
  states: readonly LinearWorkflowStateRecord[],
  labels: readonly LinearLabelRecord[],
): Result<LinearReadCatalog, DomainError> {
  if (!uniqueIds(labels)) return fail();
  const statuses = buildStatusCatalog(states);
  if (!statuses.ok) return statuses;
  const agentRole = buildLabelGroup(labels, labelGroups.agentRole);
  if (!agentRole.ok) return agentRole;
  const reviewRequirement = buildLabelGroup(labels, labelGroups.reviewRequirement);
  if (!reviewRequirement.ok) return reviewRequirement;
  const agentStatus = buildLabelGroup(labels, labelGroups.agentStatus);
  if (!agentStatus.ok) return agentStatus;
  const blockingReason = buildLabelGroup(labels, labelGroups.blockingReason);
  if (!blockingReason.ok) return blockingReason;
  return ok(
    Object.freeze({
      ...statuses.value,
      agentRole: agentRole.value,
      reviewRequirement: reviewRequirement.value,
      agentStatus: agentStatus.value,
      blockingReason: blockingReason.value,
    }),
  );
}

function selectedValue<Value extends string>(
  labelIds: readonly string[],
  group: LinearLabelGroupCatalog<Value>,
): Result<Value | undefined, DomainError> {
  const selected = labelIds
    .map((labelId) => group.valueByLabelId[labelId])
    .filter((value) => value !== undefined);
  return selected.length <= 1 ? ok(selected[0]) : fail();
}

function linearPriority(value: number): Result<Priority | undefined, DomainError> {
  const priorities: Readonly<Record<number, Priority | undefined>> = {
    0: undefined,
    1: "urgent",
    2: "high",
    3: "medium",
    4: "low",
  };
  return Object.hasOwn(priorities, value) ? ok(priorities[value]) : fail();
}

export function createLinearIssueSnapshot(
  context: LinearProjectContext,
  issue: LinearIssueRecord,
  relations: readonly LinearRelationRecord[],
  comments: readonly LinearCommentRecord[],
): Result<LinearIssueSnapshot, DomainError> {
  if (issue.teamId !== context.team.id || issue.projectId !== context.project.id) return fail();
  if (new Set(issue.labelIds).size !== issue.labelIds.length) return fail();
  if (!uniqueIds(relations) || !uniqueIds(comments)) return fail();
  const workStatus = context.catalog.workStatusByStateId[issue.stateId];
  if (workStatus === undefined) return fail();
  const priority = linearPriority(issue.priority);
  if (!priority.ok) return priority;
  const updatedAt = parseInstant(issue.updatedAt);
  if (!updatedAt.ok) return fail();
  const archivedAt =
    issue.archivedAt === null || issue.archivedAt === undefined
      ? undefined
      : parseInstant(issue.archivedAt);
  if (archivedAt !== undefined && !archivedAt.ok) return fail();
  const agentRole = selectedValue(issue.labelIds, context.catalog.agentRole);
  if (!agentRole.ok) return agentRole;
  const reviewRequirement = selectedValue(issue.labelIds, context.catalog.reviewRequirement);
  if (!reviewRequirement.ok) return reviewRequirement;
  const agentStatus = selectedValue(issue.labelIds, context.catalog.agentStatus);
  if (!agentStatus.ok) return agentStatus;
  const blockingReason = selectedValue(issue.labelIds, context.catalog.blockingReason);
  if (!blockingReason.ok) return blockingReason;
  if (agentStatus.value === undefined && blockingReason.value !== undefined) return fail();

  let agentCondition: AgentCondition | undefined;
  if (agentStatus.value !== undefined) {
    try {
      agentCondition = createAgentCondition(
        agentStatus.value,
        blockingReason.value === undefined ? [] : [blockingReason.value],
      );
    } catch {
      return fail();
    }
  }
  const controlledIds = new Set([
    ...Object.keys(context.catalog.agentRole.valueByLabelId),
    ...Object.keys(context.catalog.reviewRequirement.valueByLabelId),
    ...Object.keys(context.catalog.agentStatus.valueByLabelId),
    ...Object.keys(context.catalog.blockingReason.valueByLabelId),
  ]);
  const parsedComments: { id: string; body: string; createdAt: Instant }[] = [];
  for (const comment of comments) {
    const createdAt = parseInstant(comment.createdAt);
    if (!createdAt.ok) return fail();
    parsedComments.push({ id: comment.id, body: comment.body, createdAt: createdAt.value });
  }

  return ok(
    Object.freeze({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      ...(issue.description === null ? {} : { description: issue.description }),
      ...(priority.value === undefined ? {} : { priority: priority.value }),
      updatedAt: updatedAt.value,
      ...(archivedAt === undefined ? {} : { archivedAt: archivedAt.value }),
      ...(issue.trashed === undefined ? {} : { trashed: issue.trashed }),
      teamId: issue.teamId,
      projectId: issue.projectId,
      workStatus,
      stateId: issue.stateId,
      ...(agentRole.value === undefined ? {} : { agentRole: agentRole.value }),
      ...(reviewRequirement.value === undefined
        ? {}
        : { reviewRequirement: reviewRequirement.value }),
      ...(agentCondition === undefined ? {} : { agentCondition }),
      otherLabelIds: Object.freeze(issue.labelIds.filter((labelId) => !controlledIds.has(labelId))),
      relations: Object.freeze([...relations]),
      comments: Object.freeze(parsedComments.map((comment) => Object.freeze(comment))),
    }),
  );
}
