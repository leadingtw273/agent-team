import { renameSync } from "node:fs";
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

import {
  createFixedClock,
  domainError,
  err,
  ok,
  parseInstant,
} from "../../src/domain/foundation/index.js";
import {
  acquireFileLock,
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
} from "../../src/infrastructure/files/index.js";

const stateSchema = z
  .object({
    schemaVersion: z.literal(1),
    value: z.string(),
  })
  .strict();

const temporaryDirectories: string[] = [];

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
  it("allows exactly one writer and permits a new writer only after verified release", async () => {
    const root = await temporaryDirectory();
    const lockPath = join(root, "state", "locks", "events.lock");
    const instant = parseInstant("2026-08-04T16:00:00.000Z");
    if (!instant.ok) throw new Error(instant.error.code);
    const clock = createFixedClock(instant.value);

    const [first, second] = await Promise.all([
      acquireFileLock(lockPath, "writer-a", clock),
      acquireFileLock(lockPath, "writer-b", clock),
    ]);
    if (first.ok === second.ok) throw new Error("expected exactly one lock winner");
    const winner = first.ok ? first : second;
    const loser = first.ok ? second : first;
    if (!winner.ok || loser.ok) throw new Error("expected one winner and one loser");
    expect(loser.error.code).toBe("conflict");
    expect((await stat(lockPath)).mode & 0o777).toBe(0o600);

    await expect(winner.value.release()).resolves.toEqual({ ok: true, value: undefined });
    const next = await acquireFileLock(lockPath, "writer-c", clock);
    expect(next.ok).toBe(true);
    if (next.ok)
      await expect(next.value.release()).resolves.toEqual({ ok: true, value: undefined });
  });

  it("reclaims a token-matched lock only after the recorded process is confirmed dead", async () => {
    const root = await temporaryDirectory();
    const lockPath = join(root, "state", "locks", "stale.lock");
    const lock = await acquireFileLock(lockPath, "crashed-writer");
    if (!lock.ok) throw new Error(lock.error.code);
    const snapshot = await inspectFileLock(lockPath);
    if (!snapshot.ok) throw new Error(snapshot.error.code);

    const active = await reclaimStaleFileLock(lockPath, snapshot.value.token, () => true);
    expect(active.ok).toBe(false);
    if (active.ok) throw new Error("active process lock must not be reclaimed");
    expect(active.error.code).toBe("conflict");

    await expect(
      reclaimStaleFileLock(lockPath, snapshot.value.token, () => false),
    ).resolves.toEqual({ ok: true, value: undefined });
    const recovered = await acquireFileLock(lockPath, "recovered-writer");
    if (!recovered.ok) throw new Error(recovered.error.code);
    await expect(recovered.value.release()).resolves.toEqual({ ok: true, value: undefined });
  });

  it("does not unlink a lock whose ownership record was replaced", async () => {
    const root = await temporaryDirectory();
    const lockPath = join(root, "lock");
    const lock = await acquireFileLock(lockPath, "writer");
    if (!lock.ok) throw new Error(lock.error.code);
    await writeFile(
      lockPath,
      '{"schemaVersion":1,"token":"different","holderId":"other","pid":1,"acquiredAt":"2026-08-04T16:00:00.000Z"}\n',
      "utf8",
    );

    const released = await lock.value.release();
    expect(released.ok).toBe(false);
    if (released.ok) throw new Error("expected replaced lock ownership to fail");
    expect(released.error.code).toBe("conflict");
    await expect(stat(lockPath)).resolves.toBeDefined();
  });
});
