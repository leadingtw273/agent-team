import type { DomainError, Identifier, Result } from "../../domain/foundation/index.js";
import type { Lease } from "../../domain/jobs/index.js";

export interface LeaseMutation<Value> {
  readonly leases: readonly Lease[];
  readonly value: Value;
  readonly changed: boolean;
}

export interface LeaseTransactionReceipt<Value> {
  readonly value: Value;
  readonly persistence: "unchanged" | "confirmed" | "unknown";
  readonly lockRelease: "confirmed" | "unknown";
}

export interface LeaseRepository {
  readAll(): Promise<Result<readonly Lease[], DomainError>>;
  transact<Value>(
    transactionHolderId: string,
    mutate: (leases: readonly Lease[]) => Result<LeaseMutation<Value>, DomainError>,
  ): Promise<Result<LeaseTransactionReceipt<Value>, DomainError>>;
}

export type LeaseActionReceipt = LeaseTransactionReceipt<Lease>;

export type ReclaimExpiredReceipt = LeaseTransactionReceipt<readonly Identifier<"lease">[]>;
