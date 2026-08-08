/**
 * C015o decision 3: durable, atomically-CAS-guarded per-issue admission claim -- the authoritative
 * guard against dispatching a second `Job` for an issue that already has one unresolved, closing
 * the gap `dispatchOnce`'s own header comment (composition.ts) already disclosed: the per-issue
 * `Lease` (src/domain/jobs/lease.ts) only provides mutual exclusion for the duration of one
 * dispatch/resume *attempt* -- it is acquired and released around a single async call, never held
 * for a job's entire lifetime -- and `FileJobProgressStore` (job-progress-store.ts) only starts
 * tracking a job once its `ImplementerPipeline` reaches `ci_waiting` (a Draft PR exists), leaving a
 * durable-guard-free window from "Job created" through "PR opened". A `requires_manual` job sitting
 * unresolved for hours (a retryable reviewer-provider timeout, in the real incident this ticket
 * closes) has *no lease left* and *no PR-existence signal* blocking a fresh dispatch attempt for
 * the same Linear issue from creating a second, duplicate `Job`+PR.
 *
 * This store is a CLI/adapter-layer concern exactly like `FileJobProgressStore` -- it does not
 * touch `Job` (src/domain/jobs/schema.ts) or `Dispatcher.dispatch()` (src/application/dispatch/
 * dispatcher.ts) at all. The composition root (`dispatchOnce`, composition.ts) claims *before*
 * calling the unmodified `Dispatcher.dispatch()`, and reconciles (keeps the winning claim, releases
 * every other one) once `dispatch()` returns -- see that file's own comment for the exact sequence
 * and the residual race window this leaves open (disclosed, not hidden).
 *
 * File shape mirrors `FileJobProgressStore` deliberately (same lock/CAS/read-back machinery, same
 * `AtomicFileStore`) -- one JSON file per `projectId`+`issueId` composite key
 * (`${projectId}__${issueId}.json`), a sibling `.lock` file, an explicit numeric `revision` for
 * optimistic CAS, and `writeJsonWithSchema`'s mandatory read-back before a write is trusted.
 *
 * Terminal release policy (decision 3's own explicit rule, restated here so it cannot drift):
 * `release()` may only be called with reason `"completed"`, `"cancelled"`, `"superseded"`, or the
 * CLI-internal `"not_dispatched"` (a claim made *in anticipation* of a dispatch that ultimately
 * picked a different candidate, or dispatched nothing at all -- this claim never had a job attached
 * and was never itself "resolved" in the human sense, so it is a distinct reason from the other
 * three, which all describe a job's own real lifecycle ending). `requires_manual` -- and every
 * other non-terminal `JobProgressStage` -- is explicitly *not* a valid release reason: an
 * unresolved human hand-off is still unresolved, and letting a fresh dispatch attempt run again
 * while the original job is still stuck is exactly the bug this store exists to close. The only way
 * to release a claim whose job reached `requires_manual` is the explicit `dispatch resolve` CLI
 * command (decision 4), which requires a human to type a fixed confirmation phrase and choose
 * `superseded`/`cancelled` themselves -- never automatic.
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
import { jobIdSchema, projectIdSchema, issueIdSchema } from "../../domain/jobs/index.js";
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

export const issueAdmissionReleaseReasonSchema = z.enum([
  "completed",
  "cancelled",
  "superseded",
  "not_dispatched",
  // C016 fix: the *only* release reason not reachable through `dispatch resolve`'s normal
  // "resolve a job-progress record" model -- see `createDispatchResolveLegacyClaimHandler`
  // (legacy-claim-handlers.ts) for the full rationale. Exists solely for a claim that has *no*
  // job-progress record to resolve against at all (the exact bug this ticket closes: a `paused`
  // outcome that returned without ever persisting one). Deliberately never written by anything
  // other than that one handler, and always requires `releaseNote` below (a human-authored audit
  // trail of *why* this claim was recovered outside the normal model) -- this is a controlled
  // repair path, not a second, quieter way to release an ordinary stuck claim.
  "legacy_recovered",
]);

export type IssueAdmissionReleaseReason = z.infer<typeof issueAdmissionReleaseReasonSchema>;

/** C016 fix: required exactly when `releaseReason === "legacy_recovered"` (enforced below) --
 * the durable, on-disk audit trail `createDispatchResolveLegacyClaimHandler` leaves behind
 * instead of silently deleting or rewriting the claim file. Bounded the same way every other
 * free-text-ish field in this codebase's adapters layer is (never unbounded, never the reason to
 * reject a legitimate note). */
const releaseNoteSchema = z.string().trim().min(1).max(2000);

export const issueAdmissionRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    projectId: projectIdSchema,
    issueId: issueIdSchema,
    /** Absent until the real `Job` this claim is reserving space for is confirmed created --
     * `Dispatcher.dispatch()` generates the job id itself, internally, only once it has already
     * selected this exact candidate, so the claim is necessarily written *before* that id exists
     * and updated (`attachJob`) immediately after. A claim that stays jobless forever (a crash
     * between claiming and `dispatch()` returning) is not silently different from a jobless claim
     * that lost the reconcile race -- both need the same human `dispatch resolve` escape hatch. */
    jobId: jobIdSchema.optional(),
    state: z.enum(["active", "released"]),
    releaseReason: issueAdmissionReleaseReasonSchema.optional(),
    /** Set by `resolve` (decision 4) when `releaseReason === "superseded"` -- the job that
     * actually owns this issue going forward. Required exactly when superseded, absent otherwise
     * (enforced below, not left to convention). */
    supersededByJobId: jobIdSchema.optional(),
    /** C016 fix: set by `createDispatchResolveLegacyClaimHandler` when
     * `releaseReason === "legacy_recovered"` -- see that field's own schema comment. Required
     * exactly when legacy-recovered, absent otherwise (enforced below, the same pairing
     * discipline `supersededByJobId` above already established). */
    releaseNote: releaseNoteSchema.optional(),
    claimedAt: instantSchema,
    updatedAt: instantSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (record.state === "released" && record.releaseReason === undefined) {
      context.addIssue({
        code: "custom",
        message: "a released claim must record why",
        path: ["releaseReason"],
      });
    }
    if (record.state === "active" && record.releaseReason !== undefined) {
      context.addIssue({
        code: "custom",
        message: "an active claim must not carry a release reason",
        path: ["releaseReason"],
      });
    }
    if (record.releaseReason === "superseded" && record.supersededByJobId === undefined) {
      context.addIssue({
        code: "custom",
        message: "a superseded release must name the job that supersedes it",
        path: ["supersededByJobId"],
      });
    }
    if (record.releaseReason !== "superseded" && record.supersededByJobId !== undefined) {
      context.addIssue({
        code: "custom",
        message: "supersededByJobId is only meaningful for a superseded release",
        path: ["supersededByJobId"],
      });
    }
    if (record.releaseReason === "legacy_recovered" && record.releaseNote === undefined) {
      context.addIssue({
        code: "custom",
        message: "a legacy-recovered release must carry an audit note",
        path: ["releaseNote"],
      });
    }
    if (record.releaseReason !== "legacy_recovered" && record.releaseNote !== undefined) {
      context.addIssue({
        code: "custom",
        message: "releaseNote is only meaningful for a legacy-recovered release",
        path: ["releaseNote"],
      });
    }
  });

export type IssueAdmissionRecord = z.infer<typeof issueAdmissionRecordSchema>;

function isNotFound(error: DomainError): boolean {
  return error.code === "not_found";
}

function isValidCompositeKey(projectId: string, issueId: string): boolean {
  return parseIdentifier("project", projectId).ok && parseIdentifier("issue", issueId).ok;
}

/** Structural shape `dispatchOnce` (composition.ts) depends on -- satisfied by both the real
 * `FileIssueAdmissionStore` (below) and `--dry-run`'s `InMemoryIssueAdmissionStore`
 * (ephemeral-ports.ts), the same "Pick over a concrete class" convention this codebase already
 * uses for `LeaseRepository`/`JobRepository`. */
export interface IssueAdmissionPort {
  load(
    projectId: string,
    issueId: string,
  ): Promise<Result<IssueAdmissionRecord | undefined, DomainError>>;
  claim(projectId: string, issueId: string): Promise<Result<IssueAdmissionRecord, DomainError>>;
  attachJob(
    projectId: string,
    issueId: string,
    expectedRevision: number,
    jobId: string,
  ): Promise<Result<IssueAdmissionRecord, DomainError>>;
  release(
    projectId: string,
    issueId: string,
    expectedRevision: number,
    reason: IssueAdmissionReleaseReason,
    supersededByJobId?: string,
    /** C016 fix: required exactly when `reason === "legacy_recovered"` -- see
     * `releaseNoteSchema`'s own comment. */
    note?: string,
  ): Promise<Result<IssueAdmissionRecord, DomainError>>;
}

/** Mirrors `FileJobProgressStore` line for line in shape and locking discipline -- see this file's
 * own header for the rationale. `clock` stamps `updatedAt`/`claimedAt` on every write. */
export class FileIssueAdmissionStore implements IssueAdmissionPort {
  readonly #directory: string;
  readonly #store: AtomicFileStore;
  readonly #clock: Clock;

  constructor(
    directory: string,
    store: AtomicFileStore = new AtomicFileStore(),
    clock: Clock = createClock(),
  ) {
    if (!isAbsolute(directory)) throw new Error("issue_admission_root_must_be_absolute");
    this.#directory = directory;
    this.#store = store;
    this.#clock = clock;
  }

  #path(projectId: string, issueId: string): string {
    return join(this.#directory, `${projectId}__${issueId}.json`);
  }

  #lockPath(projectId: string, issueId: string): string {
    return `${this.#path(projectId, issueId)}.lock`;
  }

  async load(
    projectId: string,
    issueId: string,
    options: ReadOptions = {},
  ): Promise<Result<IssueAdmissionRecord | undefined, DomainError>> {
    if (!isValidCompositeKey(projectId, issueId) || options.signal?.aborted === true) {
      return err(domainError("invariant_violation"));
    }
    const loaded = await readJsonWithSchema(
      this.#path(projectId, issueId),
      issueAdmissionRecordSchema,
    );
    if (!loaded.ok) return isNotFound(loaded.error) ? ok(undefined) : loaded;
    return ok(loaded.value);
  }

  /**
   * Claims `issueId` for a not-yet-created `Job`. Fails closed with `conflict` if a record already
   * exists and is `state:"active"` -- this is the single atomic write every concurrent dispatcher
   * process contends on; exactly one caller racing on the same `(projectId, issueId)` at the same
   * moment can ever see this call succeed (guarded by `acquireRecoverableFileLock` on the same
   * path every other method here also locks). Claiming again after a genuine `release()` is
   * allowed (a fresh, later claim is not the same claim) and simply overwrites with a new
   * `claimedAt`.
   */
  async claim(
    projectId: string,
    issueId: string,
    options: ReadOptions = {},
  ): Promise<Result<IssueAdmissionRecord, DomainError>> {
    if (!isValidCompositeKey(projectId, issueId) || options.signal?.aborted === true) {
      return err(domainError("invariant_violation"));
    }
    const acquired = await acquireRecoverableFileLock(
      this.#lockPath(projectId, issueId),
      `issue-admission:${String(process.pid)}:${randomUUID()}`,
    );
    if (!acquired.ok) return acquired;
    const result = await this.#claimLocked(projectId, issueId);
    const released = await acquired.value.release();
    return !released.ok && result.ok ? released : result;
  }

  async #claimLocked(
    projectId: string,
    issueId: string,
  ): Promise<Result<IssueAdmissionRecord, DomainError>> {
    const current = await readJsonWithSchema(
      this.#path(projectId, issueId),
      issueAdmissionRecordSchema,
    );
    const normalizedCurrent = !current.ok && isNotFound(current.error) ? ok(undefined) : current;
    if (!normalizedCurrent.ok) return normalizedCurrent;
    if (normalizedCurrent.value?.state === "active") return err(domainError("conflict"));

    const now = this.#clock.now();
    const candidate = {
      schemaVersion: 1 as const,
      revision: (normalizedCurrent.value?.revision ?? -1) + 1,
      projectId,
      issueId,
      state: "active" as const,
      claimedAt: now,
      updatedAt: now,
    };
    return this.#writeValidated(projectId, issueId, candidate);
  }

  /** Fills in the real `jobId` once `Dispatcher.dispatch()` has confirmed one exists -- a CAS
   * update, never a fresh claim (the caller must already hold the claim it is attaching to). */
  async attachJob(
    projectId: string,
    issueId: string,
    expectedRevision: number,
    jobId: string,
    options: ReadOptions = {},
  ): Promise<Result<IssueAdmissionRecord, DomainError>> {
    const parsedJobId = jobIdSchema.safeParse(jobId);
    if (
      !isValidCompositeKey(projectId, issueId) ||
      !parsedJobId.success ||
      options.signal?.aborted === true
    ) {
      return err(domainError("invariant_violation"));
    }
    const acquired = await acquireRecoverableFileLock(
      this.#lockPath(projectId, issueId),
      `issue-admission:${String(process.pid)}:${randomUUID()}`,
    );
    if (!acquired.ok) return acquired;
    const result = await this.#mutateLocked(projectId, issueId, expectedRevision, (existing) => {
      if (existing.state !== "active") return err(domainError("conflict"));
      return ok({ ...existing, jobId: parsedJobId.data });
    });
    const released = await acquired.value.release();
    return !released.ok && result.ok ? released : result;
  }

  /** Releases a claim -- only ever with one of `issueAdmissionReleaseReasonSchema`'s fixed
   * reasons, never for `requires_manual` or any other non-terminal `JobProgressStage` (see this
   * file's own header). `expectedRevision` makes this a genuine CAS: a stale caller acting on an
   * outdated view of the claim fails closed with `conflict` rather than silently releasing a claim
   * a *different* process has since moved on. */
  async release(
    projectId: string,
    issueId: string,
    expectedRevision: number,
    reason: IssueAdmissionReleaseReason,
    supersededByJobId?: string,
    note?: string,
    options: ReadOptions = {},
  ): Promise<Result<IssueAdmissionRecord, DomainError>> {
    const parsedSupersededBy =
      supersededByJobId === undefined ? undefined : jobIdSchema.safeParse(supersededByJobId);
    const parsedNote = note === undefined ? undefined : releaseNoteSchema.safeParse(note);
    if (
      !isValidCompositeKey(projectId, issueId) ||
      (reason === "superseded") !== (supersededByJobId !== undefined) ||
      (reason === "legacy_recovered") !== (note !== undefined) ||
      (parsedSupersededBy !== undefined && !parsedSupersededBy.success) ||
      (parsedNote !== undefined && !parsedNote.success) ||
      options.signal?.aborted === true
    ) {
      return err(domainError("invariant_violation"));
    }
    const acquired = await acquireRecoverableFileLock(
      this.#lockPath(projectId, issueId),
      `issue-admission:${String(process.pid)}:${randomUUID()}`,
    );
    if (!acquired.ok) return acquired;
    const result = await this.#mutateLocked(projectId, issueId, expectedRevision, (existing) => {
      if (existing.state !== "active") return err(domainError("conflict"));
      return ok({
        ...existing,
        state: "released" as const,
        releaseReason: reason,
        ...(parsedSupersededBy?.success === true
          ? { supersededByJobId: parsedSupersededBy.data }
          : {}),
        ...(parsedNote?.success === true ? { releaseNote: parsedNote.data } : {}),
      });
    });
    const released = await acquired.value.release();
    return !released.ok && result.ok ? released : result;
  }

  async #mutateLocked(
    projectId: string,
    issueId: string,
    expectedRevision: number,
    mutate: (
      existing: IssueAdmissionRecord,
    ) => Result<Omit<IssueAdmissionRecord, "updatedAt">, DomainError>,
  ): Promise<Result<IssueAdmissionRecord, DomainError>> {
    const current = await readJsonWithSchema(
      this.#path(projectId, issueId),
      issueAdmissionRecordSchema,
    );
    if (!current.ok) return current;
    if (current.value.revision !== expectedRevision) return err(domainError("conflict"));
    const mutated = mutate(current.value);
    if (!mutated.ok) return mutated;
    const candidate = {
      ...mutated.value,
      revision: current.value.revision + 1,
      updatedAt: this.#clock.now(),
    };
    return this.#writeValidated(projectId, issueId, candidate);
  }

  async #writeValidated(
    projectId: string,
    issueId: string,
    candidate: unknown,
  ): Promise<Result<IssueAdmissionRecord, DomainError>> {
    const validated = issueAdmissionRecordSchema.safeParse(candidate);
    if (!validated.success) return err(domainError("invariant_violation"));
    const written = await writeJsonWithSchema(
      this.#store,
      this.#path(projectId, issueId),
      issueAdmissionRecordSchema,
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
