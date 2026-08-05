import { z } from "zod";

import { createHash } from "node:crypto";

import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import { agentRoleSchema, projectIdSchema } from "../../domain/project/index.js";
import { canonicalSerialize } from "../../domain/review/index.js";
import { Redactor } from "../../infrastructure/redaction/index.js";

const boundedText = z.string().trim().min(1).max(10_000);
const platformKey = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,63}$/u)
  .max(64);
const externalId = z.string().trim().min(1).max(255);
const commandArgument = z
  .string()
  .max(10_000)
  .refine((value) => !/[\u0000\r\n]/u.test(value));

export const projectCommandSchema = z
  .object({
    executable: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,254}$/u)
      .refine(
        (value) =>
          !["bash", "cmd", "fish", "powershell", "pwsh", "sh", "zsh"].includes(value.toLowerCase()),
      ),
    arguments: z.array(commandArgument).max(200),
  })
  .strict();

const roleInstructionsSchema = z
  .object(
    Object.fromEntries(
      agentRoleSchema.options.map((role) => [role, z.array(boundedText).max(100).optional()]),
    ) as Record<
      (typeof agentRoleSchema.options)[number],
      z.ZodOptional<z.ZodArray<typeof boundedText>>
    >,
  )
  .strict();

export const trustedProjectConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: projectIdSchema,
    defaultBranch: z.string().trim().min(1).max(255),
    platforms: z
      .object({
        workManagement: z
          .object({
            provider: platformKey,
            containerId: externalId,
            projectId: externalId,
          })
          .strict(),
        sourceControl: z
          .object({
            provider: platformKey,
            repository: z
              .string()
              .trim()
              .regex(/^[^/\s]+(?:\/[^/\s]+)+$/u)
              .max(255),
          })
          .strict(),
      })
      .strict(),
    projectRules: z.array(boundedText).max(1_000),
    roleInstructions: roleInstructionsSchema,
    commands: z
      .object({
        quality: z.array(projectCommandSchema).min(1).max(50),
        visualReview: z.array(projectCommandSchema).max(50),
      })
      .strict(),
  })
  .strict();

export type ProjectCommand = z.infer<typeof projectCommandSchema>;
export type TrustedProjectConfig = z.infer<typeof trustedProjectConfigSchema>;

export interface SerializedTrustedProjectConfig {
  readonly content: string;
  readonly contentDigest: string;
}

/** Produces deterministic, secret-scanned bytes suitable for the trusted default-branch file. */
export function serializeTrustedProjectConfig(
  input: unknown,
): Result<SerializedTrustedProjectConfig, DomainError<"invariant_violation">> {
  const parsed = trustedProjectConfigSchema.safeParse(input);
  if (!parsed.success) return err(domainError("invariant_violation"));
  const serialized = canonicalSerialize(parsed.data);
  if (!serialized.ok) return err(domainError("invariant_violation"));
  const content = `${serialized.value}\n`;
  if (new Redactor().redactText(content) !== content) {
    return err(domainError("invariant_violation"));
  }
  return ok(
    Object.freeze({
      content,
      contentDigest: createHash("sha256").update(content, "utf8").digest("hex"),
    }),
  );
}
