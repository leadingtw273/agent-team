/**
 * C015a: `--dry-run` support. Rather than duplicate `Dispatcher.dispatch()`'s own eligibility/
 * routing/decision logic to "just report what would happen," dry-run runs the real `Dispatcher`
 * against throwaway, in-memory-only `LeaseRepository`/`JobRepository` implementations -- so the
 * exact same engine code path is exercised (no drift between "what dry-run predicts" and "what a
 * real run does"), while guaranteeing zero mutation of any real file on disk: these two classes
 * never touch the filesystem at all.
 */
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import type {
  LeaseMutation,
  LeaseRepository,
  LeaseTransactionReceipt,
} from "../../application/leases/index.js";
import type { Job } from "../../domain/jobs/index.js";
import type { JobRepository, JobWriteReceipt } from "../../application/dispatch/index.js";
import type { Lease } from "../../domain/jobs/index.js";

export class InMemoryLeaseRepository implements LeaseRepository {
  #leases: readonly Lease[] = [];

  readAll(): Promise<Result<readonly Lease[], DomainError>> {
    return Promise.resolve(ok(this.#leases));
  }

  transact<Value>(
    transactionHolderId: string,
    mutate: (leases: readonly Lease[]) => Result<LeaseMutation<Value>, DomainError>,
  ): Promise<Result<LeaseTransactionReceipt<Value>, DomainError>> {
    if (transactionHolderId.trim().length === 0) {
      return Promise.resolve(err(domainError("invariant_violation")));
    }
    const mutation = mutate(this.#leases);
    if (!mutation.ok) return Promise.resolve(mutation);
    if (mutation.value.changed) this.#leases = mutation.value.leases;
    return Promise.resolve(
      ok({
        value: mutation.value.value,
        persistence: mutation.value.changed ? ("confirmed" as const) : ("unchanged" as const),
        lockRelease: "confirmed" as const,
      }),
    );
  }
}

export class InMemoryJobRepository implements JobRepository {
  #jobs: readonly Job[] = [];

  create(job: Job): Promise<Result<JobWriteReceipt, DomainError>> {
    if (this.#jobs.some((existing) => existing.id === job.id)) {
      return Promise.resolve(err(domainError("conflict")));
    }
    this.#jobs = [...this.#jobs, job];
    return Promise.resolve(ok({ durability: "confirmed" as const }));
  }

  list(): readonly Job[] {
    return this.#jobs;
  }
}
