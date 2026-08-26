import { z } from "zod";

import { jobIdSchema, projectIdSchema } from "../../domain/jobs/index.js";
import {
  agentRoleSchema,
  issueSkillSelectionSchema,
  issueSkillSelectionsSchema,
  skillNameSchema,
  skillRequirementSchema,
} from "../../domain/project/index.js";

export const skillModeSchema = z.enum(["knowledge_only", "rubric_only"]);
export const skillPublicReasonSchema = z.enum(["missing", "not_allowed", "content_changed"]);
export const skillScanDecisionSchema = z.enum([
  "allow_knowledge_only",
  "allow_rubric_only",
  "blocked",
]);

export type SkillMode = z.infer<typeof skillModeSchema>;
export type SkillRequirement = z.infer<typeof skillRequirementSchema>;
export type SkillPublicReason = z.infer<typeof skillPublicReasonSchema>;

export const skillRelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .regex(/^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/).+$/u);

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const sourceCommitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const fileDigestsSchema = z.record(skillRelativePathSchema, digestSchema);

const skillCatalogEntryBaseSchema = z
  .object({
    name: skillNameSchema,
    displayName: z.string().trim().min(1).max(120),
    mode: skillModeSchema,
    source: z
      .object({
        repository: z.url().max(2_048),
        commit: sourceCommitSchema,
        path: skillRelativePathSchema,
        treeDigest: digestSchema,
      })
      .strict(),
    installedTreeDigest: digestSchema,
    fileDigests: fileDigestsSchema,
    allowedReferences: z.array(skillRelativePathSchema).max(200),
  })
  .strict();

function validateCatalogEntry(
  entry: z.infer<typeof skillCatalogEntryBaseSchema>,
  context: z.RefinementCtx,
): void {
  if (entry.fileDigests["SKILL.md"] === undefined) {
    context.addIssue({ code: "custom", path: ["fileDigests"], message: "SKILL.md is required." });
  }
  const seen = new Set<string>();
  for (const [index, path] of entry.allowedReferences.entries()) {
    if (
      !path.startsWith("references/") ||
      entry.fileDigests[path] === undefined ||
      seen.has(path)
    ) {
      context.addIssue({
        code: "custom",
        path: ["allowedReferences", index],
        message: "Reference must be unique, contained, and present in fileDigests.",
      });
    }
    seen.add(path);
  }
}

export const skillCatalogEntrySchema =
  skillCatalogEntryBaseSchema.superRefine(validateCatalogEntry);

export type SkillCatalogEntry = z.infer<typeof skillCatalogEntrySchema>;

export const skillCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    digestAlgorithm: z.literal("sha256-v1-posix-path-nul-size-nul-bytes"),
    skills: z.array(skillCatalogEntrySchema).max(200),
  })
  .strict()
  .superRefine((catalog, context) => {
    const seen = new Set<string>();
    for (const [index, skill] of catalog.skills.entries()) {
      if (seen.has(skill.name)) {
        context.addIssue({
          code: "custom",
          path: ["skills", index, "name"],
          message: "Skill names must be unique.",
        });
      }
      seen.add(skill.name);
    }
  });

export type SkillCatalog = z.infer<typeof skillCatalogSchema>;

const roleDefaultsSchema = z
  .object(
    Object.fromEntries(
      agentRoleSchema.options.map((role) => [role, z.array(skillNameSchema).max(50).optional()]),
    ) as Record<
      (typeof agentRoleSchema.options)[number],
      z.ZodOptional<z.ZodArray<typeof skillNameSchema>>
    >,
  )
  .strict();

export const projectSkillPolicySchema = z
  .object({
    catalogId: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
      .max(120)
      .optional(),
    catalogDigest: digestSchema.optional(),
    allowlist: z.array(skillNameSchema).max(200),
    roleDefaults: roleDefaultsSchema.optional(),
  })
  .strict()
  .superRefine((policy, context) => {
    if ((policy.catalogId === undefined) !== (policy.catalogDigest === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["catalogDigest"],
        message: "Catalog id and digest must be supplied together.",
      });
    }
    const allowed = new Set<string>();
    for (const [index, name] of policy.allowlist.entries()) {
      if (allowed.has(name)) {
        context.addIssue({
          code: "custom",
          path: ["allowlist", index],
          message: "Allowlist entries must be unique.",
        });
      }
      allowed.add(name);
    }
    for (const [role, names] of Object.entries(policy.roleDefaults ?? {})) {
      if (names === undefined) continue;
      if (new Set(names).size !== names.length) {
        context.addIssue({
          code: "custom",
          path: ["roleDefaults", role],
          message: "Role defaults must be unique.",
        });
      }
    }
  });

export type ProjectSkillPolicy = z.infer<typeof projectSkillPolicySchema>;

export const jobSkillSelectionSchema = issueSkillSelectionSchema;
export const jobSkillSelectionsSchema = issueSkillSelectionsSchema;
export type JobSkillSelection = z.infer<typeof jobSkillSelectionSchema>;

export const jobSkillSnapshotEntrySchema = skillCatalogEntryBaseSchema
  .pick({
    name: true,
    displayName: true,
    mode: true,
    source: true,
    installedTreeDigest: true,
    fileDigests: true,
    allowedReferences: true,
  })
  .extend({ requirement: skillRequirementSchema })
  .strict()
  .superRefine(validateCatalogEntry);

export const jobSkillSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobId: jobIdSchema,
    projectId: projectIdSchema,
    skills: z.array(jobSkillSnapshotEntrySchema).max(50),
    omitted: z
      .array(z.object({ name: skillNameSchema, reason: skillPublicReasonSchema }).strict())
      .max(50),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const seen = new Set<string>();
    for (const [index, skill] of snapshot.skills.entries()) {
      if (seen.has(skill.name)) {
        context.addIssue({
          code: "custom",
          path: ["skills", index, "name"],
          message: "Snapshot Skill names must be unique.",
        });
      }
      seen.add(skill.name);
    }
    for (const [index, omission] of snapshot.omitted.entries()) {
      if (seen.has(omission.name)) {
        context.addIssue({
          code: "custom",
          path: ["omitted", index, "name"],
          message: "Selected and omitted Skill names must be disjoint and unique.",
        });
      }
      seen.add(omission.name);
    }
  });

export type JobSkillSnapshot = z.infer<typeof jobSkillSnapshotSchema>;

export const jobSkillSnapshotsByRoleSchema = z
  .object(
    Object.fromEntries(
      agentRoleSchema.options.map((role) => [role, jobSkillSnapshotSchema.optional()]),
    ) as Record<
      (typeof agentRoleSchema.options)[number],
      z.ZodOptional<typeof jobSkillSnapshotSchema>
    >,
  )
  .strict();

export type JobSkillSnapshotsByRole = z.infer<typeof jobSkillSnapshotsByRoleSchema>;

export const firstGodotSkillAllowlist = Object.freeze([
  "godot-project-foundations",
  "godot-gdscript-mastery",
  "godot-testing-patterns",
  "godot-debugging-profiling",
  "godot-camera-systems",
  "godot-physics-3d",
  "godot-raycasting-queries",
  "godot-3d-world-building",
  "godot-agent-vision",
] as const);

export const tankSkirmishGodotSkillPolicy = Object.freeze(
  projectSkillPolicySchema.parse({
    catalogId: "gd-agentic-skills-6a36f189",
    catalogDigest: "a957ba2615456637c7886f186d437d2259dd7b6bac1b5cbc3bc5c3546d103ece",
    allowlist: firstGodotSkillAllowlist,
    roleDefaults: {
      team_lead: [],
      implementer: [
        "godot-project-foundations",
        "godot-gdscript-mastery",
        "godot-testing-patterns",
      ],
      code_reviewer: ["godot-testing-patterns", "godot-debugging-profiling"],
      visual_reviewer: ["godot-agent-vision"],
      integration_engineer: [
        "godot-project-foundations",
        "godot-testing-patterns",
        "godot-debugging-profiling",
      ],
    },
  }),
);
