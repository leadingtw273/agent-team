/**
 * C017b (D2): the minimal, non-backlog observability adapter the coordinator's decision required
 * for `CiRecoveryObservabilityPort` (src/application/pipelines/ci-recovery-model.ts) -- see that
 * interface's own header for the full "why" (distinguishing "the log was never attached" from "the
 * log was attached and the repair still failed"). Mirrors `FileReviewReportDiagnosticsSidecar`
 * (review-report-diagnostics-sidecar.ts) in shape -- one JSON file per job id, atomically written,
 * 0600 -- but is deliberately simpler in every place that file's own extra rules do not apply here:
 *
 * - **No `Redactor`, ever.** `CiRecoveryObservabilityPort.recordCiLogExcerpt`'s own type only ever
 *   carries a boolean, a short closed-shape `reason` string (one of `ci-log-excerpt.ts`'s own
 *   adapter-level reason codes, e.g. `"log_transport_unavailable"`, never free text), and byte
 *   counts -- there is no untrusted excerpt text anywhere in this adapter's input to begin with,
 *   unlike the rejected-provider-output the review-report sidecar redacts.
 * - **Synchronous, fire-and-forget port method.** `recordCiLogExcerpt` is declared `void`, not
 *   `Promise<Result<...>>` -- a diagnostic write must never make `CiRecoveryPipeline.run()` await
 *   disk I/O, and (per that port's own header) must never be capable of failing the repair attempt
 *   it is merely annotating. The underlying atomic write is still genuinely async; this adapter
 *   just never hands that promise back to the caller, only logs-and-swallows a rejection. A
 *   disclosed, accepted consequence: on process exit immediately after the *last* line a repair
 *   attempt would ever write, this specific diagnostic write could be lost -- acceptable for a
 *   best-effort aid whose entire purpose is disambiguating *repeated* failures, not the last one.
 * - **One file per job, overwritten every call** -- same "explicit, cleanable, no TTL sweep needed"
 *   reasoning as the review-report sidecar's own header: an operator can delete the whole directory
 *   at any time with zero effect on any durable state this codebase depends on.
 */
import { isAbsolute, join } from "node:path";

import { z } from "zod";

import {
  createClock,
  canonicalInstantPattern,
  parseInstant,
  type Clock,
  type Instant,
} from "../../domain/foundation/index.js";
import type { CiRecoveryObservabilityPort } from "../../application/pipelines/ci-recovery-model.js";
import { AtomicFileStore, writeJsonWithSchema } from "../../infrastructure/files/index.js";

const instantSchema = z
  .string()
  .regex(canonicalInstantPattern)
  .refine((value) => parseInstant(value).ok) as unknown as z.ZodType<Instant>;

const ciLogExcerptDiagnosticsRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobId: z.string().trim().min(1).max(255),
    recordedAt: instantSchema,
    available: z.boolean(),
    reason: z.string().trim().min(1).max(255).optional(),
    sourceBytes: z.number().int().nonnegative().optional(),
    excerptBytes: z.number().int().nonnegative().optional(),
  })
  .strict();

export type CiLogExcerptDiagnosticsRecord = z.infer<typeof ciLogExcerptDiagnosticsRecordSchema>;

export interface CiLogExcerptDiagnosticsSidecarOptions {
  readonly agentTeamHome: string;
  readonly store?: AtomicFileStore;
  readonly clock?: Clock;
}

export function defaultCiLogExcerptDiagnosticsDirectory(agentTeamHome: string): string {
  return join(agentTeamHome, "state", "dispatch", "ci-log-excerpt-diagnostics");
}

export class CiLogExcerptDiagnosticsSidecar implements CiRecoveryObservabilityPort {
  readonly #directory: string;
  readonly #store: AtomicFileStore;
  readonly #clock: Clock;
  readonly #pending = new Set<Promise<void>>();

  constructor(options: CiLogExcerptDiagnosticsSidecarOptions) {
    const directory = defaultCiLogExcerptDiagnosticsDirectory(options.agentTeamHome);
    if (!isAbsolute(directory)) throw new Error("ci_log_excerpt_diagnostics_root_must_be_absolute");
    this.#directory = directory;
    this.#store = options.store ?? new AtomicFileStore();
    this.#clock = options.clock ?? createClock();
  }

  #path(jobId: string): string {
    return join(this.#directory, `${jobId}.json`);
  }

  recordCiLogExcerpt(
    record: Readonly<{
      jobId: string;
      available: boolean;
      reason?: string;
      sourceBytes?: number;
      excerptBytes?: number;
    }>,
  ): void {
    if (record.jobId.trim().length === 0 || record.jobId.length > 255) return;
    const value: CiLogExcerptDiagnosticsRecord = {
      schemaVersion: 1,
      jobId: record.jobId,
      recordedAt: this.#clock.now(),
      available: record.available,
      ...(record.reason === undefined ? {} : { reason: record.reason }),
      ...(record.sourceBytes === undefined ? {} : { sourceBytes: record.sourceBytes }),
      ...(record.excerptBytes === undefined ? {} : { excerptBytes: record.excerptBytes }),
    };
    // Fire-and-forget by design -- see this class's own module header for why the port contract
    // is synchronous `void` and why a lost last-write on process exit is an accepted limitation.
    // `#pending` tracks the in-flight promise purely so `flush()` (below, test-only -- never part
    // of `CiRecoveryObservabilityPort`) can await it deterministically; it is never read to decide
    // whether a *new* write should proceed.
    const write = writeJsonWithSchema(
      this.#store,
      this.#path(record.jobId),
      ciLogExcerptDiagnosticsRecordSchema,
      value,
      { visibility: "private" },
    )
      .catch(() => {
        // Best-effort diagnostic only; a write failure must never surface anywhere the repair
        // attempt itself can observe it.
      })
      .then(() => {
        this.#pending.delete(write);
      });
    this.#pending.add(write);
  }

  /** Test-only: awaits every write `recordCiLogExcerpt` has fired but not yet settled. Never part
   * of `CiRecoveryObservabilityPort` and never called from `CiRecoveryPipeline` -- production code
   * intentionally never waits on this adapter's I/O (see this class's own module header). */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.#pending]);
  }
}
