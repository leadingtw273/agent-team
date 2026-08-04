import {
  createClock,
  domainError,
  err,
  generateIdentifier,
  instantFromDate,
  ok,
  type Clock,
  type DomainError,
  type Identifier,
  type Instant,
  type Result,
} from "../../domain/foundation/index.js";
import {
  canAcquireLease,
  leaseSchema,
  leaseState,
  type Lease,
  type LeaseTarget,
} from "../../domain/jobs/index.js";
import type { LeaseActionReceipt, LeaseRepository, ReclaimExpiredReceipt } from "./model.js";

export const defaultLeaseDurationMs = 5 * 60 * 1000;
export const maximumLeaseDurationMs = 60 * 60 * 1000;

export type LeaseIdFactory = () => Result<Identifier<"lease">, DomainError>;

export interface LeaseCoordinatorOptions {
  readonly clock?: Clock;
  readonly leaseDurationMs?: number;
  readonly generateLeaseId?: LeaseIdFactory;
}

export interface AcquireLeaseInput extends LeaseTarget {
  readonly holderId: string;
}

export interface LeaseOwnershipInput {
  readonly leaseId: Identifier<"lease">;
  readonly holderId: string;
}

function freezeLease(lease: Lease): Lease {
  return Object.freeze({ ...lease });
}

function validDuration(durationMs: number): boolean {
  return Number.isSafeInteger(durationMs) && durationMs > 0 && durationMs <= maximumLeaseDurationMs;
}

function expiryFrom(now: Instant, durationMs: number): Result<Instant, DomainError> {
  return instantFromDate(new Date(Date.parse(now) + durationMs));
}

function findLease(leases: readonly Lease[], leaseId: Identifier<"lease">): Lease | undefined {
  return leases.find((lease) => lease.id === leaseId);
}

export class LeaseCoordinator {
  readonly #clock: Clock;
  readonly #leaseDurationMs: number;
  readonly #generateLeaseId: LeaseIdFactory;

  constructor(
    readonly repository: LeaseRepository,
    options: LeaseCoordinatorOptions = {},
  ) {
    this.#clock = options.clock ?? createClock();
    this.#leaseDurationMs = options.leaseDurationMs ?? defaultLeaseDurationMs;
    this.#generateLeaseId = options.generateLeaseId ?? (() => generateIdentifier("lease"));
  }

  async acquire(input: AcquireLeaseInput): Promise<Result<LeaseActionReceipt, DomainError>> {
    if (!validDuration(this.#leaseDurationMs)) return err(domainError("invariant_violation"));
    const now = this.#clock.now();
    const expiresAt = expiryFrom(now, this.#leaseDurationMs);
    const leaseId = this.#generateLeaseId();
    if (!expiresAt.ok) return expiresAt;
    if (!leaseId.ok) return leaseId;
    const candidate = leaseSchema.safeParse({
      schemaVersion: 1,
      id: leaseId.value,
      jobId: input.jobId,
      issueId: input.issueId,
      holderId: input.holderId,
      acquiredAt: now,
      expiresAt: expiresAt.value,
    });
    if (!candidate.success) return err(domainError("invariant_violation"));

    return this.repository.transact(`lease-acquire:${input.holderId}`, (leases) => {
      if (
        leases.some((lease) => lease.id === leaseId.value) ||
        !canAcquireLease(leases, input, now)
      ) {
        return err(domainError("conflict"));
      }
      const acquired = freezeLease(candidate.data);
      return ok(
        Object.freeze({
          leases: Object.freeze([...leases, acquired]),
          value: acquired,
          changed: true,
        }),
      );
    });
  }

  async renew(input: LeaseOwnershipInput): Promise<Result<LeaseActionReceipt, DomainError>> {
    if (!validDuration(this.#leaseDurationMs)) return err(domainError("invariant_violation"));
    const now = this.#clock.now();
    const expiresAt = expiryFrom(now, this.#leaseDurationMs);
    if (!expiresAt.ok) return expiresAt;

    return this.repository.transact(`lease-renew:${input.holderId}`, (leases) => {
      const current = findLease(leases, input.leaseId);
      if (current?.holderId !== input.holderId) {
        return err(domainError("conflict"));
      }
      if (leaseState(current, now) !== "active" || expiresAt.value <= current.expiresAt) {
        return err(domainError("conflict"));
      }
      const renewed = leaseSchema.safeParse({ ...current, expiresAt: expiresAt.value });
      if (!renewed.success) return err(domainError("invariant_violation"));
      const stable = freezeLease(renewed.data);
      return ok(
        Object.freeze({
          leases: Object.freeze(
            leases.map((lease) => (lease.id === input.leaseId ? stable : lease)),
          ),
          value: stable,
          changed: true,
        }),
      );
    });
  }

  async release(input: LeaseOwnershipInput): Promise<Result<LeaseActionReceipt, DomainError>> {
    const now = this.#clock.now();
    return this.repository.transact(`lease-release:${input.holderId}`, (leases) => {
      const current = findLease(leases, input.leaseId);
      if (current?.holderId !== input.holderId) {
        return err(domainError("conflict"));
      }
      if (
        now < current.acquiredAt ||
        (current.releasedAt !== undefined && current.releasedAt > now)
      ) {
        return err(domainError("conflict"));
      }
      if (current.releasedAt !== undefined) {
        return ok(
          Object.freeze({
            leases,
            value: freezeLease(current),
            changed: false,
          }),
        );
      }
      const released = leaseSchema.safeParse({ ...current, releasedAt: now });
      if (!released.success) return err(domainError("invariant_violation"));
      const stable = freezeLease(released.data);
      return ok(
        Object.freeze({
          leases: Object.freeze(
            leases.map((lease) => (lease.id === input.leaseId ? stable : lease)),
          ),
          value: stable,
          changed: true,
        }),
      );
    });
  }

  async inspectExpired(): Promise<Result<readonly Lease[], DomainError>> {
    const leases = await this.repository.readAll();
    if (!leases.ok) return leases;
    const now = this.#clock.now();
    return ok(
      Object.freeze(
        leases.value
          .filter((lease) => leaseState(lease, now) === "expired")
          .map((lease) => freezeLease(lease)),
      ),
    );
  }

  async reclaimExpired(controllerId: string): Promise<Result<ReclaimExpiredReceipt, DomainError>> {
    const now = this.#clock.now();
    if (controllerId.trim().length === 0) return err(domainError("invariant_violation"));
    return this.repository.transact(`lease-reclaim:${controllerId}`, (leases) => {
      const reclaimedIds: Identifier<"lease">[] = [];
      const next: Lease[] = [];
      for (const lease of leases) {
        if (leaseState(lease, now) !== "expired") {
          next.push(lease);
          continue;
        }
        const released = leaseSchema.safeParse({ ...lease, releasedAt: now });
        if (!released.success) return err(domainError("invariant_violation"));
        reclaimedIds.push(lease.id);
        next.push(freezeLease(released.data));
      }
      return ok(
        Object.freeze({
          leases: reclaimedIds.length === 0 ? leases : Object.freeze(next),
          value: Object.freeze(reclaimedIds),
          changed: reclaimedIds.length > 0,
        }),
      );
    });
  }
}
