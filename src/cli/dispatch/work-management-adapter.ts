/**
 * C015c item 5: `WorkManagementPort` adapter for `LifecyclePipeline`
 * (src/application/pipelines/lifecycle.ts) -- only the narrow slice `LifecyclePipelinePorts`
 * actually declares: `Pick<WorkManagementPort, "getIssue" | "setWorkStatus" | "setAgentCondition"
 * | "appendComment">`. Wraps the same `LinearReadModel`/`LinearMutationClient` pair the rest of
 * the dispatch CLI already uses (composition.ts's `discovery.readModel`), never a new transport.
 *
 * `LinearIssueSnapshot` (src/adapters/linear/model.ts) is not `WorkManagementIssueSnapshot`
 * (src/application/ports/work-management.ts) -- the former is Linear's own read shape, the latter
 * wraps a full domain `Issue`. `toWorkManagementSnapshot` below builds the minimal, honestly-
 * derivable `Issue` (`id`/`projectId`/`externalId`/`title` only -- the same
 * `generateDeterministicIdentifier("issue", externalId)` convention `linear-discovery.ts` already
 * established for turning a Linear id into a domain id). It deliberately does not re-parse the
 * Ready Gate template (goal/acceptanceCriteria/...): `LifecyclePipeline` only ever reads
 * `issue.projectId`/`issue.externalId`/top-level `workStatus`/`agentCondition` (confirmed by
 * reading lifecycle.ts directly), so those optional fields would be unread scope creep here.
 *
 * `setWorkStatus` narrows to the one case `LifecyclePipeline` ever actually calls (confirmed via
 * grep: always `target: "completed"`, in `#handleMerge`) -- any other target fails closed with
 * `invariant_violation` rather than pretending to support a general status-to-cause mapping this
 * adapter was never asked to build. `setAgentCondition` similarly fails closed if asked to carry
 * more than one blocking reason: Linear's own label model
 * (`LinearVisibleAgentCondition.blockingReason`) only ever carries one.
 */
import type {
  MutationOptions,
  ReadOptions,
  WorkManagementComment,
  WorkManagementIssueQuery,
  WorkManagementIssueRef,
  WorkManagementIssueSnapshot,
  WorkManagementPort,
} from "../../application/ports/index.js";
import {
  domainError,
  err,
  generateDeterministicIdentifier,
  ok,
  parseInstant,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import { issueSchema } from "../../domain/project/index.js";
import { workStatuses, type AgentCondition, type WorkStatus } from "../../domain/workflow/index.js";
import type { LinearIssueSnapshot } from "../../adapters/linear/model.js";
import type { LinearMutationClient } from "../../adapters/linear/write.js";
import type { LinearReadModel } from "../../adapters/linear/read.js";

/** Same narrowing convention as `LinearDiscoveryReadModel` (linear-discovery.ts): only the
 * methods this adapter actually calls, so callers/tests can fake a plain object instead of a
 * real `LinearMutationClient`/`LinearReadModel` instance. */
export type LinearWorkManagementMutationClient = Pick<
  LinearMutationClient,
  | "observeGithubMerge"
  | "requireManualIntervention"
  | "setAgentCondition"
  | "clearAgentCondition"
  | "appendComment"
> &
  Partial<Pick<LinearMutationClient, "transitionWorkStatus">>;
export type LinearWorkManagementReadModel = Pick<
  LinearReadModel,
  "readContext" | "readIssue" | "listIssueIdsInState"
> &
  Partial<Pick<LinearReadModel, "readIssueHistory">>;

export interface LinearWorkManagementAdapterOptions {
  readonly readModel: LinearWorkManagementReadModel;
  readonly mutationClient: LinearWorkManagementMutationClient;
  readonly teamId: string;
  readonly linearProjectId: string;
}

function toWorkManagementSnapshot(
  projectId: string,
  snapshot: LinearIssueSnapshot,
): Result<WorkManagementIssueSnapshot, DomainError> {
  const issueId = generateDeterministicIdentifier("issue", snapshot.id);
  if (!issueId.ok) return issueId;
  const issue = issueSchema.safeParse({
    schemaVersion: 1,
    id: issueId.value,
    projectId,
    externalId: snapshot.id,
    title: snapshot.title,
    ...(snapshot.agentRole === undefined ? {} : { agentRole: snapshot.agentRole }),
    ...(snapshot.reviewRequirement === undefined
      ? {}
      : { reviewRequirement: snapshot.reviewRequirement }),
  });
  if (!issue.success) return err(domainError("invariant_violation"));
  return ok(
    Object.freeze({
      issue: issue.data,
      workStatus: snapshot.workStatus,
      ...(snapshot.stateId === undefined ? {} : { workStatusStateId: snapshot.stateId }),
      ...(snapshot.agentCondition === undefined ? {} : { agentCondition: snapshot.agentCondition }),
      ...(snapshot.archivedAt === undefined ? {} : { archivedAt: snapshot.archivedAt }),
      ...(snapshot.trashed === undefined ? {} : { trashed: snapshot.trashed }),
      updatedAt: snapshot.updatedAt,
      revision: snapshot.updatedAt,
    }),
  );
}

export class LinearWorkManagementAdapter implements Pick<
  WorkManagementPort,
  | "getIssue"
  | "listIssues"
  | "setWorkStatus"
  | "setAgentCondition"
  | "clearAgentCondition"
  | "appendComment"
> {
  readonly #readModel: LinearWorkManagementReadModel;
  readonly #mutationClient: LinearWorkManagementMutationClient;
  readonly #teamId: string;
  readonly #linearProjectId: string;

  constructor(options: LinearWorkManagementAdapterOptions) {
    this.#readModel = options.readModel;
    this.#mutationClient = options.mutationClient;
    this.#teamId = options.teamId;
    this.#linearProjectId = options.linearProjectId;
  }

  async getIssueHistory(reference: WorkManagementIssueRef, options: ReadOptions = {}) {
    if (this.#readModel.readIssueHistory === undefined) {
      return err(domainError("invariant_violation"));
    }
    const context = await this.#context(options);
    if (!context.ok) return context;
    const current = await this.#readModel.readIssue(
      context.value,
      reference.externalIssueId,
      options,
    );
    if (!current.ok) return current;
    if (current.value.stateId === undefined) return err(domainError("invariant_violation"));
    const history = await this.#readModel.readIssueHistory(reference.externalIssueId, options);
    if (!history.ok) return history;
    const entries = [];
    for (const entry of history.value.entries) {
      const createdAt = parseInstant(entry.createdAt);
      if (!createdAt.ok) return err(domainError("invariant_violation"));
      entries.push(
        Object.freeze({
          id: entry.id,
          createdAt: createdAt.value,
          actorKind: entry.actorId === null ? ("automation" as const) : ("human" as const),
          fromStateId: entry.fromStateId,
          toStateId: entry.toStateId,
          fromTeamId: entry.fromTeamId,
          toTeamId: entry.toTeamId,
          fromProjectId: entry.fromProjectId,
          toProjectId: entry.toProjectId,
          archived: entry.archived,
          trashed: entry.trashed,
        }),
      );
    }
    const stateSpans = [];
    for (const span of history.value.stateSpans) {
      const startedAt = parseInstant(span.startedAt);
      const endedAt = span.endedAt === null ? null : parseInstant(span.endedAt);
      if (!startedAt.ok || (endedAt !== null && !endedAt.ok)) {
        return err(domainError("invariant_violation"));
      }
      stateSpans.push(
        Object.freeze({
          id: span.id,
          stateId: span.stateId,
          startedAt: startedAt.value,
          endedAt: endedAt === null ? null : endedAt.value,
        }),
      );
    }
    return ok(
      Object.freeze({
        currentStateId: current.value.stateId,
        stateIdByWorkStatus: context.value.catalog.stateIdByWorkStatus,
        entries: Object.freeze(entries),
        stateSpans: Object.freeze(stateSpans),
      }),
    );
  }

  async #context(options: ReadOptions = {}) {
    return this.#readModel.readContext(this.#teamId, this.#linearProjectId, options);
  }

  async getIssue(
    reference: WorkManagementIssueRef,
    options: ReadOptions = {},
  ): Promise<Result<WorkManagementIssueSnapshot, DomainError>> {
    const context = await this.#context(options);
    if (!context.ok) return context;
    const read = await this.#readModel.readIssue(context.value, reference.externalIssueId, options);
    if (!read.ok) return read;
    return toWorkManagementSnapshot(reference.project.id, read.value);
  }

  async listIssues(
    query: WorkManagementIssueQuery,
    options: ReadOptions = {},
  ): Promise<Result<readonly WorkManagementIssueSnapshot[], DomainError>> {
    const context = await this.#context(options);
    if (!context.ok) return context;
    const statuses = query.workStatuses ?? workStatuses;
    const issueIds = new Set<string>();
    for (const status of statuses) {
      const listed = await this.#readModel.listIssueIdsInState(
        context.value,
        context.value.catalog.stateIdByWorkStatus[status],
        options,
      );
      if (!listed.ok) return listed;
      for (const issueId of listed.value) issueIds.add(issueId);
    }
    const snapshots: WorkManagementIssueSnapshot[] = [];
    for (const issueId of issueIds) {
      const read = await this.#readModel.readIssue(context.value, issueId, options);
      if (!read.ok) return read;
      if (
        query.updatedAfter !== undefined &&
        Date.parse(read.value.updatedAt) <= Date.parse(query.updatedAfter)
      ) {
        continue;
      }
      const snapshot = toWorkManagementSnapshot(query.project.id, read.value);
      if (!snapshot.ok) return snapshot;
      snapshots.push(snapshot.value);
    }
    return ok(Object.freeze(snapshots));
  }

  async setWorkStatus(
    reference: WorkManagementIssueRef,
    status: WorkStatus,
    _options: MutationOptions,
  ): Promise<Result<WorkManagementIssueSnapshot, DomainError>> {
    void _options;
    if (
      status !== "completed" &&
      status !== "requires_manual" &&
      status !== "in_review" &&
      status !== "in_progress"
    ) {
      return err(domainError("invariant_violation"));
    }
    const context = await this.#context();
    if (!context.ok) return context;
    const result =
      status === "completed"
        ? await this.#mutationClient.observeGithubMerge(context.value, reference.externalIssueId)
        : status === "requires_manual"
          ? await this.#mutationClient.requireManualIntervention(
              context.value,
              reference.externalIssueId,
            )
          : this.#mutationClient.transitionWorkStatus === undefined
            ? err(domainError("invariant_violation"))
            : await this.#mutationClient.transitionWorkStatus(
                context.value,
                reference.externalIssueId,
                status === "in_review"
                  ? { target: "in_review", cause: "review_started" }
                  : { target: "in_progress", cause: "work_started" },
              );
    if (!result.ok) return result;
    return toWorkManagementSnapshot(reference.project.id, result.value);
  }

  async setAgentCondition(
    reference: WorkManagementIssueRef,
    condition: AgentCondition,
    _options: MutationOptions,
  ): Promise<Result<WorkManagementIssueSnapshot, DomainError>> {
    void _options;
    if (condition.blockingReasons.length > 1) return err(domainError("invariant_violation"));
    const context = await this.#context();
    if (!context.ok) return context;
    const result = await this.#mutationClient.setAgentCondition(
      context.value,
      reference.externalIssueId,
      {
        status: condition.status,
        ...(condition.blockingReasons[0] === undefined
          ? {}
          : { blockingReason: condition.blockingReasons[0] }),
      },
    );
    if (!result.ok) return result;
    return toWorkManagementSnapshot(reference.project.id, result.value);
  }

  async clearAgentCondition(
    reference: WorkManagementIssueRef,
    _options: MutationOptions,
  ): Promise<Result<WorkManagementIssueSnapshot, DomainError>> {
    void _options;
    const context = await this.#context();
    if (!context.ok) return context;
    const result = await this.#mutationClient.clearAgentCondition(
      context.value,
      reference.externalIssueId,
    );
    if (!result.ok) return result;
    return toWorkManagementSnapshot(reference.project.id, result.value);
  }

  async appendComment(
    reference: WorkManagementIssueRef,
    body: string,
    options: MutationOptions,
  ): Promise<Result<WorkManagementComment, DomainError>> {
    const context = await this.#context();
    if (!context.ok) return context;
    const result = await this.#mutationClient.appendComment(
      context.value,
      reference.externalIssueId,
      body,
      options.idempotencyKey,
    );
    if (!result.ok) return result;
    return ok(Object.freeze({ id: result.value.id, body, createdAt: result.value.createdAt }));
  }
}
