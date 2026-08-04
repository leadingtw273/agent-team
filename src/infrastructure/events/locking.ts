import type { DomainError, Result } from "../../domain/foundation/index.js";
import {
  acquireFileLock,
  inspectFileLock,
  reclaimStaleFileLock,
  type FileLockHandle,
} from "../files/index.js";

export async function acquireRecoverableFileLock(
  lockPath: string,
  holderId: string,
): Promise<Result<FileLockHandle, DomainError>> {
  const first = await acquireFileLock(lockPath, holderId);
  if (first.ok || first.error.code !== "conflict") return first;

  const observed = await inspectFileLock(lockPath);
  if (!observed.ok) {
    return observed.error.code === "not_found" ? acquireFileLock(lockPath, holderId) : observed;
  }

  const reclaimed = await reclaimStaleFileLock(lockPath, observed.value.token);
  if (!reclaimed.ok) return reclaimed;
  return acquireFileLock(lockPath, holderId);
}
