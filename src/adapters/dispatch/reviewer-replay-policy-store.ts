import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";

import { z } from "zod";

import type { ReadOptions } from "../../application/ports/index.js";
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
import {
  AtomicFileStore,
  acquireRecoverableFileLock,
  readJsonWithSchema,
  writeJsonWithSchema,
} from "../../infrastructure/files/index.js";

const instantSchema = z
  .string()
  .regex(canonicalInstantPattern)
  .refine((value) => parseInstant(value).ok) as unknown as z.ZodType<Instant>;

export const reviewerReplayPolicyRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    projectId: projectIdSchema,
    enabled: z.boolean(),
    updatedAt: instantSchema,
  })
  .strict();
export type ReviewerReplayPolicyRecord = z.infer<typeof reviewerReplayPolicyRecordSchema>;

function notFound(error: DomainError): boolean {
  return error.code === "not_found";
}

export class FileReviewerReplayPolicyStore {
  readonly #directory: string;
  readonly #store: AtomicFileStore;
  readonly #clock: Clock;

  constructor(
    directory: string,
    store: AtomicFileStore = new AtomicFileStore(),
    clock: Clock = createClock(),
  ) {
    if (!isAbsolute(directory)) throw new Error("reviewer_replay_policy_root_must_be_absolute");
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
  ): Promise<Result<ReviewerReplayPolicyRecord | undefined, DomainError>> {
    if (!parseIdentifier("project", projectId).ok || options.signal?.aborted === true) {
      return err(domainError("invariant_violation"));
    }
    const loaded = await readJsonWithSchema(
      this.#path(projectId),
      reviewerReplayPolicyRecordSchema,
    );
    if (!loaded.ok) return notFound(loaded.error) ? ok(undefined) : loaded;
    return ok(loaded.value);
  }

  async setEnabled(
    projectId: string,
    enabled: boolean,
    options: ReadOptions = {},
  ): Promise<Result<ReviewerReplayPolicyRecord, DomainError>> {
    if (!parseIdentifier("project", projectId).ok || options.signal?.aborted === true) {
      return err(domainError("invariant_violation"));
    }
    const lock = await acquireRecoverableFileLock(
      `${this.#path(projectId)}.lock`,
      `reviewer-replay-policy:${String(process.pid)}:${randomUUID()}`,
    );
    if (!lock.ok) return lock;
    const current = await readJsonWithSchema(
      this.#path(projectId),
      reviewerReplayPolicyRecordSchema,
    );
    const normalized = !current.ok && notFound(current.error) ? ok(undefined) : current;
    let result: Result<ReviewerReplayPolicyRecord, DomainError>;
    if (!normalized.ok) {
      result = normalized;
    } else if (normalized.value?.enabled === enabled) {
      result = ok(normalized.value);
    } else {
      const candidate = reviewerReplayPolicyRecordSchema.safeParse({
        schemaVersion: 1,
        revision: (normalized.value?.revision ?? -1) + 1,
        projectId,
        enabled,
        updatedAt: this.#clock.now(),
      });
      if (!candidate.success) {
        result = err(domainError("invariant_violation"));
      } else {
        const written = await writeJsonWithSchema(
          this.#store,
          this.#path(projectId),
          reviewerReplayPolicyRecordSchema,
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
