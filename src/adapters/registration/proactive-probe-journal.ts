import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { z } from "zod";

import {
  isTerminalCleanPhase,
  isValidRegistrationProbeRunId,
  registrationProbeCleanupKinds,
  registrationProbeCleanupReasons,
  registrationProbeCleanupStates,
  registrationProbeFailureReasons,
  registrationProbePhases,
  registrationProbeStages,
  registrationProbeWebhookProviders,
  type RegistrationProbeJournalPort,
  type RegistrationProbeRun,
  type RegistrationProbeRunMutation,
} from "../../application/registration/proactive-probe-model.js";
import type { ReadOptions } from "../../application/ports/index.js";
import {
  domainError,
  err,
  ok,
  parseIdentifier,
  scopedIdentifierPattern,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import type { Project } from "../../domain/project/index.js";
import {
  AtomicFileStore,
  readJsonWithSchema,
  writeJsonWithSchema,
} from "../../infrastructure/files/index.js";
import { acquireRecoverableFileLock } from "../../infrastructure/events/index.js";

const digestPattern = /^[a-f0-9]{64}$/u;
const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,254}$/u;
const branchPattern = /^agent-team\/probe\/[a-z0-9][a-z0-9-]{0,63}$/u;
const markerPattern = /^agent-team-registration-probe:[a-z0-9][a-z0-9-]{0,63}$/u;
const worktreePathSchema = z.string().refine(isAbsolute);
const projectIdSchema = z
  .string()
  .regex(scopedIdentifierPattern("project")) as unknown as z.ZodType<Project["id"]>;

const cleanupItemSchema = z
  .object({
    state: z.enum(registrationProbeCleanupStates),
    reason: z.enum(registrationProbeCleanupReasons),
  })
  .strict();

const cleanupSchema = z
  .object(
    Object.fromEntries(
      registrationProbeCleanupKinds.map((kind) => [kind, cleanupItemSchema] as const),
    ) as Readonly<Record<(typeof registrationProbeCleanupKinds)[number], typeof cleanupItemSchema>>,
  )
  .strict();

const activationSchema = z
  .object({
    setupSessionId: z.string().regex(identifierPattern),
    authoritativeRevision: z.string().regex(shaPattern),
    defaultBranch: z.string().min(1),
    repository: z.string().min(1),
    configDigest: z.string().regex(digestPattern),
  })
  .strict();

const registrationProbeRunSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    phase: z.enum(registrationProbePhases),
    projectId: projectIdSchema,
    registrationRevision: z.number().int().nonnegative(),
    runId: z.string().refine(isValidRegistrationProbeRunId),
    branch: z.string().regex(branchPattern),
    marker: z.string().regex(markerPattern),
    worktreePath: worktreePathSchema,
    activation: activationSchema,
    cleanup: cleanupSchema,
    linear: z
      .object({ issueId: z.string().min(1), state: z.literal("created") })
      .strict()
      .optional(),
    git: z
      .object({ commitSha: z.string().regex(shaPattern), pushedSha: z.string().regex(shaPattern) })
      .strict()
      .optional(),
    draftPullRequest: z
      .object({
        changeRequestId: z.string().min(1),
        number: z.number().int().positive(),
        baseBranch: z.string().min(1),
        headBranch: z.string().min(1),
        headSha: z.string().regex(shaPattern),
      })
      .strict()
      .optional(),
    ci: z
      .object({
        checkName: z.literal("CI"),
        headSha: z.string().regex(shaPattern),
        conclusion: z.literal("success"),
      })
      .strict()
      .optional(),
    status: z
      .object({
        context: z.literal("agent-team/review"),
        headSha: z.string().regex(shaPattern),
        state: z.literal("success"),
      })
      .strict()
      .optional(),
    syntheticDeliveries: z
      .array(
        z
          .object({
            provider: z.enum(registrationProbeWebhookProviders),
            deliveryId: z.string().min(1),
            latencyMs: z.number().nonnegative(),
            inboxSha256: z.string().regex(digestPattern),
          })
          .strict(),
      )
      .optional(),
    providerEvents: z
      .array(
        z
          .object({
            provider: z.enum(registrationProbeWebhookProviders),
            deliveryId: z.string().min(1),
            eventType: z.string().min(1),
            remoteObjectId: z.string().min(1),
            headSha: z.string().regex(shaPattern).optional(),
            payloadSha256: z.string().regex(digestPattern),
            streamKey: z.string().min(1),
          })
          .strict(),
      )
      .optional(),
    failure: z
      .object({
        stage: z.enum(registrationProbeStages),
        reason: z.enum(registrationProbeFailureReasons),
      })
      .strict()
      .optional(),
  })
  .strict() as unknown as z.ZodType<RegistrationProbeRun>;

function isNotFound(error: DomainError): boolean {
  return error.code === "not_found";
}

/**
 * Durable, per-run CAS journal for the O006 active probe. Mirrors `DurableInbox`'s lock-then-read-
 * then-write-then-readback shape: one JSON file per run, guarded by a recoverable kernel-held
 * file lock, with every write re-read from disk before it is trusted.
 */
export class FileRegistrationProbeJournalStore implements RegistrationProbeJournalPort {
  readonly #directory: string;
  readonly #store: AtomicFileStore;

  constructor(directory: string, store: AtomicFileStore = new AtomicFileStore()) {
    if (!isAbsolute(directory)) throw new Error("registration_probe_journal_root_must_be_absolute");
    this.#directory = directory;
    this.#store = store;
  }

  #path(runId: string): string {
    return join(this.#directory, `${runId}.json`);
  }

  #lockPath(runId: string): string {
    return `${this.#path(runId)}.lock`;
  }

  async load(
    runId: string,
    options: ReadOptions = {},
  ): Promise<Result<RegistrationProbeRun | undefined, DomainError>> {
    if (!isValidRegistrationProbeRunId(runId) || options.signal?.aborted === true) {
      return err(domainError("invariant_violation"));
    }
    const loaded = await readJsonWithSchema(this.#path(runId), registrationProbeRunSchema);
    if (!loaded.ok) return isNotFound(loaded.error) ? ok(undefined) : loaded;
    return ok(loaded.value);
  }

  async compareAndSwap(
    runId: string,
    expectedRevision: number | null,
    next: RegistrationProbeRunMutation,
    options: ReadOptions = {},
  ): Promise<Result<RegistrationProbeRun, DomainError>> {
    if (
      !isValidRegistrationProbeRunId(runId) ||
      next.runId !== runId ||
      options.signal?.aborted === true
    ) {
      return err(domainError("invariant_violation"));
    }
    const acquired = await acquireRecoverableFileLock(
      this.#lockPath(runId),
      `registration-probe-journal:${String(process.pid)}:${randomUUID()}`,
    );
    if (!acquired.ok) return acquired;
    const result = await this.#compareAndSwapLocked(runId, expectedRevision, next);
    const released = await acquired.value.release();
    return !released.ok && result.ok ? released : result;
  }

  async #compareAndSwapLocked(
    runId: string,
    expectedRevision: number | null,
    next: RegistrationProbeRunMutation,
  ): Promise<Result<RegistrationProbeRun, DomainError>> {
    const current = await readJsonWithSchema(this.#path(runId), registrationProbeRunSchema);
    const normalizedCurrent = !current.ok && isNotFound(current.error) ? ok(undefined) : current;
    if (!normalizedCurrent.ok) return normalizedCurrent;
    if (expectedRevision === null) {
      if (normalizedCurrent.value !== undefined) return err(domainError("conflict"));
    } else if (normalizedCurrent.value?.revision !== expectedRevision) {
      return err(domainError("conflict"));
    }

    const candidate = { ...next, revision: (normalizedCurrent.value?.revision ?? -1) + 1 };
    const validated = registrationProbeRunSchema.safeParse(candidate);
    if (!validated.success) return err(domainError("invariant_violation"));

    const written = await writeJsonWithSchema(
      this.#store,
      this.#path(runId),
      registrationProbeRunSchema,
      validated.data,
      { visibility: "private" },
    );
    if (!written.ok) return written;
    if (written.value.durability !== "confirmed" || !written.value.readBack.ok) {
      return err(domainError("external_failure"));
    }
    return ok(written.value.readBack.value);
  }

  async listActiveForProject(
    projectId: Project["id"],
    options: ReadOptions = {},
  ): Promise<Result<readonly RegistrationProbeRun[], DomainError>> {
    const parsedProjectId = parseIdentifier("project", projectId);
    if (!parsedProjectId.ok || options.signal?.aborted === true) {
      return err(domainError("invariant_violation"));
    }
    let entries: string[];
    try {
      entries = (await readdir(this.#directory)).filter((name) => name.endsWith(".json"));
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return ok(Object.freeze([]));
      }
      return err(domainError("external_failure"));
    }

    const runs: RegistrationProbeRun[] = [];
    for (const entry of entries.sort()) {
      const loaded = await readJsonWithSchema(
        join(this.#directory, entry),
        registrationProbeRunSchema,
      );
      if (!loaded.ok) {
        if (isNotFound(loaded.error)) continue;
        return loaded;
      }
      if (`${loaded.value.runId}.json` !== entry) return err(domainError("invariant_violation"));
      if (loaded.value.projectId !== projectId) continue;
      if (isTerminalCleanPhase(loaded.value.phase)) continue;
      runs.push(loaded.value);
    }
    return ok(Object.freeze(runs));
  }
}
