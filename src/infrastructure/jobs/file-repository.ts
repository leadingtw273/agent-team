/**
 * C015a: the first real implementation of `JobRepository` (src/application/dispatch/
 * dispatcher.ts) -- the engine interface has existed since C001-C014 but had zero production
 * composition. Mirrors `FileLeaseRepository` (src/infrastructure/leases/file-repository.ts)
 * exactly: a single JSON collection file, atomic write via `AtomicFileStore` (0600 by default),
 * schema read-back, and a file lock guarding the read-modify-write. Unlike leases (which need
 * arbitrary `transact`), `JobRepository`'s only operation is `create` -- once a job is written it
 * is never mutated by this repository again (C015b's pipeline owns the job's lifecycle from
 * there), so this file only ever appends.
 */
import { isAbsolute } from "node:path";

import { z } from "zod";

import type { JobRepository, JobWriteReceipt } from "../../application/dispatch/index.js";
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

    const lock = await acquireFileLock(this.lockPath, `file-job-repository:${parsedJob.data.id}`);
    if (!lock.ok) return lock;
    const operation = await this.#createLocked(parsedJob.data);
    await lock.value.release();
    return operation;
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
}
