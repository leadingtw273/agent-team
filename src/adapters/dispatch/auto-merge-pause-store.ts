/**
 * E116cap: durable, per-project CAS record of whether this project's *future* auto-merge is
 * paused because a change request was observed merged out-of-process (bypassing this tool's own
 * Controller-authorized merge gate -- see `LifecyclePipeline.#handleMerge`,
 * src/application/pipelines/lifecycle.ts). This is the real backing capability C015v's own header
 * (lifecycle-policy-adapter.ts) explicitly deferred as "E116's own, separate, deliberately-deferred
 * scope": `NoOpAutoMergePauseAdapter` never wrote anything anywhere, so a project could suffer an
 * out-of-process merge and immediately have its *next* PR auto-merged with zero human awareness.
 *
 * This store answers a narrower question than C015v's `PauseAutoMergeOutcome` does. C015v's
 * `pauseAutoMerge` port call is always about one specific, already-merged change request -- and
 * for that *specific* PR there is, by construction, no live auto-merge left to cancel (that
 * semantics is preserved verbatim by `NoOpAutoMergePauseAdapter`, kept unchanged in
 * lifecycle-policy-adapter.ts). This store instead answers "is this *project* currently paused for
 * *future* auto-merge arm attempts" -- a project-wide quarantine flag, not a per-PR cancellation.
 * `FileAutoMergePauseAdapter` (lifecycle-policy-adapter.ts) is what bridges the two: it writes this
 * project-level flag when `LifecyclePipeline` observes an out-of-process merge, and honestly reports
 * `"paused"` for having done so (a real, durable, newly-possible action -- never `"not_applicable"`,
 * which would misreport that nothing happened).
 *
 * File shape mirrors `FileIssueAdmissionStore` (issue-admission-store.ts) more closely than
 * `FileJobProgressStore` (job-progress-store.ts): a single JSON file per `projectId`
 * (`${projectId}.json`), a sibling `.lock` file guarded by `acquireRecoverableFileLock`, an explicit
 * numeric `revision` for optimistic CAS, and `writeJsonWithSchema`'s mandatory read-back before a
 * write is trusted -- but, like `FileIssueAdmissionStore`'s `claim`/`release`, this store exposes
 * two narrow, purpose-built mutation methods (`pause`/`resolve`) rather than a generic
 * `compareAndSwap(expectedRevision, ...)`: every legal transition this store's business rules allow
 * is idempotent by construction (see each method's own header), so there is no legitimate caller
 * that needs to supply its own `expectedRevision` -- doing so would only add a footgun (a caller
 * racing itself with a stale revision) with no offsetting benefit.
 *
 * `evidence` is write-once, exactly like `JobProgressRecord.baseRevision`'s own documented
 * invariant (job-progress-store.ts): once a project is paused, a *second* out-of-process merge
 * observed while still paused never overwrites the original evidence -- the first incident is what
 * a human resolving the pause needs to see, not whichever one happened to be observed most
 * recently.
 */
import { randomUUID } from "node:crypto";
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
import { projectIdSchema } from "../../domain/jobs/index.js";
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

/** Decimal PR number, never GitHub's opaque node id -- same rationale, and same shape, as
 * `job-progress-store.ts`'s own `changeRequestNumberSchema` (O009c's lesson, restated there). */
const changeRequestNumberSchema = z.string().regex(/^\d+$/u).max(20);

const mergedHeadShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu);

export const autoMergePauseEvidenceSchema = z
  .object({
    changeRequestId: changeRequestNumberSchema,
    mergedHeadSha: mergedHeadShaSchema,
  })
  .strict();
export type AutoMergePauseEvidence = z.infer<typeof autoMergePauseEvidenceSchema>;

export const autoMergePauseStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("active") }).strict(),
  z
    .object({
      state: z.literal("paused"),
      reason: z.literal("out_of_process_merge"),
      pausedAt: instantSchema,
      evidence: autoMergePauseEvidenceSchema,
    })
    .strict(),
]);
export type AutoMergePauseStatus = z.infer<typeof autoMergePauseStatusSchema>;

export const autoMergePauseRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    projectId: projectIdSchema,
    status: autoMergePauseStatusSchema,
    updatedAt: instantSchema,
  })
  .strict();
export type AutoMergePauseRecord = z.infer<typeof autoMergePauseRecordSchema>;

function isNotFound(error: DomainError): boolean {
  return error.code === "not_found";
}

function isValidProjectId(projectId: string): boolean {
  return parseIdentifier("project", projectId).ok;
}

/**
 * Mirrors `FileIssueAdmissionStore`/`FileJobProgressStore` in locking/atomic-write discipline (see
 * this file's own header). `clock` stamps `updatedAt`/`pausedAt` on every write the caller never
 * supplies directly.
 */
export class FileAutoMergePauseStore {
  readonly #directory: string;
  readonly #store: AtomicFileStore;
  readonly #clock: Clock;

  constructor(
    directory: string,
    store: AtomicFileStore = new AtomicFileStore(),
    clock: Clock = createClock(),
  ) {
    if (!isAbsolute(directory)) throw new Error("auto_merge_pause_root_must_be_absolute");
    this.#directory = directory;
    this.#store = store;
    this.#clock = clock;
  }

  #path(projectId: string): string {
    return join(this.#directory, `${projectId}.json`);
  }

  #lockPath(projectId: string): string {
    return `${this.#path(projectId)}.lock`;
  }

  async load(
    projectId: string,
    options: ReadOptions = {},
  ): Promise<Result<AutoMergePauseRecord | undefined, DomainError>> {
    if (!isValidProjectId(projectId) || options.signal?.aborted === true) {
      return err(domainError("invariant_violation"));
    }
    const loaded = await readJsonWithSchema(this.#path(projectId), autoMergePauseRecordSchema);
    if (!loaded.ok) return isNotFound(loaded.error) ? ok(undefined) : loaded;
    return ok(loaded.value);
  }

  /**
   * Idempotent: if the project is already `"paused"`, returns the existing record unchanged --
   * never overwrites the original `evidence`/`pausedAt` with a second observation (see this file's
   * own header on why that write-once behavior is deliberate). Only a project that is currently
   * `"active"` (or has no record at all) actually transitions, exactly once, under this method's
   * own lock -- there is no caller-supplied `expectedRevision` to race against.
   */
  async pause(
    projectId: string,
    evidence: AutoMergePauseEvidence,
    options: ReadOptions = {},
  ): Promise<Result<AutoMergePauseRecord, DomainError>> {
    const parsedEvidence = autoMergePauseEvidenceSchema.safeParse(evidence);
    if (
      !isValidProjectId(projectId) ||
      !parsedEvidence.success ||
      options.signal?.aborted === true
    ) {
      return err(domainError("invariant_violation"));
    }
    const acquired = await acquireRecoverableFileLock(
      this.#lockPath(projectId),
      `auto-merge-pause:${String(process.pid)}:${randomUUID()}`,
    );
    if (!acquired.ok) return acquired;
    const result = await this.#pauseLocked(projectId, parsedEvidence.data);
    const released = await acquired.value.release();
    return !released.ok && result.ok ? released : result;
  }

  async #pauseLocked(
    projectId: string,
    evidence: AutoMergePauseEvidence,
  ): Promise<Result<AutoMergePauseRecord, DomainError>> {
    const current = await readJsonWithSchema(this.#path(projectId), autoMergePauseRecordSchema);
    const normalizedCurrent = !current.ok && isNotFound(current.error) ? ok(undefined) : current;
    if (!normalizedCurrent.ok) return normalizedCurrent;
    if (normalizedCurrent.value?.status.state === "paused") return ok(normalizedCurrent.value);

    const now = this.#clock.now();
    const candidate = {
      schemaVersion: 1 as const,
      revision: (normalizedCurrent.value?.revision ?? -1) + 1,
      projectId,
      status: {
        state: "paused" as const,
        reason: "out_of_process_merge" as const,
        pausedAt: now,
        evidence,
      },
      updatedAt: now,
    };
    return this.#writeValidated(projectId, candidate);
  }

  /**
   * Idempotent: if the project has no record at all, or is already `"active"`, returns the
   * existing record (or `undefined` for "never paused") unchanged -- resolving a project that was
   * never paused, or that a concurrent `resolve` already cleared, is not an error. Only a project
   * currently `"paused"` actually transitions, exactly once, under this method's own lock.
   */
  async resolve(
    projectId: string,
    options: ReadOptions = {},
  ): Promise<Result<AutoMergePauseRecord | undefined, DomainError>> {
    if (!isValidProjectId(projectId) || options.signal?.aborted === true) {
      return err(domainError("invariant_violation"));
    }
    const acquired = await acquireRecoverableFileLock(
      this.#lockPath(projectId),
      `auto-merge-pause:${String(process.pid)}:${randomUUID()}`,
    );
    if (!acquired.ok) return acquired;
    const result = await this.#resolveLocked(projectId);
    const released = await acquired.value.release();
    return !released.ok && result.ok ? released : result;
  }

  async #resolveLocked(
    projectId: string,
  ): Promise<Result<AutoMergePauseRecord | undefined, DomainError>> {
    const current = await readJsonWithSchema(this.#path(projectId), autoMergePauseRecordSchema);
    const normalizedCurrent = !current.ok && isNotFound(current.error) ? ok(undefined) : current;
    if (!normalizedCurrent.ok) return normalizedCurrent;
    if (
      normalizedCurrent.value === undefined ||
      normalizedCurrent.value.status.state === "active"
    ) {
      return ok(normalizedCurrent.value);
    }

    const candidate = {
      schemaVersion: 1 as const,
      revision: normalizedCurrent.value.revision + 1,
      projectId,
      status: { state: "active" as const },
      updatedAt: this.#clock.now(),
    };
    return this.#writeValidated(projectId, candidate);
  }

  async #writeValidated(
    projectId: string,
    candidate: unknown,
  ): Promise<Result<AutoMergePauseRecord, DomainError>> {
    const validated = autoMergePauseRecordSchema.safeParse(candidate);
    if (!validated.success) return err(domainError("invariant_violation"));
    const written = await writeJsonWithSchema(
      this.#store,
      this.#path(projectId),
      autoMergePauseRecordSchema,
      validated.data,
      { visibility: "private" },
    );
    if (!written.ok) return written;
    if (written.value.durability !== "confirmed" || !written.value.readBack.ok) {
      return err(domainError("external_failure"));
    }
    return ok(written.value.readBack.value);
  }
}
