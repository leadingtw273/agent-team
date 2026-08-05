import { z } from "zod";

import type { ReadOptions } from "../../application/ports/common.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import {
  buildLinearReadCatalog,
  createLinearIssueSnapshot,
  type LinearCommentRecord,
  type LinearIssueRecord,
  type LinearIssueSnapshot,
  type LinearLabelRecord,
  type LinearNamedRecord,
  type LinearProjectContext,
  type LinearRelationRecord,
  type LinearTeamRecord,
  type LinearWorkflowStateRecord,
} from "./model.js";
import { LinearGraphqlTransport } from "./transport.js";

const idSchema = z.string().trim().min(1).max(255);
const nameSchema = z.string().trim().min(1).max(255);
const pageInfoSchema = z
  .object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() })
  .strict();
const connectionSchema = <Schema extends z.ZodType>(node: Schema) =>
  z.object({ nodes: z.array(node), pageInfo: pageInfoSchema }).strict();
const namedSchema = z.object({ id: idSchema, name: nameSchema }).strict();
const teamSchema = namedSchema.extend({ key: z.string().trim().min(1).max(64) }).strict();
const stateSchema = namedSchema.extend({ type: z.string().trim().min(1).max(64) }).strict();
const labelSchema = namedSchema
  .extend({
    isGroup: z.boolean(),
    parent: z.object({ id: idSchema }).strict().nullable(),
  })
  .strict();

const identitySchema = z
  .object({ team: teamSchema.nullable(), project: namedSchema.nullable() })
  .strict();
const statesPageSchema = z
  .object({
    team: z
      .object({ states: connectionSchema(stateSchema) })
      .strict()
      .nullable(),
  })
  .strict();
const projectTeamsPageSchema = z
  .object({
    project: z
      .object({ teams: connectionSchema(z.object({ id: idSchema }).strict()) })
      .strict()
      .nullable(),
  })
  .strict();
const labelsPageSchema = z.object({ issueLabels: connectionSchema(labelSchema) }).strict();
const issueBaseSchema = z
  .object({
    issue: z
      .object({
        id: idSchema,
        identifier: z.string().trim().min(1).max(255),
        title: z.string().trim().min(1).max(255),
        description: z.string().nullable(),
        priority: z.number().int(),
        updatedAt: z.string(),
        team: z.object({ id: idSchema }).strict(),
        project: z.object({ id: idSchema }).strict().nullable(),
        state: z.object({ id: idSchema }).strict(),
      })
      .strict()
      .nullable(),
  })
  .strict();
const issueLabelsPageSchema = z
  .object({
    issue: z
      .object({ labels: connectionSchema(z.object({ id: idSchema }).strict()) })
      .strict()
      .nullable(),
  })
  .strict();
const relationNodeSchema = z
  .object({
    id: idSchema,
    type: z.string().trim().min(1).max(64),
    relatedIssue: z
      .object({ id: idSchema, identifier: z.string().trim().min(1).max(255) })
      .strict(),
  })
  .strict();
const relationsPageSchema = z
  .object({
    issue: z
      .object({ relations: connectionSchema(relationNodeSchema) })
      .strict()
      .nullable(),
  })
  .strict();
const inverseRelationsPageSchema = z
  .object({
    issue: z
      .object({ inverseRelations: connectionSchema(relationNodeSchema) })
      .strict()
      .nullable(),
  })
  .strict();
const commentNodeSchema = z
  .object({ id: idSchema, body: z.string().max(100_000), createdAt: z.string() })
  .strict();
const commentsPageSchema = z
  .object({
    issue: z
      .object({ comments: connectionSchema(commentNodeSchema) })
      .strict()
      .nullable(),
  })
  .strict();

const identityQuery = `
  query AgentTeamReadIdentity($teamId: String!, $projectId: String!) {
    team(id: $teamId) { id name key }
    project(id: $projectId) { id name }
  }
`;
const statesQuery = `
  query AgentTeamReadStates($teamId: String!, $after: String) {
    team(id: $teamId) {
      states(first: 50, after: $after) {
        nodes { id name type }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;
const projectTeamsQuery = `
  query AgentTeamReadProjectTeams($projectId: String!, $after: String) {
    project(id: $projectId) {
      teams(first: 50, after: $after) {
        nodes { id }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;
const labelsQuery = `
  query AgentTeamReadLabels($teamId: ID!, $after: String) {
    issueLabels(first: 50, after: $after, filter: { team: { id: { eq: $teamId } } }) {
      nodes { id name isGroup parent { id } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
const issueBaseQuery = `
  query AgentTeamReadIssue($issueId: String!) {
    issue(id: $issueId) {
      id identifier title description priority updatedAt
      team { id }
      project { id }
      state { id }
    }
  }
`;
const issueLabelsQuery = `
  query AgentTeamReadIssueLabels($issueId: String!, $after: String) {
    issue(id: $issueId) {
      labels(first: 50, after: $after) {
        nodes { id }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;
const issueRelationsQuery = `
  query AgentTeamReadIssueRelations($issueId: String!, $after: String) {
    issue(id: $issueId) {
      relations(first: 50, after: $after) {
        nodes { id type relatedIssue { id identifier } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;
const issueInverseRelationsQuery = `
  query AgentTeamReadIssueInverseRelations($issueId: String!, $after: String) {
    issue(id: $issueId) {
      inverseRelations(first: 50, after: $after) {
        nodes { id type relatedIssue { id identifier } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;
const issueCommentsQuery = `
  query AgentTeamReadIssueComments($issueId: String!, $after: String) {
    issue(id: $issueId) {
      comments(first: 50, after: $after) {
        nodes { id body createdAt }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

function failure<Value>(
  code: "external_failure" | "not_found" = "external_failure",
): Result<Value, DomainError> {
  return err(domainError(code));
}

function parse<Value>(schema: z.ZodType<Value>, value: unknown): Result<Value, DomainError> {
  const parsed = schema.safeParse(value);
  return parsed.success ? ok(parsed.data) : failure();
}

export class LinearReadModel {
  constructor(readonly transport: LinearGraphqlTransport) {}

  async readContext(
    teamId: string,
    projectId: string,
    options: ReadOptions = {},
  ): Promise<Result<LinearProjectContext, DomainError>> {
    const identityResult = await this.transport.request<
      unknown,
      { teamId: string; projectId: string }
    >(
      {
        operationName: "AgentTeamReadIdentity",
        query: identityQuery,
        variables: { teamId, projectId },
      },
      options,
    );
    if (!identityResult.ok) return identityResult;
    const identity = parse(identitySchema, identityResult.value);
    if (!identity.ok) return identity;
    if (identity.value.team === null || identity.value.project === null)
      return failure("not_found");
    if (identity.value.team.id !== teamId || identity.value.project.id !== projectId)
      return failure();

    const projectTeams = await this.transport.paginate<unknown, { readonly id: string }>(
      {
        operationName: "AgentTeamReadProjectTeams",
        query: projectTeamsQuery,
        variables: { projectId },
        selectConnection: (data) => {
          const page = projectTeamsPageSchema.parse(data);
          if (page.project === null) throw new Error("linear_project_not_found");
          return page.project.teams;
        },
      },
      options,
    );
    if (!projectTeams.ok) return projectTeams;
    if (!projectTeams.value.some((team) => team.id === teamId)) return failure();

    const statesResult = await this.transport.paginate<unknown, z.infer<typeof stateSchema>>(
      {
        operationName: "AgentTeamReadStates",
        query: statesQuery,
        variables: { teamId },
        selectConnection: (data) => {
          const page = statesPageSchema.parse(data);
          if (page.team === null) throw new Error("linear_team_not_found");
          return connectionSchema(stateSchema).parse(page.team.states);
        },
      },
      options,
    );
    if (!statesResult.ok) return statesResult;
    const labelsResult = await this.transport.paginate<unknown, z.infer<typeof labelSchema>>(
      {
        operationName: "AgentTeamReadLabels",
        query: labelsQuery,
        variables: { teamId },
        selectConnection: (data) =>
          connectionSchema(labelSchema).parse(labelsPageSchema.parse(data).issueLabels),
      },
      options,
    );
    if (!labelsResult.ok) return labelsResult;

    const states: LinearWorkflowStateRecord[] = statesResult.value.map((state) => ({ ...state }));
    const labels: LinearLabelRecord[] = labelsResult.value.map((label) => ({
      id: label.id,
      name: label.name,
      isGroup: label.isGroup,
      parentId: label.parent?.id ?? null,
    }));
    const catalog = buildLinearReadCatalog(states, labels);
    if (!catalog.ok) return catalog;
    const team: LinearTeamRecord = Object.freeze({ ...identity.value.team });
    const project: LinearNamedRecord = Object.freeze({ ...identity.value.project });
    return ok(Object.freeze({ team, project, catalog: catalog.value }));
  }

  async readIssue(
    context: LinearProjectContext,
    issueId: string,
  ): Promise<Result<LinearIssueSnapshot, DomainError>> {
    const baseResult = await this.transport.request<unknown, { issueId: string }>({
      operationName: "AgentTeamReadIssue",
      query: issueBaseQuery,
      variables: { issueId },
    });
    if (!baseResult.ok) return baseResult;
    const base = parse(issueBaseSchema, baseResult.value);
    if (!base.ok) return base;
    if (base.value.issue === null) return failure("not_found");

    const labels = await this.transport.paginate<unknown, { readonly id: string }>({
      operationName: "AgentTeamReadIssueLabels",
      query: issueLabelsQuery,
      variables: { issueId },
      selectConnection: (data) => {
        const page = issueLabelsPageSchema.parse(data);
        if (page.issue === null) throw new Error("linear_issue_not_found");
        return page.issue.labels;
      },
    });
    if (!labels.ok) return labels;
    const outbound = await this.readRelations(issueId, "outbound");
    if (!outbound.ok) return outbound;
    const inbound = await this.readRelations(issueId, "inbound");
    if (!inbound.ok) return inbound;
    const comments = await this.transport.paginate<unknown, z.infer<typeof commentNodeSchema>>({
      operationName: "AgentTeamReadIssueComments",
      query: issueCommentsQuery,
      variables: { issueId },
      selectConnection: (data) => {
        const page = commentsPageSchema.parse(data);
        if (page.issue === null) throw new Error("linear_issue_not_found");
        return page.issue.comments;
      },
    });
    if (!comments.ok) return comments;

    const raw = base.value.issue;
    const issue: LinearIssueRecord = {
      id: raw.id,
      identifier: raw.identifier,
      title: raw.title,
      description: raw.description,
      priority: raw.priority,
      updatedAt: raw.updatedAt,
      teamId: raw.team.id,
      projectId: raw.project?.id ?? null,
      stateId: raw.state.id,
      labelIds: labels.value.map((label) => label.id),
    };
    const commentRecords: LinearCommentRecord[] = comments.value.map((comment) => ({ ...comment }));
    return createLinearIssueSnapshot(
      context,
      issue,
      [...outbound.value, ...inbound.value],
      commentRecords,
    );
  }

  private async readRelations(
    issueId: string,
    direction: "outbound" | "inbound",
  ): Promise<Result<readonly LinearRelationRecord[], DomainError>> {
    const result = await this.transport.paginate<unknown, z.infer<typeof relationNodeSchema>>({
      operationName:
        direction === "outbound"
          ? "AgentTeamReadIssueRelations"
          : "AgentTeamReadIssueInverseRelations",
      query: direction === "outbound" ? issueRelationsQuery : issueInverseRelationsQuery,
      variables: { issueId },
      selectConnection: (data) => {
        if (direction === "outbound") {
          const page = relationsPageSchema.parse(data);
          if (page.issue === null) throw new Error("linear_issue_not_found");
          return page.issue.relations;
        }
        const page = inverseRelationsPageSchema.parse(data);
        if (page.issue === null) throw new Error("linear_issue_not_found");
        return page.issue.inverseRelations;
      },
    });
    if (!result.ok) return result;
    return ok(
      Object.freeze(
        result.value.map((relation) =>
          Object.freeze({
            id: relation.id,
            type: relation.type,
            relatedIssueId: relation.relatedIssue.id,
            relatedIssueIdentifier: relation.relatedIssue.identifier,
            direction,
          }),
        ),
      ),
    );
  }
}
