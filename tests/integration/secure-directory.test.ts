import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { withSecureDirectory } from "../../src/infrastructure/files/index.js";
import { ok } from "../../src/domain/foundation/index.js";

const roots: string[] = [];

async function container(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-team-secure-directory-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Linux held secure directory", () => {
  it("creates only 0700 directories and atomically replaces only 0600 regular files", async () => {
    const parent = await container();
    const root = join(parent, "state");
    const content = Buffer.from("trusted state\n", "utf8");

    const result = await withSecureDirectory(
      root,
      ["tokens", "issuer-1"],
      { create: true },
      async (directory) => {
        const written = await directory.atomicReplace("record.json", content);
        if (!written.ok) return written;
        const read = await directory.readFile("record.json");
        if (!read.ok) return read;
        expect(Buffer.from(read.value).toString("utf8")).toBe("trusted state\n");
        return directory.verifyIdentity();
      },
    );

    expect(result).toEqual({ ok: true, value: undefined });
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "tokens"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "tokens", "issuer-1"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "tokens", "issuer-1", "record.json"))).mode & 0o777).toBe(0o600);
  });

  it.each(["root", "parent", "child"] as const)(
    "rejects a %s symlink and never writes through it",
    async (attack) => {
      const parent = await container();
      const root = join(parent, "state");
      const target = join(parent, "attacker-target");
      await mkdir(target, { mode: 0o700 });
      if (attack === "root") {
        await symlink(target, root, "dir");
      } else {
        await mkdir(root, { mode: 0o700 });
        if (attack === "parent") {
          await symlink(target, join(root, "tokens"), "dir");
        } else {
          await mkdir(join(root, "tokens"), { mode: 0o700 });
          await symlink(target, join(root, "tokens", "issuer-1"), "dir");
        }
      }

      await expect(
        withSecureDirectory(root, ["tokens", "issuer-1"], { create: true }, async (directory) =>
          directory.atomicReplace("record.json", Buffer.from("attack", "utf8")),
        ),
      ).resolves.toMatchObject({ ok: false, error: { code: "permission_denied" } });
      await expect(readFile(join(target, "record.json"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("rejects non-directories and unsafe private directory permissions", async () => {
    const parent = await container();
    const fileRoot = join(parent, "file-root");
    await writeFile(fileRoot, "not a directory", { mode: 0o600 });
    await expect(
      withSecureDirectory(fileRoot, [], { create: false }, () => Promise.resolve(ok(undefined))),
    ).resolves.toMatchObject({ ok: false, error: { code: "permission_denied" } });

    const unsafeRoot = join(parent, "unsafe-root");
    await mkdir(unsafeRoot, { mode: 0o700 });
    await chmod(unsafeRoot, 0o755);
    await expect(
      withSecureDirectory(unsafeRoot, [], { create: false }, () => Promise.resolve(ok(undefined))),
    ).resolves.toMatchObject({ ok: false, error: { code: "permission_denied" } });
  });

  it("keeps writes anchored to the opened inode and rejects a rename-plus-replacement swap", async () => {
    const parent = await container();
    const root = join(parent, "state");
    const heldPath = join(root, "tokens", "issuer-1");
    const movedPath = `${heldPath}.moved`;

    const result = await withSecureDirectory(
      root,
      ["tokens", "issuer-1"],
      { create: true },
      async (directory) => {
        await rename(heldPath, movedPath);
        await mkdir(heldPath, { mode: 0o700 });
        return directory.atomicReplace("record.json", Buffer.from("original inode\n", "utf8"));
      },
    );

    expect(result).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await readFile(join(movedPath, "record.json"), "utf8")).toBe("original inode\n");
    await expect(readFile(join(heldPath, "record.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("provides 0600 active-owner locks and stale-owner reclamation within the held directory", async () => {
    const parent = await container();
    const root = join(parent, "state");
    const result = await withSecureDirectory(
      root,
      ["leases"],
      { create: true },
      async (directory) => {
        const active = await directory.acquireLock("operation.lock", "active-owner");
        if (!active.ok) return active;
        expect((await stat(join(root, "leases", "operation.lock"))).mode & 0o777).toBe(0o600);
        const conflict = await directory.acquireLock("operation.lock", "second-owner");
        expect(conflict).toMatchObject({ ok: false, error: { code: "conflict" } });
        const released = await active.value.release();
        if (!released.ok) return released;

        const stale = await directory.acquireLock("operation.lock", "stale-owner");
        if (!stale.ok) return stale;
        const observed = await directory.inspectLock("operation.lock");
        if (!observed.ok) return observed;
        const reclaimed = await directory.reclaimStaleLock(
          "operation.lock",
          observed.value.token,
          () => false,
        );
        if (!reclaimed.ok) return reclaimed;
        return ok(undefined);
      },
    );

    expect(result).toEqual({ ok: true, value: undefined });
    await expect(stat(join(root, "leases", "operation.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
