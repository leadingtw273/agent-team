import { isAbsolute, resolve } from "node:path";

import { z } from "zod";

import {
  registrationSetupActivationMarkerDigest,
  verifyRegistrationSetupActivationBinding,
  verifyRegistrationSetupApprovalLedgerBinding,
  type RegistrationSetupActivationMarker,
  type RegistrationSetupActivationPublishOptions,
  type RegistrationSetupActivationRegistryPort,
  type RegistrationSetupFinalApprovalAuthorityPort,
  type RegistrationSetupSession,
} from "../../application/registration/index.js";
import type { AsyncPortResult, ReadOptions } from "../../application/ports/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import { sha256Digest } from "../../domain/review/index.js";
import { AtomicFileStore, withSecureDirectory } from "../../infrastructure/files/index.js";
import {
  FileRegistrationSetupFinalApprovalAuthority,
  FileRegistrationSetupSessionStore,
} from "./setup-durable.js";

const digestPattern = /^[0-9a-f]{64}$/u;
const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:@+-]{0,220}$/u;
const mutationKeyPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:@+/-]{0,500}$/u;
const digestSchema = z.string().regex(digestPattern);
const markerSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: z.literal("source_control_default_branch"),
    setupSessionId: z.string().regex(identifierPattern),
    projectId: z.string().regex(identifierPattern),
    repository: z.string().min(1),
    changeRequestId: z.string().regex(identifierPattern),
    setupHeadSha: z.string().regex(shaPattern),
    mergeCommitSha: z.string().regex(shaPattern),
    authoritativeRevision: z.string().regex(shaPattern),
    defaultBranch: z.string().min(1),
    configDigest: digestSchema,
    linearAuditIssueId: z.string().regex(identifierPattern),
    gateEvidenceDigest: digestSchema,
    auditReceiptsDigest: digestSchema,
    approvalSource: z.enum(["local_ui", "current_user_conversation"]),
    approvalReferenceDigest: digestSchema,
    approvalConsumeOperationDigest: digestSchema,
    authorityDigest: digestSchema,
    approvalNonceDigest: digestSchema,
  })
  .strict() as unknown as z.ZodType<RegistrationSetupActivationMarker>;
const indexSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectKeyDigest: digestSchema,
    markerDigest: digestSchema,
    marker: markerSchema,
  })
  .strict();
type ActivationPublishResult = Readonly<{
  state: "confirmed" | "reused" | "replaced";
  marker: RegistrationSetupActivationMarker;
}>;

function projectKey(projectId: string): string | undefined {
  if (!identifierPattern.test(projectId)) return undefined;
  const digest = sha256Digest({ kind: "registration_setup_activation_project", projectId });
  return digest.ok ? digest.value : undefined;
}

// C026: delegates to the shared application-layer helper so this adapter's CAS comparisons and the
// caller's expectedPriorMarkerDigest (threaded from setup.ts) are always computed identically.
function markerDigest(marker: RegistrationSetupActivationMarker): string | undefined {
  const digest = registrationSetupActivationMarkerDigest(marker);
  return digest.ok ? digest.value : undefined;
}

async function readIndex(
  stateRoot: string,
  key: string,
): Promise<Result<z.infer<typeof indexSchema>, DomainError>> {
  return withSecureDirectory(
    stateRoot,
    ["registration-setup-activation", key],
    { create: false },
    async (directory) => {
      const bytes = await directory.readFile("index.json", { maxBytes: 128 * 1024 });
      if (!bytes.ok) return bytes;
      try {
        const parsed = indexSchema.safeParse(JSON.parse(Buffer.from(bytes.value).toString("utf8")));
        if (!parsed.success) return err(domainError("external_failure"));
        const digest = markerDigest(parsed.data.marker);
        return digest === parsed.data.markerDigest && parsed.data.projectKeyDigest === key
          ? ok(parsed.data)
          : err(domainError("conflict"));
      } catch {
        return err(domainError("external_failure"));
      }
    },
  );
}

/** Project-keyed, atomic activation publication. It exposes no session write or merge capability. */
export class FileRegistrationSetupActivationRegistry implements RegistrationSetupActivationRegistryPort {
  readonly #stateRoot: string;
  readonly #atomicStore: AtomicFileStore;
  readonly #sessions: Pick<FileRegistrationSetupSessionStore, "load" | "readActivation">;
  readonly #approvalLedger: Pick<RegistrationSetupFinalApprovalAuthorityPort, "readConsumed">;

  constructor(
    stateRoot: string,
    atomicStore: AtomicFileStore = new AtomicFileStore(),
    sessions: Pick<
      FileRegistrationSetupSessionStore,
      "load" | "readActivation"
    > = new FileRegistrationSetupSessionStore(stateRoot),
    approvalLedger: Pick<
      RegistrationSetupFinalApprovalAuthorityPort,
      "readConsumed"
    > = new FileRegistrationSetupFinalApprovalAuthority(stateRoot),
  ) {
    if (!isAbsolute(stateRoot)) throw new TypeError("state_root_must_be_absolute");
    this.#stateRoot = resolve(stateRoot);
    this.#atomicStore = atomicStore;
    this.#sessions = sessions;
    this.#approvalLedger = approvalLedger;
  }

  async #verifyMarker(
    marker: RegistrationSetupActivationMarker,
    options: ReadOptions,
  ): Promise<Result<RegistrationSetupSession, DomainError>> {
    const session = await this.#sessions.load(marker.setupSessionId, options);
    if (!session.ok) return session;
    const sessionMarker = await this.#sessions.readActivation(marker.setupSessionId, options);
    if (!sessionMarker.ok) return sessionMarker;
    if (
      session.value === undefined ||
      sessionMarker.value === undefined ||
      !verifyRegistrationSetupActivationBinding(session.value, marker) ||
      JSON.stringify(sessionMarker.value) !== JSON.stringify(marker)
    ) {
      return err(domainError("conflict"));
    }
    const anchor = await this.#approvalLedger.readConsumed(marker.approvalReferenceDigest, options);
    return anchor.ok && verifyRegistrationSetupApprovalLedgerBinding(session.value, anchor.value)
      ? ok(session.value)
      : err(domainError("conflict"));
  }

  async read(projectId: string, options: ReadOptions = {}) {
    const key = projectKey(projectId);
    if (key === undefined || options.signal?.aborted === true) {
      return err(domainError("invariant_violation"));
    }
    const read = await readIndex(this.#stateRoot, key);
    if (!read.ok && read.error.code === "not_found") return ok(undefined);
    if (!read.ok) return read;
    if (read.value.marker.projectId !== projectId) return err(domainError("conflict"));
    const verified = await this.#verifyMarker(read.value.marker, options);
    return verified.ok ? ok(read.value.marker) : verified;
  }

  async publish(
    marker: RegistrationSetupActivationMarker,
    options: RegistrationSetupActivationPublishOptions,
  ): AsyncPortResult<ActivationPublishResult> {
    const parsed = markerSchema.safeParse(marker);
    const key = projectKey(marker.projectId);
    const digest = parsed.success ? markerDigest(parsed.data) : undefined;
    const expectedPrior = options.expectedPriorMarkerDigest;
    if (
      !parsed.success ||
      key === undefined ||
      digest === undefined ||
      !mutationKeyPattern.test(options.idempotencyKey) ||
      (expectedPrior !== undefined && !digestPattern.test(expectedPrior)) ||
      options.signal?.aborted === true
    ) {
      return err(domainError("invariant_violation"));
    }
    const verified = await this.#verifyMarker(parsed.data, options);
    if (!verified.ok) return verified;
    return withSecureDirectory<ActivationPublishResult>(
      this.#stateRoot,
      ["registration-setup-activation", key],
      { create: true },
      async (directory) => {
        const lock = await directory.acquireLock("index.lock", `activation-index:${key}`);
        if (!lock.ok) return lock;
        try {
          const existing = await directory.readFile("index.json", { maxBytes: 128 * 1024 });
          // C026: CAS state machine. `existing` is the authoritative current record (read while
          // holding the lock); `expectedPrior` is the caller's belief about it, captured just
          // before this call. The three exit states below are the only ones this method returns.
          let current: z.infer<typeof indexSchema> | undefined;
          if (existing.ok) {
            try {
              const parsedCurrent = indexSchema.safeParse(
                JSON.parse(Buffer.from(existing.value).toString("utf8")),
              );
              if (!parsedCurrent.success) return err(domainError("conflict"));
              current = parsedCurrent.data;
            } catch {
              return err(domainError("conflict"));
            }
          } else if (existing.error.code !== "not_found") {
            return err(existing.error);
          }
          if (current !== undefined) {
            // Idempotent retry: the exact same marker is already published -- reuse, no write.
            if (
              current.markerDigest === digest &&
              JSON.stringify(current.marker) === JSON.stringify(parsed.data)
            ) {
              return ok({ state: "reused" as const, marker: current.marker });
            }
            // Anti-stale/anti-rollback: a different marker exists and the caller's expectedPrior
            // does not match it -- either no expectedPrior was supplied (caller believed there was
            // no index) or it names a marker that is no longer current. Reject either way.
            if (current.markerDigest !== expectedPrior) {
              return err(domainError("conflict"));
            }
            // CAS hit: atomically replace the prior record with the new (re-approval) marker.
            const replacement = indexSchema.parse({
              schemaVersion: 1,
              projectKeyDigest: key,
              markerDigest: digest,
              marker: parsed.data,
            });
            const replaced = await directory.atomicReplace(
              "index.json",
              Buffer.from(`${JSON.stringify(replacement, null, 2)}\n`, "utf8"),
              this.#atomicStore,
              {
                commitGuard: () => lock.value.assertOwnership(),
                publicationGuard: () => lock.value.assertOwnershipSync(),
              },
            );
            if (!replaced.ok) return err(replaced.error);
            const confirmedReplace = await readIndex(this.#stateRoot, key);
            return replaced.value.durability === "confirmed" &&
              confirmedReplace.ok &&
              confirmedReplace.value.markerDigest === digest
              ? ok({ state: "replaced" as const, marker: confirmedReplace.value.marker })
              : err(domainError("external_failure"));
          }
          // No existing index. expectedPrior !== undefined means the caller believed one existed
          // (deleted/rolled back since) -- reject rather than silently treating it as first write.
          if (expectedPrior !== undefined) {
            return err(domainError("conflict"));
          }
          const record = indexSchema.parse({
            schemaVersion: 1,
            projectKeyDigest: key,
            markerDigest: digest,
            marker: parsed.data,
          });
          const written = await directory.atomicReplace(
            "index.json",
            Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8"),
            this.#atomicStore,
            {
              commitGuard: () => lock.value.assertOwnership(),
              publicationGuard: () => lock.value.assertOwnershipSync(),
            },
          );
          if (!written.ok) return err(written.error);
          const confirmed = await readIndex(this.#stateRoot, key);
          return written.value.durability === "confirmed" &&
            confirmed.ok &&
            confirmed.value.markerDigest === digest
            ? ok({ state: "confirmed" as const, marker: confirmed.value.marker })
            : err(domainError("external_failure"));
        } finally {
          await lock.value.release();
        }
      },
    );
  }
}
