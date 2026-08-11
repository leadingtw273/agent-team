import { mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AtomicFileStore,
  withSecureDirectory,
  type AtomicFileOperations,
} from "../../src/infrastructure/files/index.js";
import {
  FileOperatorCanaryAttestationStore,
  operatorCanaryScopeDigest,
} from "../../src/adapters/dispatch/operator-canary-attestation-store.js";
import { ok, parseInstant, type Clock, type Instant } from "../../src/domain/foundation/index.js";

const roots: string[] = [];
const projectId = "project_018f47d2-77a4-7cc1-8ef2-0123456789ab";
const externalIssueId = "b9567572-6a20-41e2-b20f-0123456789ab";
const cliVersion = "claude 2.1.0";

function instant(value: string): Instant {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function mutableClock(initial: Instant): Readonly<{ clock: Clock; set(value: Instant): void }> {
  let current = initial;
  return Object.freeze({
    clock: Object.freeze({ now: () => current }),
    set(value: Instant) {
      current = value;
    },
  });
}

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-team-operator-canary-"));
  roots.push(root);
  return root;
}

function storeAt(
  root: string,
  clock: Clock,
  ids: readonly string[] = [],
): FileOperatorCanaryAttestationStore {
  let next = 0;
  return new FileOperatorCanaryAttestationStore(root, {
    clock,
    generateAttestationId: () => ids[next++] ?? "84b31f82-50ff-4ad1-93a0-0123456789ab",
  });
}

function scope() {
  return { projectId, linearExternalIssueId: externalIssueId } as const;
}

function atomicStore(overrides: Partial<AtomicFileOperations> = {}): AtomicFileStore {
  return new AtomicFileStore({
    chmod,
    mkdir,
    open,
    rename,
    unlink,
    renameSync,
    ...overrides,
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FileOperatorCanaryAttestationStore", () => {
  it("issues a private exact-scope record, reads it back, and consumes it exactly once", async () => {
    const root = await home();
    const clock = mutableClock(instant("2026-08-12T12:00:00.000Z"));
    const store = storeAt(root, clock.clock, [
      "84b31f82-50ff-4ad1-93a0-0123456789ab",
      "0d490248-3ca2-464b-9230-0123456789ab",
    ]);

    const issued = await store.issue({ ...scope(), claudeCliVersion: cliVersion });
    expect(issued).toMatchObject({
      ok: true,
      value: {
        source: "operator_canary",
        authority: "current_user_conversation",
        provider: "claude",
        state: "issued",
        revision: 0,
        issuedAt: "2026-08-12T12:00:00.000Z",
        expiresAt: "2026-08-12T12:15:00.000Z",
      },
    });
    if (!issued.ok) return;

    const digest = operatorCanaryScopeDigest(scope());
    if (digest === undefined) throw new Error("fixture scope must be valid");
    const directory = join(root, "state", "quota", "operator-canary");
    const record = join(directory, `attestation-${digest}.json`);
    const lock = join(directory, `attestation-${digest}.lock`);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(record)).mode & 0o777).toBe(0o600);
    expect((await stat(lock)).mode & 0o777).toBe(0o600);
    const names = await readdir(directory);
    expect(names.join("\n")).not.toContain(projectId);
    expect(names.join("\n")).not.toContain(externalIssueId);

    expect(await store.inspect(scope())).toEqual({
      ok: true,
      value: { state: "issued", attestation: issued.value },
    });
    await expect(store.issue({ ...scope(), claudeCliVersion: cliVersion })).resolves.toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    await expect(
      store.consume({
        ...scope(),
        claudeCliVersion: "claude 9.9.9",
        attestationId: issued.value.attestationId,
        expectedRevision: issued.value.revision,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "conflict" } });
    await expect(
      store.consume({
        projectId: "project_018f47d2-77a4-7cc1-8ef2-9999999999ab",
        linearExternalIssueId: externalIssueId,
        claudeCliVersion: cliVersion,
        attestationId: issued.value.attestationId,
        expectedRevision: issued.value.revision,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "conflict" } });
    const consumed = await store.consume({
      ...scope(),
      claudeCliVersion: cliVersion,
      attestationId: issued.value.attestationId,
      expectedRevision: issued.value.revision,
    });
    expect(consumed).toMatchObject({ ok: true, value: { state: "consumed", revision: 1 } });
    expect(await store.inspect(scope())).toMatchObject({ ok: true, value: { state: "consumed" } });
    expect(
      await store.consume({
        ...scope(),
        claudeCliVersion: cliVersion,
        attestationId: issued.value.attestationId,
        expectedRevision: issued.value.revision,
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    const replacement = await store.issue({ ...scope(), claudeCliVersion: cliVersion });
    expect(replacement).toMatchObject({ ok: true, value: { state: "issued", revision: 2 } });
    if (replacement.ok)
      expect(replacement.value.attestationId).not.toBe(issued.value.attestationId);
  });

  it("fails closed at the future and expiry boundaries, and only reissues a new id after expiry", async () => {
    const root = await home();
    const clock = mutableClock(instant("2026-08-12T12:00:00.000Z"));
    const store = storeAt(root, clock.clock, [
      "84b31f82-50ff-4ad1-93a0-0123456789ab",
      "0d490248-3ca2-464b-9230-0123456789ab",
    ]);
    const first = await store.issue({ ...scope(), claudeCliVersion: cliVersion });
    if (!first.ok) throw new Error(first.error.code);

    clock.set(instant("2026-08-12T12:15:00.000Z"));
    expect(await store.inspect(scope())).toEqual({ ok: true, value: { state: "expired" } });
    const second = await store.issue({ ...scope(), claudeCliVersion: cliVersion });
    expect(second).toMatchObject({ ok: true, value: { state: "issued", revision: 1 } });
    if (!second.ok) return;
    expect(second.value.attestationId).not.toBe(first.value.attestationId);

    clock.set(instant("2026-08-12T12:14:59.999Z"));
    expect(await store.inspect(scope())).toMatchObject({
      ok: false,
      error: { code: "invariant_violation" },
    });
  });

  it("rechecks expiry after waiting for the scope lock instead of consuming from a stale clock", async () => {
    const root = await home();
    const clock = mutableClock(instant("2026-08-12T12:00:00.000Z"));
    const store = storeAt(root, clock.clock);
    const issued = await store.issue({ ...scope(), claudeCliVersion: cliVersion });
    if (!issued.ok) throw new Error(issued.error.code);
    const digest = operatorCanaryScopeDigest(scope());
    if (digest === undefined) throw new Error("fixture scope must be valid");

    const held = await withSecureDirectory(
      root,
      ["state", "quota", "operator-canary"],
      { create: false },
      async (directory) => {
        const lock = await directory.acquireLock(`attestation-${digest}.lock`, "expiry-boundary");
        if (!lock.ok) return lock;
        let released = false;
        try {
          // `consume()` used to snapshot `clock.now()` before it queued on this lock.  Advance the
          // fake clock after invoking it but before releasing the lock: the transaction must now
          // see expiry and reject rather than writing a consumed record.
          const pending = store.consume({
            ...scope(),
            claudeCliVersion: cliVersion,
            attestationId: issued.value.attestationId,
            expectedRevision: issued.value.revision,
          });
          clock.set(instant("2026-08-12T12:15:00.000Z"));
          const release = await lock.value.release();
          released = release.ok;
          if (!release.ok) return release;
          await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "conflict" } });
          return ok(undefined);
        } finally {
          if (!released) await lock.value.release();
        }
      },
    );
    expect(held).toEqual({ ok: true, value: undefined });
    await expect(store.inspect(scope())).resolves.toEqual({
      ok: true,
      value: { state: "expired" },
    });
  });

  it("rejects strict-schema corruption, unsafe modes, record symlinks, and lock symlinks", async () => {
    const root = await home();
    const clock = mutableClock(instant("2026-08-12T12:00:00.000Z"));
    const store = storeAt(root, clock.clock);
    const issued = await store.issue({ ...scope(), claudeCliVersion: cliVersion });
    if (!issued.ok) throw new Error(issued.error.code);
    const digest = operatorCanaryScopeDigest(scope());
    if (digest === undefined) throw new Error("fixture scope must be valid");
    const directory = join(root, "state", "quota", "operator-canary");
    const record = join(directory, `attestation-${digest}.json`);
    const lock = join(directory, `attestation-${digest}.lock`);

    await writeFile(record, `${JSON.stringify({ schemaVersion: 1 })}\n`, { mode: 0o600 });
    expect(await store.inspect(scope())).toMatchObject({
      ok: false,
      error: { code: "invariant_violation" },
    });

    await writeFile(record, "x".repeat(16 * 1024 + 1), { mode: 0o600 });
    expect(await store.inspect(scope())).toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });

    await writeFile(record, "{}", { mode: 0o600 });
    await chmod(record, 0o644);
    expect(await store.inspect(scope())).toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });

    await unlink(record);
    await symlink(join(root, "attacker-record"), record);
    expect(await store.inspect(scope())).toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });
    expect((await lstat(record)).isSymbolicLink()).toBe(true);

    await unlink(record);
    await writeFile(record, JSON.stringify(issued.value), { mode: 0o600 });
    await unlink(lock);
    await symlink(join(root, "attacker-lock"), lock);
    expect(
      await store.consume({
        ...scope(),
        claudeCliVersion: cliVersion,
        attestationId: issued.value.attestationId,
        expectedRevision: issued.value.revision,
      }),
    ).toMatchObject({ ok: false, error: { code: "permission_denied" } });
  });

  it("allows exactly one concurrent issue and one concurrent consumer", async () => {
    const root = await home();
    const clock = mutableClock(instant("2026-08-12T12:00:00.000Z"));
    const firstStore = storeAt(root, clock.clock, ["84b31f82-50ff-4ad1-93a0-0123456789ab"]);
    const secondStore = storeAt(root, clock.clock, ["0d490248-3ca2-464b-9230-0123456789ab"]);

    const issued = await Promise.all([
      firstStore.issue({ ...scope(), claudeCliVersion: cliVersion }),
      secondStore.issue({ ...scope(), claudeCliVersion: cliVersion }),
    ]);
    const winner = issued.find((candidate) => candidate.ok);
    expect(issued.filter((candidate) => candidate.ok)).toHaveLength(1);
    expect(issued.filter((candidate) => !candidate.ok)).toMatchObject([
      { error: { code: "conflict" } },
    ]);
    if (winner === undefined) throw new Error("one issue must win");

    const consumeInput = {
      ...scope(),
      claudeCliVersion: cliVersion,
      attestationId: winner.value.attestationId,
      expectedRevision: winner.value.revision,
    };
    const consumed = await Promise.all([
      firstStore.consume(consumeInput),
      secondStore.consume(consumeInput),
    ]);
    expect(consumed.filter((candidate) => candidate.ok)).toHaveLength(1);
    expect(consumed.filter((candidate) => !candidate.ok)).toMatchObject([
      { error: { code: "conflict" } },
    ]);
  });

  it("fails closed on a future consumed timestamp or an invalid injected clock", async () => {
    const root = await home();
    const clock = mutableClock(instant("2026-08-12T12:00:00.000Z"));
    const store = storeAt(root, clock.clock);
    const issued = await store.issue({ ...scope(), claudeCliVersion: cliVersion });
    if (!issued.ok) throw new Error(issued.error.code);
    const consumed = await store.consume({
      ...scope(),
      claudeCliVersion: cliVersion,
      attestationId: issued.value.attestationId,
      expectedRevision: issued.value.revision,
    });
    if (!consumed.ok) throw new Error(consumed.error.code);
    const digest = operatorCanaryScopeDigest(scope());
    if (digest === undefined) throw new Error("fixture scope must be valid");
    const record = join(root, "state", "quota", "operator-canary", `attestation-${digest}.json`);
    const corrupted = JSON.parse(await readFile(record, "utf8")) as Record<string, unknown>;
    corrupted["consumedAt"] = "2026-08-12T12:14:00.000Z";
    await writeFile(record, `${JSON.stringify(corrupted)}\n`, { mode: 0o600 });
    expect(await store.inspect(scope())).toMatchObject({
      ok: false,
      error: { code: "invariant_violation" },
    });

    const invalidClockStore = storeAt(root, {
      now: () => "not-an-instant" as Instant,
    });
    await expect(
      invalidClockStore.issue({ ...scope(), claudeCliVersion: cliVersion }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invariant_violation" } });
  });

  it("fails closed when the publication guard observes a lock replacement before rename", async () => {
    const root = await home();
    const clock = mutableClock(instant("2026-08-12T12:00:00.000Z"));
    const digest = operatorCanaryScopeDigest(scope());
    if (digest === undefined) throw new Error("fixture scope must be valid");
    const directory = join(root, "state", "quota", "operator-canary");
    const record = join(directory, `attestation-${digest}.json`);
    const lock = join(directory, `attestation-${digest}.lock`);
    const files = atomicStore({
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        if (flags === "wx") {
          await unlink(lock);
          await symlink(join(root, "attacker-lock"), lock);
        }
        return handle;
      },
    });
    const store = new FileOperatorCanaryAttestationStore(root, { clock: clock.clock, files });

    const issued = await store.issue({ ...scope(), claudeCliVersion: cliVersion });
    expect(issued.ok).toBe(false);
    expect((await lstat(lock)).isSymbolicLink()).toBe(true);
    await expect(lstat(record)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed after a parent path swap and after durability or readback becomes uncertain", async () => {
    const firstRoot = await home();
    const clock = mutableClock(instant("2026-08-12T12:00:00.000Z"));
    const directory = join(firstRoot, "state", "quota", "operator-canary");
    const movedDirectory = `${directory}-moved`;
    const attackerDirectory = join(firstRoot, "attacker-directory");
    let swapped = false;
    const pathSwapStore = new FileOperatorCanaryAttestationStore(firstRoot, {
      clock: clock.clock,
      files: atomicStore({
        renameSync: (from, to) => {
          if (!swapped) {
            swapped = true;
            renameSync(directory, movedDirectory);
            mkdirSync(attackerDirectory, { recursive: true, mode: 0o700 });
            symlinkSync(attackerDirectory, directory);
          }
          renameSync(from, to);
        },
      }),
    });
    expect(await pathSwapStore.issue({ ...scope(), claudeCliVersion: cliVersion })).toMatchObject({
      ok: false,
    });
    expect((await lstat(directory)).isSymbolicLink()).toBe(true);

    const secondRoot = await home();
    const durabilityStore = new FileOperatorCanaryAttestationStore(secondRoot, {
      clock: clock.clock,
      files: atomicStore({
        open: async (path, flags, mode) => {
          if (flags === "r") throw new Error("directory fsync unavailable");
          return open(path, flags, mode);
        },
      }),
    });
    await expect(
      durabilityStore.issue({ ...scope(), claudeCliVersion: cliVersion }),
    ).resolves.toMatchObject({ ok: false, error: { code: "external_failure" } });

    const thirdRoot = await home();
    const readbackStore = new FileOperatorCanaryAttestationStore(thirdRoot, {
      clock: clock.clock,
      files: atomicStore({
        renameSync: (from, to) => {
          renameSync(from, to);
          writeFileSync(to, "{", { mode: 0o600 });
        },
      }),
    });
    await expect(
      readbackStore.issue({ ...scope(), claudeCliVersion: cliVersion }),
    ).resolves.toMatchObject({ ok: false, error: { code: "external_failure" } });
  });
});
