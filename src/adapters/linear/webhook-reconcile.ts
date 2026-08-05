import { z } from "zod";

import type { ReadOptions } from "../../application/ports/common.js";
import type {
  WebhookReadBackChange,
  WebhookReadBackPort,
  WebhookReadBackRequest,
} from "../../application/reconcile/webhook-model.js";
import {
  normalizeLinearIssueRevision,
  type LinearIssueRevision as NormalizedLinearIssueRevision,
} from "../../application/reconcile/provider-revision.js";
import {
  domainError,
  err,
  ok,
  parseInstant,
  type DomainError,
  type Instant,
  type Result,
} from "../../domain/foundation/index.js";
import { projectSchema } from "../../domain/project/index.js";
import { LinearGraphqlTransport } from "./transport.js";

const linearIdSchema = z.string().trim().min(1).max(255);
const pageInfoSchema = z
  .object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() })
  .strict();
const issueRevisionSchema = z
  .object({
    id: linearIdSchema,
    identifier: z.string().trim().min(1).max(255),
    title: z.string().trim().min(1).max(255),
    description: z.string().max(100_000).nullable(),
    priority: z.number().int(),
    updatedAt: z.string().trim().min(1).max(128),
    team: z.object({ id: linearIdSchema }).strict(),
    project: z.object({ id: linearIdSchema }).strict().nullable(),
    state: z.object({ id: linearIdSchema }).strict(),
  })
  .strict();
const issueConnectionSchema = z
  .object({ nodes: z.array(issueRevisionSchema), pageInfo: pageInfoSchema })
  .strict();
const issuesPageSchema = z.object({ issues: issueConnectionSchema }).strict();

type LinearIssueRevision = z.infer<typeof issueRevisionSchema>;

const issueRevisionsQuery = `
  query AgentTeamReadWebhookReconcileIssues(
    $projectId: String!
    $fromInclusive: DateTime!
    $throughInclusive: DateTime!
    $after: String
  ) {
    issues(
      first: 50
      after: $after
      filter: {
        project: { id: { eq: $projectId } }
        updatedAt: { gte: $fromInclusive, lte: $throughInclusive }
      }
    ) {
      nodes {
        id
        identifier
        title
        description
        priority
        updatedAt
        team { id }
        project { id }
        state { id }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

function failure<Value>(
  code: DomainError["code"] = "external_failure",
): Result<Value, DomainError> {
  return err(domainError(code));
}

function validRequest(request: WebhookReadBackRequest): boolean {
  if (
    request.provider !== "linear" ||
    !projectSchema.safeParse(request.project).success ||
    request.project.workManagement.provider !== "linear"
  ) {
    return false;
  }
  const from = parseInstant(request.fromInclusive);
  const through = parseInstant(request.throughInclusive);
  return from.ok && through.ok && from.value <= through.value;
}

function withinInclusiveWindow(
  occurredAt: Instant,
  fromInclusive: Instant,
  throughInclusive: Instant,
): boolean {
  return occurredAt >= fromInclusive && occurredAt <= throughInclusive;
}

function interrupted(options: ReadOptions): boolean {
  return options.signal?.aborted ?? false;
}

function changeFromIssue(issue: NormalizedLinearIssueRevision): WebhookReadBackChange {
  return Object.freeze({
    providerEventId: issue.providerEventId,
    eventType: "Issue",
    occurredAt: issue.updatedAt,
    streamKey: issue.id,
    payload: Object.freeze({
      providerEventId: issue.providerEventId,
      issue: Object.freeze({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        priority: issue.priority,
        updatedAt: issue.updatedAt,
        teamId: issue.teamId,
        projectId: issue.projectId,
        stateId: issue.stateId,
      }),
    }),
  });
}

/**
 * Reads Linear Issue revisions as a recovery path for missed webhooks. It is
 * deliberately read-only; normal webhook ingest remains the primary source.
 */
export class LinearWebhookReconcileAdapter implements WebhookReadBackPort {
  constructor(readonly transport: LinearGraphqlTransport) {}

  async readChanges(
    request: WebhookReadBackRequest,
    options: ReadOptions = {},
  ): Promise<Result<readonly WebhookReadBackChange[], DomainError>> {
    if (interrupted(options)) return failure("interrupted");
    if (!validRequest(request)) return failure("invariant_violation");

    const revisions = await this.transport.paginate<unknown, LinearIssueRevision>(
      {
        operationName: "AgentTeamReadWebhookReconcileIssues",
        query: issueRevisionsQuery,
        variables: {
          projectId: request.project.workManagement.projectId,
          fromInclusive: request.fromInclusive,
          throughInclusive: request.throughInclusive,
        },
        selectConnection: (data) => issuesPageSchema.parse(data).issues,
      },
      options,
    );
    if (!revisions.ok) return revisions;
    if (interrupted(options)) return failure("interrupted");

    const changes: WebhookReadBackChange[] = [];
    const identities = new Set<string>();
    for (const issue of revisions.value) {
      if (interrupted(options)) return failure("interrupted");
      const issueProjectId = issue.project?.id;
      if (issueProjectId !== request.project.workManagement.projectId) {
        return failure();
      }
      const normalized = normalizeLinearIssueRevision({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        priority: issue.priority,
        updatedAt: issue.updatedAt,
        teamId: issue.team.id,
        projectId: issueProjectId,
        stateId: issue.state.id,
      });
      if (!normalized.ok) return failure();
      if (
        !withinInclusiveWindow(
          normalized.value.updatedAt,
          request.fromInclusive,
          request.throughInclusive,
        )
      ) {
        return failure();
      }
      const change = changeFromIssue(normalized.value);
      if (identities.has(change.providerEventId)) return failure();
      identities.add(change.providerEventId);
      changes.push(change);
    }

    return ok(
      Object.freeze(
        changes.sort(
          (left, right) =>
            left.occurredAt.localeCompare(right.occurredAt) ||
            left.providerEventId.localeCompare(right.providerEventId),
        ),
      ),
    );
  }
}
