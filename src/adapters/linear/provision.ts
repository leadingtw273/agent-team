import { z } from "zod";

import type { ReadOptions } from "../../application/ports/common.js";
import type {
  LinearProvisionCreateReceipt,
  LinearProvisionDesiredObject,
  LinearProvisionInventory,
  LinearProvisionPort,
  LinearProvisionRemoteObject,
  LinearProvisionTarget,
} from "../../application/registration/index.js";
import { linearProvisionDigest } from "../../application/registration/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import { LinearGraphqlTransport } from "./transport.js";

const idSchema = z.string().trim().min(1).max(255);
const nameSchema = z.string().trim().min(1).max(255);
const pageInfoSchema = z
  .object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() })
  .strict();
const identitySchema = z
  .object({
    team: z.object({ id: idSchema }).strict().nullable(),
    project: z
      .object({
        id: idSchema,
        teams: z
          .object({ nodes: z.array(z.object({ id: idSchema }).strict()), pageInfo: pageInfoSchema })
          .strict(),
      })
      .strict()
      .nullable(),
  })
  .strict();
const stateSchema = z.object({ id: idSchema, name: nameSchema, type: nameSchema }).strict();
const statesPageSchema = z
  .object({
    team: z
      .object({
        states: z.object({ nodes: z.array(stateSchema), pageInfo: pageInfoSchema }).strict(),
      })
      .strict()
      .nullable(),
  })
  .strict();
const labelSchema = z
  .object({
    id: idSchema,
    name: nameSchema,
    description: z.string().nullable(),
    color: z.string().trim().min(1).max(64),
    isGroup: z.boolean(),
    parent: z.object({ id: idSchema }).strict().nullable(),
    team: z.object({ id: idSchema }).strict().nullable(),
  })
  .strict();
const labelsPageSchema = z
  .object({
    issueLabels: z.object({ nodes: z.array(labelSchema), pageInfo: pageInfoSchema }).strict(),
  })
  .strict();
const templateSchema = z
  .object({
    id: idSchema,
    name: nameSchema,
    description: z.string().nullable(),
    type: nameSchema,
    templateData: z.record(z.string(), z.unknown()),
    team: z.object({ id: idSchema }).strict().nullable(),
  })
  .strict();
const templatesSchema = z.object({ templates: z.array(templateSchema) }).strict();
const createLabelSchema = z
  .object({
    issueLabelCreate: z
      .object({
        success: z.boolean(),
        issueLabel: z.object({ id: idSchema }).strict().nullable(),
      })
      .strict(),
  })
  .strict();
const createTemplateSchema = z
  .object({
    templateCreate: z
      .object({
        success: z.boolean(),
        template: z.object({ id: idSchema }).strict().nullable(),
      })
      .strict(),
  })
  .strict();

const identityQuery = `
  query AgentTeamProvisionIdentity($teamId: String!, $projectId: String!) {
    team(id: $teamId) { id }
    project(id: $projectId) {
      id
      teams(first: 50) { nodes { id } pageInfo { hasNextPage endCursor } }
    }
  }
`;
const statesQuery = `
  query AgentTeamProvisionStates($teamId: String!, $after: String) {
    team(id: $teamId) {
      states(first: 50, after: $after) {
        nodes { id name type }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;
const labelsQuery = `
  query AgentTeamProvisionLabels($teamId: ID!, $after: String) {
    issueLabels(first: 50, after: $after, filter: { team: { id: { eq: $teamId } } }) {
      nodes { id name description color isGroup parent { id } team { id } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
const templatesQuery = `
  query AgentTeamProvisionTemplates {
    templates { id name description type templateData team { id } }
  }
`;
const createLabelMutation = `
  mutation AgentTeamProvisionCreateLabel($input: IssueLabelCreateInput!) {
    issueLabelCreate(input: $input) { success issueLabel { id } }
  }
`;
const createTemplateMutation = `
  mutation AgentTeamProvisionCreateTemplate($input: TemplateCreateInput!) {
    templateCreate(input: $input) { success template { id } }
  }
`;

function failure<Value>(code: DomainError["code"] = "external_failure") {
  return err(domainError(code)) as Result<Value, DomainError>;
}

function payloadString(desired: LinearProvisionDesiredObject, key: string): string | undefined {
  const value = desired.payload[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Production GraphQL port for O003. It deliberately exposes no delete/update/rename operation.
 * Workflow-state creation stays manual because S004 did not prove that mutation capability.
 */
export class LinearProvisionGraphqlAdapter implements LinearProvisionPort {
  constructor(readonly transport: LinearGraphqlTransport) {}

  async readInventory(
    target: LinearProvisionTarget,
    options: ReadOptions = {},
  ): Promise<Result<LinearProvisionInventory, DomainError>> {
    const identityResult = await this.transport.request<
      unknown,
      { teamId: string; projectId: string }
    >(
      {
        operationName: "AgentTeamProvisionIdentity",
        query: identityQuery,
        variables: target,
      },
      options,
    );
    if (!identityResult.ok) return identityResult;
    const identity = identitySchema.safeParse(identityResult.value);
    if (
      !identity.success ||
      identity.data.team?.id !== target.teamId ||
      identity.data.project?.id !== target.projectId ||
      identity.data.project.teams.pageInfo.hasNextPage ||
      !identity.data.project.teams.nodes.some((team) => team.id === target.teamId)
    ) {
      return failure();
    }

    const states = await this.transport.paginate<unknown, z.infer<typeof stateSchema>>(
      {
        operationName: "AgentTeamProvisionStates",
        query: statesQuery,
        variables: { teamId: target.teamId },
        selectConnection: (data) => {
          const page = statesPageSchema.parse(data);
          if (page.team === null) throw new Error("linear_team_not_found");
          return page.team.states;
        },
      },
      options,
    );
    if (!states.ok) return states;
    const labels = await this.transport.paginate<unknown, z.infer<typeof labelSchema>>(
      {
        operationName: "AgentTeamProvisionLabels",
        query: labelsQuery,
        variables: { teamId: target.teamId },
        selectConnection: (data) => labelsPageSchema.parse(data).issueLabels,
      },
      options,
    );
    if (!labels.ok) return labels;
    const templatesResult = await this.transport.request<unknown, Record<string, never>>(
      {
        operationName: "AgentTeamProvisionTemplates",
        query: templatesQuery,
        variables: {},
      },
      options,
    );
    if (!templatesResult.ok) return templatesResult;
    const templates = templatesSchema.safeParse(templatesResult.value);
    if (!templates.success) return failure();

    const objects: LinearProvisionRemoteObject[] = [
      ...states.value.map((state) =>
        Object.freeze({
          id: state.id,
          kind: "workflow_state" as const,
          name: state.name,
          teamId: target.teamId,
          fingerprint: linearProvisionDigest({ type: state.type }),
        }),
      ),
      ...labels.value
        .filter((label) => label.team?.id === target.teamId)
        .map((label) =>
          Object.freeze({
            id: label.id,
            kind: label.isGroup ? ("label_group" as const) : ("label" as const),
            name: label.name,
            teamId: target.teamId,
            ...(label.parent === null ? {} : { parentId: label.parent.id }),
            fingerprint: linearProvisionDigest({
              color: label.color,
              description: label.description ?? "",
              isGroup: label.isGroup,
            }),
          }),
        ),
      ...templates.data.templates
        .filter((template) => template.team?.id === target.teamId)
        .map((template) =>
          Object.freeze({
            id: template.id,
            kind: "form_template" as const,
            name: template.name,
            teamId: target.teamId,
            fingerprint: linearProvisionDigest({
              type: template.type,
              description: template.description ?? "",
              templateData: template.templateData,
            }),
          }),
        ),
    ];
    if (new Set(objects.map((object) => object.id)).size !== objects.length) return failure();
    return ok(
      Object.freeze({
        target: Object.freeze({ ...target }),
        objects: Object.freeze(objects),
        capabilities: Object.freeze({
          workflow_state: "manual" as const,
          label_group: "automatic" as const,
          label: "automatic" as const,
          form_template: "automatic" as const,
        }),
      }),
    );
  }

  async create(
    target: LinearProvisionTarget,
    desired: LinearProvisionDesiredObject,
    parentId: string | undefined,
    options: ReadOptions = {},
  ): Promise<Result<LinearProvisionCreateReceipt, DomainError>> {
    if (desired.kind === "workflow_state") return failure("unavailable");
    if (desired.kind === "label" || desired.kind === "label_group") {
      if (
        (desired.kind === "label" && parentId === undefined) ||
        (desired.kind === "label_group" && parentId !== undefined)
      ) {
        return failure("invariant_violation");
      }
      const color = payloadString(desired, "color");
      const description = payloadString(desired, "description");
      if (color === undefined || description === undefined) return failure();
      const result = await this.transport.request<
        unknown,
        { input: Readonly<Record<string, unknown>> }
      >(
        {
          operationName: "AgentTeamProvisionCreateLabel",
          query: createLabelMutation,
          variables: {
            input: {
              teamId: target.teamId,
              name: desired.name,
              description,
              color,
              ...(desired.kind === "label_group"
                ? { isGroup: true }
                : { parentId, isGroup: false }),
            },
          },
        },
        options,
      );
      if (!result.ok) return result;
      const parsed = createLabelSchema.safeParse(result.value);
      return parsed.success && parsed.data.issueLabelCreate.success
        ? parsed.data.issueLabelCreate.issueLabel === null
          ? failure()
          : ok(Object.freeze({ id: parsed.data.issueLabelCreate.issueLabel.id }))
        : failure();
    }

    const description = payloadString(desired, "description");
    const type = payloadString(desired, "type");
    const templateData = desired.payload["templateData"];
    if (
      description === undefined ||
      type !== "issue" ||
      typeof templateData !== "object" ||
      templateData === null ||
      Array.isArray(templateData)
    ) {
      return failure();
    }
    const result = await this.transport.request<
      unknown,
      { input: Readonly<Record<string, unknown>> }
    >(
      {
        operationName: "AgentTeamProvisionCreateTemplate",
        query: createTemplateMutation,
        variables: {
          input: {
            teamId: target.teamId,
            name: desired.name,
            description,
            type,
            templateData,
          },
        },
      },
      options,
    );
    if (!result.ok) return result;
    const parsed = createTemplateSchema.safeParse(result.value);
    return parsed.success && parsed.data.templateCreate.success
      ? parsed.data.templateCreate.template === null
        ? failure()
        : ok(Object.freeze({ id: parsed.data.templateCreate.template.id }))
      : failure();
  }
}
