/**
 * C015c item 5: `WorkManagementPort` adapter for `LifecyclePipeline`
 * (src/application/pipelines/lifecycle.ts) -- only the narrow slice `LifecyclePipelinePorts`
 * actually declares: `Pick<WorkManagementPort, "getIssue" | "setWorkStatus" | "setAgentCondition"
 * | "appendComment">`. Wraps the same `LinearReadModel`/`LinearMutationClient` pair the rest of
 * the dispatch CLI already uses (composition.ts's `discovery.readModel`), never a new transport.
 *
 * `LinearIssueSnapshot` (src/adapters/linear/model.ts) is not `WorkManagementIssueSnapshot`
 * (src/application/ports/work-management.ts) -- the former is Linear's own read shape, the latter
 * wraps a full domain `Issue`. `toWorkManagementSnapshot` below deliberately reuses discovery's
 * canonical Ready Gate mapping so requirement identity remains stable between dispatch and later
 * merge/acceptance readback.
 *
 * `setWorkStatus` accepts only the lifecycle targets supported by the dispatch composition and
 * requires an explicit domain cause whenever `in_progress` could mean either initial work or a
 * requested fix. Unsupported or ambiguous transitions fail closed with `invariant_violation`.
 * `setAgentCondition` similarly fails closed if asked to carry more than one blocking reason:
 * Linear's own label model
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
  WorkStatusMutationOptions,
} from "../../application/ports/index.js";
import {
  domainError,
  err,
  ok,
  parseInstant,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import type { Project } from "../../domain/project/index.js";
import { workStatuses, type AgentCondition, type WorkStatus } from "../../domain/workflow/index.js";
import type { LinearIssueSnapshot } from "../../adapters/linear/model.js";
import type { LinearMutationClient } from "../../adapters/linear/write.js";
import type { LinearReadModel } from "../../adapters/linear/read.js";
import { parseReadyGateTemplate } from "../../adapters/linear/requirement-template.js";
import { toDomainIssue } from "../../adapters/dispatch/linear-discovery.js";

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
  project: Project,
  snapshot: LinearIssueSnapshot,
): Result<WorkManagementIssueSnapshot, DomainError> {
  const template = parseReadyGateTemplate(snapshot.description);
  if (template.dependencies.kind === "unparsed") return err(domainError("conflict"));
  const issue = toDomainIssue(project, snapshot, {
    ...template,
    dependencies: template.dependencies,
  });
  if (!issue.ok) return issue;
  return ok(
    Object.freeze({
      issue: issue.value,
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
    return toWorkManagementSnapshot(reference.project, read.value);
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
      const snapshot = toWorkManagementSnapshot(query.project, read.value);
      if (!snapshot.ok) return snapshot;
      snapshots.push(snapshot.value);
    }
    return ok(Object.freeze(snapshots));
  }

  async setWorkStatus(
    reference: WorkManagementIssueRef,
    status: WorkStatus,
    options: WorkStatusMutationOptions,
  ): Promise<Result<WorkManagementIssueSnapshot, DomainError>> {
    if (
      status !== "completed" &&
      status !== "requires_manual" &&
      status !== "in_review" &&
      status !== "in_progress" &&
      status !== "ready"
    ) {
      return err(domainError("invariant_violation"));
    }
    const transitionCause =
      status === "in_review"
        ? (options.cause ?? "review_started")
        : status === "in_progress" || status === "ready"
          ? options.cause
          : undefined;
    if ((status === "in_progress" || status === "ready") && transitionCause === undefined) {
      return err(domainError("invariant_violation"));
    }
    if (
      (status === "completed" &&
        options.cause !== undefined &&
        options.cause !== "github_merge_observed") ||
      (status === "requires_manual" &&
        options.cause !== undefined &&
        options.cause !== "policy_requires_manual")
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
                { target: status, cause: transitionCause ?? "review_started" },
              );
    if (!result.ok) return result;
    return toWorkManagementSnapshot(reference.project, result.value);
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
    return toWorkManagementSnapshot(reference.project, result.value);
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
    return toWorkManagementSnapshot(reference.project, result.value);
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
