/**
 * C015r decision 5: the observability sidecar that closes the "zero留存" gap C015q's diagnosis named
 * (`/home/markchou/.claude/jobs/6152588f/tmp/c015q-diagnose.md`, item 2.1) -- until now, a `report`
 * stage failure left the model's actual rejected output nowhere on disk at all, anywhere, ever.
 *
 * Explicit rules (coordinator's decision 5, restated so they cannot drift):
 * - Written *only* when a `report`-stage contract failure occurs (never any other failure kind).
 * - 0600 file permissions (`AtomicFileStore.write`'s own default `visibility: "private"`).
 * - A hard size cap: the rejected text is truncated (never silently dropped -- `truncated: true` is
 *   recorded alongside) before it ever reaches this adapter's write path.
 * - Passed through the same `Redactor` every provider-facing text already goes through
 *   (`src/infrastructure/redaction/`), so a prompt-injected secret cannot leak into this file any
 *   more than it already could leak into a provider transcript.
 * - "永不進 audit/outcome/PR/Linear": this store is *only* ever called from resume-composition.ts at
 *   the one point a `report`-stage failure is detected, is never read by any other code path in this
 *   codebase, and its return value is deliberately never threaded into `ResumeJobOutcome` or
 *   `JobProgressRecord` -- see resume-composition.ts's own call site comment.
 * - "TTL 或明確可清理": this adapter deliberately keeps at most **one** file per job id (each new
 *   write overwrites the previous one for that job) rather than growing an unbounded timestamped
 *   history -- an operator can delete the entire sidecar directory at any time with zero effect on
 *   any durable state this codebase depends on (nothing here is ever read back by production code,
 *   only by a human debugging a `requires_manual` job). That is the "明確可清理" half of the
 *   requirement; no separate TTL sweep process exists or is needed.
 *
 * File shape intentionally does *not* reuse `FileJobProgressStore`'s CAS/lock machinery: there is no
 * concurrent-writer race to guard against that matters here (an overwrite losing a race with another
 * overwrite for the same job just means the very latest of two failures within the same resume
 * attempt is kept, which is an acceptable, disclosed limitation for a best-effort diagnostic aid).
 */
import { isAbsolute, join } from "node:path";

import { z } from "zod";

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
import { reportContractFailureCategorySchema } from "../../application/pipelines/reviewer-model.js";
import type { ProviderTextRedactor } from "../../application/provider-job/index.js";
import { AtomicFileStore, writeJsonWithSchema } from "../../infrastructure/files/index.js";

const instantSchema = z
  .string()
  .regex(canonicalInstantPattern)
  .refine((value) => parseInstant(value).ok) as unknown as z.ZodType<Instant>;

/** Deliberately generous relative to what any single rejected report realistically needs (the
 * schema's own `maxOutputBytes` ceiling upstream is measured in MB), but still a hard, small cap --
 * this is a diagnostic aid, not a durable archive. */
export const defaultReviewReportSidecarMaxBytes = 16_384;

const reviewReportSidecarRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobId: z.string().trim().min(1).max(255),
    category: reportContractFailureCategorySchema,
    capturedAt: instantSchema,
    truncated: z.boolean(),
    originalByteLength: z.number().int().nonnegative(),
    rejectedOutput: z.string().max(defaultReviewReportSidecarMaxBytes),
  })
  .strict();

export type ReviewReportSidecarRecord = z.infer<typeof reviewReportSidecarRecordSchema>;

export interface ReviewReportDiagnosticsSidecarPort {
  record(
    input: Readonly<{ jobId: string; category: string; rejectedOutput: string }>,
  ): Promise<Result<Readonly<{ path: string }>, DomainError>>;
}

export class FileReviewReportDiagnosticsSidecar implements ReviewReportDiagnosticsSidecarPort {
  readonly #directory: string;
  readonly #redactor: ProviderTextRedactor;
  readonly #store: AtomicFileStore;
  readonly #clock: Clock;
  readonly #maxBytes: number;

  constructor(
    directory: string,
    redactor: ProviderTextRedactor,
    store: AtomicFileStore = new AtomicFileStore(),
    clock: Clock = createClock(),
    maxBytes: number = defaultReviewReportSidecarMaxBytes,
  ) {
    if (!isAbsolute(directory)) throw new Error("review_report_sidecar_root_must_be_absolute");
    this.#directory = directory;
    this.#redactor = redactor;
    this.#store = store;
    this.#clock = clock;
    this.#maxBytes = maxBytes;
  }

  #path(jobId: string): string {
    return join(this.#directory, `${jobId}.json`);
  }

  async record(
    input: Readonly<{ jobId: string; category: string; rejectedOutput: string }>,
  ): Promise<Result<Readonly<{ path: string }>, DomainError>> {
    if (input.jobId.trim().length === 0 || input.jobId.length > 255) {
      return err(domainError("invariant_violation"));
    }
    const redacted = this.#redactor.redactText(input.rejectedOutput);
    const originalByteLength = Buffer.byteLength(redacted, "utf8");
    const truncated = originalByteLength > this.#maxBytes;
    const rejectedOutput = truncated
      ? Buffer.from(redacted, "utf8").subarray(0, this.#maxBytes).toString("utf8")
      : redacted;
    const path = this.#path(input.jobId);
    const written = await writeJsonWithSchema(
      this.#store,
      path,
      reviewReportSidecarRecordSchema,
      {
        schemaVersion: 1,
        jobId: input.jobId,
        category: input.category,
        capturedAt: this.#clock.now(),
        truncated,
        originalByteLength,
        rejectedOutput,
      },
      { visibility: "private" },
    );
    if (!written.ok) return written;
    if (written.value.durability !== "confirmed" || !written.value.readBack.ok) {
      return err(domainError("external_failure"));
    }
    return ok(Object.freeze({ path }));
  }
}

export function defaultReviewReportSidecarDirectory(agentTeamHome: string): string {
  return join(agentTeamHome, "state", "dispatch", "review-report-sidecar");
}
