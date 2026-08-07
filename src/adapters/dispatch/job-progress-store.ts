/**
 * C015c item 1: durable, per-job CAS progress index for the CLI's own dispatch-run scheduling --
 * approved by the decision layer after an escalation confirmed `Job` (src/domain/jobs/schema.ts)
 * carries no lifecycle/state field at all, and F004's `WorkStatus` (src/domain/workflow/) governs
 * the Linear *Issue*, not `Job`. This store is a host-connection-layer concern, deliberately kept
 * out of `src/domain` and `src/application` -- the same precedent as O005's setup-session journal
 * and O006's probe journal (`src/adapters/registration/proactive-probe-journal.ts`), both of which
 * also keep "where did this multi-step host operation get to" entirely in adapters.
 *
 * **`stage` is not F004's `WorkStatus`, and the two must never be conflated.** `WorkStatus`
 * (backlog/ready/in_progress/in_review/completed/canceled) is the Linear issue's own state
 * machine, transitioned only through `transitionWorkStatus`/`WorkManagementPort.setWorkStatus`.
 * `JobProgressStage` below is a CLI-internal scheduling label with no engine meaning whatsoever --
 * it exists solely so a later `agent-team run` invocation (a fresh process) can find "which of my
 * own jobs got how far" without any engine changes. Do not add a case to this union expecting it
 * to influence, or be influenced by, `WorkStatus` transitions.
 *
 * File shape mirrors `FileRegistrationProbeJournalStore` exactly: one JSON file per job id
 * (`${jobId}.json`), a sibling `.lock` file guarded by a recoverable kernel-held lock
 * (`acquireRecoverableFileLock`), an explicit numeric `revision` for optimistic CAS
 * (`compareAndSwap(jobId, expectedRevision, mutation)` -- `expectedRevision: null` means "must not
 * exist yet"), and `writeJsonWithSchema`'s mandatory read-back before a write is trusted.
 *
 * `changeRequestId` is the decimal PR number as a **string** -- O009c's own lesson, restated here
 * because it is exactly the kind of value a naive implementation gets wrong twice: GitHub's
 * `ChangeRequestSnapshot.id` is an opaque GraphQL node id, *not* the same value
 * `ChangeRequestRef.changeRequestId` (a decimal string) expects. Storing the node id here would
 * make every future resume attempt fail to look the PR back up.
 */
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { z } from "zod";

import type { ReadOptions } from "../../application/ports/index.js";
import {
  createClock,
  domainError,
  err,
  ok,
  parseIdentifier,
  canonicalInstantPattern,
  parseInstant,
  type Clock,
  type DomainError,
  type Instant,
  type Result,
} from "../../domain/foundation/index.js";
import { checkpointIdSchema } from "../../domain/checkpoint/index.js";
import { jobIdSchema, projectIdSchema, issueIdSchema } from "../../domain/jobs/index.js";
import { headShaSchema } from "../../domain/review/index.js";
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

/** Decimal PR number, never the opaque GitHub node id -- see this file's own header (O009c). */
const changeRequestNumberSchema = z.string().regex(/^\d+$/u).max(20);

/** Bounded, structural cap only -- the *policy* cap (2 attempts, decision 2's
 * `reviewProviderRetries`/`ciProviderRetries`) is enforced by resume-composition.ts before it ever
 * writes a record with this stage; this schema-level bound exists only to keep the field itself
 * sane (never negative, never absurdly large) regardless of caller bugs. */
const providerRetryCountSchema = z.number().int().min(0).max(100);
/** The `DomainError.code` string that caused this retry -- purely for a human/log to read (see
 * this store's own header: `stage` carries no engine meaning). Not re-validated against
 * `DomainErrorCode`'s fixed enum here deliberately -- this file must never need to import that
 * enum just to stay in sync with it; resume-composition.ts is what decides whether a code is
 * `retryable` before ever reaching this stage at all. */
const lastErrorCodeSchema = z.string().trim().min(1).max(64);

export const jobProgressStageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("implementing") }).strict(),
  z.object({ kind: z.literal("ci_waiting") }).strict(),
  z.object({ kind: z.literal("awaiting_review") }).strict(),
  z.object({ kind: z.literal("fix_round") }).strict(),
  z.object({ kind: z.literal("merging") }).strict(),
  z.object({ kind: z.literal("completed") }).strict(),
  z.object({ kind: z.literal("failed") }).strict(),
  // References a real domain Checkpoint (src/domain/checkpoint/) -- checkpoint's own paused/
  // human-handoff semantics are unchanged; this is only a pointer so a resume attempt knows one
  // exists, per the decision layer's "進度檔與 checkpoint 並存不互斥" instruction.
  z.object({ kind: z.literal("paused"), checkpointId: checkpointIdSchema }).strict(),
  // A resume attempt found the recorded state did not match live reality (branch/head SHA/open
  // status mismatch) -- fail-closed: never guessed at, never auto-corrected, left for a human.
  z.object({ kind: z.literal("requires_manual") }).strict(),
  // C015o decision 2: `ReviewerPipeline.run()`/`CiRecoveryPipeline.run()` returned `state:"failed"`
  // with a *retryable* `DomainError` (timeout/unavailable/rate_limited/quota_unknown/interrupted)
  // at a provider-invocation stage -- not a state mismatch, not a permission/invariant/conflict
  // error, which still go straight to `requires_manual`. Resumable (see `resumableStageKinds`
  // below) up to a fixed attempt cap tracked by `retries`; the cap itself is enforced by
  // resume-composition.ts, which transitions to `requires_manual` once exhausted.
  z
    .object({
      kind: z.literal("review_pending_retry"),
      retries: providerRetryCountSchema,
      lastErrorCode: lastErrorCodeSchema,
    })
    .strict(),
  // Symmetric to `review_pending_retry`, for `CiRecoveryPipeline.run()`'s own retryable
  // `provider_start`/`provider_run` failures -- named to pair visibly with its reviewer sibling.
  z
    .object({
      kind: z.literal("ci_pending_retry"),
      retries: providerRetryCountSchema,
      lastErrorCode: lastErrorCodeSchema,
    })
    .strict(),
  // C015o decision 4: an explicit, human-issued terminal verdict via `agent-team dispatch resolve`
  // -- this job's own work is being abandoned in favor of `supersededByJobId` (a different job that
  // now owns this issue, e.g. after a duplicate-dispatch incident). Never written automatically.
  z.object({ kind: z.literal("superseded"), supersededByJobId: jobIdSchema }).strict(),
  // C015o decision 4: an explicit, human-issued terminal verdict via `agent-team dispatch resolve`
  // -- this job's work is abandoned outright, no successor job. Never written automatically.
  z.object({ kind: z.literal("cancelled") }).strict(),
]);

export type JobProgressStage = z.infer<typeof jobProgressStageSchema>;

export const jobProgressRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    jobId: jobIdSchema,
    projectId: projectIdSchema,
    issueId: issueIdSchema,
    /** C015c item 2: the raw Linear issue id (never the derived domain `issueId` above, which is
     * a one-way `generateDeterministicIdentifier` hash -- unrecoverable from the domain id alone).
     * A resume attempt in a *fresh process* has nothing else that can look the Linear issue back
     * up to re-derive `Issue`/`RequirementSnapshot` for `CiRecoveryPipeline`/`ReviewerPipeline`. */
    externalIssueId: z.string().trim().min(1).max(255),
    /** C015c item 2: the model string the original dispatch decision selected. Not derivable from
     * anything else a fresh process has on hand (it is a runtime routing decision, not a pure
     * function of `Issue`) -- without this, a resumed job could not build a valid
     * `CiRecoveryPipelineRequest`/`ReviewerPipelineRequest`. */
    model: z.string().trim().min(1).max(255),
    stage: jobProgressStageSchema,
    branch: z.string().trim().min(1).max(255),
    worktreePath: z.string().startsWith("/").min(2).max(1024),
    changeRequestId: changeRequestNumberSchema.optional(),
    headSha: headShaSchema.optional(),
    updatedAt: instantSchema,
  })
  .strict();

export type JobProgressRecord = z.infer<typeof jobProgressRecordSchema>;
/** The caller never supplies `schemaVersion` (always `1`, stamped by the store itself -- see
 * `compareAndSwap`) nor `revision`/`updatedAt` (computed by the store on every write). */
export type JobProgressRecordMutation = Omit<
  JobProgressRecord,
  "schemaVersion" | "revision" | "updatedAt"
>;

function isNotFound(error: DomainError): boolean {
  return error.code === "not_found";
}

/**
 * Mirrors `FileRegistrationProbeJournalStore` (src/adapters/registration/proactive-probe-journal.ts)
 * line for line in shape -- see this file's own header for why. `clock` stamps `updatedAt` on every
 * `compareAndSwap` (the caller never supplies it directly, so every record's timestamp reflects
 * when the store actually wrote it, not when the caller happened to compute the mutation).
 */
export class FileJobProgressStore {
  readonly #directory: string;
  readonly #store: AtomicFileStore;
  readonly #clock: Clock;

  constructor(
    directory: string,
    store: AtomicFileStore = new AtomicFileStore(),
    clock: Clock = createClock(),
  ) {
    if (!isAbsolute(directory)) throw new Error("job_progress_root_must_be_absolute");
    this.#directory = directory;
    this.#store = store;
    this.#clock = clock;
  }

  #path(jobId: string): string {
    return join(this.#directory, `${jobId}.json`);
  }

  #lockPath(jobId: string): string {
    return `${this.#path(jobId)}.lock`;
  }

  async load(
    jobId: string,
    options: ReadOptions = {},
  ): Promise<Result<JobProgressRecord | undefined, DomainError>> {
    if (!isValidJobId(jobId) || options.signal?.aborted === true) {
      return err(domainError("invariant_violation"));
    }
    const loaded = await readJsonWithSchema(this.#path(jobId), jobProgressRecordSchema);
    if (!loaded.ok) return isNotFound(loaded.error) ? ok(undefined) : loaded;
    return ok(loaded.value);
  }

  async compareAndSwap(
    jobId: string,
    expectedRevision: number | null,
    next: JobProgressRecordMutation,
    options: ReadOptions = {},
  ): Promise<Result<JobProgressRecord, DomainError>> {
    if (!isValidJobId(jobId) || next.jobId !== jobId || options.signal?.aborted === true) {
      return err(domainError("invariant_violation"));
    }
    const acquired = await acquireRecoverableFileLock(
      this.#lockPath(jobId),
      `job-progress:${String(process.pid)}:${randomUUID()}`,
    );
    if (!acquired.ok) return acquired;
    const result = await this.#compareAndSwapLocked(jobId, expectedRevision, next);
    const released = await acquired.value.release();
    return !released.ok && result.ok ? released : result;
  }

  async #compareAndSwapLocked(
    jobId: string,
    expectedRevision: number | null,
    next: JobProgressRecordMutation,
  ): Promise<Result<JobProgressRecord, DomainError>> {
    const current = await readJsonWithSchema(this.#path(jobId), jobProgressRecordSchema);
    const normalizedCurrent = !current.ok && isNotFound(current.error) ? ok(undefined) : current;
    if (!normalizedCurrent.ok) return normalizedCurrent;
    if (expectedRevision === null) {
      if (normalizedCurrent.value !== undefined) return err(domainError("conflict"));
    } else if (normalizedCurrent.value?.revision !== expectedRevision) {
      return err(domainError("conflict"));
    }

    const candidate = {
      ...next,
      schemaVersion: 1 as const,
      revision: (normalizedCurrent.value?.revision ?? -1) + 1,
      updatedAt: this.#clock.now(),
    };
    const validated = jobProgressRecordSchema.safeParse(candidate);
    if (!validated.success) return err(domainError("invariant_violation"));

    const written = await writeJsonWithSchema(
      this.#store,
      this.#path(jobId),
      jobProgressRecordSchema,
      validated.data,
      { visibility: "private" },
    );
    if (!written.ok) return written;
    if (written.value.durability !== "confirmed" || !written.value.readBack.ok) {
      return err(domainError("external_failure"));
    }
    return ok(written.value.readBack.value);
  }

  /** Returns every progress record for a project, any stage -- deliberately not pre-filtered to
   * "resumable" stages: that is a scheduling decision for the caller (item 2's composition), not
   * this store's job. */
  async listForProject(
    projectId: string,
    options: ReadOptions = {},
  ): Promise<Result<readonly JobProgressRecord[], DomainError>> {
    const parsedProjectId = parseIdentifier("project", projectId);
    if (!parsedProjectId.ok || options.signal?.aborted === true) {
      return err(domainError("invariant_violation"));
    }
    let entries: string[];
    try {
      entries = (await readdir(this.#directory)).filter((name) => name.endsWith(".json"));
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return ok(Object.freeze([]));
      }
      return err(domainError("external_failure"));
    }

    const records: JobProgressRecord[] = [];
    for (const entry of entries.sort()) {
      const loaded = await readJsonWithSchema(
        join(this.#directory, entry),
        jobProgressRecordSchema,
      );
      if (!loaded.ok) {
        if (isNotFound(loaded.error)) continue;
        return loaded;
      }
      if (`${loaded.value.jobId}.json` !== entry) return err(domainError("invariant_violation"));
      if (loaded.value.projectId !== projectId) continue;
      records.push(loaded.value);
    }
    return ok(Object.freeze(records));
  }
}

function isValidJobId(jobId: string): boolean {
  return parseIdentifier("job", jobId).ok;
}
