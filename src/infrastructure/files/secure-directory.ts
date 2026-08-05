import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, type Stats } from "node:fs";
import { mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import { AtomicFileStore, privateFileMode, syncDirectory } from "./atomic.js";
import { privateDirectoryMode } from "./layout.js";

const entryNamePattern = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._@+-]{0,254}$/u;

export interface SecureDirectoryIdentity {
  readonly device: number;
  readonly inode: number;
}

export interface SecureDirectoryOpenOptions {
  readonly create?: boolean;
}

export interface SecureFileReadOptions {
  readonly maxBytes?: number;
}

export interface SecureLockIdentity {
  readonly device: number;
  readonly inode: number;
  readonly generation: string;
}

export interface SecureFileLockHandle {
  readonly path: string;
  readonly holderId: string;
  readonly identity: SecureLockIdentity;
  assertOwnership(): Promise<Result<void, DomainError>>;
  release(): Promise<Result<void, DomainError>>;
}

interface PermanentLockRecord {
  readonly schemaVersion: 1;
  readonly generation: string;
}

interface HeldDirectoryHandle {
  readonly fd: number;
  readonly stat: () => Promise<Stats>;
  readonly close: () => Promise<void>;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function fileError(error: unknown): DomainError {
  if (hasCode(error, "ENOENT")) return domainError("not_found");
  if (
    hasCode(error, "ELOOP") ||
    hasCode(error, "ENOTDIR") ||
    hasCode(error, "EACCES") ||
    hasCode(error, "EPERM")
  ) {
    return domainError("permission_denied");
  }
  return domainError("external_failure");
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  if (handle === undefined) return;
  try {
    await handle.close();
  } catch {
    // The operation result remains authoritative.
  }
}

function validEntryName(name: string): boolean {
  return entryNamePattern.test(name);
}

function validPermanentLockRecord(value: unknown): value is PermanentLockRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return (
    record["schemaVersion"] === 1 &&
    typeof record["generation"] === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      record["generation"],
    ) &&
    Object.keys(record).length === 2
  );
}

async function readPermanentLockRecord(
  handle: FileHandle,
): Promise<Result<PermanentLockRecord, DomainError>> {
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      (info.mode & 0o777) !== privateFileMode ||
      info.size <= 0 ||
      info.size > 4096
    ) {
      return err(domainError("permission_denied"));
    }
    const content = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(content, 0, content.length, 0);
    if (bytesRead !== content.length) return err(domainError("external_failure"));
    const parsed: unknown = JSON.parse(content.toString("utf8"));
    return validPermanentLockRecord(parsed) ? ok(parsed) : err(domainError("invariant_violation"));
  } catch (error) {
    return err(fileError(error));
  }
}

async function acquireKernelLock(fd: number): Promise<Result<void, DomainError>> {
  return new Promise((resolveResult) => {
    let settled = false;
    const settle = (result: Result<void, DomainError>): void => {
      if (settled) return;
      settled = true;
      resolveResult(result);
    };
    try {
      const child = spawn("/usr/bin/flock", ["-E", "75", "-n", "3"], {
        stdio: ["ignore", "ignore", "ignore", fd],
      });
      child.once("error", () => {
        settle(err(domainError("external_failure")));
      });
      child.once("exit", (code, signal) => {
        if (signal !== null || code === null) {
          settle(err(domainError("external_failure")));
        } else if (code === 0) {
          settle(ok(undefined));
        } else {
          settle(err(domainError(code === 75 ? "conflict" : "external_failure")));
        }
      });
    } catch {
      settle(err(domainError("external_failure")));
    }
  });
}

async function openChildDirectory(
  parent: FileHandle,
  name: string,
  create: boolean,
  privateDirectory: boolean,
): Promise<FileHandle> {
  const path = `/proc/self/fd/${String(parent.fd)}/${name}`;
  if (create) {
    try {
      await mkdir(path, { mode: privateDirectoryMode });
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
  }
  const child = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const info = await child.stat();
  if (!info.isDirectory() || (privateDirectory && (info.mode & 0o777) !== privateDirectoryMode)) {
    await child.close();
    throw Object.assign(new Error("unsafe_private_directory"), { code: "EACCES" });
  }
  return child;
}

async function openAbsoluteDirectory(
  rootPath: string,
  children: readonly string[],
  create: boolean,
): Promise<FileHandle> {
  const rootParts = resolve(rootPath)
    .split(sep)
    .filter((part) => part.length > 0);
  let current = await open(sep, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const [index, part] of rootParts.entries()) {
      const isPrivateRoot = index === rootParts.length - 1;
      const child = await openChildDirectory(current, part, create && isPrivateRoot, isPrivateRoot);
      await current.close();
      current = child;
    }
    for (const childName of children) {
      const child = await openChildDirectory(current, childName, create, true);
      await current.close();
      current = child;
    }
    return current;
  } catch (error) {
    await closeQuietly(current);
    throw error;
  }
}

function syncHandle(fd: number): HeldDirectoryHandle {
  let closed = false;
  return Object.freeze({
    fd,
    stat: () => Promise.resolve(fstatSync(fd)),
    close: () => {
      if (!closed) {
        closeSync(fd);
        closed = true;
      }
      return Promise.resolve();
    },
  });
}

function openAbsoluteDirectorySync(
  rootPath: string,
  children: readonly string[],
  create: boolean,
): HeldDirectoryHandle {
  const rootParts = resolve(rootPath)
    .split(sep)
    .filter((part) => part.length > 0);
  let current = openSync(sep, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const [index, part] of rootParts.entries()) {
      const isPrivateRoot = index === rootParts.length - 1;
      const path = `/proc/self/fd/${String(current)}/${part}`;
      if (create && isPrivateRoot) {
        try {
          mkdirSync(path, { mode: privateDirectoryMode });
        } catch (error) {
          if (!hasCode(error, "EEXIST")) throw error;
        }
      }
      const child = openSync(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const info = fstatSync(child);
      if (!info.isDirectory() || (isPrivateRoot && (info.mode & 0o777) !== privateDirectoryMode)) {
        closeSync(child);
        throw Object.assign(new Error("unsafe_private_directory"), { code: "EACCES" });
      }
      closeSync(current);
      current = child;
    }
    for (const childName of children) {
      const path = `/proc/self/fd/${String(current)}/${childName}`;
      if (create) {
        try {
          mkdirSync(path, { mode: privateDirectoryMode });
        } catch (error) {
          if (!hasCode(error, "EEXIST")) throw error;
        }
      }
      const child = openSync(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const info = fstatSync(child);
      if (!info.isDirectory() || (info.mode & 0o777) !== privateDirectoryMode) {
        closeSync(child);
        throw Object.assign(new Error("unsafe_private_directory"), { code: "EACCES" });
      }
      closeSync(current);
      current = child;
    }
    return syncHandle(current);
  } catch (error) {
    closeSync(current);
    throw error;
  }
}

export class HeldSecureDirectory {
  readonly #handle: HeldDirectoryHandle;
  readonly #rootPath: string;
  readonly #children: readonly string[];
  readonly identity: SecureDirectoryIdentity;

  constructor(
    handle: HeldDirectoryHandle,
    rootPath: string,
    children: readonly string[],
    identity: SecureDirectoryIdentity,
  ) {
    this.#handle = handle;
    this.#rootPath = rootPath;
    this.#children = children;
    this.identity = identity;
  }

  close(): Promise<void> {
    return this.#handle.close();
  }

  #path(name: string): Result<string, DomainError> {
    return validEntryName(name)
      ? ok(`/proc/self/fd/${String(this.#handle.fd)}/${name}`)
      : err(domainError("invariant_violation"));
  }

  async verifyIdentity(): Promise<Result<void, DomainError>> {
    try {
      const info = await this.#handle.stat();
      return info.isDirectory() &&
        (info.mode & 0o777) === privateDirectoryMode &&
        info.dev === this.identity.device &&
        info.ino === this.identity.inode
        ? ok(undefined)
        : err(domainError("conflict"));
    } catch (error) {
      return err(fileError(error));
    }
  }

  async verifyPathIdentity(): Promise<Result<void, DomainError>> {
    let reopened: FileHandle | undefined;
    try {
      reopened = await openAbsoluteDirectory(this.#rootPath, this.#children, false);
      const info = await reopened.stat();
      return info.dev === this.identity.device && info.ino === this.identity.inode
        ? ok(undefined)
        : err(domainError("conflict"));
    } catch (error) {
      const mapped = fileError(error);
      return err(domainError(mapped.code === "not_found" ? "conflict" : mapped.code));
    } finally {
      await closeQuietly(reopened);
    }
  }

  async readFile(
    name: string,
    options: SecureFileReadOptions = {},
  ): Promise<Result<Uint8Array, DomainError>> {
    const path = this.#path(name);
    if (!path.ok) return path;
    const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      return err(domainError("invariant_violation"));
    }
    let file: FileHandle | undefined;
    try {
      file = await open(path.value, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await file.stat();
      if (!info.isFile() || (info.mode & 0o777) !== privateFileMode || info.size > maxBytes) {
        return err(domainError("permission_denied"));
      }
      return ok(Uint8Array.from(await file.readFile()));
    } catch (error) {
      return err(fileError(error));
    } finally {
      await closeQuietly(file);
    }
  }

  async atomicReplace(
    name: string,
    content: Uint8Array,
    store: AtomicFileStore = new AtomicFileStore(),
  ): Promise<Result<Readonly<{ durability: "confirmed" | "unknown" }>, DomainError>> {
    const path = this.#path(name);
    if (!path.ok) return path;
    return store.write(path.value, Uint8Array.from(content), {
      visibility: "private",
    });
  }

  async deleteFile(name: string): Promise<Result<void, DomainError>> {
    const path = this.#path(name);
    if (!path.ok) return path;
    const readable = await this.readFile(name, { maxBytes: 64 * 1024 * 1024 });
    if (!readable.ok) return readable;
    try {
      await unlink(path.value);
      await syncDirectory(`/proc/self/fd/${String(this.#handle.fd)}`);
      return ok(undefined);
    } catch (error) {
      return err(fileError(error));
    }
  }

  async acquireLock(
    name: string,
    holderId: string,
  ): Promise<Result<SecureFileLockHandle, DomainError>> {
    const path = this.#path(name);
    if (!path.ok) return path;
    if (holderId.trim().length === 0) return err(domainError("invariant_violation"));
    let handle: FileHandle | undefined;
    try {
      try {
        handle = await open(path.value, "wx+", privateFileMode);
        const created: PermanentLockRecord = Object.freeze({
          schemaVersion: 1,
          generation: randomUUID(),
        });
        await handle.writeFile(`${JSON.stringify(created)}\n`, "utf8");
        await handle.chmod(privateFileMode);
        await handle.sync();
        await syncDirectory(`/proc/self/fd/${String(this.#handle.fd)}`);
      } catch (error) {
        await closeQuietly(handle);
        handle = undefined;
        if (!hasCode(error, "EEXIST")) throw error;
        handle = await open(path.value, constants.O_RDWR | constants.O_NOFOLLOW);
      }

      const ownedHandle = handle;
      const ownedInfo = await ownedHandle.stat();
      const record = await readPermanentLockRecord(ownedHandle);
      if (!record.ok) {
        await closeQuietly(ownedHandle);
        return record;
      }
      const kernelLock = await acquireKernelLock(ownedHandle.fd);
      if (!kernelLock.ok) {
        await closeQuietly(ownedHandle);
        return kernelLock;
      }

      const identity: SecureLockIdentity = Object.freeze({
        device: ownedInfo.dev,
        inode: ownedInfo.ino,
        generation: record.value.generation,
      });
      let finished = false;
      const assertOwnership = async (): Promise<Result<void, DomainError>> => {
        if (finished) return err(domainError("conflict"));
        const directoryIdentity = await this.verifyIdentity();
        if (!directoryIdentity.ok) return directoryIdentity;
        const directoryPathIdentity = await this.verifyPathIdentity();
        if (!directoryPathIdentity.ok) return directoryPathIdentity;
        let canonical: FileHandle | undefined;
        try {
          const heldInfo = await ownedHandle.stat();
          if (
            !heldInfo.isFile() ||
            (heldInfo.mode & 0o777) !== privateFileMode ||
            heldInfo.dev !== identity.device ||
            heldInfo.ino !== identity.inode
          ) {
            return err(domainError("conflict"));
          }
          const heldRecord = await readPermanentLockRecord(ownedHandle);
          if (!heldRecord.ok || heldRecord.value.generation !== identity.generation) {
            return err(domainError("conflict"));
          }
          canonical = await open(path.value, constants.O_RDONLY | constants.O_NOFOLLOW);
          const canonicalInfo = await canonical.stat();
          if (
            !canonicalInfo.isFile() ||
            (canonicalInfo.mode & 0o777) !== privateFileMode ||
            canonicalInfo.dev !== identity.device ||
            canonicalInfo.ino !== identity.inode
          ) {
            return err(domainError("conflict"));
          }
          const canonicalRecord = await readPermanentLockRecord(canonical);
          return canonicalRecord.ok && canonicalRecord.value.generation === identity.generation
            ? ok(undefined)
            : err(domainError("conflict"));
        } catch (error) {
          const mapped = fileError(error);
          return err(domainError(mapped.code === "not_found" ? "conflict" : mapped.code));
        } finally {
          await closeQuietly(canonical);
        }
      };
      const initialOwnership = await assertOwnership();
      if (!initialOwnership.ok) {
        await closeQuietly(ownedHandle);
        return initialOwnership;
      }
      return ok(
        Object.freeze({
          path: path.value,
          holderId,
          identity,
          assertOwnership,
          release: async (): Promise<Result<void, DomainError>> => {
            if (finished) return err(domainError("conflict"));
            finished = true;
            try {
              await ownedHandle.close();
              return ok(undefined);
            } catch (error) {
              return err(fileError(error));
            }
          },
        }),
      );
    } catch (error) {
      await closeQuietly(handle);
      return err(fileError(error));
    }
  }
}

export function openHeldSecureDirectory(
  rootPath: string,
  children: readonly string[],
  options: SecureDirectoryOpenOptions,
): Result<HeldSecureDirectory, DomainError> {
  if (
    process.platform !== "linux" ||
    !isAbsolute(rootPath) ||
    children.some((child) => !validEntryName(child))
  ) {
    return err(domainError(process.platform === "linux" ? "invariant_violation" : "unavailable"));
  }
  try {
    const root = resolve(rootPath);
    const handle = openAbsoluteDirectorySync(root, children, options.create === true);
    const info = fstatSync(handle.fd);
    return ok(
      new HeldSecureDirectory(handle, root, [...children], {
        device: info.dev,
        inode: info.ino,
      }),
    );
  } catch (error) {
    return err(fileError(error));
  }
}

export async function withSecureDirectory<Value>(
  rootPath: string,
  children: readonly string[],
  options: SecureDirectoryOpenOptions,
  action: (directory: HeldSecureDirectory) => Promise<Result<Value, DomainError>>,
): Promise<Result<Value, DomainError>> {
  if (
    process.platform !== "linux" ||
    !isAbsolute(rootPath) ||
    children.some((child) => !validEntryName(child))
  ) {
    return err(domainError(process.platform === "linux" ? "invariant_violation" : "unavailable"));
  }
  let handle: FileHandle | undefined;
  try {
    handle = await openAbsoluteDirectory(resolve(rootPath), children, options.create === true);
    const info = await handle.stat();
    const held = new HeldSecureDirectory(handle, resolve(rootPath), [...children], {
      device: info.dev,
      inode: info.ino,
    });
    const result = await action(held);
    const identity = await held.verifyIdentity();
    if (!identity.ok && result.ok) return identity;
    const pathIdentity = await held.verifyPathIdentity();
    if (!pathIdentity.ok && result.ok) return pathIdentity;
    return result;
  } catch (error) {
    return err(fileError(error));
  } finally {
    await closeQuietly(handle);
  }
}
