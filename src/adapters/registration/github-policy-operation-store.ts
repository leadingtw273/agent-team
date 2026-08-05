import { isAbsolute, resolve } from "node:path";

import { z } from "zod";

import type {
  GitHubPolicyOperationNext,
  GitHubPolicyOperationSnapshot,
  GitHubPolicyOperationStore,
} from "../../application/registration/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import {
  AtomicFileStore,
  openHeldSecureDirectory,
  type HeldSecureDirectory,
  type SecureFileLockHandle,
  type SecureLockIdentity,
} from "../../infrastructure/files/index.js";

const operationIdPattern = /^[a-f0-9]{64}$/u;
const revisionPattern = /^[a-f0-9]{64}$/u;
const reservationIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const rulesetIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const lockGenerationPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const operationSnapshotSchema: z.ZodType<GitHubPolicyOperationSnapshot> = z
  .object({
    schemaVersion: z.literal(1),
    operationId: z.string().regex(operationIdPattern),
    revision: z.number().int().positive(),
    bindingRevision: z.string().regex(revisionPattern),
    inventoryRevision: z.string().regex(revisionPattern),
    phase: z.enum(["reserved", "mutation_started", "verification_pending", "completed"]),
    reservationId: z.string().regex(reservationIdPattern),
    rulesetId: z.string().regex(rulesetIdPattern).nullable(),
    autoMergeAttempted: z.boolean(),
    changed: z.boolean(),
  })
  .strict();

interface LockIdentityManifest extends SecureLockIdentity {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly lockName: string;
}

const lockIdentityManifestSchema: z.ZodType<LockIdentityManifest> = z
  .object({
    schemaVersion: z.literal(1),
    operationId: z.string().regex(operationIdPattern),
    lockName: z.string(),
    device: z.number().int().nonnegative(),
    inode: z.number().int().nonnegative(),
    generation: z.string().regex(lockGenerationPattern),
  })
  .strict();

function fileName(operationId: string): string {
  return `${operationId}.json`;
}

function lockName(operationId: string): string {
  return `${operationId}.lock`;
}

function lockManifestName(operationId: string): string {
  return `${operationId}.lock-identity.json`;
}

function snapshot(
  operationId: string,
  revision: number,
  next: GitHubPolicyOperationNext,
): GitHubPolicyOperationSnapshot {
  return Object.freeze({
    schemaVersion: 1,
    operationId,
    revision,
    bindingRevision: next.bindingRevision,
    inventoryRevision: next.inventoryRevision,
    phase: next.phase,
    reservationId: next.reservationId,
    rulesetId: next.rulesetId,
    autoMergeAttempted: next.autoMergeAttempted,
    changed: next.changed,
  });
}

async function readHeld(
  directory: HeldSecureDirectory,
  operationId: string,
): Promise<Result<GitHubPolicyOperationSnapshot | undefined, DomainError>> {
  const content = await directory.readFile(fileName(operationId), { maxBytes: 1024 * 1024 });
  if (!content.ok) return content.error.code === "not_found" ? ok(undefined) : content;
  try {
    const value: unknown = JSON.parse(Buffer.from(content.value).toString("utf8"));
    const parsed = operationSnapshotSchema.safeParse(value);
    return parsed.success ? ok(parsed.data) : err(domainError("invariant_violation"));
  } catch {
    return err(domainError("invariant_violation"));
  }
}

function serialize(value: GitHubPolicyOperationSnapshot): Result<Uint8Array, DomainError> {
  const parsed = operationSnapshotSchema.safeParse(value);
  if (!parsed.success) return err(domainError("invariant_violation"));
  return ok(Buffer.from(`${JSON.stringify(parsed.data, null, 2)}\n`, "utf8"));
}

function lockManifest(operationId: string, identity: SecureLockIdentity): LockIdentityManifest {
  return Object.freeze({
    schemaVersion: 1,
    operationId,
    lockName: lockName(operationId),
    device: identity.device,
    inode: identity.inode,
    generation: identity.generation,
  });
}

function sameLockManifest(left: LockIdentityManifest, right: LockIdentityManifest): boolean {
  return (
    left.operationId === right.operationId &&
    left.lockName === right.lockName &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.generation === right.generation
  );
}

async function readLockManifest(
  directory: HeldSecureDirectory,
  operationId: string,
): Promise<Result<LockIdentityManifest | undefined, DomainError>> {
  const content = await directory.readFile(lockManifestName(operationId), { maxBytes: 64 * 1024 });
  if (!content.ok) return content.error.code === "not_found" ? ok(undefined) : content;
  try {
    const value: unknown = JSON.parse(Buffer.from(content.value).toString("utf8"));
    const parsed = lockIdentityManifestSchema.safeParse(value);
    if (!parsed.success) return err(domainError("invariant_violation"));
    const expected = lockManifest(operationId, parsed.data);
    return sameLockManifest(parsed.data, expected)
      ? ok(parsed.data)
      : err(domainError("invariant_violation"));
  } catch {
    return err(domainError("invariant_violation"));
  }
}

/**
 * Private, file-backed operation journal. The constructor holds the exact
 * Linux directory inode; every lock, read, write, read-back, and CAS stays
 * relative to that descriptor and fails closed if its pathname is replaced.
 */
export class FileGitHubPolicyOperationStore implements GitHubPolicyOperationStore {
  readonly #directory: Result<HeldSecureDirectory, DomainError>;
  readonly #files: AtomicFileStore;

  constructor(directory: string, files = new AtomicFileStore()) {
    this.#files = files;
    this.#directory =
      isAbsolute(directory) && process.platform === "linux"
        ? openHeldSecureDirectory(resolve(directory), [], { create: true })
        : err(domainError(process.platform === "linux" ? "invariant_violation" : "unavailable"));
  }

  async close(): Promise<void> {
    if (this.#directory.ok) await this.#directory.value.close();
  }

  async #run<Value>(
    action: (directory: HeldSecureDirectory) => Promise<Result<Value, DomainError>>,
  ): Promise<Result<Value, DomainError>> {
    if (!this.#directory.ok) return this.#directory;
    const held = this.#directory.value;
    const before = await held.verifyIdentity();
    if (!before.ok) return before;
    const pathBefore = await held.verifyPathIdentity();
    if (!pathBefore.ok) return pathBefore;
    const outcome = await action(held);
    const after = await held.verifyIdentity();
    if (!after.ok && outcome.ok) return after;
    const pathAfter = await held.verifyPathIdentity();
    if (!pathAfter.ok && outcome.ok) return pathAfter;
    return outcome;
  }

  async #bindLockIdentity(
    directory: HeldSecureDirectory,
    operationId: string,
    lock: SecureFileLockHandle,
  ): Promise<Result<void, DomainError>> {
    const expected = lockManifest(operationId, lock.identity);
    const ownershipBefore = await lock.assertOwnership();
    if (!ownershipBefore.ok) return ownershipBefore;
    let observed = await readLockManifest(directory, operationId);
    if (!observed.ok) return observed;
    if (observed.value === undefined) {
      const content = Buffer.from(`${JSON.stringify(expected, null, 2)}\n`, "utf8");
      const written = await directory.atomicReplace(
        lockManifestName(operationId),
        content,
        this.#files,
        {
          commitGuard: async () => {
            const owned = await lock.assertOwnership();
            if (!owned.ok) return owned;
            const existing = await readLockManifest(directory, operationId);
            return existing.ok && existing.value === undefined
              ? ok(undefined)
              : err(domainError("conflict"));
          },
        },
      );
      if (!written.ok) return written;
      observed = await readLockManifest(directory, operationId);
      if (!observed.ok || observed.value === undefined) {
        return err(domainError("external_failure"));
      }
      const ownershipAfterWrite = await lock.assertOwnership();
      if (written.value.durability !== "confirmed" || !ownershipAfterWrite.ok) {
        return err(domainError("external_failure"));
      }
    }
    const ownershipAfter = await lock.assertOwnership();
    if (!ownershipAfter.ok) return ownershipAfter;
    return sameLockManifest(observed.value, expected)
      ? ok(undefined)
      : err(domainError("conflict"));
  }

  async #assertLockBinding(
    directory: HeldSecureDirectory,
    operationId: string,
    lock: SecureFileLockHandle,
  ): Promise<Result<void, DomainError>> {
    const ownedBefore = await lock.assertOwnership();
    if (!ownedBefore.ok) return ownedBefore;
    const observed = await readLockManifest(directory, operationId);
    if (!observed.ok || observed.value === undefined) {
      return observed.ok ? err(domainError("conflict")) : observed;
    }
    if (!sameLockManifest(observed.value, lockManifest(operationId, lock.identity))) {
      return err(domainError("conflict"));
    }
    return lock.assertOwnership();
  }

  async #withOperationLock<Value>(
    directory: HeldSecureDirectory,
    operationId: string,
    action: (lock: SecureFileLockHandle) => Promise<Result<Value, DomainError>>,
  ): Promise<Result<Value, DomainError>> {
    const lock = await directory.acquireLock(
      lockName(operationId),
      `github-policy-operation:${String(process.pid)}`,
    );
    if (!lock.ok) return lock;
    let outcome: Result<Value, DomainError> = err(domainError("external_failure"));
    try {
      const bound = await this.#bindLockIdentity(directory, operationId, lock.value);
      if (!bound.ok) {
        outcome = bound;
      } else {
        const before = await lock.value.assertOwnership();
        outcome = before.ok ? await action(lock.value) : before;
        const after = await lock.value.assertOwnership();
        if (!after.ok && outcome.ok) outcome = after;
      }
    } finally {
      const released = await lock.value.release();
      if (!released.ok && outcome.ok) outcome = err(domainError("external_failure"));
    }
    return outcome;
  }

  read(
    operationId: string,
  ): Promise<Result<GitHubPolicyOperationSnapshot | undefined, DomainError>> {
    if (!operationIdPattern.test(operationId)) {
      return Promise.resolve(err(domainError("invariant_violation")));
    }
    return this.#run((directory) =>
      this.#withOperationLock(directory, operationId, () => readHeld(directory, operationId)),
    );
  }

  compareAndSwap(
    command: Readonly<{
      operationId: string;
      expectedRevision: number | null;
      next: GitHubPolicyOperationNext;
    }>,
  ): Promise<Result<GitHubPolicyOperationSnapshot, DomainError>> {
    if (
      !operationIdPattern.test(command.operationId) ||
      (command.expectedRevision !== null &&
        (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision <= 0))
    ) {
      return Promise.resolve(err(domainError("invariant_violation")));
    }
    return this.#run((directory) =>
      this.#withOperationLock(directory, command.operationId, async (lock) => {
        const ownershipBeforeRead = await lock.assertOwnership();
        if (!ownershipBeforeRead.ok) return ownershipBeforeRead;
        const current = await readHeld(directory, command.operationId);
        if (!current.ok) return current;
        if ((current.value?.revision ?? null) !== command.expectedRevision) {
          return err(domainError("conflict"));
        }
        const next = snapshot(
          command.operationId,
          (current.value?.revision ?? 0) + 1,
          command.next,
        );
        const content = serialize(next);
        if (!content.ok) return content;
        const ownershipBeforeWrite = await lock.assertOwnership();
        if (!ownershipBeforeWrite.ok) return ownershipBeforeWrite;
        const written = await directory.atomicReplace(
          fileName(command.operationId),
          content.value,
          this.#files,
          {
            commitGuard: () => this.#assertLockBinding(directory, command.operationId, lock),
          },
        );
        if (!written.ok) return written;
        const readBack = await readHeld(directory, command.operationId);
        const ownershipAfterReadBack = await this.#assertLockBinding(
          directory,
          command.operationId,
          lock,
        );
        if (
          written.value.durability !== "confirmed" ||
          !ownershipAfterReadBack.ok ||
          !readBack.ok ||
          readBack.value?.revision !== next.revision
        ) {
          return err(domainError("external_failure"));
        }
        return ok(readBack.value);
      }),
    );
  }
}
