import { z } from "zod";

import {
  canonicalInstantPattern,
  domainError,
  err,
  ok,
  parseInstant,
  type DomainError,
  type Instant,
  type Result,
} from "../foundation/index.js";
import { issueSchema, type Issue } from "../project/index.js";
import { sha256Digest, type Sha256Digest } from "./canonical.js";

const instantSchema = z
  .string()
  .regex(canonicalInstantPattern)
  .refine((value) => parseInstant(value).ok) as unknown as z.ZodType<Instant>;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u) as unknown as z.ZodType<Sha256Digest>;

export const requirementSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    capturedAt: instantSchema,
    requirementsDigest: sha256Schema,
    issue: issueSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    const digest = sha256Digest(snapshot.issue);
    if (!digest.ok || digest.value !== snapshot.requirementsDigest) {
      context.addIssue({
        code: "custom",
        message: "Requirement digest must match the captured Issue.",
        path: ["requirementsDigest"],
      });
    }
  });

export type RequirementSnapshot = z.infer<typeof requirementSnapshotSchema>;

export function createRequirementSnapshot(
  issueInput: Issue,
  capturedAt: Instant,
): Result<RequirementSnapshot, DomainError<"invariant_violation">> {
  const issue = issueSchema.safeParse(issueInput);
  if (!issue.success) return err(domainError("invariant_violation"));
  const digest = sha256Digest(issue.data);
  if (!digest.ok) return digest;

  return ok(
    Object.freeze({
      schemaVersion: 1 as const,
      capturedAt,
      requirementsDigest: digest.value,
      issue: issue.data,
    }),
  );
}
