import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";

import { z } from "zod";

import {
  reportContractFailureCategorySchema,
  safeReviewReportDiagnosticSchema,
} from "../../application/pipelines/index.js";
import {
  createClock,
  domainError,
  err,
  ok,
  canonicalInstantPattern,
  parseInstant,
  type Clock,
  type DomainError,
  type Instant,
  type Result,
} from "../../domain/foundation/index.js";
import { jobIdSchema } from "../../domain/jobs/index.js";
import {
  AtomicFileStore,
  acquireRecoverableFileLock,
  readJsonWithSchema,
  writeJsonWithSchema,
} from "../../infrastructure/files/index.js";

const instantSchema = z
  .string()
  .regex(canonicalInstantPattern)
  .refine((value) => parseInstant(value).ok) as unknown as z.ZodType<Instant>;
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);

const diagnosticEntrySchema = z
  .object({
    attempt: z.number().int().min(1).max(2),
    kind: z.enum(["format", "transport"]),
    category: reportContractFailureCategorySchema.optional(),
    errorCode: z.string().trim().min(1).max(64).optional(),
    diagnostics: z.array(safeReviewReportDiagnosticSchema).max(100),
    recordedAt: instantSchema,
  })
  .strict();

export const reviewerReplayDiagnosticRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobId: jobIdSchema,
    identityDigest: digestSchema,
    entries: z.array(diagnosticEntrySchema).max(2),
    updatedAt: instantSchema,
  })
  .strict();
export type ReviewerReplayDiagnosticEntry = z.input<typeof diagnosticEntrySchema>;

export class FileReviewerReplayDiagnosticStore {
  readonly #directory: string;
  readonly #store: AtomicFileStore;
  readonly #clock: Clock;

  constructor(
    directory: string,
    store: AtomicFileStore = new AtomicFileStore(),
    clock: Clock = createClock(),
  ) {
    if (!isAbsolute(directory)) throw new Error("reviewer_replay_diagnostic_root_must_be_absolute");
    this.#directory = directory;
    this.#store = store;
    this.#clock = clock;
  }

  #path(jobId: string): string {
    return join(this.#directory, `${jobId}.json`);
  }

  async append(
    jobId: string,
    identityDigest: string,
    entry: Omit<ReviewerReplayDiagnosticEntry, "recordedAt">,
  ): Promise<Result<void, DomainError>> {
    if (!jobIdSchema.safeParse(jobId).success || !digestSchema.safeParse(identityDigest).success) {
      return err(domainError("invariant_violation"));
    }
    const lock = await acquireRecoverableFileLock(
      `${this.#path(jobId)}.lock`,
      `reviewer-replay-diagnostic:${String(process.pid)}:${randomUUID()}`,
    );
    if (!lock.ok) return lock;
    const current = await readJsonWithSchema(
      this.#path(jobId),
      reviewerReplayDiagnosticRecordSchema,
    );
    const normalized = !current.ok && current.error.code === "not_found" ? ok(undefined) : current;
    let result: Result<void, DomainError>;
    if (!normalized.ok) {
      result = normalized;
    } else if (
      normalized.value !== undefined &&
      normalized.value.identityDigest !== identityDigest
    ) {
      result = err(domainError("conflict"));
    } else if (normalized.value?.entries.some((candidate) => candidate.attempt === entry.attempt)) {
      result = ok(undefined);
    } else {
      const now = this.#clock.now();
      const candidate = reviewerReplayDiagnosticRecordSchema.safeParse({
        schemaVersion: 1,
        jobId,
        identityDigest,
        entries: [...(normalized.value?.entries ?? []), { ...entry, recordedAt: now }],
        updatedAt: now,
      });
      if (!candidate.success) {
        result = err(domainError("invariant_violation"));
      } else {
        const written = await writeJsonWithSchema(
          this.#store,
          this.#path(jobId),
          reviewerReplayDiagnosticRecordSchema,
          candidate.data,
          { visibility: "private" },
        );
        result = !written.ok
          ? written
          : written.value.durability !== "confirmed" || !written.value.readBack.ok
            ? err(domainError("external_failure"))
            : ok(undefined);
      }
    }
    const released = await lock.value.release();
    return !released.ok && result.ok ? released : result;
  }
}
