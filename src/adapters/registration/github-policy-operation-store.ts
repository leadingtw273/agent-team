import { isAbsolute, join, resolve } from "node:path";

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
  acquireFileLock,
  AtomicFileStore,
  readJsonWithSchema,
  writeJsonWithSchema,
} from "../../infrastructure/files/index.js";

const operationIdPattern = /^[a-f0-9]{64}$/u;
const revisionPattern = /^[a-f0-9]{64}$/u;
const reservationIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const rulesetIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
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

function fileName(operationId: string): string {
  return `${operationId}.json`;
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

/**
 * Private, file-backed operation journal. Each CAS is serialized by an O_EXCL
 * lock and committed through fsync + atomic rename + authoritative read-back.
 */
export class FileGitHubPolicyOperationStore implements GitHubPolicyOperationStore {
  readonly #directory: string;
  readonly #files: AtomicFileStore;

  constructor(directory: string, files = new AtomicFileStore()) {
    if (!isAbsolute(directory)) throw new TypeError("GitHub operation directory must be absolute.");
    this.#directory = resolve(directory);
    this.#files = files;
  }

  async read(
    operationId: string,
  ): Promise<Result<GitHubPolicyOperationSnapshot | undefined, DomainError>> {
    if (!operationIdPattern.test(operationId)) return err(domainError("invariant_violation"));
    const result = await readJsonWithSchema(
      join(this.#directory, fileName(operationId)),
      operationSnapshotSchema,
    );
    return !result.ok && result.error.code === "not_found" ? ok(undefined) : result;
  }

  async compareAndSwap(
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
      return err(domainError("invariant_violation"));
    }
    const lock = await acquireFileLock(
      join(this.#directory, `${command.operationId}.lock`),
      `github-policy-operation:${String(process.pid)}`,
    );
    if (!lock.ok) return lock;
    let outcome: Result<GitHubPolicyOperationSnapshot, DomainError>;
    try {
      const current = await this.read(command.operationId);
      if (!current.ok) {
        outcome = current;
      } else if ((current.value?.revision ?? null) !== command.expectedRevision) {
        outcome = err(domainError("conflict"));
      } else {
        const next = snapshot(
          command.operationId,
          (current.value?.revision ?? 0) + 1,
          command.next,
        );
        const written = await writeJsonWithSchema(
          this.#files,
          join(this.#directory, fileName(command.operationId)),
          operationSnapshotSchema,
          next,
          { visibility: "private" },
        );
        outcome =
          written.ok &&
          written.value.durability === "confirmed" &&
          written.value.readBack.ok &&
          written.value.readBack.value.revision === next.revision
            ? ok(written.value.readBack.value)
            : err(domainError("external_failure"));
      }
    } finally {
      const released = await lock.value.release();
      if (!released.ok) outcome = err(domainError("external_failure"));
    }
    return outcome;
  }
}
