import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";

import {
  domainError,
  err,
  ok,
  parseIdentifier,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import type {
  IssueScope,
  IssueScopeLockHandle,
  IssueScopeLockPort,
} from "../../application/pipelines/work-status-lifecycle-model.js";
import { acquireRecoverableFileLock } from "../../infrastructure/files/index.js";

export function issueScopeDigest(scope: IssueScope): Result<string, DomainError> {
  if (
    !parseIdentifier("project", scope.projectId).ok ||
    scope.externalIssueId.trim().length === 0 ||
    scope.externalIssueId.length > 255
  ) {
    return err(domainError("invariant_violation"));
  }
  return ok(
    createHash("sha256")
      .update(scope.projectId, "utf8")
      .update("\0", "utf8")
      .update(scope.externalIssueId, "utf8")
      .digest("hex"),
  );
}

/** Kernel-held, crash-recoverable lock with exactly one canonical file per project+Linear Issue. */
export class FileIssueScopeLock implements IssueScopeLockPort {
  readonly #directory: string;

  constructor(directory: string) {
    if (!isAbsolute(directory)) throw new Error("issue_scope_lock_root_must_be_absolute");
    this.#directory = directory;
  }

  async acquire(
    scope: IssueScope,
    holderId: string,
  ): Promise<Result<IssueScopeLockHandle, DomainError>> {
    const digest = issueScopeDigest(scope);
    if (!digest.ok || holderId.trim().length === 0 || holderId.length > 255) {
      return err(domainError("invariant_violation"));
    }
    const lock = await acquireRecoverableFileLock(
      join(this.#directory, `${digest.value}.lock`),
      holderId,
    );
    if (!lock.ok) return lock;
    return ok(
      Object.freeze({
        scopeDigest: digest.value,
        holderId,
        release: () => lock.value.release(),
      }),
    );
  }
}
