/**
 * E102-5: durable, write-once receipt store for a `visual_review`/`dual_review` job's Linear
 * publication -- the visual manifest's PNG artifacts uploaded via the existing `LinearUploadClient`
 * (adapters/linear/upload.ts) plus one manifest summary comment posted via
 * `LinearMutationClient.appendComment` (adapters/linear/write.ts). `resume-composition.ts`'s
 * `resumeReview` calls this store (through `linear-publication.ts`'s coordinator) before ever
 * invoking `reviewer.run()`: a persisted, valid receipt for the exact (issueId, headSha) under
 * review is the only thing that authorizes the reviewer to start (see that file's own call site).
 *
 * Why a receipt-store gate is the *actual* idempotency mechanism, not a convenience: Linear's own
 * `fileUpload` GraphQL mutation (upload.ts) allocates a brand-new S3 object on every single call --
 * it carries no idempotency key at all, unlike `appendComment` (which durably dedupes via a hashed
 * marker baked into the comment body, see write.ts's own `commentMarker`/`#appendComment`). A
 * second, retried call to `uploadArtifact` for an artifact this exact (issueId, headSha) already
 * has a receipt for would therefore always allocate a second, orphaned asset -- and its own
 * follow-on `appendComment` call would *also* fail with `"conflict"` the instant the same
 * idempotency marker is reused with a different body (a fresh `assetUrl` every retry), because
 * `#appendComment` compares stored bodies verbatim. `linear-publication.ts`'s coordinator therefore
 * always calls this store's `load()` *before* attempting any upload, and only ever calls `create()`
 * once, after every upload and the manifest comment have both durably succeeded.
 *
 * File shape mirrors `FileIssueAdmissionStore` (issue-admission-store.ts): one JSON file per
 * `${projectId}__${issueId}__${headSha}` composite key, a sibling `.lock` file guarded by
 * `acquireRecoverableFileLock`, and `writeJsonWithSchema`'s mandatory read-back before a write is
 * ever trusted. Unlike that store (and `FileJobProgressStore`), a receipt is **write-once**: once a
 * publication succeeds it never changes, so this store exposes `create` (fails closed with
 * `conflict` if a receipt already exists for this key) rather than a general `compareAndSwap` --
 * every caller must `load()` first and reuse an existing valid receipt, never blindly overwrite one.
 *
 * Canonical digest contract for E102-4: see `canonicalLinearPublicationReceipt`/
 * `linearPublicationReceiptDigest` below -- this is the exact, stable representation E102-4's own
 * `publicationDigest = SHA256(canonical Linear receipts)` is specified to consume. Both the schema
 * (via its own `superRefine`, enforcing `artifacts` sorted by `path` with no duplicates) and the
 * digest function (a fixed, explicit field list, deliberately excluding `schemaVersion`/
 * `projectId`/`createdAt`) exist so two independently-computed receipts for the identical
 * publication always hash identically, and so a receipt's digest is stable across reads regardless
 * of *when* it was written.
 */
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";

import { z } from "zod";

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
import { issueIdSchema, repositoryRelativePathSchema } from "../../domain/project/index.js";
import { projectIdSchema } from "../../domain/jobs/index.js";
import { headShaSchema } from "../../domain/review/index.js";
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

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const linearIdSchema = z.string().trim().min(1).max(255);
const linearAssetUrlSchema = z.url().max(2_048);
const externalIssueIdSchema = z.string().trim().min(1).max(255);

const linearPublicationArtifactReceiptSchema = z
  .object({
    path: repositoryRelativePathSchema,
    sha256: sha256Schema,
    assetUrl: linearAssetUrlSchema,
    commentId: linearIdSchema,
  })
  .strict();
export type LinearPublicationArtifactReceipt = z.infer<
  typeof linearPublicationArtifactReceiptSchema
>;

const linearPublicationManifestCommentSchema = z
  .object({
    id: linearIdSchema,
    /** sha256 of the exact comment body text posted -- the manifest summary content this receipt
     * binds to, never the manifest JSON file itself (which is never uploaded as a Linear file --
     * see `linear-publication.ts`'s own header for why). */
    sha256: sha256Schema,
  })
  .strict();

export const linearPublicationReceiptRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: projectIdSchema,
    issueId: issueIdSchema,
    externalIssueId: externalIssueIdSchema,
    headSha: headShaSchema,
    /** sha256 over the semantically load-bearing subset of the `VisualManifest` this publication
     * covers (issueId/commitSha/artifacts -- see `linear-publication.ts`'s `sha256OfManifest`) --
     * deliberately excludes `generatedAt`/`environment`, so a manifest rebuilt from disk (same
     * content, fresh timestamp) still digests identically and a genuinely valid receipt is never
     * rejected as stale just because the evidence directory was regenerated. */
    manifestDigest: sha256Schema,
    manifestComment: linearPublicationManifestCommentSchema,
    artifacts: z.array(linearPublicationArtifactReceiptSchema).min(1).max(1_000),
    createdAt: instantSchema,
  })
  .strict()
  .superRefine((record, context) => {
    const paths = record.artifacts.map((artifact) => artifact.path);
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: "custom",
        message: "Receipt artifacts must have unique paths.",
        path: ["artifacts"],
      });
    }
    const sorted = [...paths].sort();
    if (!paths.every((path, index) => path === sorted[index])) {
      context.addIssue({
        code: "custom",
        message: "Receipt artifacts must be sorted by path for a stable canonical form.",
        path: ["artifacts"],
      });
    }
  });
export type LinearPublicationReceiptRecord = z.infer<typeof linearPublicationReceiptRecordSchema>;

export type NewLinearPublicationReceipt = Omit<
  LinearPublicationReceiptRecord,
  "schemaVersion" | "createdAt"
>;

/** E102-4's own `publicationDigest = SHA256(canonical Linear receipts)` input contract. Field order
 * is fixed by this function's own explicit object-literal construction (JavaScript preserves
 * string-key insertion order, ECMA-262 OrdinaryOwnPropertyKeys) -- never the schema's declaration
 * order, never recomputed by generically sorting keys. `artifacts` is already guaranteed sorted by
 * `path` (the schema's own `superRefine` above), so no further sorting happens here. Deliberately
 * excludes `schemaVersion`/`projectId` (storage plumbing, never semantically part of "what got
 * published") and `createdAt` (a volatile wall-clock field a stable digest must never depend on --
 * two otherwise-identical publications a second apart must hash identically). */
export interface CanonicalLinearPublicationReceipt {
  readonly issueId: string;
  readonly externalIssueId: string;
  readonly headSha: string;
  readonly manifestDigest: string;
  readonly manifestComment: Readonly<{ id: string; sha256: string }>;
  readonly artifacts: readonly Readonly<{
    path: string;
    sha256: string;
    assetUrl: string;
    commentId: string;
  }>[];
}

export function canonicalLinearPublicationReceipt(
  record: LinearPublicationReceiptRecord,
): CanonicalLinearPublicationReceipt {
  return Object.freeze({
    issueId: record.issueId,
    externalIssueId: record.externalIssueId,
    headSha: record.headSha,
    manifestDigest: record.manifestDigest,
    manifestComment: Object.freeze({
      id: record.manifestComment.id,
      sha256: record.manifestComment.sha256,
    }),
    artifacts: Object.freeze(
      record.artifacts.map((artifact) =>
        Object.freeze({
          path: artifact.path,
          sha256: artifact.sha256,
          assetUrl: artifact.assetUrl,
          commentId: artifact.commentId,
        }),
      ),
    ),
  });
}

export function linearPublicationReceiptDigest(record: LinearPublicationReceiptRecord): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalLinearPublicationReceipt(record)), "utf8")
    .digest("hex");
}

/** Sort per-receipt digests so the aggregate is independent of receipt input order. */
export function aggregateLinearPublicationDigest(
  records: readonly LinearPublicationReceiptRecord[],
): string {
  const digests = records.map((record) => linearPublicationReceiptDigest(record));
  const sorted = [...digests].sort();
  return createHash("sha256").update(JSON.stringify(sorted), "utf8").digest("hex");
}

function isNotFound(error: DomainError): boolean {
  return error.code === "not_found";
}

export interface LinearPublicationStorePort {
  load(
    projectId: string,
    issueId: string,
    headSha: string,
  ): Promise<Result<LinearPublicationReceiptRecord | undefined, DomainError>>;
  create(
    record: NewLinearPublicationReceipt,
  ): Promise<Result<LinearPublicationReceiptRecord, DomainError>>;
}

export class FileLinearPublicationStore implements LinearPublicationStorePort {
  readonly #directory: string;
  readonly #store: AtomicFileStore;
  readonly #clock: Clock;

  constructor(
    directory: string,
    store: AtomicFileStore = new AtomicFileStore(),
    clock: Clock = createClock(),
  ) {
    if (!isAbsolute(directory)) throw new Error("linear_publication_root_must_be_absolute");
    this.#directory = directory;
    this.#store = store;
    this.#clock = clock;
  }

  #path(projectId: string, issueId: string, headSha: string): string {
    return join(this.#directory, `${projectId}__${issueId}__${headSha.toLowerCase()}.json`);
  }

  #lockPath(projectId: string, issueId: string, headSha: string): string {
    return `${this.#path(projectId, issueId, headSha)}.lock`;
  }

  async load(
    projectId: string,
    issueId: string,
    headSha: string,
  ): Promise<Result<LinearPublicationReceiptRecord | undefined, DomainError>> {
    if (
      !parseIdentifier("project", projectId).ok ||
      !parseIdentifier("issue", issueId).ok ||
      !headShaSchema.safeParse(headSha).success
    ) {
      return err(domainError("invariant_violation"));
    }
    const loaded = await readJsonWithSchema(
      this.#path(projectId, issueId, headSha),
      linearPublicationReceiptRecordSchema,
    );
    if (!loaded.ok) return isNotFound(loaded.error) ? ok(undefined) : loaded;
    return ok(loaded.value);
  }

  async create(
    record: NewLinearPublicationReceipt,
  ): Promise<Result<LinearPublicationReceiptRecord, DomainError>> {
    if (
      !parseIdentifier("project", record.projectId).ok ||
      !parseIdentifier("issue", record.issueId).ok ||
      !headShaSchema.safeParse(record.headSha).success
    ) {
      return err(domainError("invariant_violation"));
    }
    const acquired = await acquireRecoverableFileLock(
      this.#lockPath(record.projectId, record.issueId, record.headSha),
      `linear-publication:${String(process.pid)}:${randomUUID()}`,
    );
    if (!acquired.ok) return acquired;
    const result = await this.#createLocked(record);
    const released = await acquired.value.release();
    return !released.ok && result.ok ? released : result;
  }

  async #createLocked(
    record: NewLinearPublicationReceipt,
  ): Promise<Result<LinearPublicationReceiptRecord, DomainError>> {
    const path = this.#path(record.projectId, record.issueId, record.headSha);
    const existing = await readJsonWithSchema(path, linearPublicationReceiptRecordSchema);
    if (existing.ok) return err(domainError("conflict"));
    if (!isNotFound(existing.error)) return existing;

    const candidate = { ...record, schemaVersion: 1 as const, createdAt: this.#clock.now() };
    const validated = linearPublicationReceiptRecordSchema.safeParse(candidate);
    if (!validated.success) return err(domainError("invariant_violation"));

    const written = await writeJsonWithSchema(
      this.#store,
      path,
      linearPublicationReceiptRecordSchema,
      validated.data,
      { visibility: "private" },
    );
    if (!written.ok) return written;
    if (written.value.durability !== "confirmed" || !written.value.readBack.ok) {
      return err(domainError("external_failure"));
    }
    return ok(written.value.readBack.value);
  }
}

export function defaultLinearPublicationDirectory(agentTeamHome: string): string {
  return join(agentTeamHome, "state", "dispatch", "linear-publication");
}
