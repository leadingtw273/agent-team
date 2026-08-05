import { renameSync } from "node:fs";
import { fork } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
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
import { basename, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { domainError, err, ok } from "../../src/domain/foundation/index.js";
import {
  acquireFileLock,
  acquireRecoverableFileLock,
  AtomicFileStore,
  createAgentTeamProjectLayout,
  createAgentTeamUserLayout,
  ensureProjectLayout,
  ensureUserLayout,
  inspectFileLock,
  privateFileMode,
  projectFileMode,
  readJsonWithSchema,
  reclaimStaleFileLock,
  writeJsonWithSchema,
  type AtomicFileOperations,
  type FileLockOperations,
} from "../../src/infrastructure/files/index.js";

const stateSchema = z
  .object({
    schemaVersion: z.literal(1),
    value: z.string(),
  })
  .strict();

const temporaryDirectories: string[] = [];

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-files-"));
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

describe("file layout", () => {
  it("creates the private user layout and versioned project layout", async () => {
    const root = await temporaryDirectory();
    const user = createAgentTeamUserLayout(root);
    const project = createAgentTeamProjectLayout(join(root, "repository"));
    await mkdir(user.secrets, { recursive: true });
    await chmod(user.secrets, 0o777);
    await mkdir(project.trustedConfig, { recursive: true });
    await chmod(project.trustedConfig, 0o777);

    expect(await ensureUserLayout(user)).toEqual({ ok: true, value: undefined });
    expect(await ensureProjectLayout(project)).toEqual({ ok: true, value: undefined });

    for (const directory of [
      user.root,
      user.config,
      user.secrets,
      user.state.jobs,
      user.state.events,
      user.state.checkpoints,
      user.state.inbox,
      user.state.leases,
      user.state.quota,
      user.state.locks,
    ]) {
      expect((await stat(directory)).mode & 0o777, directory).toBe(0o700);
    }
    expect((await stat(project.trustedConfig)).mode & 0o777).toBe(0o755);
  });
});

describe("atomic schema files", () => {
  it("publishes synchronously with no event-loop window after the ownership boundary", async () => {
    const root = await temporaryDirectory();
    const target = join(root, "state.json");
    await writeFile(target, "old", "utf8");
    let interposed = false;
    const operations: AtomicFileOperations = {
      chmod,
      mkdir,
      open,
      rename,
      renameSync: (from, to) => {
        expect(interposed).toBe(false);
        renameSync(from, to);
      },
      unlink,
    };

    const result = await new AtomicFileStore(operations).write(target, Buffer.from("new", "utf8"), {
      publicationGuard: () => {
        queueMicrotask(() => {
          interposed = true;
        });
        return ok(undefined);
      },
    });

    expect(result).toEqual({ ok: true, value: { durability: "confirmed" } });
    expect(interposed).toBe(true);
    await expect(readFile(target, "utf8")).resolves.toBe("new");
  });

  it("fails closed when a synchronous publication boundary has no synchronous rename", async () => {
    const root = await temporaryDirectory();
    const target = join(root, "state.json");
    await writeFile(target, "old", "utf8");
    let asynchronousRenameCount = 0;
    const operations: AtomicFileOperations = {
      chmod,
      mkdir,
      open,
      rename: async (from, to) => {
        asynchronousRenameCount += 1;
        await rename(from, to);
      },
      unlink,
    };

    expect(
      await new AtomicFileStore(operations).write(target, Buffer.from("new", "utf8"), {
        publicationGuard: () => ok(undefined),
      }),
    ).toMatchObject({ ok: false, error: { code: "external_failure" } });
    expect(asynchronousRenameCount).toBe(0);
    await expect(readFile(target, "utf8")).resolves.toBe("old");
  });

  it.each([
    ["synchronous", () => err(domainError("conflict"))],
    ["asynchronous", () => Promise.resolve(err(domainError("conflict")))],
  ] as const)(
    "runs a %s commit guard after temp fsync and never publishes when ownership is lost",
    async (_kind, commitGuard) => {
      const root = await temporaryDirectory();
      const target = join(root, "state.json");
      await writeFile(target, "old", "utf8");
      let renameCount = 0;
      const operations: AtomicFileOperations = {
        chmod,
        mkdir,
        open,
        rename: async (from, to) => {
          renameCount += 1;
          await rename(from, to);
        },
        unlink,
      };

      const result = await new AtomicFileStore(operations).write(
        target,
        Buffer.from("new", "utf8"),
        {
          commitGuard,
        },
      );

      expect(result).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(renameCount).toBe(0);
      await expect(readFile(target, "utf8")).resolves.toBe("old");
      const temporaryPrefix = `.${basename(target)}.`;
      expect((await readdir(root)).filter((name) => name.startsWith(temporaryPrefix))).toEqual([]);
    },
  );

  it("keeps the previous authoritative file when failure occurs before rename", async () => {
    const root = await temporaryDirectory();
    const target = join(root, "state.json");
    await writeFile(target, "old", "utf8");
    const operations: AtomicFileOperations = {
      chmod,
      mkdir,
      open,
      rename: () => Promise.reject(new Error("injected_before_rename")),
      unlink,
    };

    const result = await new AtomicFileStore(operations).write(target, Buffer.from("new", "utf8"));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected injected rename failure");
    expect(result.error.code).toBe("external_failure");
    await expect(readFile(target, "utf8")).resolves.toBe("old");
    const temporaryPrefix = `.${basename(target)}.`;
    expect((await readdir(root)).filter((name) => name.startsWith(temporaryPrefix))).toEqual([]);
  });

  it("writes private and project files with fixed permissions and schema read-back", async () => {
    const root = await temporaryDirectory();
    const store = new AtomicFileStore();
    const privatePath = join(root, "secrets", "linear.json");
    const projectPath = join(root, "repository", ".agent-team", "project.json");
    await mkdir(join(root, "secrets"), { recursive: true });
    await chmod(join(root, "secrets"), 0o777);
    await mkdir(join(root, "repository", ".agent-team"), { recursive: true });
    await chmod(join(root, "repository", ".agent-team"), 0o777);

    const privateWrite = await writeJsonWithSchema(store, privatePath, stateSchema, {
      schemaVersion: 1,
      value: "secret",
    });
    const projectWrite = await writeJsonWithSchema(
      store,
      projectPath,
      stateSchema,
      { schemaVersion: 1, value: "trusted" },
      { visibility: "project" },
    );
    if (!privateWrite.ok || !projectWrite.ok) throw new Error("expected schema writes to commit");
    expect(privateWrite.value).toEqual({
      durability: "confirmed",
      readBack: { ok: true, value: { schemaVersion: 1, value: "secret" } },
    });
    expect(projectWrite.value).toEqual({
      durability: "confirmed",
      readBack: { ok: true, value: { schemaVersion: 1, value: "trusted" } },
    });

    expect((await stat(privatePath)).mode & 0o777).toBe(privateFileMode);
    expect((await stat(projectPath)).mode & 0o777).toBe(projectFileMode);
    expect((await stat(join(root, "secrets"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "repository", ".agent-team"))).mode & 0o777).toBe(0o755);
  });

  it("reports committed durability as unknown when directory fsync fails after rename", async () => {
    const root = await temporaryDirectory();
    const target = join(root, "state.json");
    await writeFile(target, "old", "utf8");
    const operations: AtomicFileOperations = {
      chmod,
      mkdir,
      open: (path, flags, mode) =>
        path === root && flags === "r"
          ? Promise.reject(new Error("injected_directory_fsync_failure"))
          : open(path, flags, mode),
      rename,
      unlink,
    };

    const result = await new AtomicFileStore(operations).write(target, Buffer.from("new", "utf8"));
    if (!result.ok) throw new Error("post-rename failure must preserve committed outcome");
    expect(result.value.durability).toBe("unknown");
    await expect(readFile(target, "utf8")).resolves.toBe("new");
  });

  it("fails closed for malformed JSON, schema drift, missing files, and symlinks", async () => {
    const root = await temporaryDirectory();
    const malformed = join(root, "malformed.json");
    const drifted = join(root, "drifted.json");
    const missing = join(root, "missing.json");
    const target = join(root, "target.json");
    const link = join(root, "link.json");
    await writeFile(malformed, "{", "utf8");
    await writeFile(drifted, '{"schemaVersion":2,"value":"old"}', "utf8");
    await writeFile(target, '{"schemaVersion":1,"value":"valid"}', "utf8");
    await symlink(target, link);

    const malformedResult = await readJsonWithSchema(malformed, stateSchema);
    const driftedResult = await readJsonWithSchema(drifted, stateSchema);
    const missingResult = await readJsonWithSchema(missing, stateSchema);
    const linkResult = await readJsonWithSchema(link, stateSchema);
    if (malformedResult.ok || driftedResult.ok || missingResult.ok || linkResult.ok) {
      throw new Error("expected all invalid reads to fail closed");
    }
    expect(malformedResult.error.code).toBe("invariant_violation");
    expect(driftedResult.error.code).toBe("invariant_violation");
    expect(missingResult.error.code).toBe("not_found");
    expect(linkResult.error.code).toBe("external_failure");
  });
});

describe("exclusive file lock", () => {
  it("turns the old partial-publication race into one complete trusted permanent state", async () => {
    const root = await temporaryDirectory();
    const lockPath = join(root, "state", "locks", "events.lock");
    await mkdir(join(root, "state", "locks"), { recursive: true, mode: 0o700 });
    await writeFile(lockPath, "", { mode: 0o600 });
    const partialIdentity = await stat(lockPath);

    const [first, second] = await Promise.all([
      acquireFileLock(lockPath, "writer-a"),
      acquireFileLock(lockPath, "writer-b"),
    ]);
    if (first.ok === second.ok) throw new Error("expected exactly one lock winner");
    const winner = first.ok ? first : second;
    const loser = first.ok ? second : first;
    if (!winner.ok || loser.ok) throw new Error("expected one winner and one loser");
    expect(loser.error.code).toBe("conflict");

    const beforeRelease = await stat(lockPath);
    expect(beforeRelease.ino).toBe(partialIdentity.ino);
    expect(beforeRelease.mode & 0o777).toBe(0o600);
    const permanentRecord = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
    expect(Object.keys(permanentRecord).sort()).toEqual([
      "generation",
      "ownerDigest",
      "schemaVersion",
    ]);
    expect(permanentRecord["schemaVersion"]).toBe(1);
    expect(permanentRecord["generation"]).toEqual(expect.any(String));
    expect(permanentRecord["generation"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    expect(permanentRecord["ownerDigest"]).toEqual(expect.any(String));
    expect(permanentRecord["ownerDigest"]).toMatch(/^[a-f0-9]{64}$/u);
    expect(await inspectFileLock(lockPath)).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });

    await expect(winner.value.release()).resolves.toEqual({ ok: true, value: undefined });
    const afterRelease = await stat(lockPath);
    expect(afterRelease.ino).toBe(beforeRelease.ino);
    expect(await inspectFileLock(lockPath)).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });

    const next = await acquireFileLock(lockPath, "writer-c");
    if (!next.ok) throw new Error(next.error.code);
    expect((await stat(lockPath)).ino).toBe(beforeRelease.ino);
    await expect(next.value.release()).resolves.toEqual({ ok: true, value: undefined });
  });

  it("recovers after a process crashes without unlinking the permanent inode", async () => {
    const root = await temporaryDirectory();
    const lockPath = join(root, "locks", "crash.lock");
    const child = fork(new URL("../fixtures/file-lock-child.mjs", import.meta.url), [lockPath], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const message = await new Promise<unknown>((resolve) => {
      child.once("message", (received: unknown) => {
        resolve(received);
      });
    });
    expect(message).toEqual({ state: "held" });
    const heldIdentity = await stat(lockPath);

    expect(await acquireRecoverableFileLock(lockPath, "parent-contender")).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    child.kill("SIGKILL");
    await once(child, "exit");

    const recovered = await acquireRecoverableFileLock(lockPath, "parent-recovered");
    if (!recovered.ok) throw new Error(recovered.error.code);
    expect((await stat(lockPath)).ino).toBe(heldIdentity.ino);
    await expect(recovered.value.release()).resolves.toEqual({ ok: true, value: undefined });
    expect((await stat(lockPath)).ino).toBe(heldIdentity.ino);
  });

  it("treats inspect and legacy reclaim as kernel-lock probes, never as stale-owner deletion", async () => {
    const root = await temporaryDirectory();
    const lockPath = join(root, "locks", "probe.lock");
    const active = await acquireFileLock(lockPath, "active");
    if (!active.ok) throw new Error(active.error.code);
    const identity = await stat(lockPath);

    expect(await inspectFileLock(lockPath)).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect(await reclaimStaleFileLock(lockPath, "legacy-token", () => false)).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    await expect(active.value.release()).resolves.toEqual({ ok: true, value: undefined });

    await expect(reclaimStaleFileLock(lockPath, "legacy-token", () => true)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect((await stat(lockPath)).ino).toBe(identity.ino);
  });

  it("fails ownership verification but never unlinks a rewritten manifest", async () => {
    const root = await temporaryDirectory();
    const lockPath = join(root, "locks", "manifest.lock");
    const active = await acquireFileLock(lockPath, "owner");
    if (!active.ok) throw new Error(active.error.code);
    const original = JSON.parse(await readFile(lockPath, "utf8")) as {
      schemaVersion: 1;
      generation: string;
      ownerDigest: string;
    };
    const rewritten = {
      ...original,
      ownerDigest: original.ownerDigest === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64),
    };
    await writeFile(lockPath, `${JSON.stringify(rewritten)}\n`, { mode: 0o600 });

    expect(await active.value.release()).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    await expect(readFile(lockPath, "utf8")).resolves.toBe(`${JSON.stringify(rewritten)}\n`);
  });

  it("fails closed for a malformed permanent manifest instead of replacing it", async () => {
    const root = await temporaryDirectory();
    const lockPath = join(root, "locks", "malformed.lock");
    const first = await acquireFileLock(lockPath, "owner-a");
    if (!first.ok) throw new Error(first.error.code);
    await expect(first.value.release()).resolves.toEqual({ ok: true, value: undefined });
    const identity = await stat(lockPath);
    await writeFile(lockPath, '{"schemaVersion":1}\n', { mode: 0o600 });

    expect(await acquireFileLock(lockPath, "owner-b")).toMatchObject({
      ok: false,
      error: { code: "invariant_violation" },
    });
    expect((await stat(lockPath)).ino).toBe(identity.ino);
    await expect(readFile(lockPath, "utf8")).resolves.toBe('{"schemaVersion":1}\n');
  });

  it("detects canonical inode replacement on release and leaves both inodes intact", async () => {
    const root = await temporaryDirectory();
    const directory = join(root, "locks");
    const lockPath = join(directory, "replacement.lock");
    const displaced = join(directory, "replacement.lock.displaced");
    const first = await acquireFileLock(lockPath, "owner-a");
    if (!first.ok) throw new Error(first.error.code);
    const firstIdentity = await stat(lockPath);
    await rename(lockPath, displaced);

    const replacement = await acquireFileLock(lockPath, "owner-b");
    if (!replacement.ok) throw new Error(replacement.error.code);
    const replacementIdentity = await stat(lockPath);
    expect(replacementIdentity.ino).not.toBe(firstIdentity.ino);
    expect(await first.value.release()).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect((await stat(displaced)).ino).toBe(firstIdentity.ino);
    expect((await stat(lockPath)).ino).toBe(replacementIdentity.ino);
    await expect(replacement.value.release()).resolves.toEqual({ ok: true, value: undefined });
    expect((await stat(lockPath)).ino).toBe(replacementIdentity.ino);
  });

  it("fails closed when held-directory or flock capability is unavailable", async () => {
    const root = await temporaryDirectory();
    const missingPath = join(root, "missing", "events.lock");
    const unavailableOperations: FileLockOperations = {
      openDirectory: () => err(domainError("unavailable")),
    };
    expect(
      await acquireFileLock(missingPath, "writer", undefined, {}, unavailableOperations),
    ).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await exists(join(root, "missing"))).toBe(false);

    const lockPath = join(root, "locks", "events.lock");
    const established = await acquireFileLock(lockPath, "establish");
    if (!established.ok) throw new Error(established.error.code);
    await expect(established.value.release()).resolves.toEqual({ ok: true, value: undefined });
    const identity = await stat(lockPath);
    expect(
      await acquireFileLock(lockPath, "writer", undefined, {
        flockBinary: "/definitely-missing/file-lock-flock",
      }),
    ).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect((await stat(lockPath)).ino).toBe(identity.ino);
  });

  it("does not repair unsafe directory permissions unless the caller explicitly opts in", async () => {
    const root = await temporaryDirectory();
    const directory = join(root, "locks");
    const lockPath = join(directory, "events.lock");
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o755);

    expect(await acquireFileLock(lockPath, "generic-writer")).toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });
    expect((await stat(directory)).mode & 0o777).toBe(0o755);
    expect(await exists(lockPath)).toBe(false);

    const repaired = await acquireFileLock(lockPath, "settings-style-writer", undefined, {
      repairPermissions: true,
    });
    if (!repaired.ok) throw new Error(repaired.error.code);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    await expect(repaired.value.release()).resolves.toEqual({ ok: true, value: undefined });
  });
});
