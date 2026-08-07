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
  WorkManagementIssueRef,
  WorkManagementIssueSnapshot,
  WorkManagementPort,
} from "../../application/ports/index.js";
import {
  domainError,
  err,
  generateDeterministicIdentifier,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import { issueSchema } from "../../domain/project/index.js";
import type { AgentCondition, WorkStatus } from "../../domain/workflow/index.js";
import type { LinearIssueSnapshot } from "../../adapters/linear/model.js";
import type { LinearMutationClient } from "../../adapters/linear/write.js";
import type { LinearReadModel } from "../../adapters/linear/read.js";

/** Same narrowing convention as `LinearDiscoveryReadModel` (linear-discovery.ts): only the
 * methods this adapter actually calls, so callers/tests can fake a plain object instead of a
 * real `LinearMutationClient`/`LinearReadModel` instance. */
export type LinearWorkManagementMutationClient = Pick<
  LinearMutationClient,
  "observeGithubMerge" | "setAgentCondition" | "appendComment"
>;
export type LinearWorkManagementReadModel = Pick<LinearReadModel, "readContext" | "readIssue">;

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
  });
  if (!issue.success) return err(domainError("invariant_violation"));
  return ok(
    Object.freeze({
      issue: issue.data,
      workStatus: snapshot.workStatus,
      ...(snapshot.agentCondition === undefined ? {} : { agentCondition: snapshot.agentCondition }),
      updatedAt: snapshot.updatedAt,
      revision: snapshot.updatedAt,
    }),
  );
}

export class LinearWorkManagementAdapter implements Pick<
  WorkManagementPort,
  "getIssue" | "setWorkStatus" | "setAgentCondition" | "appendComment"
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

  async #context(options: ReadOptions = {}) {
    return this.#readModel.readContext(this.#teamId, this.#linearProjectId, options);
  }

  async getIssue(
    reference: WorkManagementIssueRef,
    options: ReadOptions = {},
  ): Promise<Result<WorkManagementIssueSnapshot, DomainError>> {
    const context = await this.#context(options);
    if (!context.ok) return context;
    const read = await this.#readModel.readIssue(context.value, reference.externalIssueId);
    if (!read.ok) return read;
    return toWorkManagementSnapshot(reference.project.id, read.value);
  }

  async setWorkStatus(
    reference: WorkManagementIssueRef,
    status: WorkStatus,
    _options: MutationOptions,
  ): Promise<Result<WorkManagementIssueSnapshot, DomainError>> {
    void _options;
    if (status !== "completed") return err(domainError("invariant_violation"));
    const context = await this.#context();
    if (!context.ok) return context;
    const result = await this.#mutationClient.observeGithubMerge(
      context.value,
      reference.externalIssueId,
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
