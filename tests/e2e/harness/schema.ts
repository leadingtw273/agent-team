/**
 * E005: fixed EvidenceBundle schema shared by every Live E2E Case (E101-E118) harness run.
 *
 * Locked decisions (task packet):
 * - `schemaVersion: 1`.
 * - Exactly four named sources: `linear` / `github` / `localEvents` / `checkpoints`.
 * - "缺任一來源即 Case 不得綠" (missing any one source means the case cannot be green) --
 *   `isEvidenceBundleGreen` below is the single place that rule is enforced, and every source is
 *   a discriminated `present` | `missing` union so a caller can never mistake "empty" for
 *   "collected" by accident (no source ever silently defaults to an empty-but-successful shape).
 *
 * This is a collection schema, not a validator: E007 (a separate, later task) is where cross-
 * source reconciliation (SHA/timestamp/consistency checks) happens. E005 only proves each source
 * was actually, authoritatively read.
 */
import { z } from "zod";

import { canonicalInstantPattern, parseInstant } from "../../../src/domain/foundation/index.js";

const instantSchema = z
  .string()
  .regex(canonicalInstantPattern)
  .refine((value) => parseInstant(value).ok, "Timestamp must be a canonical ISO instant.");

const shaPattern = /^[0-9a-f]{40}$/u;

/**
 * Fixed reason codes for why a source came back `missing` -- never a raw provider error message
 * (which could leak into a report; see the task's secrets-hygiene invariant). Exactly one of
 * these four applies to every `missing` source result.
 */
export const evidenceMissingReasons = [
  /** The read call itself returned an error (network/transport/auth/parse failure). */
  "read_error",
  /** The read succeeded, but the specific object this case names does not exist. */
  "not_found",
  /** The read succeeded and the object exists, but nothing fell inside the case's time window
   * (or, for localEvents, nothing matched the case's correlation id). */
  "empty_result",
  /** The case description itself is missing the fields this source needs to even attempt a
   * read (e.g. asking for github evidence with no repository configured). */
  "case_incomplete",
] as const;
export type EvidenceMissingReason = (typeof evidenceMissingReasons)[number];

export const evidenceSourceNames = ["linear", "github", "localEvents", "checkpoints"] as const;
export type EvidenceSourceName = (typeof evidenceSourceNames)[number];

function sourceResultSchema<DataSchema extends z.ZodType>(dataSchema: DataSchema) {
  return z.discriminatedUnion("status", [
    z
      .object({ status: z.literal("present"), collectedAt: instantSchema, data: dataSchema })
      .strict(),
    z
      .object({
        status: z.literal("missing"),
        collectedAt: instantSchema,
        reason: z.enum(evidenceMissingReasons),
      })
      .strict(),
  ]);
}

const linearCommentEvidenceSchema = z
  .object({ id: z.string().min(1), body: z.string(), createdAt: z.string().min(1) })
  .strict();

export const linearEvidenceDataSchema = z
  .object({
    issueId: z.string().min(1),
    identifier: z.string().min(1),
    title: z.string(),
    workStatus: z.enum(["backlog", "ready", "in_progress", "in_review", "completed", "canceled"]),
    updatedAt: z.string().min(1),
    comments: z.array(linearCommentEvidenceSchema),
  })
  .strict();
export type LinearEvidenceData = z.infer<typeof linearEvidenceDataSchema>;

const githubCommitCheckEvidenceSchema = z
  .object({
    name: z.string().min(1),
    status: z.enum(["queued", "in_progress", "completed"]),
    conclusion: z.enum(["success", "failure", "cancelled", "skipped"]).nullable(),
    url: z.string().optional(),
  })
  .strict();

const githubCommitStatusEvidenceSchema = z
  .object({
    context: z.string().min(1),
    state: z.enum(["pending", "success", "failure", "error"]),
    description: z.string().optional(),
    targetUrl: z.string().optional(),
  })
  .strict();

export const githubEvidenceDataSchema = z
  .object({
    pullRequest: z
      .object({
        number: z.number().int().positive(),
        state: z.enum(["open", "closed", "merged"]),
        draft: z.boolean(),
        headSha: z.string().regex(shaPattern),
        baseBranch: z.string().min(1),
        headBranch: z.string().min(1),
        url: z.string().min(1),
        mergeability: z.enum(["mergeable", "conflicting", "unknown"]),
        autoMergeEnabled: z.boolean(),
      })
      .strict(),
    checks: z
      .object({
        headSha: z.string().regex(shaPattern),
        aggregate: z.enum(["pending", "success", "failure"]),
        checks: z.array(githubCommitCheckEvidenceSchema),
      })
      .strict(),
    statuses: z
      .object({
        headSha: z.string().regex(shaPattern),
        statuses: z.array(githubCommitStatusEvidenceSchema),
      })
      .strict(),
  })
  .strict();
export type GithubEvidenceData = z.infer<typeof githubEvidenceDataSchema>;

const localEventEvidenceSchema = z
  .object({
    eventId: z.string().min(1),
    eventType: z.string().min(1),
    occurredAt: z.string().min(1),
    correlationId: z.string().min(1),
    subjectKind: z.string().min(1),
    subjectId: z.string().min(1),
  })
  .strict();

const inboxRecordEvidenceSchema = z
  .object({
    provider: z.enum(["github", "linear"]),
    deliveryId: z.string().min(1),
    eventType: z.string().min(1),
    receivedAt: z.string().min(1),
  })
  .strict();

export const localEventsEvidenceDataSchema = z
  .object({
    events: z.array(localEventEvidenceSchema),
    inboxRecords: z.array(inboxRecordEvidenceSchema),
  })
  .strict();
export type LocalEventsEvidenceData = z.infer<typeof localEventsEvidenceDataSchema>;

const checkpointEvidenceSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    issueId: z.string().min(1),
    jobId: z.string().min(1),
    createdAt: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

export const checkpointsEvidenceDataSchema = z
  .object({ checkpoints: z.array(checkpointEvidenceSchema) })
  .strict();
export type CheckpointsEvidenceData = z.infer<typeof checkpointsEvidenceDataSchema>;

export const evidenceBundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    caseId: z.string().min(1),
    runId: z.string().min(1),
    assembledAt: instantSchema,
    linear: sourceResultSchema(linearEvidenceDataSchema),
    github: sourceResultSchema(githubEvidenceDataSchema),
    localEvents: sourceResultSchema(localEventsEvidenceDataSchema),
    checkpoints: sourceResultSchema(checkpointsEvidenceDataSchema),
  })
  .strict();
export type EvidenceBundle = z.infer<typeof evidenceBundleSchema>;

/**
 * The one rule this whole harness exists to enforce: every one of the four named sources must be
 * `present`, or the case is not green. There is no partial-credit path.
 */
export function isEvidenceBundleGreen(bundle: EvidenceBundle): boolean {
  return evidenceSourceNames.every((name) => bundle[name].status === "present");
}

export function missingEvidenceSources(bundle: EvidenceBundle): readonly EvidenceSourceName[] {
  return evidenceSourceNames.filter((name) => bundle[name].status === "missing");
}

export type EvidenceCollectionOutcome =
  | Readonly<{ state: "green"; bundle: EvidenceBundle }>
  | Readonly<{
      state: "not_green";
      bundle: EvidenceBundle;
      missingSources: readonly EvidenceSourceName[];
    }>;

export function finalizeEvidenceCollection(bundle: EvidenceBundle): EvidenceCollectionOutcome {
  const missingSources = missingEvidenceSources(bundle);
  return missingSources.length === 0
    ? Object.freeze({ state: "green" as const, bundle })
    : Object.freeze({ state: "not_green" as const, bundle, missingSources });
}
