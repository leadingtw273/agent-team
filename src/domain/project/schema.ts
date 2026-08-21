import { z } from "zod";

import type { Identifier } from "../foundation/index.js";

const identifierBodyPattern =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

function scopedIdentifierSchema<Scope extends string>(scope: Scope): z.ZodType<Identifier<Scope>> {
  return z
    .string()
    .regex(new RegExp(`^${scope}_${identifierBodyPattern}$`, "u")) as unknown as z.ZodType<
    Identifier<Scope>
  >;
}

const nonEmptyTextSchema = z.string().trim().min(1).max(10_000);
const externalIdSchema = z.string().trim().min(1).max(255);
const platformKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,63}$/u)
  .max(64);

export const agentRoleSchema = z.enum([
  "team_lead",
  "implementer",
  "code_reviewer",
  "visual_reviewer",
  "integration_engineer",
]);

export type AgentRole = z.infer<typeof agentRoleSchema>;

export const reviewRequirementSchema = z.enum(["code_review", "visual_review", "dual_review"]);

export type ReviewRequirement = z.infer<typeof reviewRequirementSchema>;

export const humanAcceptanceRequirementSchema = z.enum(["required", "not_required"]);
export type HumanAcceptanceRequirement = z.infer<typeof humanAcceptanceRequirementSchema>;

export const verificationLevelSchema = z.enum(["light", "standard", "strict"]);
export type VerificationLevel = z.infer<typeof verificationLevelSchema>;

export const humanSummarySchema = z
  .object({
    objective: nonEmptyTextSchema,
    outcome: nonEmptyTextSchema,
    acceptance: nonEmptyTextSchema,
  })
  .strict();
export type HumanSummary = z.infer<typeof humanSummarySchema>;

export const prioritySchema = z.enum(["urgent", "high", "medium", "low"]);
export type Priority = z.infer<typeof prioritySchema>;

export const repositoryRelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/).+$/u);

export const changeRegionSchema = z
  .object({
    path: repositoryRelativePathSchema,
    coverage: z.enum(["exact", "subtree"]),
  })
  .strict();

export type ChangeRegion = z.infer<typeof changeRegionSchema>;

export const projectIdSchema = scopedIdentifierSchema("project");
export const issueIdSchema = scopedIdentifierSchema("issue");

export const projectSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: projectIdSchema,
    displayName: z.string().trim().min(1).max(120),
    localRepositoryPath: z.string().trim().startsWith("/").min(2).max(1024),
    defaultBranch: z.string().trim().min(1).max(255),
    workManagement: z
      .object({
        provider: platformKeySchema,
        containerId: externalIdSchema,
        projectId: externalIdSchema,
      })
      .strict(),
    sourceControl: z
      .object({
        provider: platformKeySchema,
        repository: z
          .string()
          .trim()
          .regex(/^[^/\s]+(?:\/[^/\s]+)+$/u)
          .max(255),
      })
      .strict(),
  })
  .strict();

export type Project = z.infer<typeof projectSchema>;

export const dependencyDeclarationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("issues"),
      issueIds: z.array(issueIdSchema).min(1).max(100),
    })
    .strict(),
]);

export type DependencyDeclaration = z.infer<typeof dependencyDeclarationSchema>;

export const issueSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: issueIdSchema,
    projectId: projectIdSchema,
    externalId: externalIdSchema,
    title: z.string().trim().min(1).max(255),
    goal: nonEmptyTextSchema.optional(),
    background: nonEmptyTextSchema.optional(),
    acceptanceCriteria: z.array(nonEmptyTextSchema).min(1).max(100).optional(),
    inScope: z.array(nonEmptyTextSchema).min(1).max(100).optional(),
    outOfScope: z.array(nonEmptyTextSchema).min(1).max(100).optional(),
    dependencies: dependencyDeclarationSchema.optional(),
    priority: prioritySchema.optional(),
    agentRole: agentRoleSchema.optional(),
    reviewRequirement: reviewRequirementSchema.optional(),
    humanSummary: humanSummarySchema.optional(),
    humanAcceptanceRequirement: humanAcceptanceRequirementSchema.optional(),
    verificationLevel: verificationLevelSchema.optional(),
    estimatedMinutes: z
      .number()
      .int()
      .positive()
      .max(24 * 60)
      .optional(),
    constraints: z.array(nonEmptyTextSchema).max(100).optional(),
    risks: z.array(nonEmptyTextSchema).max(100).optional(),
    changeRegions: z.array(changeRegionSchema).min(1).max(100).optional(),
  })
  .strict()
  .superRefine((issue, context) => {
    if (issue.dependencies?.kind !== "issues") return;
    if (!issue.dependencies.issueIds.includes(issue.id)) return;

    context.addIssue({
      code: "custom",
      message: "An issue cannot depend on itself.",
      path: ["dependencies", "issueIds"],
    });
  });

export type Issue = z.infer<typeof issueSchema>;

export const projectJsonSchema = z.toJSONSchema(projectSchema, {
  target: "draft-2020-12",
});

export const issueJsonSchema = z.toJSONSchema(issueSchema, {
  target: "draft-2020-12",
});
