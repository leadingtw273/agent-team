/**
 * C015a: the first real implementation of `JobRepository` (src/application/dispatch/
 * dispatcher.ts) -- the engine interface has existed since C001-C014 but had zero production
 * composition. Mirrors `FileLeaseRepository` (src/infrastructure/leases/file-repository.ts)
 * exactly: a single JSON collection file, atomic write via `AtomicFileStore` (0600 by default),
 * schema read-back, and a file lock guarding the read-modify-write.
 *
 * C015c item 1 extension: `update(job, options)` -- a read-modify-write-under-lock replace of one
 * job by id, mirroring `create()`'s own lock/read/write/read-back shape. This is deliberately
 * *not* added to the `JobRepository` application-layer interface (src/application/dispatch/
 * dispatcher.ts stays byte-for-byte unmodified) -- it exists here only so the engine's own,
 * separately-declared narrower job-mutation ports (`ReviewerJobPort`, `CiRecoveryJobPort` --
 * both already `update(job, options)`-shaped, in reviewer-model.ts/ci-recovery-model.ts) have a
 * real adapter to delegate to when C015c's composition wires them up. `create()` itself is
 * unchanged: a job is still only ever appended once by the dispatcher; `update()` is for the
 * pipelines that own a job's lifecycle *after* that (consuming `attempts`, recording `startedAt`).
 */
import { isAbsolute } from "node:path";

import { z } from "zod";

import type { JobRepository, JobWriteReceipt } from "../../application/dispatch/index.js";
import type { MutationOptions } from "../../application/ports/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import { jobSchema, type Job } from "../../domain/jobs/index.js";
import {
  acquireFileLock,
  AtomicFileStore,
  readJsonWithSchema,
  writeJsonWithSchema,
  runWithInProcessSerialization,
} from "../files/index.js";

const jobCollectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobs: z.array(jobSchema).max(100_000),
  })
  .strict()
  .superRefine((collection, context) => {
    const ids = collection.jobs.map((job) => job.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: "Job IDs must be unique.",
        path: ["jobs"],
      });
    }
  });

interface JobCollection {
  readonly schemaVersion: 1;
  readonly jobs: readonly Job[];
}

function freezeJobs(jobs: readonly Job[]): readonly Job[] {
  return Object.freeze(jobs.map((job) => Object.freeze({ ...job })));
}

export class FileJobRepository implements JobRepository {
  readonly #store: AtomicFileStore;

  constructor(
    readonly filePath: string,
    readonly lockPath: string,
    store = new AtomicFileStore(),
  ) {
    this.#store = store;
  }

  async readAll(): Promise<Result<readonly Job[], DomainError>> {
    if (!isAbsolute(this.filePath) || !isAbsolute(this.lockPath)) {
      return err(domainError("invariant_violation"));
    }
    const collection = await readJsonWithSchema(this.filePath, jobCollectionSchema);
    if (!collection.ok) {
      return collection.error.code === "not_found" ? ok(Object.freeze([])) : collection;
    }
    return ok(freezeJobs(collection.value.jobs));
  }

  async create(job: Job): Promise<Result<JobWriteReceipt, DomainError>> {
    if (!isAbsolute(this.filePath) || !isAbsolute(this.lockPath)) {
      return err(domainError("invariant_violation"));
    }
    const parsedJob = jobSchema.safeParse(job);
    if (!parsedJob.success) return err(domainError("invariant_violation"));

    return runWithInProcessSerialization(this.lockPath, async () => {
      const lock = await acquireFileLock(this.lockPath, `file-job-repository:${parsedJob.data.id}`);
      if (!lock.ok) return lock;
      const operation = await this.#createLocked(parsedJob.data);
      await lock.value.release();
      return operation;
    });
  }

  async #createLocked(job: Job): Promise<Result<JobWriteReceipt, DomainError>> {
    const current = await this.readAll();
    if (!current.ok) return current;
    if (current.value.some((existing) => existing.id === job.id)) {
      return err(domainError("conflict"));
    }

    const collection: JobCollection = {
      schemaVersion: 1,
      jobs: [...current.value, job],
    };
    const persisted = await writeJsonWithSchema(
      this.#store,
      this.filePath,
      jobCollectionSchema,
      collection,
    );
    if (!persisted.ok) return persisted;
    if (!persisted.value.readBack.ok) return persisted.value.readBack;
    return ok(Object.freeze({ durability: persisted.value.durability }));
  }

  async update(job: Job, options: MutationOptions): Promise<Result<JobWriteReceipt, DomainError>> {
    if (!isAbsolute(this.filePath) || !isAbsolute(this.lockPath)) {
      return err(domainError("invariant_violation"));
    }
    if (options.idempotencyKey.trim().length === 0) {
      return err(domainError("invariant_violation"));
    }
    const parsedJob = jobSchema.safeParse(job);
    if (!parsedJob.success) return err(domainError("invariant_violation"));

    return runWithInProcessSerialization(this.lockPath, async () => {
      const lock = await acquireFileLock(
        this.lockPath,
        `file-job-repository:update:${parsedJob.data.id}`,
      );
      if (!lock.ok) return lock;
      const operation = await this.#updateLocked(parsedJob.data);
      await lock.value.release();
      return operation;
    });
  }

  async #updateLocked(job: Job): Promise<Result<JobWriteReceipt, DomainError>> {
    const current = await this.readAll();
    if (!current.ok) return current;
    const index = current.value.findIndex((existing) => existing.id === job.id);
    if (index === -1) return err(domainError("not_found"));
    const existing = current.value[index];
    if (
      existing?.projectId !== job.projectId ||
      existing.issueId !== job.issueId ||
      existing.createdAt !== job.createdAt ||
      job.attempts.processRecoveries < existing.attempts.processRecoveries ||
      job.attempts.ciFixRounds < existing.attempts.ciFixRounds ||
      job.attempts.reviewerFixRounds < existing.attempts.reviewerFixRounds ||
      job.attempts.reviewRuns < existing.attempts.reviewRuns
    ) {
      return err(domainError("invariant_violation"));
    }

    const nextJobs = current.value.slice();
    nextJobs[index] = job;
    const collection: JobCollection = { schemaVersion: 1, jobs: nextJobs };
    const persisted = await writeJsonWithSchema(
      this.#store,
      this.filePath,
      jobCollectionSchema,
      collection,
    );
    if (!persisted.ok) return persisted;
    if (!persisted.value.readBack.ok) return persisted.value.readBack;
    return ok(Object.freeze({ durability: persisted.value.durability }));
  }
}
