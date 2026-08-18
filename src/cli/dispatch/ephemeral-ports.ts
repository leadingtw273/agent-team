/**
 * C015a: `--dry-run` support. Rather than duplicate `Dispatcher.dispatch()`'s own eligibility/
 * routing/decision logic to "just report what would happen," dry-run runs the real `Dispatcher`
 * against throwaway, in-memory-only `LeaseRepository`/`JobRepository` implementations -- so the
 * exact same engine code path is exercised (no drift between "what dry-run predicts" and "what a
 * real run does"), while guaranteeing zero mutation of any real file on disk: these two classes
 * never touch the filesystem at all.
 */
import {
  createClock,
  domainError,
  err,
  ok,
  type Clock,
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
import type {
  IssueAdmissionRecord,
  IssueAdmissionReleaseReason,
} from "../../adapters/dispatch/issue-admission-store.js";

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

/**
 * C015o decision 3: the same "throwaway, in-memory-only" convention as
 * `InMemoryLeaseRepository`/`InMemoryJobRepository` above, extended to the new per-issue admission
 * claim (src/adapters/dispatch/issue-admission-store.ts) -- `dispatchOnce` (composition.ts) claims
 * unconditionally before calling `Dispatcher.dispatch()`, so `--dry-run` needs *some* admission
 * port to satisfy that same code path (never a special-cased skip), and this guarantees zero
 * mutation of the real, durable admission store on disk. Starting empty every invocation is the
 * same accepted limitation `InMemoryLeaseRepository`/`InMemoryJobRepository` already have: a
 * `--dry-run` prediction cannot reflect a *real* lease/job/claim that already exists from a prior
 * genuine run -- not a new regression this ticket introduces.
 */
export class InMemoryIssueAdmissionStore {
  #records = new Map<string, IssueAdmissionRecord>();
  readonly #clock: Clock;

  constructor(clock: Clock = createClock()) {
    this.#clock = clock;
  }

  #key(projectId: string, issueId: string): string {
    return `${projectId}__${issueId}`;
  }

  load(
    projectId: string,
    issueId: string,
  ): Promise<Result<IssueAdmissionRecord | undefined, DomainError>> {
    return Promise.resolve(ok(this.#records.get(this.#key(projectId, issueId))));
  }

  claim(
    projectId: string,
    issueId: string,
    externalIssueId?: string,
  ): Promise<Result<IssueAdmissionRecord, DomainError>> {
    const key = this.#key(projectId, issueId);
    const existing = this.#records.get(key);
    if (existing?.state === "active") return Promise.resolve(err(domainError("conflict")));
    const now = this.#clock.now();
    const record = {
      schemaVersion: 1 as const,
      revision: (existing?.revision ?? -1) + 1,
      projectId,
      issueId,
      ...(externalIssueId === undefined ? {} : { externalIssueId }),
      state: "active" as const,
      claimedAt: now,
      updatedAt: now,
    } as IssueAdmissionRecord;
    this.#records.set(key, record);
    return Promise.resolve(ok(record));
  }

  attachJob(
    projectId: string,
    issueId: string,
    expectedRevision: number,
    jobId: string,
  ): Promise<Result<IssueAdmissionRecord, DomainError>> {
    const key = this.#key(projectId, issueId);
    const existing = this.#records.get(key);
    if (existing?.revision !== expectedRevision || existing.state !== "active") {
      return Promise.resolve(err(domainError("conflict")));
    }
    const updated = {
      ...existing,
      jobId,
      revision: existing.revision + 1,
      updatedAt: this.#clock.now(),
    } as IssueAdmissionRecord;
    this.#records.set(key, updated);
    return Promise.resolve(ok(updated));
  }

  release(
    projectId: string,
    issueId: string,
    expectedRevision: number,
    reason: IssueAdmissionReleaseReason,
    supersededByJobId?: string,
  ): Promise<Result<IssueAdmissionRecord, DomainError>> {
    const key = this.#key(projectId, issueId);
    const existing = this.#records.get(key);
    if (existing?.revision !== expectedRevision || existing.state !== "active") {
      return Promise.resolve(err(domainError("conflict")));
    }
    const updated = {
      ...existing,
      state: "released" as const,
      releaseReason: reason,
      ...(supersededByJobId === undefined ? {} : { supersededByJobId }),
      revision: existing.revision + 1,
      updatedAt: this.#clock.now(),
    } as IssueAdmissionRecord;
    this.#records.set(key, updated);
    return Promise.resolve(ok(updated));
  }
}
