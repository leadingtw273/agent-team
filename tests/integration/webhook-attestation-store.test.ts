import { createHash } from "node:crypto";
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

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  domainError,
  err,
  ok,
  parseInstant,
  type Clock,
  type Instant,
} from "../../src/domain/foundation/index.js";
import { projectIdSchema } from "../../src/domain/project/index.js";
import {
  AtomicFileStore,
  HeldSecureDirectory,
  type AtomicFileOperations,
} from "../../src/infrastructure/files/index.js";
import {
  FileWebhookAttestationStore,
  validateWebhookAttestation,
  webhookAttestationConfigDigest,
  webhookAttestationLookupForConfig,
  webhookAttestationTtlMs,
  type WebhookAttestationConfig,
  type WebhookAttestationLookup,
} from "../../src/cli/health/webhook-attestation-store.js";

const roots: string[] = [];
const projectIdCandidate = "project_018f47d2-77a4-7cc1-8ef2-0123456789ab";
const parsedProjectId = projectIdSchema.safeParse(projectIdCandidate);
if (!parsedProjectId.success) throw new Error("project fixture must be valid");
const projectId = parsedProjectId.data;
const publicBaseUrl = "https://webhook-runtime.example.test";
const secretSentinel = "github-secret-must-not-persist";
const deliverySentinel = "delivery-must-not-persist";

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
  const root = await mkdtemp(join(tmpdir(), "agent-team-webhook-attestation-"));
  roots.push(root);
  return root;
}

function config(
  overrides: Readonly<Partial<WebhookAttestationConfig>> = {},
): WebhookAttestationConfig {
  return {
    projectId,
    webhookBaseUrls: { github: publicBaseUrl, linear: publicBaseUrl },
    ...overrides,
  };
}

function lookup(value: WebhookAttestationConfig = config()): WebhookAttestationLookup {
  const result = webhookAttestationLookupForConfig(value);
  if (result === undefined) throw new Error("test config must be canonical and valid");
  return result;
}

function paths(root: string, input: WebhookAttestationLookup = lookup()) {
  const digest = createHash("sha256")
    .update(JSON.stringify({ schemaVersion: 1, projectId: input.projectId }), "utf8")
    .digest("hex");
  const directory = join(root, "state", "health", "webhook-attestations");
  return {
    directory,
    record: join(directory, `attestation-${digest}.json`),
    lock: join(directory, `attestation-${digest}.lock`),
  };
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

function storeAt(
  root: string,
  clock: Clock,
  files: AtomicFileStore = new AtomicFileStore(),
): FileWebhookAttestationStore {
  return new FileWebhookAttestationStore(root, { clock, files });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FileWebhookAttestationStore", () => {
  it("publishes and reads a URL-free dual-provider record with an exact 15-minute TTL", async () => {
    const root = await home();
    const clock = mutableClock(instant("2026-08-12T12:00:00.000Z"));
    const input = lookup();
    const store = storeAt(root, clock.clock);

    const written = await store.writeVerified(input);

    expect(written).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        projectId,
        configDigest: input.configDigest,
        github: "verified",
        linear: "verified",
        verifiedAt: "2026-08-12T12:00:00.000Z",
        expiresAt: "2026-08-12T12:15:00.000Z",
      },
    });
    if (!written.ok) return;
    expect(Date.parse(written.value.expiresAt) - Date.parse(written.value.verifiedAt)).toBe(
      webhookAttestationTtlMs,
    );

    const location = paths(root, input);
    expect((await stat(location.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(location.record)).mode & 0o777).toBe(0o600);
    expect((await stat(location.lock)).mode & 0o777).toBe(0o600);
    const names = await readdir(location.directory);
    expect(names.join("\n")).not.toContain(projectId);
    expect(names.join("\n")).not.toContain(publicBaseUrl);
    const bytes = await readFile(location.record, "utf8");
    expect(Object.keys(JSON.parse(bytes) as Record<string, unknown>).sort()).toEqual([
      "configDigest",
      "expiresAt",
      "github",
      "linear",
      "projectId",
      "schemaVersion",
      "verifiedAt",
    ]);
    for (const forbidden of [publicBaseUrl, secretSentinel, deliverySentinel]) {
      expect(bytes).not.toContain(forbidden);
    }
    expect(await store.read(input)).toEqual({
      ok: true,
      value: { state: "verified", attestation: written.value },
    });

    clock.set(instant("2026-08-12T12:14:59.999Z"));
    expect(await store.read(input)).toMatchObject({ ok: true, value: { state: "verified" } });
    clock.set(instant("2026-08-12T12:15:00.000Z"));
    expect(await store.read(input)).toEqual({ ok: true, value: { state: "expired" } });
  });

  it("derives a canonical URL digest and keeps an absent read completely read-only", async () => {
    const canonical = config({
      webhookBaseUrls: {
        github: "https://WEBHOOK-runtime.example.test:443/",
        linear: "https://webhook-runtime.example.test/",
      },
    });
    expect(webhookAttestationConfigDigest(canonical)).toBe(
      webhookAttestationConfigDigest(config()),
    );
    expect(
      webhookAttestationLookupForConfig(
        config({
          webhookBaseUrls: { github: "https://runtime.example.test/?query", linear: publicBaseUrl },
        }),
      ),
    ).toBeUndefined();
    expect(
      webhookAttestationLookupForConfig(
        config({
          webhookBaseUrls: { github: "https://user@runtime.example.test", linear: publicBaseUrl },
        }),
      ),
    ).toBeUndefined();

    const root = await home();
    const clock = mutableClock(instant("2026-08-12T12:00:00.000Z"));
    const store = storeAt(root, clock.clock);
    expect(await store.read(lookup())).toEqual({ ok: true, value: { state: "absent" } });
    await expect(lstat(paths(root).directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an own Symbol key on an attestation at the public validation boundary", async () => {
    const root = await home();
    const clock = mutableClock(instant("2026-08-12T12:00:00.000Z"));
    const input = lookup();
    const issued = await storeAt(root, clock.clock).writeVerified(input);
    if (!issued.ok) throw new Error(issued.error.code);
    const symbolRecord = {
      ...issued.value,
      [Symbol("unexpected-record-field")]: "must-reject",
    };

    expect(validateWebhookAttestation(symbolRecord, input, clock.clock.now())).toMatchObject({
      ok: false,
      error: { code: "invariant_violation" },
    });
  });

  it("rejects an own Symbol key on a lookup at the public store boundaries", async () => {
    const root = await home();
    const clock = mutableClock(instant("2026-08-12T12:00:00.000Z"));
    const input = lookup();
    const symbolLookup = {
      ...input,
      [Symbol("unexpected-lookup-field")]: "must-reject",
    };
    const store = storeAt(root, clock.clock);

    expect(await store.read(symbolLookup)).toMatchObject({
      ok: false,
      error: { code: "invariant_violation" },
    });
    expect(await store.writeVerified(symbolLookup)).toMatchObject({
      ok: false,
      error: { code: "invariant_violation" },
    });
    await expect(lstat(paths(root, input).directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an own Symbol key on the root configuration boundary", () => {
    const symbolConfig = {
      ...config(),
      [Symbol("unexpected-root-config-field")]: "must-reject",
    };

    expect(webhookAttestationConfigDigest(symbolConfig)).toBeUndefined();
    expect(webhookAttestationLookupForConfig(symbolConfig)).toBeUndefined();
  });

  it("rejects an own Symbol key on the nested provider configuration boundary", () => {
    const valid = config();
    const symbolConfig = {
      ...valid,
      webhookBaseUrls: {
        ...valid.webhookBaseUrls,
        [Symbol("unexpected-provider-config-field")]: "must-reject",
      },
    };

    expect(webhookAttestationConfigDigest(symbolConfig)).toBeUndefined();
    expect(webhookAttestationLookupForConfig(symbolConfig)).toBeUndefined();
  });

  it("fails closed for expiry replay, config drift, future verification, and clock rollback", async () => {
    const root = await home();
    const clock = mutableClock(instant("2026-08-12T12:00:00.000Z"));
    const original = lookup();
    const alternate = lookup(
      config({
        webhookBaseUrls: {
          github: "https://alternate-runtime.example.test",
          linear: publicBaseUrl,
        },
      }),
    );
    const store = storeAt(root, clock.clock);
    const first = await store.writeVerified(original);
    if (!first.ok) throw new Error(first.error.code);
    const firstBytes = await readFile(paths(root, original).record, "utf8");

    expect(await store.read(alternate)).toEqual({ ok: true, value: { state: "config_mismatch" } });
    const second = await store.writeVerified(alternate);
    expect(second).toMatchObject({ ok: true, value: { configDigest: alternate.configDigest } });
    expect(await store.read(original)).toEqual({ ok: true, value: { state: "config_mismatch" } });

    // Replaying a still-well-formed record from the previous configuration never verifies the
    // current configuration: configDigest is checked before H02 can report health.
    await writeFile(paths(root, alternate).record, firstBytes, { mode: 0o600 });
    expect(await store.read(alternate)).toEqual({ ok: true, value: { state: "config_mismatch" } });

    await writeFile(paths(root, original).record, JSON.stringify(first.value), { mode: 0o600 });
    clock.set(instant("2026-08-12T11:59:59.999Z"));
    expect(await store.read(original)).toMatchObject({
      ok: false,
      error: { code: "invariant_violation" },
    });
    expect(await store.writeVerified(original)).toMatchObject({
      ok: false,
      error: { code: "invariant_violation" },
    });
  });

  it("rejects prototype-bearing, unknown, wrong-schema, wrong-TTL, and wrong-project records", async () => {
    const root = await home();
    const clock = mutableClock(instant("2026-08-12T12:00:00.000Z"));
    const input = lookup();
    const store = storeAt(root, clock.clock);
    const issued = await store.writeVerified(input);
    if (!issued.ok) throw new Error(issued.error.code);
    const location = paths(root, input);

    const prototypeRecord = Object.assign(
      Object.create({ inherited: true }) as object,
      issued.value,
    );
    expect(validateWebhookAttestation(prototypeRecord, input, clock.clock.now())).toMatchObject({
      ok: false,
      error: { code: "invariant_violation" },
    });

    for (const corrupted of [
      { ...issued.value, unexpected: "field" },
      { ...issued.value, schemaVersion: 2 },
      { ...issued.value, github: "unverified" },
      { ...issued.value, expiresAt: "2026-08-12T12:15:00.001Z" },
      { ...issued.value, projectId: "project_018f47d2-77a4-7cc1-8ef2-9999999999ab" },
    ]) {
      await writeFile(location.record, `${JSON.stringify(corrupted)}\n`, { mode: 0o600 });
      expect(await store.read(input)).toMatchObject({
        ok: false,
        error: { code: corrupted.projectId === projectId ? "invariant_violation" : "conflict" },
      });
    }
  });

  it("fails closed on unsafe record or lock modes and symlink replacement", async () => {
    const root = await home();
    const clock = mutableClock(instant("2026-08-12T12:00:00.000Z"));
    const input = lookup();
    const store = storeAt(root, clock.clock);
    const issued = await store.writeVerified(input);
    if (!issued.ok) throw new Error(issued.error.code);
    const location = paths(root, input);

    await chmod(location.record, 0o644);
    expect(await store.read(input)).toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });

    await chmod(location.record, 0o600);
    await chmod(location.directory, 0o755);
    expect(await store.read(input)).toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });

    await chmod(location.directory, 0o700);
    await chmod(location.lock, 0o644);
    expect(await store.writeVerified(input)).toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });

    await chmod(location.lock, 0o600);
    await unlink(location.record);
    await symlink(join(root, "attacker-record"), location.record);
    expect(await store.read(input)).toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });
    expect((await lstat(location.record)).isSymbolicLink()).toBe(true);

    await unlink(location.record);
    await writeFile(location.record, `${JSON.stringify(issued.value)}\n`, { mode: 0o600 });
    await unlink(location.lock);
    await symlink(join(root, "attacker-lock"), location.lock);
    expect(await store.writeVerified(input)).toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });
  });

  it("serializes same-project writes and rejects a replayed previous configuration", async () => {
    const root = await home();
    const clock = mutableClock(instant("2026-08-12T12:00:00.000Z"));
    const input = lookup();
    const writers = [storeAt(root, clock.clock), storeAt(root, clock.clock)];

    const outcomes = await Promise.all(writers.map((store) => store.writeVerified(input)));
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.ok)).toMatchObject([
      { error: { code: "conflict" } },
    ]);
    expect(await storeAt(root, clock.clock).read(input)).toMatchObject({
      ok: true,
      value: { state: "verified" },
    });
  });

  it("does not report success if write, file fsync, rename, parent fsync, or read-back is uncertain", async () => {
    const clock = mutableClock(instant("2026-08-12T12:00:00.000Z"));
    const input = lookup();

    const writeRoot = await home();
    const writeFailure = storeAt(
      writeRoot,
      clock.clock,
      atomicStore({
        open: async (path, flags, mode) => {
          if (flags === "wx") throw new Error("write unavailable");
          return open(path, flags, mode);
        },
      }),
    );
    await expect(writeFailure.writeVerified(input)).resolves.toMatchObject({
      ok: false,
      error: { code: "external_failure" },
    });

    const fileSyncRoot = await home();
    const fileSyncFailure = storeAt(
      fileSyncRoot,
      clock.clock,
      atomicStore({
        open: async (path, flags, mode) => {
          const handle = await open(path, flags, mode);
          if (flags !== "wx") return handle;
          return Object.freeze({
            writeFile: handle.writeFile.bind(handle),
            chmod: handle.chmod.bind(handle),
            sync: () => Promise.reject(new Error("file fsync unavailable")),
            close: handle.close.bind(handle),
          }) as unknown as typeof handle;
        },
      }),
    );
    await expect(fileSyncFailure.writeVerified(input)).resolves.toMatchObject({
      ok: false,
      error: { code: "external_failure" },
    });

    const renameRoot = await home();
    const renameFailure = storeAt(
      renameRoot,
      clock.clock,
      atomicStore({
        renameSync: () => {
          throw new Error("rename unavailable");
        },
      }),
    );
    await expect(renameFailure.writeVerified(input)).resolves.toMatchObject({
      ok: false,
      error: { code: "external_failure" },
    });

    const parentSyncRoot = await home();
    const parentSyncFailure = storeAt(
      parentSyncRoot,
      clock.clock,
      atomicStore({
        open: async (path, flags, mode) => {
          if (flags === "r") throw new Error("parent fsync unavailable");
          return open(path, flags, mode);
        },
      }),
    );
    await expect(parentSyncFailure.writeVerified(input)).resolves.toMatchObject({
      ok: false,
      error: { code: "external_failure" },
    });

    const readBackRoot = await home();
    const readBackFailure = storeAt(
      readBackRoot,
      clock.clock,
      atomicStore({
        renameSync: (from, to) => {
          renameSync(from, to);
          writeFileSync(to, "{", { mode: 0o600 });
        },
      }),
    );
    await expect(readBackFailure.writeVerified(input)).resolves.toMatchObject({
      ok: false,
      error: { code: "external_failure" },
    });
  });

  it("does not report success after lock release becomes unknown", async () => {
    const root = await home();
    const clock = mutableClock(instant("2026-08-12T12:00:00.000Z"));
    const input = lookup();
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      HeldSecureDirectory.prototype,
      "acquireLock",
    );
    if (typeof originalDescriptor?.value !== "function") {
      throw new Error("secure directory lock primitive must be present");
    }
    const original = originalDescriptor.value as HeldSecureDirectory["acquireLock"];
    vi.spyOn(HeldSecureDirectory.prototype, "acquireLock").mockImplementation(async function (
      this: HeldSecureDirectory,
      ...args
    ) {
      const acquired = await original.call(this, ...args);
      if (!acquired.ok) return acquired;
      return ok(
        Object.freeze({
          ...acquired.value,
          release: async () => {
            await acquired.value.release();
            return err(domainError("external_failure"));
          },
        }),
      );
    });

    await expect(storeAt(root, clock.clock).writeVerified(input)).resolves.toMatchObject({
      ok: false,
      error: { code: "external_failure" },
    });
  });

  it("rejects lock inode replacement before publication and a parent path swap after publication", async () => {
    const clock = mutableClock(instant("2026-08-12T12:00:00.000Z"));
    const input = lookup();

    const lockRoot = await home();
    const lockLocation = paths(lockRoot, input);
    const lockReplacement = storeAt(
      lockRoot,
      clock.clock,
      atomicStore({
        open: async (path, flags, mode) => {
          const handle = await open(path, flags, mode);
          if (flags === "wx") {
            await unlink(lockLocation.lock);
            await symlink(join(lockRoot, "attacker-lock"), lockLocation.lock);
          }
          return handle;
        },
      }),
    );
    expect(await lockReplacement.writeVerified(input)).toMatchObject({ ok: false });
    expect((await lstat(lockLocation.lock)).isSymbolicLink()).toBe(true);
    await expect(lstat(lockLocation.record)).rejects.toMatchObject({ code: "ENOENT" });

    const pathRoot = await home();
    const pathLocation = paths(pathRoot, input);
    const movedDirectory = `${pathLocation.directory}-moved`;
    const attackerDirectory = join(pathRoot, "attacker-directory");
    let swapped = false;
    const pathSwap = storeAt(
      pathRoot,
      clock.clock,
      atomicStore({
        renameSync: (from, to) => {
          if (!swapped) {
            swapped = true;
            renameSync(pathLocation.directory, movedDirectory);
            mkdirSync(attackerDirectory, { recursive: true, mode: 0o700 });
            symlinkSync(attackerDirectory, pathLocation.directory);
          }
          renameSync(from, to);
        },
      }),
    );
    expect(await pathSwap.writeVerified(input)).toMatchObject({ ok: false });
    expect((await lstat(pathLocation.directory)).isSymbolicLink()).toBe(true);
  });
});
