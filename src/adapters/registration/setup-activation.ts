import { isAbsolute, resolve } from "node:path";

import { z } from "zod";

import type {
  RegistrationSetupActivationMarker,
  RegistrationSetupActivationRegistryPort,
} from "../../application/registration/index.js";
import type {
  AsyncPortResult,
  MutationOptions,
  ReadOptions,
} from "../../application/ports/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import { sha256Digest } from "../../domain/review/index.js";
import { AtomicFileStore, withSecureDirectory } from "../../infrastructure/files/index.js";
import { FileRegistrationSetupSessionStore } from "./setup-durable.js";

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
  state: "confirmed" | "reused";
  marker: RegistrationSetupActivationMarker;
}>;

function projectKey(projectId: string): string | undefined {
  if (!identifierPattern.test(projectId)) return undefined;
  const digest = sha256Digest({ kind: "registration_setup_activation_project", projectId });
  return digest.ok ? digest.value : undefined;
}

function markerDigest(marker: RegistrationSetupActivationMarker): string | undefined {
  const digest = sha256Digest({ kind: "registration_setup_activation_marker", marker });
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
  readonly #sessions: Pick<FileRegistrationSetupSessionStore, "readActivation">;

  constructor(
    stateRoot: string,
    atomicStore: AtomicFileStore = new AtomicFileStore(),
    sessions: Pick<
      FileRegistrationSetupSessionStore,
      "readActivation"
    > = new FileRegistrationSetupSessionStore(stateRoot),
  ) {
    if (!isAbsolute(stateRoot)) throw new TypeError("state_root_must_be_absolute");
    this.#stateRoot = resolve(stateRoot);
    this.#atomicStore = atomicStore;
    this.#sessions = sessions;
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
    const sessionMarker = await this.#sessions.readActivation(
      read.value.marker.setupSessionId,
      options,
    );
    return sessionMarker.ok &&
      sessionMarker.value !== undefined &&
      JSON.stringify(sessionMarker.value) === JSON.stringify(read.value.marker)
      ? ok(read.value.marker)
      : err(domainError(sessionMarker.ok ? "conflict" : sessionMarker.error.code));
  }

  async publish(
    marker: RegistrationSetupActivationMarker,
    options: MutationOptions,
  ): AsyncPortResult<ActivationPublishResult> {
    const parsed = markerSchema.safeParse(marker);
    const key = projectKey(marker.projectId);
    const digest = parsed.success ? markerDigest(parsed.data) : undefined;
    if (
      !parsed.success ||
      key === undefined ||
      digest === undefined ||
      !mutationKeyPattern.test(options.idempotencyKey) ||
      options.signal?.aborted === true
    ) {
      return err(domainError("invariant_violation"));
    }
    const sessionMarker = await this.#sessions.readActivation(parsed.data.setupSessionId, options);
    if (
      !sessionMarker.ok ||
      sessionMarker.value === undefined ||
      JSON.stringify(sessionMarker.value) !== JSON.stringify(parsed.data)
    ) {
      return err(domainError(sessionMarker.ok ? "conflict" : sessionMarker.error.code));
    }
    return withSecureDirectory<ActivationPublishResult>(
      this.#stateRoot,
      ["registration-setup-activation", key],
      { create: true },
      async (directory) => {
        const lock = await directory.acquireLock("index.lock", `activation-index:${key}`);
        if (!lock.ok) return lock;
        try {
          const existing = await directory.readFile("index.json", { maxBytes: 128 * 1024 });
          if (existing.ok) {
            try {
              const current = indexSchema.safeParse(
                JSON.parse(Buffer.from(existing.value).toString("utf8")),
              );
              if (!current.success) return err(domainError("conflict"));
              return current.data.markerDigest === digest &&
                JSON.stringify(current.data.marker) === JSON.stringify(parsed.data)
                ? ok({ state: "reused" as const, marker: current.data.marker })
                : err(domainError("conflict"));
            } catch {
              return err(domainError("conflict"));
            }
          }
          if (existing.error.code !== "not_found") return err(existing.error);
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
