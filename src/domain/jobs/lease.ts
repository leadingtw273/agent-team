import type { Identifier, Instant } from "../foundation/index.js";
import type { Lease } from "./schema.js";

export type LeaseState = "active" | "expired" | "released";

export interface LeaseTarget {
  readonly jobId: Identifier<"job">;
  readonly issueId: Identifier<"issue">;
}

export function leaseState(lease: Lease, now: Instant): LeaseState {
  if (lease.releasedAt !== undefined && lease.releasedAt <= now) return "released";
  return lease.expiresAt <= now ? "expired" : "active";
}

export function canAcquireLease(
  leases: readonly Lease[],
  target: LeaseTarget,
  now: Instant,
): boolean {
  return !leases.some(
    (lease) =>
      leaseState(lease, now) === "active" &&
      (lease.jobId === target.jobId || lease.issueId === target.issueId),
  );
}
