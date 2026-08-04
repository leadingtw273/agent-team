import { isAbsolute } from "node:path";

import { z } from "zod";

import type {
  LeaseMutation,
  LeaseRepository,
  LeaseTransactionReceipt,
} from "../../application/leases/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import { leaseSchema, type Lease } from "../../domain/jobs/index.js";
import {
  acquireFileLock,
  AtomicFileStore,
  readJsonWithSchema,
  writeJsonWithSchema,
} from "../files/index.js";

const leaseCollectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    leases: z.array(leaseSchema).max(100_000),
  })
  .strict()
  .superRefine((collection, context) => {
    const ids = collection.leases.map((lease) => lease.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: "Lease IDs must be unique.",
        path: ["leases"],
      });
    }
  });

interface LeaseCollection {
  readonly schemaVersion: 1;
  readonly leases: readonly Lease[];
}

function freezeLeases(leases: readonly Lease[]): readonly Lease[] {
  return Object.freeze(leases.map((lease) => Object.freeze({ ...lease })));
}

export class FileLeaseRepository implements LeaseRepository {
  readonly #store: AtomicFileStore;

  constructor(
    readonly filePath: string,
    readonly lockPath: string,
    store = new AtomicFileStore(),
  ) {
    this.#store = store;
  }

  async readAll(): Promise<Result<readonly Lease[], DomainError>> {
    if (!isAbsolute(this.filePath) || !isAbsolute(this.lockPath)) {
      return err(domainError("invariant_violation"));
    }
    const collection = await readJsonWithSchema(this.filePath, leaseCollectionSchema);
    if (!collection.ok) {
      return collection.error.code === "not_found" ? ok(Object.freeze([])) : collection;
    }
    return ok(freezeLeases(collection.value.leases));
  }

  async transact<Value>(
    transactionHolderId: string,
    mutate: (leases: readonly Lease[]) => Result<LeaseMutation<Value>, DomainError>,
  ): Promise<Result<LeaseTransactionReceipt<Value>, DomainError>> {
    if (
      !isAbsolute(this.filePath) ||
      !isAbsolute(this.lockPath) ||
      transactionHolderId.trim().length === 0
    ) {
      return err(domainError("invariant_violation"));
    }
    const lock = await acquireFileLock(this.lockPath, transactionHolderId);
    if (!lock.ok) return lock;

    const operation = await this.#transactLocked(mutate);
    const released = await lock.value.release();
    if (!operation.ok || released.ok) return operation;
    return ok(Object.freeze({ ...operation.value, lockRelease: "unknown" as const }));
  }

  async #transactLocked<Value>(
    mutate: (leases: readonly Lease[]) => Result<LeaseMutation<Value>, DomainError>,
  ): Promise<Result<LeaseTransactionReceipt<Value>, DomainError>> {
    const current = await this.readAll();
    if (!current.ok) return current;

    let mutation: Result<LeaseMutation<Value>, DomainError>;
    try {
      mutation = mutate(current.value);
    } catch {
      return err(domainError("invariant_violation"));
    }
    if (!mutation.ok) return mutation;
    if (!mutation.value.changed) {
      return ok(
        Object.freeze({
          value: mutation.value.value,
          persistence: "unchanged" as const,
          lockRelease: "confirmed" as const,
        }),
      );
    }

    const collection: LeaseCollection = {
      schemaVersion: 1,
      leases: mutation.value.leases,
    };
    const persisted = await writeJsonWithSchema(
      this.#store,
      this.filePath,
      leaseCollectionSchema,
      collection,
    );
    if (!persisted.ok) return persisted;
    if (!persisted.value.readBack.ok) return persisted.value.readBack;
    return ok(
      Object.freeze({
        value: mutation.value.value,
        persistence: persisted.value.durability,
        lockRelease: "confirmed" as const,
      }),
    );
  }
}
