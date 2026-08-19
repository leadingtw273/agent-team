import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";

import { z } from "zod";

import {
  reportContractFailureCategorySchema,
  reviewerReportSchema,
} from "../../application/pipelines/index.js";
import type { ReadOptions } from "../../application/ports/index.js";
import {
  canonicalInstantPattern,
  createClock,
  domainError,
  err,
  ok,
  parseInstant,
  type Clock,
  type DomainError,
  type Instant,
  type Result,
} from "../../domain/foundation/index.js";
import { jobIdSchema, projectIdSchema } from "../../domain/jobs/index.js";
import { issueIdSchema } from "../../domain/project/index.js";
import { headShaSchema, sha256Digest } from "../../domain/review/index.js";
import {
  AtomicFileStore,
  acquireRecoverableFileLock,
  readJsonWithSchema,
  writeJsonWithSchema,
} from "../../infrastructure/files/index.js";
import { reviewerReplayContractBindingSchema } from "./job-progress-store.js";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const instantSchema = z
  .string()
  .regex(canonicalInstantPattern)
  .refine((value) => parseInstant(value).ok) as unknown as z.ZodType<Instant>;

export const finalReviewRecoveryIdentitySchema = z
  .object({
    schemaVersion: z.literal(1),
    operation: z.literal("reviewer-final-replay"),
    jobId: jobIdSchema,
    projectId: projectIdSchema,
    issueId: issueIdSchema,
    externalIssueId: z.string().trim().min(1).max(255),
    changeRequestId: z.string().regex(/^[1-9]\d*$/u),
    sourceCheckpointId: z.string().regex(/^checkpoint_[0-9a-f-]+$/u),
    sourceCheckpointDigest: digestSchema,
    baseRevision: headShaSchema,
    requirementsDigest: digestSchema,
    headSha: headShaSchema,
    diffDigest: digestSchema,
    evidenceDigest: digestSchema.optional(),
    publicationDigest: digestSchema.optional(),
    reviewContractBinding: reviewerReplayContractBindingSchema,
  })
  .strict();
export type FinalReviewRecoveryIdentity = z.infer<typeof finalReviewRecoveryIdentitySchema>;

const finalReviewRecoveryBaseSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  jobId: jobIdSchema,
  identity: finalReviewRecoveryIdentitySchema,
  identityDigest: digestSchema,
  preProviderFailures: z.number().int().nonnegative().max(10),
  updatedAt: instantSchema,
});

const readySchema = finalReviewRecoveryBaseSchema
  .extend({
    state: z.literal("ready"),
    lastPreProviderFailure: z
      .object({
        kind: z.enum(["not_ready", "failed"]),
        stage: z.enum(["request", "change_request", "checks", "worktree", "diff", "ready"]),
        errorCode: z.string().trim().min(1).max(64).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const reservedSchema = finalReviewRecoveryBaseSchema
  .extend({ state: z.literal("provider_reserved"), reservedAt: instantSchema })
  .strict();

const providerTerminalBase = finalReviewRecoveryBaseSchema.extend({
  providerRuns: z.literal(1),
  completedAt: instantSchema,
});

const succeededSchema = providerTerminalBase
  .extend({
    state: z.literal("review_succeeded"),
    reports: z.array(reviewerReportSchema).length(1),
    reportDigests: z.array(digestSchema).length(1),
    reviewerReplayCheckpointDigest: digestSchema,
  })
  .strict();

const notApprovedSchema = providerTerminalBase
  .extend({
    state: z.literal("review_not_approved"),
    verdict: z.enum(["changes_requested", "clarification_required"]),
  })
  .strict();

const providerFailedSchema = providerTerminalBase
  .extend({
    state: z.literal("provider_failed"),
    stage: z.enum([
      "evidence",
      "checkpoint",
      "provider_start",
      "provider_run",
      "tool_decision",
      "post_review_worktree",
      "attempt_persistence",
      "unknown",
    ]),
    errorCode: z.string().trim().min(1).max(64),
  })
  .strict();

const reportFailedSchema = providerTerminalBase
  .extend({
    state: z.literal("report_failed"),
    category: reportContractFailureCategorySchema,
    diagnosticCount: z.number().int().nonnegative().max(100),
  })
  .strict();

const pausedSchema = providerTerminalBase
  .extend({
    state: z.literal("provider_paused"),
    reason: z.enum(["safety_approval_required", "provider_interrupted"]),
  })
  .strict();

const unknownSchema = providerTerminalBase
  .extend({ state: z.literal("provider_outcome_unknown") })
  .strict();

export const finalReviewRecoveryRecordSchema = z
  .discriminatedUnion("state", [
    readySchema,
    reservedSchema,
    succeededSchema,
    notApprovedSchema,
    providerFailedSchema,
    reportFailedSchema,
    pausedSchema,
    unknownSchema,
  ])
  .superRefine((value, context) => {
    const digest = sha256Digest(value.identity);
    if (!digest.ok || digest.value !== value.identityDigest) {
      context.addIssue({
        code: "custom",
        path: ["identityDigest"],
        message: "Recovery identity digest does not match canonical identity.",
      });
    }
  });
export type FinalReviewRecoveryRecord = z.infer<typeof finalReviewRecoveryRecordSchema>;
export type FinalReviewRecoveryRecordMutation = FinalReviewRecoveryRecord extends infer Record
  ? Record extends FinalReviewRecoveryRecord
    ? Omit<Record, "schemaVersion" | "revision" | "updatedAt">
    : never
  : never;

function terminal(record: FinalReviewRecoveryRecord): boolean {
  return record.state !== "ready" && record.state !== "provider_reserved";
}

function mutationFrom(record: FinalReviewRecoveryRecord): FinalReviewRecoveryRecordMutation {
  const {
    schemaVersion: _schemaVersion,
    revision: _revision,
    updatedAt: _updatedAt,
    ...mutation
  } = record;
  void _schemaVersion;
  void _revision;
  void _updatedAt;
  return mutation;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function transitionAllowed(
  current: FinalReviewRecoveryRecord | undefined,
  next: FinalReviewRecoveryRecordMutation,
): boolean {
  if (current === undefined) return next.state === "ready" && next.preProviderFailures === 0;
  if (
    current.jobId !== next.jobId ||
    current.identityDigest !== next.identityDigest ||
    !sameJson(current.identity, next.identity) ||
    next.preProviderFailures < current.preProviderFailures
  ) {
    return false;
  }
  if (terminal(current)) return sameJson(mutationFrom(current), next);
  if (current.state === "ready") {
    return (
      next.state === "provider_reserved" && next.preProviderFailures === current.preProviderFailures
    );
  }
  if (next.state === "ready") {
    return next.preProviderFailures === current.preProviderFailures + 1;
  }
  return terminal(next as FinalReviewRecoveryRecord);
}

export class FileFinalReviewRecoveryStore {
  readonly #directory: string;
  readonly #store: AtomicFileStore;
  readonly #clock: Clock;

  constructor(
    directory: string,
    store: AtomicFileStore = new AtomicFileStore(),
    clock: Clock = createClock(),
  ) {
    if (!isAbsolute(directory)) throw new Error("final_review_recovery_root_must_be_absolute");
    this.#directory = directory;
    this.#store = store;
    this.#clock = clock;
  }

  #path(jobId: string): string {
    return join(this.#directory, `${jobId}.json`);
  }

  async load(
    jobId: string,
    options: ReadOptions = {},
  ): Promise<Result<FinalReviewRecoveryRecord | undefined, DomainError>> {
    if (!jobIdSchema.safeParse(jobId).success || options.signal?.aborted === true) {
      return err(domainError("invariant_violation"));
    }
    const loaded = await readJsonWithSchema(this.#path(jobId), finalReviewRecoveryRecordSchema);
    if (!loaded.ok) return loaded.error.code === "not_found" ? ok(undefined) : loaded;
    return ok(loaded.value);
  }

  async compareAndSwap(
    jobId: string,
    expectedRevision: number | null,
    next: FinalReviewRecoveryRecordMutation,
    options: ReadOptions = {},
  ): Promise<Result<FinalReviewRecoveryRecord, DomainError>> {
    if (
      !jobIdSchema.safeParse(jobId).success ||
      next.jobId !== jobId ||
      options.signal?.aborted === true
    ) {
      return err(domainError("invariant_violation"));
    }
    const path = this.#path(jobId);
    const lock = await acquireRecoverableFileLock(
      `${path}.lock`,
      `final-review-recovery:${String(process.pid)}:${randomUUID()}`,
    );
    if (!lock.ok) return lock;
    const current = await readJsonWithSchema(path, finalReviewRecoveryRecordSchema);
    const normalized = !current.ok && current.error.code === "not_found" ? ok(undefined) : current;
    let result: Result<FinalReviewRecoveryRecord, DomainError>;
    if (!normalized.ok) {
      result = normalized;
    } else if (
      (expectedRevision === null && normalized.value !== undefined) ||
      (expectedRevision !== null && normalized.value?.revision !== expectedRevision)
    ) {
      result = err(domainError("conflict"));
    } else if (!transitionAllowed(normalized.value, next)) {
      result = err(domainError("invariant_violation"));
    } else {
      const candidate = finalReviewRecoveryRecordSchema.safeParse({
        ...next,
        schemaVersion: 1,
        revision: (normalized.value?.revision ?? -1) + 1,
        updatedAt: this.#clock.now(),
      });
      if (!candidate.success) {
        result = err(domainError("invariant_violation"));
      } else {
        const written = await writeJsonWithSchema(
          this.#store,
          path,
          finalReviewRecoveryRecordSchema,
          candidate.data,
          { visibility: "private" },
        );
        result = !written.ok
          ? written
          : written.value.durability !== "confirmed" || !written.value.readBack.ok
            ? err(domainError("external_failure"))
            : ok(written.value.readBack.value);
      }
    }
    const released = await lock.value.release();
    return !released.ok && result.ok ? released : result;
  }
}
