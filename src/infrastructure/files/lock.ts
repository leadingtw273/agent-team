import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import {
  createClock,
  domainError,
  err,
  ok,
  parseInstant,
  type Clock,
  type DomainError,
  type Instant,
  type Result,
} from "../../domain/foundation/index.js";
import { privateDirectoryMode } from "./layout.js";
import { syncDirectory } from "./atomic.js";

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

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function isLockRecord(value: unknown): value is FileLockSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return (
    record["schemaVersion"] === 1 &&
    typeof record["token"] === "string" &&
    record["token"].length > 0 &&
    typeof record["holderId"] === "string" &&
    record["holderId"].trim().length > 0 &&
    typeof record["pid"] === "number" &&
    Number.isSafeInteger(record["pid"]) &&
    record["pid"] > 0 &&
    typeof record["acquiredAt"] === "string" &&
    parseInstant(record["acquiredAt"]).ok &&
    Object.keys(record).length === 5
  );
}

async function readLockRecord(lockPath: string): Promise<Result<FileLockSnapshot, DomainError>> {
  try {
    const handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const parsed: unknown = JSON.parse(await handle.readFile("utf8"));
      return isLockRecord(parsed) ? ok(parsed) : err(domainError("invariant_violation"));
    } finally {
      await handle.close();
    }
  } catch (error) {
    return err(domainError(hasNodeErrorCode(error, "ENOENT") ? "not_found" : "external_failure"));
  }
}

function defaultProcessLivenessProbe(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasNodeErrorCode(error, "ESRCH");
  }
}

export function inspectFileLock(lockPath: string): Promise<Result<FileLockSnapshot, DomainError>> {
  if (!isAbsolute(lockPath)) return Promise.resolve(err(domainError("invariant_violation")));
  return readLockRecord(lockPath);
}

export async function reclaimStaleFileLock(
  lockPath: string,
  expectedToken: string,
  isProcessAlive: ProcessLivenessProbe = defaultProcessLivenessProbe,
): Promise<Result<void, DomainError>> {
  if (!isAbsolute(lockPath) || expectedToken.length === 0) {
    return err(domainError("invariant_violation"));
  }

  const observed = await readLockRecord(lockPath);
  if (!observed.ok) return observed;
  if (observed.value.token !== expectedToken || isProcessAlive(observed.value.pid)) {
    return err(domainError("conflict"));
  }

  const confirmed = await readLockRecord(lockPath);
  if (!confirmed.ok) return confirmed;
  if (confirmed.value.token !== expectedToken) return err(domainError("conflict"));

  try {
    await unlink(lockPath);
    await syncDirectory(dirname(lockPath));
    return ok(undefined);
  } catch (error) {
    return err(domainError(hasNodeErrorCode(error, "ENOENT") ? "not_found" : "external_failure"));
  }
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  if (handle === undefined) return;
  try {
    await handle.close();
  } catch {
    // The acquisition error remains authoritative.
  }
}

async function unlinkQuietly(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // The original acquisition failure remains authoritative.
  }
}

export async function acquireFileLock(
  lockPath: string,
  holderId: string,
  clock: Clock = createClock(),
): Promise<Result<FileLockHandle, DomainError>> {
  if (!isAbsolute(lockPath) || holderId.trim().length === 0) {
    return err(domainError("invariant_violation"));
  }

  const token = randomUUID();
  const record: FileLockSnapshot = {
    schemaVersion: 1,
    token,
    holderId,
    pid: process.pid,
    acquiredAt: clock.now(),
  };
  let handle: FileHandle | undefined;
  let created = false;

  try {
    await mkdir(dirname(lockPath), { recursive: true, mode: privateDirectoryMode });
    handle = await open(lockPath, "wx", 0o600);
    created = true;
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await syncDirectory(dirname(lockPath));
  } catch (error) {
    await closeQuietly(handle);
    if (created) await unlinkQuietly(lockPath);
    return err(domainError(hasNodeErrorCode(error, "EEXIST") ? "conflict" : "external_failure"));
  }

  return ok(
    Object.freeze({
      path: lockPath,
      holderId,
      async release(): Promise<Result<void, DomainError>> {
        const current = await readLockRecord(lockPath);
        if (!current.ok) return current;
        if (current.value.token !== token) return err(domainError("conflict"));
        try {
          await unlink(lockPath);
          await syncDirectory(dirname(lockPath));
          return ok(undefined);
        } catch (error) {
          return err(
            domainError(hasNodeErrorCode(error, "ENOENT") ? "not_found" : "external_failure"),
          );
        }
      },
    }),
  );
}
