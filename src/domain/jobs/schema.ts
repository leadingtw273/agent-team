import { z } from "zod";

import {
  canonicalInstantPattern,
  parseInstant,
  scopedIdentifierPattern,
  type Identifier,
  type Instant,
} from "../foundation/index.js";

function scopedIdentifierSchema<Scope extends string>(scope: Scope): z.ZodType<Identifier<Scope>> {
  return z.string().regex(scopedIdentifierPattern(scope)) as unknown as z.ZodType<
    Identifier<Scope>
  >;
}

const instantSchema = z
  .string()
  .regex(canonicalInstantPattern)
  .refine(
    (value) => parseInstant(value).ok,
    "Timestamp must be a canonical ISO instant.",
  ) as unknown as z.ZodType<Instant>;

const holderIdSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^(?:\S|\S[\s\S]*\S)$/u);

export const jobIdSchema = scopedIdentifierSchema("job");
export const leaseIdSchema = scopedIdentifierSchema("lease");
export const projectIdSchema = scopedIdentifierSchema("project");
export const issueIdSchema = scopedIdentifierSchema("issue");

export const jobAttemptCountersSchema = z
  .object({
    processRecoveries: z.number().int().min(0).max(1),
    ciFixRounds: z.number().int().min(0).max(2),
    reviewerFixRounds: z.number().int().min(0).max(2),
    reviewRuns: z.number().int().min(0).max(3),
  })
  .strict();

export type JobAttemptCounters = z.infer<typeof jobAttemptCountersSchema>;

export const jobSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: jobIdSchema,
    projectId: projectIdSchema,
    issueId: issueIdSchema,
    createdAt: instantSchema,
    startedAt: instantSchema.optional(),
    watchdogExtensionGranted: z.boolean(),
    attempts: jobAttemptCountersSchema,
  })
  .strict()
  .superRefine((job, context) => {
    if (job.startedAt !== undefined && job.startedAt < job.createdAt) {
      context.addIssue({
        code: "custom",
        message: "Job start cannot precede creation.",
        path: ["startedAt"],
      });
    }
  })
  .describe("Job structure. Cross-field chronology is enforced by the Domain runtime.");

export type Job = z.infer<typeof jobSchema>;

export const leaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: leaseIdSchema,
    jobId: jobIdSchema,
    issueId: issueIdSchema,
    holderId: holderIdSchema,
    acquiredAt: instantSchema,
    expiresAt: instantSchema,
    releasedAt: instantSchema.optional(),
  })
  .strict()
  .superRefine((lease, context) => {
    if (lease.expiresAt <= lease.acquiredAt) {
      context.addIssue({
        code: "custom",
        message: "Lease expiry must be after acquisition.",
        path: ["expiresAt"],
      });
    }
    if (lease.releasedAt !== undefined && lease.releasedAt < lease.acquiredAt) {
      context.addIssue({
        code: "custom",
        message: "Lease release cannot precede acquisition.",
        path: ["releasedAt"],
      });
    }
  })
  .describe("Lease structure. Cross-field chronology is enforced by the Domain runtime.");

export type Lease = z.infer<typeof leaseSchema>;

export const jobJsonSchema = z.toJSONSchema(jobSchema, { target: "draft-2020-12" });
export const leaseJsonSchema = z.toJSONSchema(leaseSchema, { target: "draft-2020-12" });
