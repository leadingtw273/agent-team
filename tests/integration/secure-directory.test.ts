import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
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

import {
  acquireKernelFileLock,
  withSecureDirectory,
} from "../../src/infrastructure/files/index.js";
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
  it.each([
    ["unavailable", "/definitely-missing/o004-flock"],
    ["unexpected nonbusy exit", "/usr/bin/false"],
  ] as const)("fails closed when the flock binary is %s", async (_kind, binary) => {
    const parent = await container();
    const handle = await open(join(parent, "probe.lock"), "a+", 0o600);
    try {
      expect(await acquireKernelFileLock(handle.fd, binary)).toMatchObject({
        ok: false,
        error: { code: "external_failure" },
      });
    } finally {
      await handle.close();
    }
  });

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

  it("keeps a permanent 0600 kernel lock until the parent-held fd closes", async () => {
    const parent = await container();
    const root = join(parent, "state");
    const result = await withSecureDirectory(
      root,
      ["leases"],
      { create: true },
      async (directory) => {
        const active = await directory.acquireLock("operation.lock", "active-owner");
        if (!active.ok) return active;
        const lockPath = join(root, "leases", "operation.lock");
        expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
        expect(await active.value.assertOwnership()).toEqual({ ok: true, value: undefined });
        const externalWhileHeld = spawnSync(
          "/usr/bin/flock",
          ["-E", "75", "-n", lockPath, "true"],
          { encoding: "utf8" },
        );
        expect(externalWhileHeld.status).toBe(75);
        const conflict = await directory.acquireLock("operation.lock", "second-owner");
        expect(conflict).toMatchObject({ ok: false, error: { code: "conflict" } });
        const released = await active.value.release();
        if (!released.ok) return released;

        expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
        const externalAfterClose = spawnSync(
          "/usr/bin/flock",
          ["-E", "75", "-n", lockPath, "true"],
          { encoding: "utf8" },
        );
        expect(externalAfterClose.status).toBe(0);
        const next = await directory.acquireLock("operation.lock", "next-owner");
        if (!next.ok) return next;
        expect(await next.value.assertOwnership()).toEqual({ ok: true, value: undefined });
        return next.value.release();
      },
    );

    expect(result).toEqual({ ok: true, value: undefined });
    expect((await stat(join(root, "leases", "operation.lock"))).mode & 0o777).toBe(0o600);
  });

  it("never moves or deletes a replacement owner during lock-path ABA", async () => {
    const parent = await container();
    const root = join(parent, "state");
    const lockDirectory = join(root, "leases");
    const displaced = join(lockDirectory, "operation.lock.displaced");
    const result = await withSecureDirectory(
      root,
      ["leases"],
      { create: true },
      async (directory) => {
        const first = await directory.acquireLock("operation.lock", "owner-a");
        if (!first.ok) return first;
        await rename(join(lockDirectory, "operation.lock"), displaced);
        const replacement = await directory.acquireLock("operation.lock", "owner-b");
        if (!replacement.ok) return replacement;

        expect(await first.value.assertOwnership()).toMatchObject({
          ok: false,
          error: { code: "conflict" },
        });
        expect(await first.value.release()).toEqual({ ok: true, value: undefined });
        expect(await replacement.value.assertOwnership()).toEqual({ ok: true, value: undefined });
        expect((await stat(displaced)).mode & 0o777).toBe(0o600);
        expect((await stat(join(lockDirectory, "operation.lock"))).mode & 0o777).toBe(0o600);
        return replacement.value.release();
      },
    );

    expect(result).toEqual({ ok: true, value: undefined });
    expect((await stat(displaced)).mode & 0o777).toBe(0o600);
    expect((await stat(join(lockDirectory, "operation.lock"))).mode & 0o777).toBe(0o600);
  });
});
