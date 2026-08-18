import { createHash } from "node:crypto";

import { z } from "zod";

import {
  domainError,
  err,
  ok,
  parseInstant,
  type DomainError,
  type Instant,
  type Result,
} from "../../domain/foundation/index.js";
import type { AgentRole, Priority, ReviewRequirement } from "../../domain/project/index.js";
import {
  canTransitionAgentStatus,
  transitionWorkStatus as validateWorkTransition,
  type AgentStatus,
  type BlockingReason,
  type WorkStatus,
  type WorkTransitionRequest,
} from "../../domain/workflow/index.js";
import type { LinearIssueSnapshot, LinearProjectContext } from "./model.js";
import { LinearGraphqlTransport } from "./transport.js";

const mutationIssueSchema = z
  .object({ id: z.string().min(1), identifier: z.string().min(1) })
  .strict();
const issueMutationPayloadSchema = z
  .object({ success: z.boolean(), issue: mutationIssueSchema.nullable() })
  .strict();
const issueCreateMutationSchema = z.object({ issueCreate: issueMutationPayloadSchema }).strict();
const issueUpdateMutationSchema = z.object({ issueUpdate: issueMutationPayloadSchema }).strict();
const commentMutationSchema = z
  .object({
    commentCreate: z
      .object({
        success: z.boolean(),
        comment: z
          .object({ id: z.string().min(1), body: z.string(), createdAt: z.string() })
          .strict()
          .nullable(),
      })
      .strict(),
  })
  .strict();

const issueCreateQuery = `
  mutation AgentTeamCreateIssue($input: IssueCreateInput!) {
    issueCreate(input: $input) { success issue { id identifier } }
  }
`;
const issueUpdateQuery = `
  mutation AgentTeamUpdateIssue($issueId: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $issueId, input: $input) { success issue { id identifier } }
  }
`;
const commentCreateQuery = `
  mutation AgentTeamCreateComment($input: CommentCreateInput!) {
    commentCreate(input: $input) { success comment { id body createdAt } }
  }
`;

export interface LinearIssueReader {
  readIssue(
    context: LinearProjectContext,
    issueId: string,
  ): Promise<Result<LinearIssueSnapshot, DomainError>>;
}

export interface CreateLinearIssueInput {
  readonly title: string;
  readonly description: string;
  readonly priority: Priority;
  readonly workStatus: WorkStatus;
  readonly agentRole?: AgentRole;
  readonly reviewRequirement?: ReviewRequirement;
  readonly agentStatus?: AgentStatus;
  readonly blockingReason?: BlockingReason;
  readonly otherLabelIds?: readonly string[];
}

export interface LinearVisibleAgentCondition {
  readonly status: AgentStatus;
  readonly blockingReason?: BlockingReason;
}

export interface LinearCommentReceipt {
  readonly id: string;
  readonly body: string;
  readonly createdAt: Instant;
  readonly reused: boolean;
}

const priorityValues = {
  urgent: 1,
  high: 2,
  medium: 3,
  low: 4,
} as const satisfies Readonly<Record<Priority, number>>;

function failure<Value>(code: "conflict" | "external_failure" = "external_failure") {
  return err(domainError(code)) as Result<Value, DomainError>;
}

function controlledLabelIds(
  context: LinearProjectContext,
  values: {
    readonly agentRole?: AgentRole;
    readonly reviewRequirement?: ReviewRequirement;
    readonly agentStatus?: AgentStatus;
    readonly blockingReason?: BlockingReason;
  },
): readonly string[] {
  return [
    values.agentRole === undefined
      ? undefined
      : context.catalog.agentRole.labelIdByValue[values.agentRole],
    values.reviewRequirement === undefined
      ? undefined
      : context.catalog.reviewRequirement.labelIdByValue[values.reviewRequirement],
    values.agentStatus === undefined
      ? undefined
      : context.catalog.agentStatus.labelIdByValue[values.agentStatus],
    values.blockingReason === undefined
      ? undefined
      : context.catalog.blockingReason.labelIdByValue[values.blockingReason],
  ].filter((value) => value !== undefined);
}

function controlledLabelIdsFromSnapshot(
  context: LinearProjectContext,
  snapshot: LinearIssueSnapshot,
): readonly string[] {
  return controlledLabelIds(context, {
    ...(snapshot.agentRole === undefined ? {} : { agentRole: snapshot.agentRole }),
    ...(snapshot.reviewRequirement === undefined
      ? {}
      : { reviewRequirement: snapshot.reviewRequirement }),
    ...(snapshot.agentCondition === undefined
      ? {}
      : {
          agentStatus: snapshot.agentCondition.status,
          blockingReason: snapshot.agentCondition.blockingReasons[0],
        }),
  });
}

function validVisibleCondition(condition: LinearVisibleAgentCondition): boolean {
  if (condition.status === "blocked") return condition.blockingReason !== undefined;
  if (condition.status === "waiting") return true;
  return condition.blockingReason === undefined;
}

function commentMarker(idempotencyKey: string): string {
  const digest = createHash("sha256").update(idempotencyKey, "utf8").digest("hex");
  return `<!-- agent-team:idempotency:${digest} -->`;
}

function storedCommentBody(body: string, marker: string): string {
  return `${body}\n\n${marker}`;
}

export class LinearMutationClient {
  readonly #commentOperations = new Map<
    string,
    {
      readonly body: string;
      readonly promise: Promise<Result<LinearCommentReceipt, DomainError>>;
    }
  >();

  constructor(
    readonly transport: LinearGraphqlTransport,
    readonly reader: LinearIssueReader,
  ) {}

  async createIssue(
    context: LinearProjectContext,
    input: CreateLinearIssueInput,
  ): Promise<Result<LinearIssueSnapshot, DomainError>> {
    if (
      !validVisibleCondition({
        status: input.agentStatus ?? "queued",
        ...(input.blockingReason === undefined ? {} : { blockingReason: input.blockingReason }),
      })
    ) {
      return failure();
    }
    const labelIds = [...controlledLabelIds(context, input), ...new Set(input.otherLabelIds ?? [])];
    const result = await this.transport.request<
      unknown,
      { input: Readonly<Record<string, unknown>> }
    >({
      operationName: "AgentTeamCreateIssue",
      query: issueCreateQuery,
      variables: {
        input: {
          teamId: context.team.id,
          projectId: context.project.id,
          title: input.title,
          description: input.description,
          priority: priorityValues[input.priority],
          stateId: context.catalog.stateIdByWorkStatus[input.workStatus],
          labelIds,
          useDefaultTemplate: false,
        },
      },
    });
    if (!result.ok) return result;
    const parsed = issueCreateMutationSchema.safeParse(result.value);
    if (
      !parsed.success ||
      !parsed.data.issueCreate.success ||
      parsed.data.issueCreate.issue === null
    ) {
      return failure();
    }
    return this.reader.readIssue(context, parsed.data.issueCreate.issue.id);
  }

  async transitionWorkStatus(
    context: LinearProjectContext,
    issueId: string,
    request: WorkTransitionRequest,
  ): Promise<Result<LinearIssueSnapshot, DomainError>> {
    const current = await this.reader.readIssue(context, issueId);
    if (!current.ok) return current;
    const transition = validateWorkTransition(current.value.workStatus, request);
    if (!transition.ok) return transition;
    return this.updateAndReadBack(
      context,
      issueId,
      { stateId: context.catalog.stateIdByWorkStatus[transition.value] },
      (snapshot) => snapshot.workStatus === transition.value,
    );
  }

  async observeGithubMerge(
    context: LinearProjectContext,
    issueId: string,
  ): Promise<Result<LinearIssueSnapshot, DomainError>> {
    return this.transitionWorkStatus(context, issueId, {
      target: "completed",
      cause: "github_merge_observed",
    });
  }

  async requireManualIntervention(
    context: LinearProjectContext,
    issueId: string,
  ): Promise<Result<LinearIssueSnapshot, DomainError>> {
    return this.transitionWorkStatus(context, issueId, {
      target: "requires_manual",
      cause: "policy_requires_manual",
    });
  }

  async cancelIssueByUser(
    context: LinearProjectContext,
    issueId: string,
  ): Promise<Result<LinearIssueSnapshot, DomainError>> {
    return this.transitionWorkStatus(context, issueId, {
      target: "canceled",
      cause: "user_canceled",
    });
  }

  async setAgentCondition(
    context: LinearProjectContext,
    issueId: string,
    condition: LinearVisibleAgentCondition,
  ): Promise<Result<LinearIssueSnapshot, DomainError>> {
    if (!validVisibleCondition(condition)) return failure();
    const current = await this.reader.readIssue(context, issueId);
    if (!current.ok) return current;
    const currentStatus = current.value.agentCondition?.status ?? "queued";
    if (!canTransitionAgentStatus(currentStatus, condition.status)) return failure("conflict");
    const labelIds = [
      ...controlledLabelIds(context, {
        ...(current.value.agentRole === undefined ? {} : { agentRole: current.value.agentRole }),
        ...(current.value.reviewRequirement === undefined
          ? {}
          : { reviewRequirement: current.value.reviewRequirement }),
        agentStatus: condition.status,
        ...(condition.blockingReason === undefined
          ? {}
          : { blockingReason: condition.blockingReason }),
      }),
      ...current.value.otherLabelIds,
    ];
    return this.updateAndReadBack(
      context,
      issueId,
      { labelIds },
      (snapshot) =>
        snapshot.agentCondition?.status === condition.status &&
        snapshot.agentCondition.blockingReasons[0] === condition.blockingReason,
    );
  }

  async clearAgentCondition(
    context: LinearProjectContext,
    issueId: string,
  ): Promise<Result<LinearIssueSnapshot, DomainError>> {
    const current = await this.reader.readIssue(context, issueId);
    if (!current.ok) return current;
    if (current.value.agentCondition === undefined) return current;
    const labelIds = [
      ...controlledLabelIds(context, {
        ...(current.value.agentRole === undefined ? {} : { agentRole: current.value.agentRole }),
        ...(current.value.reviewRequirement === undefined
          ? {}
          : { reviewRequirement: current.value.reviewRequirement }),
      }),
      ...current.value.otherLabelIds,
    ];
    return this.updateAndReadBack(
      context,
      issueId,
      { labelIds },
      (snapshot) => snapshot.agentCondition === undefined,
    );
  }

  async setOtherLabels(
    context: LinearProjectContext,
    issueId: string,
    otherLabelIds: readonly string[],
  ): Promise<Result<LinearIssueSnapshot, DomainError>> {
    if (new Set(otherLabelIds).size !== otherLabelIds.length) return failure();
    const controlledIds = new Set([
      ...Object.keys(context.catalog.agentRole.valueByLabelId),
      ...Object.keys(context.catalog.reviewRequirement.valueByLabelId),
      ...Object.keys(context.catalog.agentStatus.valueByLabelId),
      ...Object.keys(context.catalog.blockingReason.valueByLabelId),
    ]);
    if (otherLabelIds.some((labelId) => controlledIds.has(labelId))) return failure();
    const current = await this.reader.readIssue(context, issueId);
    if (!current.ok) return current;
    const labelIds = [...controlledLabelIdsFromSnapshot(context, current.value), ...otherLabelIds];
    return this.updateAndReadBack(
      context,
      issueId,
      { labelIds },
      (snapshot) =>
        snapshot.otherLabelIds.length === otherLabelIds.length &&
        snapshot.otherLabelIds.every((labelId) => otherLabelIds.includes(labelId)),
    );
  }

  /**
   * Deduplicates retries durably through a hashed marker and coalesces identical
   * calls in this process. Cross-process callers must serialize the same
   * issue/key through the controller lease or inbox.
   */
  appendComment(
    context: LinearProjectContext,
    issueId: string,
    body: string,
    idempotencyKey: string,
  ): Promise<Result<LinearCommentReceipt, DomainError>> {
    if (idempotencyKey.length === 0) return Promise.resolve(failure());
    const operationKey = `${issueId}:${commentMarker(idempotencyKey)}`;
    const pending = this.#commentOperations.get(operationKey);
    if (pending !== undefined) {
      return pending.body === body ? pending.promise : Promise.resolve(failure("conflict"));
    }
    const operation = this.#appendComment(context, issueId, body, idempotencyKey).finally(() => {
      this.#commentOperations.delete(operationKey);
    });
    this.#commentOperations.set(operationKey, { body, promise: operation });
    return operation;
  }

  async #appendComment(
    context: LinearProjectContext,
    issueId: string,
    body: string,
    idempotencyKey: string,
  ): Promise<Result<LinearCommentReceipt, DomainError>> {
    const marker = commentMarker(idempotencyKey);
    const storedBody = storedCommentBody(body, marker);
    const before = await this.reader.readIssue(context, issueId);
    if (!before.ok) return before;
    const existing = before.value.comments.filter((comment) => comment.body.includes(marker));
    if (existing.length > 1) return failure();
    if (existing[0] !== undefined) {
      if (existing[0].body !== storedBody) return failure("conflict");
      return ok({ id: existing[0].id, body, createdAt: existing[0].createdAt, reused: true });
    }

    const result = await this.transport.request<
      unknown,
      { input: { issueId: string; body: string; doNotSubscribeToIssue: boolean } }
    >({
      operationName: "AgentTeamCreateComment",
      query: commentCreateQuery,
      variables: { input: { issueId, body: storedBody, doNotSubscribeToIssue: true } },
    });
    if (!result.ok) return result;
    const parsed = commentMutationSchema.safeParse(result.value);
    if (
      !parsed.success ||
      !parsed.data.commentCreate.success ||
      parsed.data.commentCreate.comment === null
    ) {
      return failure();
    }
    const after = await this.reader.readIssue(context, issueId);
    if (!after.ok) return after;
    const matches = after.value.comments.filter((comment) => comment.body.includes(marker));
    if (matches.length !== 1 || matches[0]?.body !== storedBody) return failure();
    const createdAt = parseInstant(matches[0].createdAt);
    if (!createdAt.ok) return failure();
    return ok({ id: matches[0].id, body, createdAt: createdAt.value, reused: false });
  }

  async updateAndReadBack(
    context: LinearProjectContext,
    issueId: string,
    input: Readonly<Record<string, unknown>>,
    verify: (snapshot: LinearIssueSnapshot) => boolean,
  ): Promise<Result<LinearIssueSnapshot, DomainError>> {
    const result = await this.transport.request<
      unknown,
      { issueId: string; input: Readonly<Record<string, unknown>> }
    >({
      operationName: "AgentTeamUpdateIssue",
      query: issueUpdateQuery,
      variables: { issueId, input },
    });
    if (!result.ok) return result;
    const parsed = issueUpdateMutationSchema.safeParse(result.value);
    if (
      !parsed.success ||
      !parsed.data.issueUpdate.success ||
      parsed.data.issueUpdate.issue?.id !== issueId
    ) {
      return failure();
    }
    const readBack = await this.reader.readIssue(context, issueId);
    return readBack.ok && verify(readBack.value) ? readBack : failure();
  }
}
