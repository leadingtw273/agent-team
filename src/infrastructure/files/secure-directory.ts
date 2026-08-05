import { constants } from "node:fs";
import { mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

import {
  domainError,
  err,
  ok,
  type Clock,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import { AtomicFileStore, privateFileMode, syncDirectory } from "./atomic.js";
import { privateDirectoryMode } from "./layout.js";
import {
  acquireFileLock,
  inspectFileLock,
  reclaimStaleFileLock,
  type FileLockHandle,
  type FileLockSnapshot,
  type ProcessLivenessProbe,
} from "./lock.js";

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

export class HeldSecureDirectory {
  readonly #handle: FileHandle;
  readonly #rootPath: string;
  readonly #children: readonly string[];
  readonly identity: SecureDirectoryIdentity;

  constructor(
    handle: FileHandle,
    rootPath: string,
    children: readonly string[],
    identity: SecureDirectoryIdentity,
  ) {
    this.#handle = handle;
    this.#rootPath = rootPath;
    this.#children = children;
    this.identity = identity;
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
  ): Promise<Result<Readonly<{ durability: "confirmed" | "unknown" }>, DomainError>> {
    const path = this.#path(name);
    if (!path.ok) return path;
    return new AtomicFileStore().write(path.value, Uint8Array.from(content), {
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
    clock?: Clock,
  ): Promise<Result<FileLockHandle, DomainError>> {
    const path = this.#path(name);
    if (!path.ok) return path;
    return clock === undefined
      ? acquireFileLock(path.value, holderId)
      : acquireFileLock(path.value, holderId, clock);
  }

  async inspectLock(name: string): Promise<Result<FileLockSnapshot, DomainError>> {
    const path = this.#path(name);
    if (!path.ok) return path;
    const readable = await this.readFile(name, { maxBytes: 64 * 1024 });
    return readable.ok ? inspectFileLock(path.value) : readable;
  }

  async reclaimStaleLock(
    name: string,
    expectedToken: string,
    isProcessAlive?: ProcessLivenessProbe,
  ): Promise<Result<void, DomainError>> {
    const path = this.#path(name);
    if (!path.ok) return path;
    const readable = await this.readFile(name, { maxBytes: 64 * 1024 });
    if (!readable.ok) return readable;
    return isProcessAlive === undefined
      ? reclaimStaleFileLock(path.value, expectedToken)
      : reclaimStaleFileLock(path.value, expectedToken, isProcessAlive);
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
