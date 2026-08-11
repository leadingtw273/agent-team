import { createHash } from "node:crypto";

import { z } from "zod";
import { effectiveTreeDiffSchema } from "../../../src/domain/review/diff.js";

import { hasSafeDataShape } from "./boundary.js";

export const missingReasonCodes = [
  "not_found",
  "empty_result",
  "parse_failed",
  "read_failed",
  "authority_unavailable",
  "binding_missing",
  "duplicate_result",
  "pagination_incomplete",
] as const;
export type MissingReasonCode = (typeof missingReasonCodes)[number];

export const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
export const instantSchema = z.iso.datetime();
export const headShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
export const timelineKinds = ["dispatch_started", "merge_completed", "linear_completed"] as const;

const linearEvidenceSchema = z
  .object({
    issueAlias: z.literal("issue-1"),
    issueCount: z.number().int().nonnegative(),
    workStatus: z.literal("completed"),
    updatedAt: instantSchema,
    timeline: z
      .array(
        z
          .object({
            kind: z.enum(timelineKinds),
            occurredAt: instantSchema,
            count: z.number().int().positive(),
          })
          .strict(),
      )
      .length(3),
  })
  .strict();

const githubEvidenceSchema = z
  .object({
    pullRequestAlias: z.literal("pr-1"),
    pullRequestCount: z.number().int().nonnegative(),
    state: z.literal("merged"),
    headDigest: digestSchema,
    checks: z
      .array(
        z
          .object({
            name: z.literal("CI"),
            status: z.literal("completed"),
            conclusion: z.literal("success"),
            headDigest: digestSchema,
          })
          .strict(),
      )
      .max(1),
    reviewStatus: z
      .object({
        context: z.literal("agent-team/review"),
        state: z.literal("success"),
        headDigest: digestSchema,
      })
      .strict(),
    reviewer: z
      .object({
        role: z.literal("code_reviewer"),
        verdict: z.literal("passed"),
        headDigest: digestSchema,
        requirementsDigest: digestSchema,
        diffDigest: digestSchema,
      })
      .strict(),
    merge: z
      .object({ state: z.literal("merged"), headDigest: digestSchema, observedAt: instantSchema })
      .strict(),
  })
  .strict();

const localEvidenceSchema = z
  .object({
    jobAlias: z.literal("job-1"),
    issueAlias: z.literal("issue-1"),
    jobsForIssue: z.number().int().nonnegative(),
    exactJob: z.object({ stage: z.literal("completed"), updatedAt: instantSchema }).strict(),
    projectProgress: z
      .object({
        state: z.literal("available"),
        resumable: z.number().int().nonnegative(),
        blocked: z.number().int().nonnegative(),
        nonTerminal: z.number().int().nonnegative(),
      })
      .strict(),
    leases: z
      .object({
        state: z.literal("available"),
        active: z.number().int().nonnegative(),
        expired: z.number().int().nonnegative(),
        observedAt: instantSchema,
      })
      .strict(),
  })
  .strict();

const gitEvidenceSchema = z
  .object({ baseDigest: digestSchema, headDigest: digestSchema, effectiveDiffDigest: digestSchema })
  .strict();
export type LinearEvidence = z.infer<typeof linearEvidenceSchema>;
export type GithubEvidence = z.infer<typeof githubEvidenceSchema>;
export type LocalEvidence = z.infer<typeof localEvidenceSchema>;
export type GitEvidence = z.infer<typeof gitEvidenceSchema>;

function authoritySchema<Value extends z.ZodType>(valueSchema: Value) {
  return z.discriminatedUnion("status", [
    z.object({ status: z.literal("present"), evidence: valueSchema }).strict(),
    z.object({ status: z.literal("missing"), reasonCode: z.enum(missingReasonCodes) }).strict(),
  ]);
}

export const firstSandboxLiveArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("first_sandbox_live_artifact"),
    provenance: z
      .object({
        source: z.literal("production"),
        producerTask: z.literal("T11"),
        caseId: z.literal("first_sandbox_internal_canary"),
        runDigest: digestSchema,
        agentTeamRevision: digestSchema,
        startedAt: instantSchema,
        capturedAt: instantSchema,
      })
      .strict(),
    authorities: z
      .object({
        linear: authoritySchema(linearEvidenceSchema),
        github: authoritySchema(githubEvidenceSchema),
        local: authoritySchema(localEvidenceSchema),
        git: authoritySchema(gitEvidenceSchema),
      })
      .strict(),
  })
  .strict();
export type FirstSandboxLiveArtifact = z.infer<typeof firstSandboxLiveArtifactSchema>;

export const rawLinearObservationSchema = z
  .object({
    issues: z.array(
      z
        .object({
          id: z.string().min(1),
          identifier: z.string().min(1),
          title: z.string(),
          workStatus: z.string(),
          updatedAt: z.string(),
          timeline: z.array(
            z.object({ marker: z.string(), occurredAt: z.string(), body: z.string() }).strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();

export const rawGithubObservationSchema = z
  .object({
    pullRequests: z.array(
      z
        .object({
          number: z.number().int().positive(),
          state: z.string(),
          headSha: headShaSchema,
          mergedAt: z.string(),
          checks: z.array(
            z
              .object({
                name: z.string(),
                status: z.string(),
                conclusion: z.string(),
                headSha: headShaSchema,
                url: z.string(),
              })
              .strict(),
          ),
          statuses: z.array(
            z
              .object({
                context: z.string(),
                state: z.string(),
                headSha: headShaSchema,
                targetUrl: z.string().nullable(),
                description: z.string(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();

export const rawGitObservationSchema = z
  .object({ baseSha: headShaSchema, headSha: headShaSchema, changes: effectiveTreeDiffSchema })
  .strict();

export function authorityReadSchema<Value extends z.ZodType>(valueSchema: Value) {
  return z.discriminatedUnion("state", [
    z.object({ state: z.literal("present"), value: valueSchema }).strict(),
    z.object({ state: z.literal("missing"), reasonCode: z.enum(missingReasonCodes) }).strict(),
  ]);
}

export type Authority<Value> =
  | Readonly<{ status: "present"; evidence: Value }>
  | Readonly<{ status: "missing"; reasonCode: MissingReasonCode }>;
export type AuthorityRead<Value> =
  | Readonly<{ state: "present"; value: Value }>
  | Readonly<{ state: "missing"; reasonCode: MissingReasonCode }>;

export async function safeAuthorityRead<Value>(
  valueSchema: z.ZodType<Value>,
  read: Promise<unknown>,
): Promise<AuthorityRead<Value>> {
  let resolved: unknown;
  try {
    resolved = await read;
  } catch {
    return { state: "missing", reasonCode: "read_failed" };
  }
  if (!hasSafeDataShape(resolved)) return { state: "missing", reasonCode: "parse_failed" };
  if (
    typeof resolved === "object" &&
    resolved !== null &&
    Object.getOwnPropertyNames(resolved).length === 1 &&
    Object.getOwnPropertyDescriptor(resolved, "ok")?.value === false
  ) {
    return { state: "missing", reasonCode: "read_failed" };
  }
  const parsed = authorityReadSchema(valueSchema).safeParse(resolved);
  return parsed.success ? parsed.data : { state: "missing", reasonCode: "parse_failed" };
}

export function digestIdentifier(domain: string, raw: string): string {
  return createHash("sha256")
    .update("agent-team-live-artifact:v1\0", "utf8")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(raw, "utf8")
    .digest("hex");
}

export function parseArtifact(input: unknown): FirstSandboxLiveArtifact | undefined {
  if (!hasSafeDataShape(input)) return undefined;
  const parsed = firstSandboxLiveArtifactSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}
