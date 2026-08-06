/**
 * E006: the case manifest -- a per-case, 0600, host-local journal file recording exactly which
 * sandbox objects `seedCase()` created (provider/id/marker/createdAt), and later which of them
 * `resetCase()` has confirmed cleaned. `resetCase()` (seed-reset.ts) is the *only* code allowed to
 * mutate an external object, and it is only ever allowed to act on an id it reads back out of
 * this exact file -- never a name/pattern scan (locked decision: "絕不提供掃描式清理").
 */
import { join } from "node:path";

import { z } from "zod";

import { canonicalInstantPattern, parseInstant } from "../../../src/domain/foundation/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../../src/domain/foundation/index.js";
import {
  AtomicFileStore,
  readJsonWithSchema,
  writeJsonWithSchema,
} from "../../../src/infrastructure/files/index.js";
import { acquireRecoverableFileLock } from "../../../src/infrastructure/events/index.js";

const instantSchema = z
  .string()
  .regex(canonicalInstantPattern)
  .refine((value) => parseInstant(value).ok, "Timestamp must be a canonical ISO instant.");
const shaPattern = /^[0-9a-f]{40}$/u;

export const e2eManifestKinds = [
  "linearIssue",
  "githubBranch",
  "githubDraftPullRequest",
  "localWorktree",
] as const;
export type E2eManifestKind = (typeof e2eManifestKinds)[number];

const resolutionSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("confirmed"), resolvedAt: instantSchema }).strict(),
  z
    .object({
      state: z.literal("requires_manual"),
      resolvedAt: instantSchema,
      reason: z.string().min(1).max(255),
    })
    .strict(),
]);
export type E2eManifestResolution = z.infer<typeof resolutionSchema>;

const entryBase = { marker: z.string().min(1).max(512), createdAt: instantSchema } as const;

export const e2eManifestEntrySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("linearIssue"),
      provider: z.literal("linear"),
      id: z.string().min(1),
      ...entryBase,
      teamId: z.string().min(1),
      projectId: z.string().min(1),
      workflowStateId: z.string().min(1),
      resolution: resolutionSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("githubBranch"),
      provider: z.literal("github"),
      id: z.string().min(1), // the branch name
      ...entryBase,
      repository: z.string().min(1),
      headSha: z.string().regex(shaPattern),
      resolution: resolutionSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("githubDraftPullRequest"),
      provider: z.literal("github"),
      id: z.string().min(1), // the PR number, as a decimal string (see O009c)
      ...entryBase,
      repository: z.string().min(1),
      headBranch: z.string().min(1),
      resolution: resolutionSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("localWorktree"),
      provider: z.literal("local"),
      id: z.string().min(1), // the worktree path
      ...entryBase,
      repositoryRoot: z.string().min(1),
      branch: z.string().min(1),
      headSha: z.string().regex(shaPattern),
      resolution: resolutionSchema.optional(),
    })
    .strict(),
]);
export type E2eManifestEntry = z.infer<typeof e2eManifestEntrySchema>;
export type E2eManifestEntryOf<Kind extends E2eManifestKind> = Extract<
  E2eManifestEntry,
  { kind: Kind }
>;

export const e2eCaseManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    caseId: z.string().min(1).max(64),
    caseRunId: z.string().min(1).max(128),
    entries: z.array(e2eManifestEntrySchema).max(1_000),
  })
  .strict();
export type E2eCaseManifest = z.infer<typeof e2eCaseManifestSchema>;

/**
 * `e2e-<caseId>-<hex>` -- same bounded-identifier shape as the rest of this codebase's own
 * runId conventions (see `registrationProbeBranch`/`isValidRegistrationProbeRunId`,
 * src/application/registration/proactive-probe-model.ts): a fixed literal prefix, a normalized
 * case id, and a random hex suffix, entirely lower-case/hyphen/digit.
 */
export const caseRunIdPattern = /^e2e-[a-z0-9]{1,32}-[a-f0-9]{8,32}$/u;

export function generateCaseRunId(caseId: string, randomHex: () => string): string {
  const normalizedCaseId = caseId
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "")
    .slice(0, 32);
  return `e2e-${normalizedCaseId}-${randomHex()}`;
}

function manifestPath(directory: string, caseRunId: string): string {
  return join(directory, `${caseRunId}.json`);
}

/**
 * Durable, per-case-run, lock-guarded manifest store. Mirrors the rest of this codebase's own
 * "lock → read → write → readback" durability shape (see e.g. `FileRegistrationProbeJournalStore`
 * in src/adapters/registration/proactive-probe-journal.ts).
 */
export class E2eCaseManifestStore {
  readonly #directory: string;
  readonly #store: AtomicFileStore;

  constructor(directory: string, store: AtomicFileStore = new AtomicFileStore()) {
    this.#directory = directory;
    this.#store = store;
  }

  #lockPath(caseRunId: string): string {
    return `${manifestPath(this.#directory, caseRunId)}.lock`;
  }

  async load(caseRunId: string): Promise<Result<E2eCaseManifest | undefined, DomainError>> {
    const loaded = await readJsonWithSchema(
      manifestPath(this.#directory, caseRunId),
      e2eCaseManifestSchema,
    );
    if (!loaded.ok) return loaded.error.code === "not_found" ? ok(undefined) : loaded;
    return loaded;
  }

  /**
   * Appends one newly-created object to the manifest, creating the manifest itself if this is
   * the case's first seeded object. Rejects (as `invariant_violation`) a duplicate
   * `kind`+`id` -- seed should never record the same real object twice.
   */
  async appendEntry(
    caseId: string,
    caseRunId: string,
    entry: E2eManifestEntry,
  ): Promise<Result<E2eCaseManifest, DomainError>> {
    const acquired = await acquireRecoverableFileLock(
      this.#lockPath(caseRunId),
      `e2e-case-manifest:${String(process.pid)}`,
    );
    if (!acquired.ok) return acquired;
    const result = await this.#appendLocked(caseId, caseRunId, entry);
    const released = await acquired.value.release();
    if (!released.ok && result.ok) return released;
    return result;
  }

  async #appendLocked(
    caseId: string,
    caseRunId: string,
    entry: E2eManifestEntry,
  ): Promise<Result<E2eCaseManifest, DomainError>> {
    const current = await this.load(caseRunId);
    if (!current.ok) return current;
    const existing = current.value ?? { schemaVersion: 1 as const, caseId, caseRunId, entries: [] };
    if (existing.caseId !== caseId || existing.caseRunId !== caseRunId) {
      return err(domainError("invariant_violation"));
    }
    if (
      existing.entries.some(
        (candidate) => candidate.kind === entry.kind && candidate.id === entry.id,
      )
    ) {
      return err(domainError("conflict"));
    }
    const next: E2eCaseManifest = { ...existing, entries: [...existing.entries, entry] };
    const written = await writeJsonWithSchema(
      this.#store,
      manifestPath(this.#directory, caseRunId),
      e2eCaseManifestSchema,
      next,
    );
    if (!written.ok) return written;
    if (written.value.durability !== "confirmed" || !written.value.readBack.ok) {
      return err(domainError("external_failure"));
    }
    return ok(written.value.readBack.value);
  }

  /** Records a reset outcome for exactly one already-seeded entry (never invented, never a
   * scan) -- this is `resetCase()`'s only write to the manifest. */
  async recordResolution(
    caseRunId: string,
    kind: E2eManifestKind,
    id: string,
    resolution: E2eManifestResolution,
  ): Promise<Result<E2eCaseManifest, DomainError>> {
    const acquired = await acquireRecoverableFileLock(
      this.#lockPath(caseRunId),
      `e2e-case-manifest:${String(process.pid)}`,
    );
    if (!acquired.ok) return acquired;
    const result = await this.#recordResolutionLocked(caseRunId, kind, id, resolution);
    const released = await acquired.value.release();
    if (!released.ok && result.ok) return released;
    return result;
  }

  async #recordResolutionLocked(
    caseRunId: string,
    kind: E2eManifestKind,
    id: string,
    resolution: E2eManifestResolution,
  ): Promise<Result<E2eCaseManifest, DomainError>> {
    const current = await this.load(caseRunId);
    if (!current.ok) return current;
    if (current.value === undefined) return err(domainError("not_found"));
    const index = current.value.entries.findIndex(
      (candidate) => candidate.kind === kind && candidate.id === id,
    );
    if (index < 0) return err(domainError("not_found"));
    const entries = [...current.value.entries];
    const target = entries[index];
    if (target === undefined) return err(domainError("not_found"));
    entries[index] = { ...target, resolution };
    const next: E2eCaseManifest = { ...current.value, entries };
    const written = await writeJsonWithSchema(
      this.#store,
      manifestPath(this.#directory, caseRunId),
      e2eCaseManifestSchema,
      next,
    );
    if (!written.ok) return written;
    if (written.value.durability !== "confirmed" || !written.value.readBack.ok) {
      return err(domainError("external_failure"));
    }
    return ok(written.value.readBack.value);
  }
}
