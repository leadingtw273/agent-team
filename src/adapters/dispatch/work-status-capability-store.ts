import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";

import { z } from "zod";

import type { ReadOptions } from "../../application/ports/index.js";
import type { LinearProjectContext } from "../linear/index.js";
import {
  createClock,
  domainError,
  err,
  ok,
  parseIdentifier,
  canonicalInstantPattern,
  parseInstant,
  type Clock,
  type DomainError,
  type Instant,
  type Result,
} from "../../domain/foundation/index.js";
import { projectIdSchema } from "../../domain/jobs/index.js";
import { agentStatuses, blockingReasons, workStatuses } from "../../domain/workflow/index.js";
import { sha256Digest, type Sha256Digest } from "../../domain/review/index.js";
import {
  AtomicFileStore,
  acquireRecoverableFileLock,
  readJsonWithSchema,
  writeJsonWithSchema,
} from "../../infrastructure/files/index.js";

const externalIdSchema = z.string().trim().min(1).max(255);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u) as unknown as z.ZodType<Sha256Digest>;
const instantSchema = z
  .string()
  .regex(canonicalInstantPattern)
  .refine((value) => parseInstant(value).ok) as unknown as z.ZodType<Instant>;

const workStateIdsSchema = z.record(z.enum(workStatuses), externalIdSchema);
const agentStatusLabelIdsSchema = z.record(z.enum(agentStatuses), externalIdSchema);
const blockingReasonLabelIdsSchema = z.record(z.enum(blockingReasons), externalIdSchema);

export const workStatusCapabilityIdentitySchema = z
  .object({
    teamId: externalIdSchema,
    linearProjectId: externalIdSchema,
    workStateIds: workStateIdsSchema,
    agentStatus: z
      .object({ groupId: externalIdSchema, labelIds: agentStatusLabelIdsSchema })
      .strict(),
    blockingReason: z
      .object({ groupId: externalIdSchema, labelIds: blockingReasonLabelIdsSchema })
      .strict(),
  })
  .strict();
export type WorkStatusCapabilityIdentity = z.infer<typeof workStatusCapabilityIdentitySchema>;

export const workStatusCapabilitySnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    identity: workStatusCapabilityIdentitySchema,
    digest: digestSchema,
  })
  .strict();
export type WorkStatusCapabilitySnapshot = z.infer<typeof workStatusCapabilitySnapshotSchema>;

export const workStatusCapabilityRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    projectId: projectIdSchema,
    capability: workStatusCapabilitySnapshotSchema,
    checkedAt: instantSchema,
  })
  .strict();
export type WorkStatusCapabilityRecord = z.infer<typeof workStatusCapabilityRecordSchema>;

function sortedRecord<Value extends string>(
  values: readonly Value[],
  source: Readonly<Record<Value, string>>,
): Readonly<Record<Value, string>> {
  return Object.freeze(
    Object.fromEntries([...values].sort().map((value) => [value, source[value]])) as Record<
      Value,
      string
    >,
  );
}

/**
 * Projects only a verified Linear catalog into the runtime identity used by every work-status
 * transition. Names never survive this boundary: runtime mutations bind exclusively to these IDs
 * and the canonical digest. `checkedAt` deliberately lives outside the digest so an unchanged
 * catalog has a stable identity across probes.
 */
export function createWorkStatusCapabilitySnapshot(
  context: LinearProjectContext,
): Result<WorkStatusCapabilitySnapshot, DomainError<"invariant_violation">> {
  const identity = workStatusCapabilityIdentitySchema.safeParse({
    teamId: context.team.id,
    linearProjectId: context.project.id,
    workStateIds: sortedRecord(workStatuses, context.catalog.stateIdByWorkStatus),
    agentStatus: {
      groupId: context.catalog.agentStatus.groupId,
      labelIds: sortedRecord(agentStatuses, context.catalog.agentStatus.labelIdByValue),
    },
    blockingReason: {
      groupId: context.catalog.blockingReason.groupId,
      labelIds: sortedRecord(blockingReasons, context.catalog.blockingReason.labelIdByValue),
    },
  });
  if (!identity.success) return err(domainError("invariant_violation"));
  const digest = sha256Digest(identity.data);
  if (!digest.ok) return digest;
  return ok(Object.freeze({ schemaVersion: 1, identity: identity.data, digest: digest.value }));
}

function isNotFound(error: DomainError): boolean {
  return error.code === "not_found";
}

/** Private, per-project evidence of the most recently read-back Linear capability catalog. */
export class FileWorkStatusCapabilityStore {
  readonly #directory: string;
  readonly #store: AtomicFileStore;
  readonly #clock: Clock;

  constructor(
    directory: string,
    store: AtomicFileStore = new AtomicFileStore(),
    clock: Clock = createClock(),
  ) {
    if (!isAbsolute(directory)) throw new Error("work_status_capability_root_must_be_absolute");
    this.#directory = directory;
    this.#store = store;
    this.#clock = clock;
  }

  #path(projectId: string): string {
    return join(this.#directory, `${projectId}.json`);
  }

  async load(
    projectId: string,
    options: ReadOptions = {},
  ): Promise<Result<WorkStatusCapabilityRecord | undefined, DomainError>> {
    if (!parseIdentifier("project", projectId).ok || options.signal?.aborted === true) {
      return err(domainError("invariant_violation"));
    }
    const loaded = await readJsonWithSchema(
      this.#path(projectId),
      workStatusCapabilityRecordSchema,
    );
    if (!loaded.ok) return isNotFound(loaded.error) ? ok(undefined) : loaded;
    return ok(loaded.value);
  }

  async save(
    projectId: string,
    capability: WorkStatusCapabilitySnapshot,
    options: ReadOptions = {},
  ): Promise<Result<WorkStatusCapabilityRecord, DomainError>> {
    const parsed = workStatusCapabilitySnapshotSchema.safeParse(capability);
    const recomputed = parsed.success ? sha256Digest(parsed.data.identity) : undefined;
    if (
      !parseIdentifier("project", projectId).ok ||
      !parsed.success ||
      recomputed === undefined ||
      !recomputed.ok ||
      recomputed.value !== parsed.data.digest ||
      options.signal?.aborted === true
    ) {
      return err(domainError("invariant_violation"));
    }
    const path = this.#path(projectId);
    const lock = await acquireRecoverableFileLock(
      `${path}.lock`,
      `work-status-capability:${String(process.pid)}:${randomUUID()}`,
    );
    if (!lock.ok) return lock;
    const current = await readJsonWithSchema(path, workStatusCapabilityRecordSchema);
    const normalized = !current.ok && isNotFound(current.error) ? ok(undefined) : current;
    let result: Result<WorkStatusCapabilityRecord, DomainError>;
    if (!normalized.ok) {
      result = normalized;
    } else {
      const candidate = workStatusCapabilityRecordSchema.safeParse({
        schemaVersion: 1,
        revision: (normalized.value?.revision ?? -1) + 1,
        projectId,
        capability: parsed.data,
        checkedAt: this.#clock.now(),
      });
      if (!candidate.success) {
        result = err(domainError("invariant_violation"));
      } else {
        const written = await writeJsonWithSchema(
          this.#store,
          path,
          workStatusCapabilityRecordSchema,
          candidate.data,
          { visibility: "private" },
        );
        result = !written.ok
          ? written
          : written.value.durability !== "confirmed" || !written.value.readBack.ok
            ? err(domainError("external_failure"))
            : ok(written.value.readBack.value);
      }
    }
    const released = await lock.value.release();
    return !released.ok && result.ok ? released : result;
  }
}
