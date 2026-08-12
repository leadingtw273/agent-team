/**
 * Short-lived, local-only evidence that both webhook transports reached the durable Inbox.
 * URLs are used only to derive a digest and are never persisted by this store.
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

export const webhookAttestationTtlMs = 900_000;

const maximumRecordBytes = 4 * 1024;
const digestPattern = /^[a-f0-9]{64}$/u;
const canonicalBaseUrlInputSchema = z.string().trim().min(1).max(2_048);
const configDigestSchema = z.string().regex(digestPattern);
const instantSchema = z
  .string()
  .regex(canonicalInstantPattern)
  .refine((value) => parseInstant(value).ok) as unknown as z.ZodType<Instant>;

export const webhookAttestationLookupSchema = z
  .object({
    projectId: projectIdSchema,
    configDigest: configDigestSchema,
  })
  .strict();

const webhookAttestationConfigSchema = z
  .object({
    projectId: projectIdSchema,
    webhookBaseUrls: z
      .object({
        github: canonicalBaseUrlInputSchema,
        linear: canonicalBaseUrlInputSchema,
      })
      .strict(),
  })
  .strict();

/** The complete durable record shape. No URLs, secrets, or delivery identifiers are allowed. */
export const webhookHealthAttestationSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: projectIdSchema,
    configDigest: configDigestSchema,
    github: z.literal("verified"),
    linear: z.literal("verified"),
    verifiedAt: instantSchema,
    expiresAt: instantSchema,
  })
  .strict()
  .superRefine((record, context) => {
    const verifiedAt = Date.parse(record.verifiedAt);
    const expiresAt = Date.parse(record.expiresAt);
    if (
      !Number.isFinite(verifiedAt) ||
      !Number.isFinite(expiresAt) ||
      expiresAt - verifiedAt !== webhookAttestationTtlMs
    ) {
      context.addIssue({
        code: "custom",
        message: "expiry must be exactly the webhook attestation TTL after verification",
        path: ["expiresAt"],
      });
    }
  });

export type WebhookAttestationLookup = z.infer<typeof webhookAttestationLookupSchema>;
export type WebhookAttestationConfig = z.infer<typeof webhookAttestationConfigSchema>;
export type WebhookHealthAttestation = z.infer<typeof webhookHealthAttestationSchema>;

export type WebhookAttestationInspection =
  | Readonly<{ state: "absent" }>
  | Readonly<{ state: "config_mismatch" }>
  | Readonly<{ state: "expired" }>
  | Readonly<{ state: "verified"; attestation: WebhookHealthAttestation }>;

function isDataOnlyPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return false;
    return Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (descriptor) => "value" in descriptor && descriptor.enumerable,
    );
  } catch {
    return false;
  }
}

function hasExactOwnKeys(value: unknown, expectedKeys: readonly string[]): boolean {
  if (!isDataOnlyPlainObject(value)) return false;
  try {
    // `Object.keys` intentionally omits symbols. They are still own fields, so allowing one
    // would make the strict object boundary accept unknown data that cannot be serialized.
    if (Object.getOwnPropertySymbols(value).length !== 0) return false;
    const actualKeys = Object.keys(value);
    return (
      actualKeys.length === expectedKeys.length &&
      expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    );
  } catch {
    return false;
  }
}

function parseLookup(value: unknown): WebhookAttestationLookup | undefined {
  if (!hasExactOwnKeys(value, ["projectId", "configDigest"])) return undefined;
  const parsed = webhookAttestationLookupSchema.safeParse(value);
  return parsed.success
    ? Object.freeze({ projectId: parsed.data.projectId, configDigest: parsed.data.configDigest })
    : undefined;
}

function parseConfig(value: unknown): WebhookAttestationConfig | undefined {
  if (!hasExactOwnKeys(value, ["projectId", "webhookBaseUrls"])) return undefined;
  const raw = value as Readonly<Record<string, unknown>>;
  if (!hasExactOwnKeys(raw["webhookBaseUrls"], ["github", "linear"])) return undefined;
  const parsed = webhookAttestationConfigSchema.safeParse(value);
  return parsed.success
    ? Object.freeze({
        projectId: parsed.data.projectId,
        webhookBaseUrls: Object.freeze({ ...parsed.data.webhookBaseUrls }),
      })
    : undefined;
}

function parseAttestation(value: unknown): Result<WebhookHealthAttestation, DomainError> {
  if (
    !hasExactOwnKeys(value, [
      "schemaVersion",
      "projectId",
      "configDigest",
      "github",
      "linear",
      "verifiedAt",
      "expiresAt",
    ])
  ) {
    return err(domainError("invariant_violation"));
  }
  const parsed = webhookHealthAttestationSchema.safeParse(value);
  return parsed.success
    ? ok(Object.freeze({ ...parsed.data }))
    : err(domainError("invariant_violation"));
}

function canonicalBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    const loopback = ["127.0.0.1", "::1", "[::1]", "localhost"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.pathname !== "/"
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * Derives the expected digest from the registration probe's two base URLs and project ID.
 * The stable JSON envelope fixes provider ordering while URL normalization removes harmless
 * spelling differences such as an omitted trailing slash or default HTTPS port.
 */
export function webhookAttestationConfigDigest(
  config: WebhookAttestationConfig,
): string | undefined {
  const parsed = parseConfig(config);
  if (parsed === undefined) return undefined;
  const github = canonicalBaseUrl(parsed.webhookBaseUrls.github);
  const linear = canonicalBaseUrl(parsed.webhookBaseUrls.linear);
  if (github === undefined || linear === undefined) return undefined;
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        projectId: parsed.projectId,
        webhookBaseUrls: { github, linear },
      }),
      "utf8",
    )
    .digest("hex");
}

/** Converts registered probe configuration into the URL-free lookup H02 should retain. */
export function webhookAttestationLookupForConfig(
  config: WebhookAttestationConfig,
): WebhookAttestationLookup | undefined {
  const parsed = parseConfig(config);
  const configDigest = parsed === undefined ? undefined : webhookAttestationConfigDigest(parsed);
  return parsed === undefined || configDigest === undefined
    ? undefined
    : Object.freeze({ projectId: parsed.projectId, configDigest });
}

function projectDigest(projectId: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ schemaVersion: 1, projectId }), "utf8")
    .digest("hex");
}

function recordName(lookup: WebhookAttestationLookup): string {
  return `attestation-${projectDigest(lookup.projectId)}.json`;
}

function lockName(lookup: WebhookAttestationLookup): string {
  return `attestation-${projectDigest(lookup.projectId)}.lock`;
}

function currentInstant(clock: Clock): Result<Instant, DomainError> {
  try {
    const parsed = parseInstant(clock.now());
    return parsed.ok ? parsed : err(domainError("invariant_violation"));
  } catch {
    return err(domainError("invariant_violation"));
  }
}

function timeWindow(
  attestation: WebhookHealthAttestation,
  now: Instant,
): Result<"verified" | "expired", DomainError> {
  const verifiedAt = Date.parse(attestation.verifiedAt);
  const expiresAt = Date.parse(attestation.expiresAt);
  const observedAt = Date.parse(now);
  if (!Number.isFinite(verifiedAt) || !Number.isFinite(expiresAt) || !Number.isFinite(observedAt)) {
    return err(domainError("invariant_violation"));
  }
  if (verifiedAt > observedAt) return err(domainError("invariant_violation"));
  return ok(observedAt < expiresAt ? "verified" : "expired");
}

/**
 * Validates an in-memory or decoded record against its expected project/configuration and clock.
 * Any malformed input, clock rollback, future verification time, or wrong project is an error;
 * a configuration drift or expiry is a typed non-verified result.
 */
export function validateWebhookAttestation(
  value: unknown,
  lookup: WebhookAttestationLookup,
  now: Instant,
): Result<Exclude<WebhookAttestationInspection, Readonly<{ state: "absent" }>>, DomainError> {
  const expected = parseLookup(lookup);
  const observedAt = parseInstant(now);
  const parsed = parseAttestation(value);
  if (expected === undefined || !observedAt.ok || !parsed.ok) {
    return err(domainError("invariant_violation"));
  }
  if (parsed.value.projectId !== expected.projectId) return err(domainError("conflict"));
  const window = timeWindow(parsed.value, observedAt.value);
  if (!window.ok) return window;
  if (parsed.value.configDigest !== expected.configDigest) {
    return ok(Object.freeze({ state: "config_mismatch" }));
  }
  return window.value === "expired"
    ? ok(Object.freeze({ state: "expired" }))
    : ok(Object.freeze({ state: "verified", attestation: parsed.value }));
}

function serializeRecord(attestation: WebhookHealthAttestation): Result<Uint8Array, DomainError> {
  const parsed = parseAttestation(attestation);
  return parsed.ok
    ? ok(Uint8Array.from(Buffer.from(`${JSON.stringify(parsed.value)}\n`, "utf8")))
    : parsed;
}

async function readRecord(
  directory: HeldSecureDirectory,
  lookup: WebhookAttestationLookup,
): Promise<Result<WebhookHealthAttestation | undefined, DomainError>> {
  const bytes = await directory.readFile(recordName(lookup), { maxBytes: maximumRecordBytes });
  if (!bytes.ok) return bytes.error.code === "not_found" ? ok(undefined) : bytes;
  const decoded = (() => {
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.value)) as unknown;
    } catch {
      return undefined;
    }
  })();
  const parsed =
    decoded === undefined ? err(domainError("invariant_violation")) : parseAttestation(decoded);
  if (!parsed.ok) return parsed;
  return parsed.value.projectId === lookup.projectId ? parsed : err(domainError("conflict"));
}

async function writeAndReadBack(
  directory: HeldSecureDirectory,
  lock: SecureFileLockHandle,
  lookup: WebhookAttestationLookup,
  attestation: WebhookHealthAttestation,
  files: AtomicFileStore,
): Promise<Result<WebhookHealthAttestation, DomainError>> {
  const content = serializeRecord(attestation);
  if (!content.ok) return content;
  const ownedBefore = await lock.assertOwnership();
  if (!ownedBefore.ok) return ownedBefore;
  const written = await directory.atomicReplace(recordName(lookup), content.value, files, {
    publicationGuard: () => lock.assertOwnershipSync(),
  });
  if (!written.ok || written.value.durability !== "confirmed") {
    return written.ok ? err(domainError("external_failure")) : written;
  }
  const ownedAfterWrite = await lock.assertOwnership();
  if (!ownedAfterWrite.ok) return ownedAfterWrite;
  const rawReadBack = await directory.readFile(recordName(lookup), {
    maxBytes: maximumRecordBytes,
  });
  if (!rawReadBack.ok) return rawReadBack;
  if (Buffer.compare(Buffer.from(rawReadBack.value), Buffer.from(content.value)) !== 0) {
    return err(domainError("external_failure"));
  }
  const decoded = (() => {
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(rawReadBack.value),
      ) as unknown;
    } catch {
      return undefined;
    }
  })();
  const readBack =
    decoded === undefined ? err(domainError("external_failure")) : parseAttestation(decoded);
  const ownedAfterReadBack = await lock.assertOwnership();
  if (!ownedAfterReadBack.ok) return ownedAfterReadBack;
  return readBack.ok && JSON.stringify(readBack.value) === JSON.stringify(attestation)
    ? ok(readBack.value)
    : err(domainError("external_failure"));
}

/**
 * Per-project durable store. Reads never create a directory or lock, so a future health reader
 * remains strictly read-only. Writes are serialized by one permanent, kernel-held project lock.
 */
export class FileWebhookAttestationStore {
  readonly #agentTeamHome: string;
  readonly #files: AtomicFileStore;
  readonly #clock: Clock;

  constructor(
    agentTeamHome: string,
    options: Readonly<{ files?: AtomicFileStore; clock?: Clock }> = {},
  ) {
    if (!isAbsolute(agentTeamHome)) throw new TypeError("agent_team_home_must_be_absolute");
    this.#agentTeamHome = agentTeamHome;
    this.#files = options.files ?? new AtomicFileStore();
    this.#clock = options.clock ?? createClock();
  }

  async #withDirectory<Value>(
    create: boolean,
    action: (directory: HeldSecureDirectory) => Promise<Result<Value, DomainError>>,
  ): Promise<Result<Value, DomainError>> {
    return withSecureDirectory(
      this.#agentTeamHome,
      ["state", "health", "webhook-attestations"],
      { create },
      action,
    );
  }

  async #withLock<Value>(
    directory: HeldSecureDirectory,
    lookup: WebhookAttestationLookup,
    action: (lock: SecureFileLockHandle) => Promise<Result<Value, DomainError>>,
  ): Promise<Result<Value, DomainError>> {
    const lock = await directory.acquireLock(
      lockName(lookup),
      `webhook-attestation:${randomUUID()}`,
    );
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

  /** Read and validate only: no directory, lock, record, or timestamp is ever written. */
  async read(
    input: WebhookAttestationLookup,
  ): Promise<Result<WebhookAttestationInspection, DomainError>> {
    const lookup = parseLookup(input);
    if (lookup === undefined) return err(domainError("invariant_violation"));
    const read = await this.#withDirectory(false, async (directory) =>
      readRecord(directory, lookup),
    );
    if (!read.ok) {
      return read.error.code === "not_found"
        ? ok(Object.freeze({ state: "absent" as const }))
        : read;
    }
    if (read.value === undefined) return ok(Object.freeze({ state: "absent" as const }));
    const now = currentInstant(this.#clock);
    if (!now.ok) return now;
    return validateWebhookAttestation(read.value, lookup, now.value);
  }

  /**
   * Publish a new dual-provider verified record. The only accepted state is fixed `verified`
   * for both providers; the verification and expiry timestamps are minted under the project lock.
   */
  async writeVerified(
    input: WebhookAttestationLookup,
  ): Promise<Result<WebhookHealthAttestation, DomainError>> {
    const lookup = parseLookup(input);
    if (lookup === undefined) return err(domainError("invariant_violation"));
    return this.#withDirectory(true, async (directory) =>
      this.#withLock(directory, lookup, async (lock) => {
        // A malformed or future existing record is never overwritten: that would turn an unknown
        // durability/security state into a false healthy result. A valid old config is allowed to
        // be replaced only after H02 has independently verified the new transport configuration.
        const current = await readRecord(directory, lookup);
        if (!current.ok) return current;
        const verifiedAt = currentInstant(this.#clock);
        if (!verifiedAt.ok) return verifiedAt;
        if (current.value !== undefined) {
          const existingWindow = timeWindow(current.value, verifiedAt.value);
          if (!existingWindow.ok) return existingWindow;
        }
        const verifiedAtMs = Date.parse(verifiedAt.value);
        const expiresAt = parseInstant(
          new Date(verifiedAtMs + webhookAttestationTtlMs).toISOString(),
        );
        if (!expiresAt.ok) return err(domainError("invariant_violation"));
        const candidate: WebhookHealthAttestation = Object.freeze({
          schemaVersion: 1,
          projectId: lookup.projectId,
          configDigest: lookup.configDigest,
          github: "verified",
          linear: "verified",
          verifiedAt: verifiedAt.value,
          expiresAt: expiresAt.value,
        });
        return writeAndReadBack(directory, lock, lookup, candidate, this.#files);
      }),
    );
  }
}
