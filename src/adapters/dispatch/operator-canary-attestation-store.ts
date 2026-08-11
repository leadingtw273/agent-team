/**
 * Private, one-time operator attestation for the narrowly-scoped Claude canary.  This is not a
 * provider quota observation: the record is keyed to one project and one Linear opaque issue id,
 * and may only be consumed once before a new-job admission claim is attempted.
 */
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import { z } from "zod";

import {
  canonicalInstantPattern,
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
import { projectIdSchema } from "../../domain/project/index.js";
import {
  AtomicFileStore,
  withSecureDirectory,
  type HeldSecureDirectory,
  type SecureFileLockHandle,
} from "../../infrastructure/files/index.js";

export const operatorCanaryTtlMs = 900_000;

const maximumRecordBytes = 16 * 1024;
const opaqueLinearIssueIdSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value),
    "linear external issue id must be exact opaque text",
  );
const claudeCliVersionSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value),
    "claude cli version must be one normalized line",
  );
const instantSchema = z
  .string()
  .regex(canonicalInstantPattern)
  .refine((value) => parseInstant(value).ok) as unknown as z.ZodType<Instant>;
const revisionSchema = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, "revision must be a safe integer");
const attestationIdSchema = z.uuid();

export const operatorCanaryAttestationSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: revisionSchema,
    attestationId: attestationIdSchema,
    source: z.literal("operator_canary"),
    authority: z.literal("current_user_conversation"),
    provider: z.literal("claude"),
    projectId: projectIdSchema,
    linearExternalIssueId: opaqueLinearIssueIdSchema,
    claudeCliVersion: claudeCliVersionSchema,
    issuedAt: instantSchema,
    expiresAt: instantSchema,
    state: z.enum(["issued", "consumed"]),
    consumedAt: instantSchema.optional(),
  })
  .strict()
  .superRefine((record, context) => {
    const issuedAt = Date.parse(record.issuedAt);
    const expiresAt = Date.parse(record.expiresAt);
    if (
      !Number.isFinite(issuedAt) ||
      !Number.isFinite(expiresAt) ||
      expiresAt - issuedAt !== operatorCanaryTtlMs
    ) {
      context.addIssue({
        code: "custom",
        message: "attestation expiry must be exactly the canary TTL after issue time",
        path: ["expiresAt"],
      });
    }
    if (record.state === "issued" && record.consumedAt !== undefined) {
      context.addIssue({
        code: "custom",
        message: "issued attestation must not carry consumedAt",
        path: ["consumedAt"],
      });
    }
    if (record.state === "consumed" && record.consumedAt === undefined) {
      context.addIssue({
        code: "custom",
        message: "consumed attestation must carry consumedAt",
        path: ["consumedAt"],
      });
    }
    if (
      record.consumedAt !== undefined &&
      (!Number.isFinite(issuedAt) ||
        !Number.isFinite(expiresAt) ||
        Date.parse(record.consumedAt) < issuedAt ||
        Date.parse(record.consumedAt) >= expiresAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "consumedAt must be inside the issued validity window",
        path: ["consumedAt"],
      });
    }
  });

export type OperatorCanaryAttestation = z.infer<typeof operatorCanaryAttestationSchema>;

export interface OperatorCanaryScope {
  readonly projectId: string;
  readonly linearExternalIssueId: string;
}

export interface OperatorCanaryIssueInput extends OperatorCanaryScope {
  readonly claudeCliVersion: string;
}

export interface OperatorCanaryConsumeInput extends OperatorCanaryIssueInput {
  readonly attestationId: string;
  readonly expectedRevision: number;
}

const operatorCanaryIssueInputSchema = z
  .object({
    projectId: projectIdSchema,
    linearExternalIssueId: opaqueLinearIssueIdSchema,
    claudeCliVersion: claudeCliVersionSchema,
  })
  .strict();
const operatorCanaryConsumeInputSchema = operatorCanaryIssueInputSchema
  .extend({
    attestationId: attestationIdSchema,
    expectedRevision: revisionSchema,
  })
  .strict();

export type OperatorCanaryInspection =
  | Readonly<{ state: "absent" }>
  | Readonly<{ state: "expired" }>
  | Readonly<{ state: "consumed" }>
  | Readonly<{ state: "issued"; attestation: OperatorCanaryAttestation }>;

function scopeDigest(scope: OperatorCanaryScope): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        projectId: scope.projectId,
        linearExternalIssueId: scope.linearExternalIssueId,
      }),
      "utf8",
    )
    .digest("hex");
}

export function operatorCanaryScopeDigest(scope: OperatorCanaryScope): string | undefined {
  return validScope(scope) ? scopeDigest(scope) : undefined;
}

export function operatorCanaryVersionDigest(version: string): string | undefined {
  const parsed = claudeCliVersionSchema.safeParse(version);
  return parsed.success
    ? createHash("sha256").update(parsed.data, "utf8").digest("hex")
    : undefined;
}

function recordName(scope: OperatorCanaryScope): string {
  return `attestation-${scopeDigest(scope)}.json`;
}

function lockName(scope: OperatorCanaryScope): string {
  return `attestation-${scopeDigest(scope)}.lock`;
}

function validScope(scope: OperatorCanaryScope): boolean {
  return (
    projectIdSchema.safeParse(scope.projectId).success &&
    opaqueLinearIssueIdSchema.safeParse(scope.linearExternalIssueId).success
  );
}

function timeWindowState(
  attestation: OperatorCanaryAttestation,
  now: Instant,
): Result<"issued" | "expired" | "consumed", DomainError> {
  const issuedAt = Date.parse(attestation.issuedAt);
  const expiresAt = Date.parse(attestation.expiresAt);
  const observedAt = Date.parse(now);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || !Number.isFinite(observedAt)) {
    return err(domainError("invariant_violation"));
  }
  if (issuedAt > observedAt) return err(domainError("invariant_violation"));
  if (
    attestation.state === "consumed" &&
    (attestation.consumedAt === undefined || Date.parse(attestation.consumedAt) > observedAt)
  ) {
    return err(domainError("invariant_violation"));
  }
  if (attestation.state === "consumed") return ok("consumed");
  return ok(observedAt < expiresAt ? "issued" : "expired");
}

function exactScopeMatches(
  attestation: OperatorCanaryAttestation,
  scope: OperatorCanaryScope,
): boolean {
  return (
    attestation.projectId === scope.projectId &&
    attestation.linearExternalIssueId === scope.linearExternalIssueId
  );
}

function parseRecord(bytes: Uint8Array): Result<OperatorCanaryAttestation, DomainError> {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = operatorCanaryAttestationSchema.safeParse(JSON.parse(decoded) as unknown);
    return parsed.success
      ? ok(Object.freeze(parsed.data))
      : err(domainError("invariant_violation"));
  } catch {
    return err(domainError("invariant_violation"));
  }
}

function serializeRecord(attestation: OperatorCanaryAttestation): Result<Uint8Array, DomainError> {
  const parsed = operatorCanaryAttestationSchema.safeParse(attestation);
  return parsed.success
    ? ok(Uint8Array.from(Buffer.from(`${JSON.stringify(parsed.data)}\n`, "utf8")))
    : err(domainError("invariant_violation"));
}

async function readRecord(
  directory: HeldSecureDirectory,
  scope: OperatorCanaryScope,
): Promise<Result<OperatorCanaryAttestation | undefined, DomainError>> {
  const bytes = await directory.readFile(recordName(scope), { maxBytes: maximumRecordBytes });
  if (!bytes.ok) return bytes.error.code === "not_found" ? ok(undefined) : bytes;
  const parsed = parseRecord(bytes.value);
  if (!parsed.ok) return parsed;
  return exactScopeMatches(parsed.value, scope) ? parsed : err(domainError("conflict"));
}

async function writeAndReadBack(
  directory: HeldSecureDirectory,
  lock: SecureFileLockHandle,
  scope: OperatorCanaryScope,
  attestation: OperatorCanaryAttestation,
  files: AtomicFileStore,
): Promise<Result<OperatorCanaryAttestation, DomainError>> {
  const content = serializeRecord(attestation);
  if (!content.ok) return content;
  const ownedBefore = await lock.assertOwnership();
  if (!ownedBefore.ok) return ownedBefore;
  const written = await directory.atomicReplace(recordName(scope), content.value, files, {
    publicationGuard: () => lock.assertOwnershipSync(),
  });
  if (!written.ok || written.value.durability !== "confirmed") {
    return written.ok ? err(domainError("external_failure")) : written;
  }
  const ownedAfterWrite = await lock.assertOwnership();
  if (!ownedAfterWrite.ok) return ownedAfterWrite;
  const rawReadBack = await directory.readFile(recordName(scope), { maxBytes: maximumRecordBytes });
  if (!rawReadBack.ok) return rawReadBack;
  if (Buffer.compare(Buffer.from(rawReadBack.value), Buffer.from(content.value)) !== 0) {
    return err(domainError("external_failure"));
  }
  const readBack = parseRecord(rawReadBack.value);
  const ownedAfterReadBack = await lock.assertOwnership();
  if (!ownedAfterReadBack.ok) return ownedAfterReadBack;
  return readBack.ok && JSON.stringify(readBack.value) === JSON.stringify(attestation)
    ? ok(readBack.value)
    : err(domainError("external_failure"));
}

/**
 * The store keeps the AGENT_TEAM_HOME directory descriptor held for each individual operation,
 * then takes a permanent per-scope lock.  Raw scope values only ever exist inside record content;
 * filenames and public status are SHA-256 digests.
 */
export class FileOperatorCanaryAttestationStore {
  readonly #agentTeamHome: string;
  readonly #files: AtomicFileStore;
  readonly #clock: Clock;
  readonly #generateAttestationId: () => string;

  constructor(
    agentTeamHome: string,
    options: Readonly<{
      files?: AtomicFileStore;
      clock?: Clock;
      generateAttestationId?: () => string;
    }> = {},
  ) {
    if (!isAbsolute(agentTeamHome)) throw new TypeError("agent_team_home_must_be_absolute");
    this.#agentTeamHome = agentTeamHome;
    this.#files = options.files ?? new AtomicFileStore();
    this.#clock = options.clock ?? createClock();
    this.#generateAttestationId = options.generateAttestationId ?? randomUUID;
  }

  async #withDirectory<Value>(
    create: boolean,
    action: (directory: HeldSecureDirectory) => Promise<Result<Value, DomainError>>,
  ): Promise<Result<Value, DomainError>> {
    return withSecureDirectory(
      this.#agentTeamHome,
      ["state", "quota", "operator-canary"],
      { create },
      action,
    );
  }

  async #withLock<Value>(
    directory: HeldSecureDirectory,
    scope: OperatorCanaryScope,
    holder: string,
    action: (lock: SecureFileLockHandle) => Promise<Result<Value, DomainError>>,
  ): Promise<Result<Value, DomainError>> {
    const lock = await directory.acquireLock(lockName(scope), holder);
    if (!lock.ok) return lock;
    let result: Result<Value, DomainError> = err(domainError("external_failure"));
    try {
      const ownedBefore = await lock.value.assertOwnership();
      result = ownedBefore.ok ? await action(lock.value) : ownedBefore;
      const ownedAfter = await lock.value.assertOwnership();
      if (!ownedAfter.ok && result.ok) result = ownedAfter;
    } finally {
      const released = await lock.value.release();
      if (!released.ok && result.ok) result = err(domainError("external_failure"));
    }
    return result;
  }

  async inspect(
    scope: OperatorCanaryScope,
  ): Promise<Result<OperatorCanaryInspection, DomainError>> {
    if (!validScope(scope)) return err(domainError("invariant_violation"));
    const read = await this.#withDirectory(false, async (directory) =>
      readRecord(directory, scope),
    );
    if (!read.ok) {
      return read.error.code === "not_found"
        ? ok(Object.freeze({ state: "absent" as const }))
        : read;
    }
    if (read.value === undefined) return ok(Object.freeze({ state: "absent" as const }));
    // Read the clock only after the no-follow snapshot has been obtained.  `inspect` is advisory,
    // but this still avoids reporting a stale active window when filesystem work crossed expiry.
    const now = this.#clock.now();
    const window = timeWindowState(read.value, now);
    if (!window.ok) return window;
    switch (window.value) {
      case "issued":
        return ok(Object.freeze({ state: "issued" as const, attestation: read.value }));
      case "expired":
        return ok(Object.freeze({ state: "expired" as const }));
      case "consumed":
        return ok(Object.freeze({ state: "consumed" as const }));
    }
  }

  async issue(
    input: OperatorCanaryIssueInput,
  ): Promise<Result<OperatorCanaryAttestation, DomainError>> {
    const parsedInput = operatorCanaryIssueInputSchema.safeParse(input);
    if (!parsedInput.success) return err(domainError("invariant_violation"));
    const issuedInput = parsedInput.data;
    return this.#withDirectory(true, async (directory) =>
      this.#withLock(
        directory,
        issuedInput,
        `operator-canary-issue:${randomUUID()}`,
        async (lock) => {
          const current = await readRecord(directory, issuedInput);
          if (!current.ok) return current;
          // The validity/expiry decision is part of this lock-protected transaction.  Capturing
          // `now` before waiting for the lock could otherwise let a queued caller reissue or
          // consume using a point in time that predates the actual transaction.
          const canonicalNow = parseInstant(this.#clock.now());
          if (!canonicalNow.ok) return err(domainError("invariant_violation"));
          if (current.value !== undefined) {
            const window = timeWindowState(current.value, canonicalNow.value);
            if (!window.ok) return window;
            if (window.value === "issued") return err(domainError("conflict"));
          }
          const issuedAtMs = Date.parse(canonicalNow.value);
          const expiresAt = new Date(issuedAtMs + operatorCanaryTtlMs).toISOString();
          const parsedExpiry = parseInstant(expiresAt);
          if (!parsedExpiry.ok) return err(domainError("invariant_violation"));
          const generatedId = this.#generateAttestationId();
          if (
            !attestationIdSchema.safeParse(generatedId).success ||
            generatedId === current.value?.attestationId
          ) {
            return err(domainError("external_failure"));
          }
          const candidate: OperatorCanaryAttestation = Object.freeze({
            schemaVersion: 1,
            revision: (current.value?.revision ?? -1) + 1,
            attestationId: generatedId,
            source: "operator_canary",
            authority: "current_user_conversation",
            provider: "claude",
            projectId: issuedInput.projectId,
            linearExternalIssueId: issuedInput.linearExternalIssueId,
            claudeCliVersion: issuedInput.claudeCliVersion,
            issuedAt: canonicalNow.value,
            expiresAt: parsedExpiry.value,
            state: "issued",
          });
          return writeAndReadBack(directory, lock, issuedInput, candidate, this.#files);
        },
      ),
    );
  }

  async consume(
    input: OperatorCanaryConsumeInput,
  ): Promise<Result<OperatorCanaryAttestation, DomainError>> {
    const parsedInput = operatorCanaryConsumeInputSchema.safeParse(input);
    if (!parsedInput.success) return err(domainError("invariant_violation"));
    const consumeInput = parsedInput.data;
    return this.#withDirectory(false, async (directory) =>
      this.#withLock(
        directory,
        consumeInput,
        `operator-canary-consume:${randomUUID()}`,
        async (lock) => {
          const current = await readRecord(directory, consumeInput);
          if (!current.ok) return current;
          const existing = current.value;
          if (existing?.state !== "issued") {
            return err(domainError("conflict"));
          }
          if (
            existing.attestationId !== consumeInput.attestationId ||
            existing.revision !== consumeInput.expectedRevision ||
            existing.claudeCliVersion !== consumeInput.claudeCliVersion
          ) {
            return err(domainError("conflict"));
          }
          const canonicalNow = parseInstant(this.#clock.now());
          if (!canonicalNow.ok) return err(domainError("invariant_violation"));
          const window = timeWindowState(existing, canonicalNow.value);
          if (!window.ok) return window;
          if (window.value !== "issued") return err(domainError("conflict"));
          const next: OperatorCanaryAttestation = Object.freeze({
            ...existing,
            revision: existing.revision + 1,
            state: "consumed",
            consumedAt: canonicalNow.value,
          });
          return writeAndReadBack(directory, lock, consumeInput, next, this.#files);
        },
      ),
    );
  }
}
