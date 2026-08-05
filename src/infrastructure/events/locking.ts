import type { DomainError, Result } from "../../domain/foundation/index.js";
import {
  acquireRecoverableFileLock as acquireAnchoredRecoverableFileLock,
  type FileLockHandle,
} from "../files/index.js";

export async function acquireRecoverableFileLock(
  lockPath: string,
  holderId: string,
): Promise<Result<FileLockHandle, DomainError>> {
  return acquireAnchoredRecoverableFileLock(lockPath, holderId);
}
