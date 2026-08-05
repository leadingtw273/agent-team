import { accessSync, constants, statSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";

import {
  createClock,
  domainError,
  err,
  type Clock,
  type DomainError,
  type Instant,
  type Result,
} from "../../domain/foundation/index.js";
import {
  openHeldSecureDirectory,
  type HeldSecureDirectory,
  type SecureDirectoryOpenOptions,
} from "./secure-directory.js";

/** Legacy owner shape retained for source compatibility with inspection callers. */
export interface FileLockSnapshot {
  readonly schemaVersion: 1;
  readonly token: string;
  readonly holderId: string;
  readonly pid: number;
  readonly acquiredAt: Instant;
}

export interface FileLockHandle {
  readonly path: string;
  readonly holderId: string;
  release(): Promise<Result<void, DomainError>>;
}

export type ProcessLivenessProbe = (pid: number) => boolean;

export interface FileLockAcquireOptions {
  /** Opt in only for callers that own the directory and may safely narrow it to 0700. */
  readonly repairPermissions?: boolean;
  /** Test/capability override. Production uses /usr/bin/flock. */
  readonly flockBinary?: string;
}

export interface FileLockOperations {
  readonly openDirectory: (
    rootPath: string,
    children: readonly string[],
    options: SecureDirectoryOpenOptions,
  ) => Result<HeldSecureDirectory, DomainError>;
}

function openDefaultDirectory(
  rootPath: string,
  children: readonly string[],
  options: SecureDirectoryOpenOptions,
): Result<HeldSecureDirectory, DomainError> {
  if (process.platform !== "linux") return err(domainError("unavailable"));
  try {
    if (!statSync("/proc/self/fd").isDirectory()) return err(domainError("unavailable"));
  } catch {
    return err(domainError("unavailable"));
  }
  return openHeldSecureDirectory(rootPath, children, options);
}

const nodeFileLockOperations: FileLockOperations = Object.freeze({
  openDirectory: openDefaultDirectory,
});

interface LockDirectoryContext {
  readonly directory: HeldSecureDirectory;
  readonly lockName: string;
  readonly requestedPath: string;
}

async function closeDirectoryQuietly(directory: HeldSecureDirectory | undefined): Promise<void> {
  if (directory === undefined) return;
  try {
    await directory.close();
  } catch {
    // The operation result remains authoritative.
  }
}

function openLockDirectory(
  lockPath: string,
  create: boolean,
  options: FileLockAcquireOptions,
  operations: FileLockOperations,
): Result<LockDirectoryContext, DomainError> {
  if (!isAbsolute(lockPath)) return err(domainError("invariant_violation"));
  const lockName = basename(lockPath);
  let rootPath = dirname(lockPath);
  const children: string[] = [];

  for (;;) {
    const opened = operations.openDirectory(rootPath, children, {
      create,
      repairPermissions: options.repairPermissions === true,
    });
    if (opened.ok) {
      return {
        ok: true,
        value: Object.freeze({
          directory: opened.value,
          lockName,
          requestedPath: lockPath,
        }),
      };
    }
    if (!create || opened.error.code !== "not_found") return opened;
    const parent = dirname(rootPath);
    if (parent === rootPath) return opened;
    children.unshift(basename(rootPath));
    rootPath = parent;
  }
}

async function acquireInDirectory(
  context: LockDirectoryContext,
  holderId: string,
  options: FileLockAcquireOptions,
): Promise<Result<FileLockHandle, DomainError>> {
  const acquired = await context.directory.acquireLock(
    context.lockName,
    holderId,
    options.flockBinary,
  );
  if (!acquired.ok) return acquired;

  let finished = false;
  return {
    ok: true,
    value: Object.freeze({
      path: context.requestedPath,
      holderId,
      async release(): Promise<Result<void, DomainError>> {
        if (finished) return err(domainError("conflict"));
        finished = true;
        const ownership = await acquired.value.assertOwnership();
        const released = await acquired.value.release();
        await closeDirectoryQuietly(context.directory);
        return ownership.ok ? released : ownership;
      },
    }),
  };
}

export async function acquireFileLock(
  lockPath: string,
  holderId: string,
  clock: Clock = createClock(),
  options: FileLockAcquireOptions = {},
  operations: FileLockOperations = nodeFileLockOperations,
): Promise<Result<FileLockHandle, DomainError>> {
  void clock;
  if (holderId.trim().length === 0) return err(domainError("invariant_violation"));
  try {
    accessSync(options.flockBinary ?? "/usr/bin/flock", constants.X_OK);
  } catch {
    return err(domainError("unavailable"));
  }
  const context = openLockDirectory(lockPath, true, options, operations);
  if (!context.ok) return context;
  const acquired = await acquireInDirectory(context.value, holderId, options);
  if (!acquired.ok) await closeDirectoryQuietly(context.value.directory);
  return acquired;
}

/**
 * Crash recovery is provided by the kernel: the permanent inode remains, while the flock is
 * released automatically when the owner process closes or loses its fd.
 */
export function acquireRecoverableFileLock(
  lockPath: string,
  holderId: string,
  clock: Clock = createClock(),
  options: FileLockAcquireOptions = {},
  operations: FileLockOperations = nodeFileLockOperations,
  _isProcessAlive?: ProcessLivenessProbe,
): Promise<Result<FileLockHandle, DomainError>> {
  void _isProcessAlive;
  return acquireFileLock(lockPath, holderId, clock, options, operations);
}

async function probeFileLock(
  lockPath: string,
  operations: FileLockOperations,
): Promise<Result<void, DomainError>> {
  const context = openLockDirectory(lockPath, false, {}, operations);
  if (!context.ok) return context;
  try {
    const existing = await context.value.directory.readFile(context.value.lockName, {
      maxBytes: 4096,
    });
    if (!existing.ok) return existing;
    const probe = await context.value.directory.acquireLock(
      context.value.lockName,
      `file-lock-probe:${String(process.pid)}`,
    );
    if (!probe.ok) return probe;
    const released = await probe.value.release();
    return released.ok ? err(domainError("not_found")) : released;
  } finally {
    await closeDirectoryQuietly(context.value.directory);
  }
}

/**
 * Inspection intentionally does not return the persistent inode's historical owner metadata.
 * A held kernel lock is `conflict`; an acquirable permanent inode is `not_found` (no active owner).
 */
export async function inspectFileLock(
  lockPath: string,
  operations: FileLockOperations = nodeFileLockOperations,
): Promise<Result<FileLockSnapshot, DomainError>> {
  const probed = await probeFileLock(lockPath, operations);
  return probed.ok ? err(domainError("external_failure")) : probed;
}

/**
 * Compatibility probe for old stale-reclaim callers. It never unlinks or rewrites the canonical
 * inode: success means the lock was already kernel-acquirable; conflict means an owner is active.
 */
export async function reclaimStaleFileLock(
  lockPath: string,
  expectedToken: string,
  _isProcessAlive?: ProcessLivenessProbe,
  operations: FileLockOperations = nodeFileLockOperations,
): Promise<Result<void, DomainError>> {
  if (expectedToken.length === 0) return err(domainError("invariant_violation"));
  const probed = await probeFileLock(lockPath, operations);
  return !probed.ok && probed.error.code === "not_found" ? { ok: true, value: undefined } : probed;
}
