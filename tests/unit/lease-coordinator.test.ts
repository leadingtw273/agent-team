import { describe, expect, it } from "vitest";

import {
  LeaseCoordinator,
  type LeaseMutation,
  type LeaseRepository,
  type LeaseTransactionReceipt,
} from "../../src/application/leases/index.js";
import {
  createFixedClock,
  domainError,
  err,
  ok,
  parseIdentifier,
  parseInstant,
  type DomainError,
  type Identifier,
  type Instant,
  type Result,
} from "../../src/domain/foundation/index.js";
import type { Lease } from "../../src/domain/jobs/index.js";

function instant(value: string): Instant {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function id<Scope extends string>(scope: Scope, value: string): Identifier<Scope> {
  const parsed = parseIdentifier(scope, value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const target = {
  jobId: id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab"),
  issueId: id("issue", "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab"),
};

const leaseIds = [
  id("lease", "lease_018f47d2-77a4-7cc1-8ef2-0123456789ab"),
  id("lease", "lease_018f47d2-77a4-7cc1-8ef2-1123456789ab"),
  id("lease", "lease_018f47d2-77a4-7cc1-8ef2-2123456789ab"),
] as const;

class MemoryLeaseRepository implements LeaseRepository {
  leases: readonly Lease[] = [];
  readonly failure: DomainError | undefined;

  constructor(failure?: DomainError) {
    this.failure = failure;
  }

  readAll(): Promise<Result<readonly Lease[], DomainError>> {
    return Promise.resolve(this.failure === undefined ? ok(this.leases) : err(this.failure));
  }

  transact<Value>(
    _transactionHolderId: string,
    mutate: (leases: readonly Lease[]) => Result<LeaseMutation<Value>, DomainError>,
  ): Promise<Result<LeaseTransactionReceipt<Value>, DomainError>> {
    if (this.failure !== undefined) return Promise.resolve(err(this.failure));
    const mutation = mutate(this.leases);
    if (!mutation.ok) return Promise.resolve(mutation);
    if (mutation.value.changed) this.leases = mutation.value.leases;
    return Promise.resolve(
      ok({
        value: mutation.value.value,
        persistence: mutation.value.changed ? "confirmed" : "unchanged",
        lockRelease: "confirmed",
      }),
    );
  }
}

function coordinator(
  repository: LeaseRepository,
  now: Instant,
  leaseId: Identifier<"lease"> = leaseIds[0],
  leaseDurationMs = 5 * 60 * 1000,
): LeaseCoordinator {
  return new LeaseCoordinator(repository, {
    clock: createFixedClock(now),
    leaseDurationMs,
    generateLeaseId: () => ok(leaseId),
  });
}

describe("lease acquisition", () => {
  it("persists one bounded lease and blocks the same Job or Issue", async () => {
    const repository = new MemoryLeaseRepository();
    const first = await coordinator(repository, instant("2026-08-04T12:00:00.000Z")).acquire({
      ...target,
      holderId: "dispatcher-a",
    });

    expect(first).toMatchObject({
      ok: true,
      value: {
        persistence: "confirmed",
        value: {
          id: leaseIds[0],
          holderId: "dispatcher-a",
          acquiredAt: "2026-08-04T12:00:00.000Z",
          expiresAt: "2026-08-04T12:05:00.000Z",
        },
      },
    });
    await expect(
      coordinator(repository, instant("2026-08-04T12:01:00.000Z"), leaseIds[1]).acquire({
        ...target,
        holderId: "dispatcher-b",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "conflict" } });
    await expect(
      coordinator(repository, instant("2026-08-04T12:01:00.000Z"), leaseIds[2]).acquire({
        jobId: id("job", "job_018f47d2-77a4-7cc1-8ef2-1123456789ab"),
        issueId: target.issueId,
        holderId: "dispatcher-c",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(repository.leases).toHaveLength(1);
  });

  it("rejects invalid runtime configuration, holder data, and ID collisions", async () => {
    const repository = new MemoryLeaseRepository();
    await expect(
      coordinator(repository, instant("2026-08-04T12:00:00.000Z"), leaseIds[0], 0).acquire({
        ...target,
        holderId: "dispatcher",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invariant_violation" } });
    await expect(
      coordinator(repository, instant("2026-08-04T12:00:00.000Z")).acquire({
        ...target,
        holderId: " ",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invariant_violation" } });

    const first = await coordinator(repository, instant("2026-08-04T12:00:00.000Z")).acquire({
      ...target,
      holderId: "dispatcher",
    });
    if (!first.ok) throw new Error(first.error.code);
    await expect(
      coordinator(repository, instant("2026-08-04T12:06:00.000Z"), leaseIds[0]).acquire({
        jobId: id("job", "job_018f47d2-77a4-7cc1-8ef2-1123456789ab"),
        issueId: id("issue", "issue_018f47d2-77a4-7cc1-8ef2-1123456789ab"),
        holderId: "dispatcher",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});

describe("lease renewal and release", () => {
  it("lets only the current holder extend an active lease", async () => {
    const repository = new MemoryLeaseRepository();
    const acquired = await coordinator(repository, instant("2026-08-04T12:00:00.000Z")).acquire({
      ...target,
      holderId: "dispatcher",
    });
    if (!acquired.ok) throw new Error(acquired.error.code);

    await expect(
      coordinator(repository, instant("2026-08-04T12:01:00.000Z")).renew({
        leaseId: acquired.value.value.id,
        holderId: "intruder",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "conflict" } });
    await expect(
      coordinator(repository, instant("2026-08-04T12:01:00.000Z")).renew({
        leaseId: acquired.value.value.id,
        holderId: "dispatcher",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { value: { expiresAt: "2026-08-04T12:06:00.000Z" } },
    });
    await expect(
      coordinator(repository, instant("2026-08-04T12:06:00.000Z")).renew({
        leaseId: acquired.value.value.id,
        holderId: "dispatcher",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("releases by ownership and makes repeated release idempotent", async () => {
    const repository = new MemoryLeaseRepository();
    const acquired = await coordinator(repository, instant("2026-08-04T12:00:00.000Z")).acquire({
      ...target,
      holderId: "dispatcher",
    });
    if (!acquired.ok) throw new Error(acquired.error.code);
    const atNoonOne = coordinator(repository, instant("2026-08-04T12:01:00.000Z"));

    await expect(
      atNoonOne.release({ leaseId: acquired.value.value.id, holderId: "intruder" }),
    ).resolves.toMatchObject({ ok: false, error: { code: "conflict" } });
    const released = await atNoonOne.release({
      leaseId: acquired.value.value.id,
      holderId: "dispatcher",
    });
    expect(released).toMatchObject({
      ok: true,
      value: {
        persistence: "confirmed",
        value: { releasedAt: "2026-08-04T12:01:00.000Z" },
      },
    });
    await expect(
      atNoonOne.release({ leaseId: acquired.value.value.id, holderId: "dispatcher" }),
    ).resolves.toMatchObject({ ok: true, value: { persistence: "unchanged" } });
  });
});

describe("expired lease recovery", () => {
  it("identifies zombies, tombstones them, and permits a later acquisition", async () => {
    const repository = new MemoryLeaseRepository();
    const acquired = await coordinator(
      repository,
      instant("2026-08-04T12:00:00.000Z"),
      leaseIds[0],
      1_000,
    ).acquire({ ...target, holderId: "crashed-dispatcher" });
    if (!acquired.ok) throw new Error(acquired.error.code);
    const recovery = coordinator(repository, instant("2026-08-04T12:00:01.000Z"), leaseIds[1]);

    await expect(recovery.inspectExpired()).resolves.toMatchObject({
      ok: true,
      value: [{ id: leaseIds[0] }],
    });
    await expect(recovery.reclaimExpired("reconciler")).resolves.toMatchObject({
      ok: true,
      value: { value: [leaseIds[0]], persistence: "confirmed" },
    });
    await expect(recovery.reclaimExpired("reconciler")).resolves.toMatchObject({
      ok: true,
      value: { value: [], persistence: "unchanged" },
    });
    await expect(
      recovery.acquire({ ...target, holderId: "replacement-dispatcher" }),
    ).resolves.toMatchObject({ ok: true, value: { value: { id: leaseIds[1] } } });
  });

  it("propagates repository failures instead of assuming an empty store", async () => {
    const repository = new MemoryLeaseRepository(domainError("external_failure"));
    await expect(
      coordinator(repository, instant("2026-08-04T12:00:00.000Z")).inspectExpired(),
    ).resolves.toMatchObject({ ok: false, error: { code: "external_failure" } });
    await expect(
      coordinator(repository, instant("2026-08-04T12:00:00.000Z")).acquire({
        ...target,
        holderId: "dispatcher",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "external_failure" } });
  });
});
