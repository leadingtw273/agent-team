import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LeaseCoordinator } from "../../src/application/leases/index.js";
import {
  ok,
  parseIdentifier,
  parseInstant,
  type Identifier,
  type Instant,
} from "../../src/domain/foundation/index.js";
import { FileLeaseRepository } from "../../src/infrastructure/leases/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-leases-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

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

function paths(root: string): { file: string; lock: string } {
  return {
    file: join(root, ".agent-team", "state", "leases", "leases.json"),
    lock: join(root, ".agent-team", "state", "locks", "leases.lock"),
  };
}

describe("file lease repository", () => {
  it("allows exactly one of two concurrent Dispatchers to acquire a target", async () => {
    const root = await temporaryDirectory();
    const location = paths(root);
    const firstRepository = new FileLeaseRepository(location.file, location.lock);
    const secondRepository = new FileLeaseRepository(location.file, location.lock);
    const now = instant("2026-08-04T12:00:00.000Z");
    const first = new LeaseCoordinator(firstRepository, {
      clock: { now: () => now },
      generateLeaseId: () => ok(id("lease", "lease_018f47d2-77a4-7cc1-8ef2-0123456789ab")),
    });
    const second = new LeaseCoordinator(secondRepository, {
      clock: { now: () => now },
      generateLeaseId: () => ok(id("lease", "lease_018f47d2-77a4-7cc1-8ef2-1123456789ab")),
    });

    const results = await Promise.all([
      first.acquire({ ...target, holderId: "dispatcher-a" }),
      second.acquire({ ...target, holderId: "dispatcher-b" }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    await expect(firstRepository.readAll()).resolves.toMatchObject({
      ok: true,
      value: [{ jobId: target.jobId, issueId: target.issueId }],
    });
    expect((await stat(location.file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, ".agent-team", "state", "leases"))).mode & 0o777).toBe(0o700);
  });

  it("persists renew, release, expired reclaim, and read-back across instances", async () => {
    const root = await temporaryDirectory();
    const location = paths(root);
    const repository = new FileLeaseRepository(location.file, location.lock);
    let now = instant("2026-08-04T12:00:00.000Z");
    let nextLeaseId = id("lease", "lease_018f47d2-77a4-7cc1-8ef2-0123456789ab");
    const coordinator = new LeaseCoordinator(repository, {
      clock: { now: () => now },
      leaseDurationMs: 1_000,
      generateLeaseId: () => ok(nextLeaseId),
    });
    const acquired = await coordinator.acquire({ ...target, holderId: "dispatcher" });
    if (!acquired.ok) throw new Error(acquired.error.code);

    now = instant("2026-08-04T12:00:00.500Z");
    await expect(
      coordinator.renew({ leaseId: acquired.value.value.id, holderId: "dispatcher" }),
    ).resolves.toMatchObject({
      ok: true,
      value: { value: { expiresAt: "2026-08-04T12:00:01.500Z" } },
    });
    now = instant("2026-08-04T12:00:01.500Z");
    await expect(coordinator.inspectExpired()).resolves.toMatchObject({
      ok: true,
      value: [{ id: acquired.value.value.id }],
    });
    await expect(coordinator.reclaimExpired("reconciler")).resolves.toMatchObject({
      ok: true,
      value: { value: [acquired.value.value.id] },
    });

    nextLeaseId = id("lease", "lease_018f47d2-77a4-7cc1-8ef2-1123456789ab");
    const replacement = await coordinator.acquire({ ...target, holderId: "replacement" });
    if (!replacement.ok) throw new Error(replacement.error.code);
    now = instant("2026-08-04T12:00:01.750Z");
    await expect(
      coordinator.release({ leaseId: replacement.value.value.id, holderId: "replacement" }),
    ).resolves.toMatchObject({ ok: true, value: { persistence: "confirmed" } });

    const reopened = new FileLeaseRepository(location.file, location.lock);
    const persisted = await reopened.readAll();
    expect(persisted).toMatchObject({
      ok: true,
      value: [
        { id: acquired.value.value.id, releasedAt: "2026-08-04T12:00:01.500Z" },
        { id: replacement.value.value.id, releasedAt: "2026-08-04T12:00:01.750Z" },
      ],
    });
  });

  it("fails closed for malformed and symlinked state", async () => {
    const root = await temporaryDirectory();
    const malformedLocation = paths(root);
    await mkdir(join(root, ".agent-team", "state", "leases"), { recursive: true });
    await writeFile(malformedLocation.file, "{", "utf8");
    await expect(
      new FileLeaseRepository(malformedLocation.file, malformedLocation.lock).readAll(),
    ).resolves.toMatchObject({ ok: false, error: { code: "invariant_violation" } });

    const validTarget = join(root, "valid.json");
    const link = join(root, "linked.json");
    await writeFile(validTarget, '{"schemaVersion":1,"leases":[]}\n', "utf8");
    await symlink(validTarget, link);
    await expect(
      new FileLeaseRepository(link, join(root, "link.lock")).readAll(),
    ).resolves.toMatchObject({ ok: false, error: { code: "external_failure" } });
    expect(await readFile(validTarget, "utf8")).toContain('"leases"');
  });
});
