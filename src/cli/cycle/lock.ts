import { join } from "node:path";

import {
  acquireRecoverableFileLock,
  inspectFileLock,
  type FileLockHandle,
  type FileLockSnapshot,
} from "../../infrastructure/files/index.js";
import { domainError, err, type DomainError, type Result } from "../../domain/foundation/index.js";

export const controllerCycleLockFileName = "controller-cycle.lock";

export interface ControllerCycleLockHandle {
  release(): Promise<Result<void, DomainError>>;
}

export type ControllerCycleLockAcquirer = (
  agentTeamHome: string,
  holderId: string,
) => Promise<Result<ControllerCycleLockHandle, DomainError>>;

/** Narrow injected seam for the secondary conflict probe. Production uses the established
 * recoverable file-lock implementation; tests use this seam to prove every unknown probe state
 * stays fail-closed. */
export interface ControllerCycleLockOperations {
  readonly acquire: (
    lockPath: string,
    holderId: string,
  ) => Promise<Result<FileLockHandle, DomainError>>;
  readonly inspect: (lockPath: string) => Promise<Result<FileLockSnapshot, DomainError>>;
}

const nodeControllerCycleLockOperations: ControllerCycleLockOperations = Object.freeze({
  acquire: acquireRecoverableFileLock,
  inspect: inspectFileLock,
});

export function controllerCycleLockPath(agentTeamHome: string): string {
  return join(agentTeamHome, "state", controllerCycleLockFileName);
}

function asControllerCycleLock(handle: FileLockHandle): ControllerCycleLockHandle {
  return Object.freeze({ release: () => handle.release() });
}

/**
 * A `conflict` may only become the caller-visible `already_running` outcome when a second,
 * independent probe still reports an actively held canonical lock. Any probe error or changing
 * state is fail-closed rather than being mistaken for a healthy concurrent cycle.
 */
export function createControllerCycleLockAcquirer(
  operations: ControllerCycleLockOperations = nodeControllerCycleLockOperations,
): ControllerCycleLockAcquirer {
  return async (agentTeamHome, holderId) => {
    const lockPath = controllerCycleLockPath(agentTeamHome);
    let acquired: Result<FileLockHandle, DomainError>;
    try {
      acquired = await operations.acquire(lockPath, holderId);
    } catch {
      return err(domainError("external_failure"));
    }
    if (acquired.ok) return { ok: true, value: asControllerCycleLock(acquired.value) };
    if (acquired.error.code !== "conflict") return acquired;

    let active: Result<FileLockSnapshot, DomainError>;
    try {
      active = await operations.inspect(lockPath);
    } catch {
      return err(domainError("external_failure"));
    }
    return !active.ok && active.error.code === "conflict"
      ? acquired
      : err(domainError("external_failure"));
  };
}

export const acquireControllerCycleLock = createControllerCycleLockAcquirer();
