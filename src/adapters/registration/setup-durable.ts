import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

import {
  createRegistrationSetupPreview,
  registrationSetupBranch,
  type RegistrationSetupActivationMarker,
  type RegistrationSetupAuditIntent,
  type RegistrationSetupAuditReceipt,
  type RegistrationSetupApprovalBinding,
  type RegistrationSetupFilePort,
  type RegistrationSetupFinalApprovalAuthorityPort,
  type RegistrationSetupFinalApprovalReceipt,
  type RegistrationSetupFinalApprovalRequest,
  type RegistrationSetupFinalApprovalAuthority,
  type RegistrationSetupGateEvidenceReceipt,
  type RegistrationSetupExecutionFence,
  type RegistrationSetupExecutionLease,
  type RegistrationSetupFencedMutationOptions,
  type RegistrationSetupJournal,
  type RegistrationSetupJournalDraft,
  type RegistrationSetupJournalPort,
  type RegistrationSetupPreviewConfirmation,
  type RegistrationSetupPreviewConfirmationAuthorityPort,
  type RegistrationSetupPreviewConfirmationBinding,
  type RegistrationSetupSession,
  type RegistrationSetupSessionDraft,
  type RegistrationSetupSessionPort,
} from "../../application/registration/index.js";
import {
  trustedProjectConfigPath,
  trustedProjectConfigSchema,
} from "../../application/projects/index.js";
import type { MutationOptions, ReadOptions } from "../../application/ports/index.js";
import {
  createClock,
  domainError,
  err,
  ok,
  parseInstant,
  type Clock,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import { projectSchema } from "../../domain/project/index.js";
import {
  AtomicFileStore,
  withSecureDirectory,
  type AtomicWriteOptions,
  type HeldSecureDirectory,
} from "../../infrastructure/files/index.js";

const digestPattern = /^[0-9a-f]{64}$/u;
const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:@+-]{0,220}$/u;
const mutationKeyPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:@+/-]{0,500}$/u;
type CommitGuard = NonNullable<AtomicWriteOptions["commitGuard"]>;
type PublicationGuard = NonNullable<AtomicWriteOptions["publicationGuard"]>;
const executionLeaseContext = new AsyncLocalStorage<RegistrationSetupExecutionLease>();

const digestSchema = z.string().regex(digestPattern);
const shaSchema = z.string().regex(shaPattern);
const identifierSchema = z.string().regex(identifierPattern);
const mutationKeySchema = z.string().regex(mutationKeyPattern);
const instantSchema = z.string().refine((value) => parseInstant(value).ok);

const worktreeSchema = z
  .object({
    repositoryRoot: z.string().refine(isAbsolute),
    path: z.string().refine(isAbsolute),
    branch: z.literal(registrationSetupBranch),
    headSha: shaSchema,
  })
  .strict();

const changeRequestSchema = z
  .object({
    id: identifierSchema,
    number: z.number().int().positive(),
    url: z.url(),
    state: z.enum(["open", "closed", "merged"]),
    draft: z.boolean(),
    baseBranch: z.string().min(1),
    headBranch: z.string().min(1),
    headSha: shaSchema,
    mergeability: z.enum(["mergeable", "conflicting", "unknown"]),
    autoMergeEnabled: z.boolean(),
    updatedAt: instantSchema,
  })
  .strict();

const evidenceSchema = z
  .object({
    code: z.enum([
      "setup_worktree_created",
      "trusted_config_written",
      "setup_preflight_passed",
      "setup_commit_pushed",
      "setup_draft_pr_created",
      "setup_ci_passed",
      "setup_fresh_review_passed",
      "setup_user_approval_consumed",
      "setup_merge_verified",
      "trusted_config_activated",
    ]),
    projectId: identifierSchema,
    setupSessionId: identifierSchema,
    previewDigest: digestSchema,
    requirementsDigest: digestSchema,
    headSha: shaSchema.optional(),
    diffDigest: digestSchema.optional(),
    changeRequestId: identifierSchema.optional(),
  })
  .strict();

const previewSchema = z
  .object({
    schemaVersion: z.literal(1),
    setupSessionId: identifierSchema,
    project: projectSchema,
    config: trustedProjectConfigSchema,
    baseRevision: shaSchema,
    worktreePath: z.string().refine(isAbsolute),
    branch: z.literal(registrationSetupBranch),
    remote: z.literal("origin"),
    linearAuditIssueId: identifierSchema,
    previewDigest: digestSchema,
    requirementsDigest: digestSchema,
  })
  .strict()
  .refine((preview) => {
    const recreated = createRegistrationSetupPreview({
      schemaVersion: preview.schemaVersion,
      setupSessionId: preview.setupSessionId,
      project: preview.project,
      config: preview.config,
      baseRevision: preview.baseRevision,
      worktreePath: preview.worktreePath,
      branch: preview.branch,
      remote: preview.remote,
      linearAuditIssueId: preview.linearAuditIssueId,
    });
    return (
      recreated.ok &&
      recreated.value.previewDigest === preview.previewDigest &&
      recreated.value.requirementsDigest === preview.requirementsDigest
    );
  });

const journalSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().positive(),
    setupSessionId: identifierSchema,
    preview: previewSchema,
    configDigest: digestSchema,
    pending: z
      .object({
        step: z.enum(["worktree", "write", "stage", "commit", "push", "draft_pull_request"]),
        idempotencyKey: mutationKeySchema,
      })
      .strict()
      .optional(),
    completed: z
      .object({
        worktree: worktreeSchema.optional(),
        write: z
          .object({ path: z.literal(trustedProjectConfigPath), contentDigest: digestSchema })
          .strict()
          .optional(),
        stage: z
          .object({
            headSha: shaSchema,
            paths: z.array(z.literal(trustedProjectConfigPath)).length(1),
          })
          .strict()
          .optional(),
        commit: z
          .object({ sha: shaSchema, branch: z.literal(registrationSetupBranch) })
          .strict()
          .optional(),
        push: z
          .object({
            remote: z.literal("origin"),
            branch: z.literal(registrationSetupBranch),
            sha: shaSchema,
          })
          .strict()
          .optional(),
        draftPullRequest: z
          .object({ changeRequestId: identifierSchema, headSha: shaSchema })
          .strict()
          .optional(),
        diff: z.object({ digest: digestSchema }).strict().optional(),
      })
      .strict(),
  })
  .strict()
  .refine((journal) => {
    const completed = journal.completed;
    const pending = journal.pending?.step;
    const prerequisites =
      (completed.worktree === undefined ||
        (completed.worktree.headSha.toLowerCase() === journal.preview.baseRevision.toLowerCase() &&
          completed.worktree.path === journal.preview.worktreePath)) &&
      (completed.write === undefined ||
        (completed.worktree !== undefined &&
          completed.write.contentDigest === journal.configDigest)) &&
      (completed.stage === undefined || completed.write !== undefined) &&
      (completed.commit === undefined || completed.stage !== undefined) &&
      (completed.push === undefined ||
        completed.push.sha.toLowerCase() === completed.commit?.sha.toLowerCase()) &&
      (completed.draftPullRequest === undefined ||
        completed.draftPullRequest.headSha.toLowerCase() === completed.push?.sha.toLowerCase()) &&
      (completed.diff === undefined || completed.draftPullRequest !== undefined);
    const pendingValid =
      pending === undefined ||
      (pending === "worktree" && completed.worktree === undefined) ||
      (pending === "write" && completed.worktree !== undefined && completed.write === undefined) ||
      (pending === "stage" && completed.write !== undefined && completed.stage === undefined) ||
      (pending === "commit" && completed.stage !== undefined && completed.commit === undefined) ||
      (pending === "push" && completed.commit !== undefined && completed.push === undefined) ||
      (pending === "draft_pull_request" &&
        completed.push !== undefined &&
        completed.draftPullRequest === undefined);
    return (
      prerequisites &&
      pendingValid &&
      journal.setupSessionId === journal.preview.setupSessionId &&
      journal.preview.config.projectId === journal.preview.project.id
    );
  }) as unknown as z.ZodType<RegistrationSetupJournal>;

const gateEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: z.literal("source_control"),
    projectId: identifierSchema,
    repository: z.string().min(1),
    changeRequestId: identifierSchema,
    headSha: shaSchema,
    requirementsDigest: digestSchema,
    diffDigest: digestSchema,
    ciChecksDigest: digestSchema,
    reviewContext: z.literal("agent-team/review"),
    reviewEvidenceUrl: z.url(),
    evidenceDigest: digestSchema,
  })
  .strict() as unknown as z.ZodType<RegistrationSetupGateEvidenceReceipt>;

const auditIntentObjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    destination: z.enum(["linear", "pull_request"]),
    kind: z.literal("registration_setup_user_approval_required"),
    setupSessionId: identifierSchema,
    projectId: identifierSchema,
    repository: z.string().min(1),
    linearAuditIssueId: identifierSchema,
    changeRequestId: identifierSchema,
    headSha: shaSchema,
    requirementsDigest: digestSchema,
    diffDigest: digestSchema,
    evidenceDigest: digestSchema,
    body: z.string().min(1).max(65_536),
    bodyDigest: digestSchema,
    idempotencyKey: mutationKeySchema,
  })
  .strict();
const auditIntentSchema =
  auditIntentObjectSchema as unknown as z.ZodType<RegistrationSetupAuditIntent>;

const auditReceiptSchema = auditIntentObjectSchema
  .omit({ kind: true, body: true, idempotencyKey: true })
  .extend({
    externalCommentId: identifierSchema,
    idempotencyKeyDigest: digestSchema,
    createdAt: instantSchema,
    reused: z.boolean(),
  })
  .strict() as unknown as z.ZodType<RegistrationSetupAuditReceipt>;

const sessionSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().positive(),
    phase: z.enum([
      "ci_waiting",
      "audit_pending",
      "awaiting_user_approval",
      "merge_authorized",
      "activated",
      "cancelled",
    ]),
    setupSessionId: identifierSchema,
    project: projectSchema,
    config: trustedProjectConfigSchema,
    baseRevision: shaSchema,
    worktree: worktreeSchema,
    remote: z.literal("origin"),
    previewDigest: digestSchema,
    requirementsDigest: digestSchema,
    diffDigest: digestSchema,
    configDigest: digestSchema,
    headSha: shaSchema,
    changeRequest: changeRequestSchema,
    linearAuditIssueId: identifierSchema,
    gateEvidenceReceipt: gateEvidenceSchema.optional(),
    audit: z
      .object({
        pending: auditIntentSchema.optional(),
        linearReceipt: auditReceiptSchema.optional(),
        pullRequestReceipt: auditReceiptSchema.optional(),
      })
      .strict()
      .optional(),
    evidence: z.array(evidenceSchema),
    approvalReferenceDigest: digestSchema.optional(),
    approvalNonceDigest: digestSchema.optional(),
    approvalAuthorityDigest: digestSchema.optional(),
    approvalSource: z.enum(["local_ui", "current_user_conversation"]).optional(),
    activatedRevisionSha: shaSchema.optional(),
  })
  .strict()
  .refine((session) => {
    const approvalRequired = session.phase === "merge_authorized" || session.phase === "activated";
    const evidenceCodes = new Set(session.evidence.map((item) => item.code));
    const gate = session.gateEvidenceReceipt;
    const gateBound =
      gate?.projectId === session.project.id &&
      gate.repository === session.project.sourceControl.repository &&
      gate.changeRequestId === session.changeRequest.id &&
      gate.headSha.toLowerCase() === session.headSha.toLowerCase() &&
      gate.requirementsDigest === session.requirementsDigest &&
      gate.diffDigest === session.diffDigest;
    const receiptBound = (receipt: RegistrationSetupAuditReceipt | undefined) =>
      receipt?.setupSessionId === session.setupSessionId &&
      receipt.projectId === session.project.id &&
      receipt.repository === session.project.sourceControl.repository &&
      receipt.linearAuditIssueId === session.linearAuditIssueId &&
      receipt.changeRequestId === session.changeRequest.id &&
      receipt.headSha.toLowerCase() === session.headSha.toLowerCase() &&
      receipt.requirementsDigest === session.requirementsDigest &&
      receipt.diffDigest === session.diffDigest &&
      receipt.evidenceDigest === gate?.evidenceDigest;
    return (
      session.project.id === session.config.projectId &&
      session.config.defaultBranch === session.project.defaultBranch &&
      session.setupSessionId.length > 0 &&
      session.worktree.repositoryRoot === session.project.localRepositoryPath &&
      session.changeRequest.headSha.toLowerCase() === session.headSha.toLowerCase() &&
      (session.phase === "ci_waiting" || session.phase === "cancelled" || gateBound) &&
      (session.phase === "ci_waiting" ||
        session.phase === "cancelled" ||
        session.phase === "audit_pending" ||
        (session.audit?.pending === undefined &&
          receiptBound(session.audit?.linearReceipt) &&
          receiptBound(session.audit?.pullRequestReceipt))) &&
      session.evidence.every(
        (item) =>
          item.projectId === session.project.id &&
          item.setupSessionId === session.setupSessionId &&
          item.previewDigest === session.previewDigest &&
          item.requirementsDigest === session.requirementsDigest,
      ) &&
      (!approvalRequired ||
        (session.approvalReferenceDigest !== undefined &&
          session.approvalNonceDigest !== undefined &&
          session.approvalAuthorityDigest !== undefined &&
          session.approvalSource !== undefined &&
          evidenceCodes.has("setup_user_approval_consumed"))) &&
      (session.phase !== "activated" ||
        (session.activatedRevisionSha !== undefined &&
          session.changeRequest.state === "merged" &&
          evidenceCodes.has("setup_merge_verified") &&
          evidenceCodes.has("trusted_config_activated")))
    );
  }) as unknown as z.ZodType<RegistrationSetupSession>;

const markerSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: z.literal("source_control_default_branch"),
    setupSessionId: identifierSchema,
    projectId: identifierSchema,
    authoritativeRevision: shaSchema,
    defaultBranch: z.string().min(1),
    configDigest: digestSchema,
  })
  .strict() as unknown as z.ZodType<RegistrationSetupActivationMarker>;

const activationRecordSchema = z
  .object({ schemaVersion: z.literal(1), session: sessionSchema, marker: markerSchema })
  .strict()
  .refine(
    ({ session, marker }) =>
      session.phase === "activated" &&
      session.setupSessionId === marker.setupSessionId &&
      session.project.id === marker.projectId &&
      session.project.defaultBranch === marker.defaultBranch &&
      session.configDigest === marker.configDigest &&
      session.activatedRevisionSha?.toLowerCase() === marker.authoritativeRevision.toLowerCase(),
  );

const executionFenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    setupSessionId: identifierSchema,
    epoch: z.number().int().positive().refine(Number.isSafeInteger),
    lockIdentity: z
      .object({
        device: z.number().int().nonnegative().refine(Number.isSafeInteger),
        inode: z.number().int().nonnegative().refine(Number.isSafeInteger),
        generation: z.uuid(),
        ownerDigest: digestSchema,
        changeEpoch: z.string().regex(/^\d+$/u),
      })
      .strict(),
    ownerDigest: digestSchema,
  })
  .strict() as unknown as z.ZodType<RegistrationSetupExecutionFence>;

const approvalBindingObjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    setupSessionId: identifierSchema,
    setupSessionRevision: z.number().int().positive(),
    projectId: identifierSchema,
    previewDigest: digestSchema,
    changeRequestId: identifierSchema,
    headSha: shaSchema,
    requirementsDigest: digestSchema,
    diffDigest: digestSchema,
    linearAuditIssueId: identifierSchema,
    gateEvidenceDigest: digestSchema,
  })
  .strict();
const approvalBindingSchema =
  approvalBindingObjectSchema as unknown as z.ZodType<RegistrationSetupApprovalBinding>;

const approvalReceiptSchema = approvalBindingObjectSchema
  .extend({
    approvalId: identifierSchema,
    issuer: z.enum(["local_ui", "current_user_conversation"]),
    authorityDigest: digestSchema,
    approvalNonceDigest: digestSchema,
    consumedAt: instantSchema,
  })
  .strict() as unknown as z.ZodType<RegistrationSetupFinalApprovalReceipt>;

const ledgerGrantSchema = z
  .object({
    approvalId: identifierSchema,
    issueOperationDigest: digestSchema,
    issuer: z.enum(["local_ui", "current_user_conversation"]),
    authorityDigest: digestSchema,
    approvalNonceDigest: digestSchema,
    binding: approvalBindingObjectSchema,
    issuedAt: instantSchema,
    expiresAt: instantSchema,
    state: z.literal("pending"),
  })
  .strict();
const consumedGrantSchema = ledgerGrantSchema
  .omit({ state: true })
  .extend({
    state: z.literal("consumed"),
    consumeOperationDigest: digestSchema,
    receipt: approvalReceiptSchema,
  })
  .strict();
const ledgerSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    grants: z.array(z.union([ledgerGrantSchema, consumedGrantSchema])),
  })
  .strict();
type ApprovalLedger = z.infer<typeof ledgerSchema>;

const previewConfirmationBindingSchema = z
  .object({
    setupSessionId: identifierSchema,
    projectId: identifierSchema,
    previewDigest: digestSchema,
  })
  .strict() as unknown as z.ZodType<RegistrationSetupPreviewConfirmationBinding>;
const previewConfirmationSchema = z
  .object({
    source: z.literal("local_ui"),
    explicit: z.literal(true),
    tokenId: identifierSchema,
    setupSessionId: identifierSchema,
    projectId: identifierSchema,
    previewDigest: digestSchema,
  })
  .strict() as unknown as z.ZodType<RegistrationSetupPreviewConfirmation>;
const pendingPreviewConfirmationSchema = z
  .object({
    tokenId: identifierSchema,
    issueOperationDigest: digestSchema,
    authorityDigest: digestSchema,
    binding: previewConfirmationBindingSchema,
    issuedAt: instantSchema,
    expiresAt: instantSchema,
    state: z.literal("pending"),
  })
  .strict();
const consumedPreviewConfirmationSchema = pendingPreviewConfirmationSchema
  .omit({ state: true })
  .extend({
    state: z.literal("consumed"),
    consumeOperationDigest: digestSchema,
    consumedAt: instantSchema,
  })
  .strict();
const previewConfirmationLedgerSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    grants: z.array(z.union([pendingPreviewConfirmationSchema, consumedPreviewConfirmationSchema])),
  })
  .strict();
type PreviewConfirmationLedger = z.infer<typeof previewConfirmationLedgerSchema>;

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function combineCommitGuards(...guards: readonly (CommitGuard | undefined)[]): CommitGuard {
  return async () => {
    for (const guard of guards) {
      if (guard === undefined) continue;
      const guarded = await guard();
      if (!guarded.ok) return guarded;
    }
    return ok(undefined);
  };
}

function combinePublicationGuards(
  ...guards: readonly (PublicationGuard | undefined)[]
): PublicationGuard {
  return () => {
    for (const guard of guards) {
      if (guard === undefined) continue;
      const guarded = guard();
      if (!guarded.ok) return guarded;
    }
    return ok(undefined);
  };
}

function activeExecutionCommitGuard(
  expectedFence?: RegistrationSetupExecutionFence,
): CommitGuard | undefined {
  const lease = executionLeaseContext.getStore();
  if (lease === undefined) {
    return expectedFence === undefined
      ? undefined
      : () => Promise.resolve(err(domainError("conflict")));
  }
  return async () => {
    if (expectedFence !== undefined && !sameValue(lease.fence, expectedFence)) {
      return err(domainError("conflict"));
    }
    return lease.assertOwnership();
  };
}

function activeExecutionPublicationGuard(
  expectedFence?: RegistrationSetupExecutionFence,
): PublicationGuard | undefined {
  const lease = executionLeaseContext.getStore();
  if (lease === undefined) {
    return expectedFence === undefined ? undefined : () => err(domainError("conflict"));
  }
  return () => {
    if (expectedFence !== undefined && !sameValue(lease.fence, expectedFence)) {
      return err(domainError("conflict"));
    }
    return lease.assertOwnershipSync();
  };
}

function hasUnknownDurability(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "durability" in value &&
    value.durability === "unknown"
  );
}

function validMutation(options: MutationOptions): boolean {
  return mutationKeyPattern.test(options.idempotencyKey) && options.signal?.aborted !== true;
}

function validFencedMutation(options: RegistrationSetupFencedMutationOptions): boolean {
  return validMutation(options) && executionFenceSchema.safeParse(options.executionFence).success;
}

function setupPaths(stateRoot: string, setupSessionId: string) {
  const root = join(stateRoot, "registration-setup", setupSessionId);
  return Object.freeze({
    root,
    journal: join(root, "journal.json"),
    session: join(root, "session.json"),
    activation: join(root, "activation.json"),
    execution: join(root, "execution.json"),
    lock: join(root, "state.lock"),
    executionLock: join(root, "execution.lock"),
  });
}

async function assertExecutionFence(
  directory: HeldSecureDirectory,
  expected: RegistrationSetupExecutionFence,
): Promise<Result<void, DomainError>> {
  const current = await readPrivate(directory, "execution.json", executionFenceSchema);
  return current.ok && sameValue(current.value, expected)
    ? ok(undefined)
    : err(domainError(current.ok ? "conflict" : current.error.code));
}

function assertExecutionFenceSync(
  directory: HeldSecureDirectory,
  expected: RegistrationSetupExecutionFence,
): Result<void, DomainError> {
  const current = readPrivateSync(directory, "execution.json", executionFenceSchema);
  return current.ok && sameValue(current.value, expected)
    ? ok(undefined)
    : err(domainError(current.ok ? "conflict" : current.error.code));
}

async function readPrivate<Value>(
  directory: HeldSecureDirectory,
  name: string,
  schema: z.ZodType<Value>,
): Promise<Result<Value, DomainError>> {
  const read = await directory.readFile(name, { maxBytes: 16 * 1024 * 1024 });
  if (!read.ok) return read;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(read.value).toString("utf8"));
    const validated = schema.safeParse(parsed);
    return validated.success ? ok(validated.data) : err(domainError("invariant_violation"));
  } catch {
    return err(domainError("invariant_violation"));
  }
}

function readPrivateSync<Value>(
  directory: HeldSecureDirectory,
  name: string,
  schema: z.ZodType<Value>,
): Result<Value, DomainError> {
  const read = directory.readFileSync(name, { maxBytes: 16 * 1024 * 1024 });
  if (!read.ok) return read;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(read.value).toString("utf8"));
    const validated = schema.safeParse(parsed);
    return validated.success ? ok(validated.data) : err(domainError("invariant_violation"));
  } catch {
    return err(domainError("invariant_violation"));
  }
}

async function persistPrivate<Value>(
  directory: HeldSecureDirectory,
  name: string,
  schema: z.ZodType<Value>,
  value: Value,
  options: Readonly<{
    store?: AtomicFileStore;
    commitGuard?: CommitGuard;
    publicationGuard?: PublicationGuard;
    postCommitGuard?: CommitGuard;
  }> = {},
): Promise<Result<Readonly<{ durability: "confirmed" | "unknown"; value?: Value }>, DomainError>> {
  const validated = schema.safeParse(value);
  if (!validated.success) return err(domainError("invariant_violation"));
  let content: Buffer;
  try {
    content = Buffer.from(`${JSON.stringify(validated.data, null, 2)}\n`, "utf8");
  } catch {
    return err(domainError("invariant_violation"));
  }
  const written = await directory.atomicReplace(name, content, options.store, {
    ...(options.commitGuard === undefined ? {} : { commitGuard: options.commitGuard }),
    ...(options.publicationGuard === undefined
      ? {}
      : { publicationGuard: options.publicationGuard }),
  });
  if (!written.ok) return written;
  if (written.value.durability !== "confirmed") return ok({ durability: "unknown" });
  const retained = await (options.postCommitGuard ?? options.commitGuard)?.();
  if (retained !== undefined && !retained.ok) return ok({ durability: "unknown" });
  const recovered = await readPrivate(directory, name, schema);
  return recovered.ok && sameValue(recovered.value, value)
    ? ok({ durability: "confirmed", value: recovered.value })
    : ok({ durability: "unknown" });
}

async function withLock<Value>(
  stateRoot: string,
  children: readonly string[],
  lockName: string,
  holderId: string,
  action: (
    directory: HeldSecureDirectory,
    lockCommitGuard: CommitGuard,
    lockPublicationGuard: PublicationGuard,
  ) => Promise<Result<Value, DomainError>>,
): Promise<Result<Value, DomainError>> {
  return withSecureDirectory(stateRoot, children, { create: true }, async (directory) => {
    const acquired = await directory.acquireLock(lockName, holderId);
    if (!acquired.ok) return acquired;
    const before = await acquired.value.assertOwnership();
    if (!before.ok) {
      await acquired.value.release();
      return before;
    }
    const lockCommitGuard: CommitGuard = () => acquired.value.assertOwnership();
    const lockPublicationGuard: PublicationGuard = () => acquired.value.assertOwnershipSync();
    const result = await action(directory, lockCommitGuard, lockPublicationGuard);
    const after = await acquired.value.assertOwnership();
    const released = await acquired.value.release();
    if (!after.ok && result.ok && !hasUnknownDurability(result.value)) return after;
    return !released.ok && result.ok && !hasUnknownDurability(result.value) ? released : result;
  });
}

export class FileRegistrationSetupJournalStore implements RegistrationSetupJournalPort {
  readonly #stateRoot: string;
  readonly #atomicStore: AtomicFileStore;

  constructor(stateRoot: string, atomicStore: AtomicFileStore = new AtomicFileStore()) {
    if (!isAbsolute(stateRoot)) throw new Error("state_root_must_be_absolute");
    this.#stateRoot = resolve(stateRoot);
    this.#atomicStore = atomicStore;
  }

  paths(setupSessionId: string) {
    if (!identifierPattern.test(setupSessionId)) throw new Error("invalid_setup_session_id");
    return setupPaths(this.#stateRoot, setupSessionId);
  }

  async load(setupSessionId: string, options: ReadOptions = {}) {
    if (!identifierPattern.test(setupSessionId) || options.signal?.aborted === true) {
      return err(domainError("invariant_violation"));
    }
    const loaded = await withSecureDirectory(
      this.#stateRoot,
      ["registration-setup", setupSessionId],
      { create: false },
      (directory) => readPrivate(directory, "journal.json", journalSchema),
    );
    if (!loaded.ok && loaded.error.code === "not_found") return ok(undefined);
    return loaded;
  }

  async save(
    expectedRevision: number | undefined,
    draft: RegistrationSetupJournalDraft,
    options: RegistrationSetupFencedMutationOptions,
  ) {
    if (
      !validFencedMutation(options) ||
      "revision" in draft ||
      !journalSchema.safeParse({ ...draft, revision: 1 }).success
    ) {
      return err(domainError("invariant_violation"));
    }
    return withLock(
      this.#stateRoot,
      ["registration-setup", draft.setupSessionId],
      "state.lock",
      `registration-setup-journal:${draft.setupSessionId}`,
      async (directory, lockCommitGuard, lockPublicationGuard) => {
        const ownership = await assertExecutionFence(directory, options.executionFence);
        if (!ownership.ok) return ownership;
        const loaded = await readPrivate(directory, "journal.json", journalSchema);
        const current = !loaded.ok && loaded.error.code === "not_found" ? ok(undefined) : loaded;
        if (!current.ok) return current;
        if (
          (expectedRevision === undefined && current.value !== undefined) ||
          (expectedRevision !== undefined && current.value?.revision !== expectedRevision)
        ) {
          return err(domainError("conflict"));
        }
        const journal = journalSchema.parse({
          ...draft,
          revision: (current.value?.revision ?? 0) + 1,
        });
        const commitGuard = combineCommitGuards(
          lockCommitGuard,
          activeExecutionCommitGuard(options.executionFence),
          () => assertExecutionFence(directory, options.executionFence),
        );
        const publicationGuard = combinePublicationGuards(
          lockPublicationGuard,
          activeExecutionPublicationGuard(options.executionFence),
          () => assertExecutionFenceSync(directory, options.executionFence),
        );
        const persisted = await persistPrivate(directory, "journal.json", journalSchema, journal, {
          store: this.#atomicStore,
          commitGuard,
          publicationGuard,
        });
        if (!persisted.ok) return persisted;
        const retained = await assertExecutionFence(directory, options.executionFence);
        return ok({
          durability: retained.ok ? persisted.value.durability : ("unknown" as const),
          journal,
        });
      },
    );
  }
}

/** Serializes the whole Setup begin saga step across processes, not merely each state save. */
export class FileRegistrationSetupExecutionStore {
  readonly #stateRoot: string;
  readonly #atomicStore: AtomicFileStore;

  constructor(stateRoot: string, atomicStore: AtomicFileStore = new AtomicFileStore()) {
    if (!isAbsolute(stateRoot)) throw new Error("state_root_must_be_absolute");
    this.#stateRoot = resolve(stateRoot);
    this.#atomicStore = atomicStore;
  }

  async runExclusive<Value>(
    setupSessionId: string,
    action: (lease: RegistrationSetupExecutionLease) => Promise<Value>,
    options: ReadOptions = {},
  ): Promise<
    Result<
      Readonly<{ state: "completed"; value: Value }> | Readonly<{ state: "in_progress" }>,
      DomainError
    >
  > {
    if (!identifierPattern.test(setupSessionId) || options.signal?.aborted === true) {
      return err(domainError("invariant_violation"));
    }
    return withSecureDirectory<
      Readonly<{ state: "completed"; value: Value }> | Readonly<{ state: "in_progress" }>
    >(
      this.#stateRoot,
      ["registration-setup", setupSessionId],
      { create: true },
      async (directory) => {
        const acquired = await directory.acquireLock(
          "execution.lock",
          `registration-setup-execution:${randomUUID()}`,
        );
        if (!acquired.ok) {
          return acquired.error.code === "conflict"
            ? ok(Object.freeze({ state: "in_progress" as const }))
            : acquired;
        }
        const execute = async (): Promise<
          Result<
            Readonly<{ state: "completed"; value: Value }> | Readonly<{ state: "in_progress" }>,
            DomainError
          >
        > => {
          const stateLock = await directory.acquireLock(
            "state.lock",
            `registration-setup-execution-epoch:${randomUUID()}`,
          );
          if (!stateLock.ok) {
            return stateLock.error.code === "conflict"
              ? ok(Object.freeze({ state: "in_progress" as const }))
              : stateLock;
          }
          let stateLockHeld = true;
          try {
            const ownership = await acquired.value.assertOwnership();
            if (!ownership.ok) return ownership;
            const current = await readPrivate(directory, "execution.json", executionFenceSchema);
            const prior = !current.ok && current.error.code === "not_found" ? undefined : current;
            if (prior !== undefined && !prior.ok) return prior;
            if (
              prior !== undefined &&
              !sameValue(prior.value.lockIdentity, acquired.value.identity)
            ) {
              return err(domainError("conflict"));
            }
            const fence = executionFenceSchema.parse({
              schemaVersion: 1,
              setupSessionId,
              epoch: (prior?.value.epoch ?? 0) + 1,
              lockIdentity: acquired.value.identity,
              ownerDigest: hash(randomBytes(32).toString("hex")),
            });
            const commitGuard = combineCommitGuards(
              () => acquired.value.assertOwnership(),
              () => stateLock.value.assertOwnership(),
              async () => {
                const latest = await readPrivate(directory, "execution.json", executionFenceSchema);
                if (prior === undefined) {
                  return !latest.ok && latest.error.code === "not_found"
                    ? ok(undefined)
                    : err(domainError(latest.ok ? "conflict" : latest.error.code));
                }
                return latest.ok && sameValue(latest.value, prior.value)
                  ? ok(undefined)
                  : err(domainError(latest.ok ? "conflict" : latest.error.code));
              },
            );
            const publicationGuard = combinePublicationGuards(
              () => acquired.value.assertOwnershipSync(),
              () => stateLock.value.assertOwnershipSync(),
              () => {
                const latest = readPrivateSync(directory, "execution.json", executionFenceSchema);
                if (prior === undefined) {
                  return !latest.ok && latest.error.code === "not_found"
                    ? ok(undefined)
                    : err(domainError(latest.ok ? "conflict" : latest.error.code));
                }
                return latest.ok && sameValue(latest.value, prior.value)
                  ? ok(undefined)
                  : err(domainError(latest.ok ? "conflict" : latest.error.code));
              },
            );
            const persisted = await persistPrivate(
              directory,
              "execution.json",
              executionFenceSchema,
              fence,
              {
                store: this.#atomicStore,
                commitGuard,
                publicationGuard,
                postCommitGuard: combineCommitGuards(
                  () => acquired.value.assertOwnership(),
                  () => stateLock.value.assertOwnership(),
                  () => assertExecutionFence(directory, fence),
                ),
              },
            );
            if (!persisted.ok || persisted.value.durability !== "confirmed") {
              return persisted.ok ? err(domainError("external_failure")) : persisted;
            }
            const lease: RegistrationSetupExecutionLease = Object.freeze({
              fence,
              assertOwnershipSync: () => {
                const lockOwnership = acquired.value.assertOwnershipSync();
                return lockOwnership.ok
                  ? assertExecutionFenceSync(directory, fence)
                  : lockOwnership;
              },
              assertOwnership: async () => {
                const lockOwnership = await acquired.value.assertOwnership();
                return lockOwnership.ok ? assertExecutionFence(directory, fence) : lockOwnership;
              },
            });
            const stateReleased = await stateLock.value.release();
            stateLockHeld = false;
            if (!stateReleased.ok) return stateReleased;
            const before = await lease.assertOwnership();
            if (!before.ok) return before;
            const value = await executionLeaseContext.run(lease, () => action(lease));
            const after = await lease.assertOwnership();
            return after.ok ? ok(Object.freeze({ state: "completed" as const, value })) : after;
          } finally {
            if (stateLockHeld) await stateLock.value.release();
          }
        };
        let result: Awaited<ReturnType<typeof execute>>;
        try {
          result = await execute();
        } catch {
          result = err(domainError("external_failure"));
        }
        const released = await acquired.value.release();
        return !released.ok && result.ok ? released : result;
      },
    );
  }
}

export class FileRegistrationSetupSessionStore implements RegistrationSetupSessionPort {
  readonly #stateRoot: string;
  readonly #atomicStore: AtomicFileStore;

  constructor(stateRoot: string, atomicStore: AtomicFileStore = new AtomicFileStore()) {
    if (!isAbsolute(stateRoot)) throw new Error("state_root_must_be_absolute");
    this.#stateRoot = resolve(stateRoot);
    this.#atomicStore = atomicStore;
  }

  paths(setupSessionId: string) {
    if (!identifierPattern.test(setupSessionId)) throw new Error("invalid_setup_session_id");
    return setupPaths(this.#stateRoot, setupSessionId);
  }

  async load(setupSessionId: string, options: ReadOptions = {}) {
    if (!identifierPattern.test(setupSessionId) || options.signal?.aborted === true) {
      return err(domainError("invariant_violation"));
    }
    const loaded = await withSecureDirectory(
      this.#stateRoot,
      ["registration-setup", setupSessionId],
      { create: false },
      async (directory) => {
        const activated = await readPrivate(directory, "activation.json", activationRecordSchema);
        if (activated.ok) return ok(activated.value.session);
        return activated.error.code === "not_found"
          ? readPrivate(directory, "session.json", sessionSchema)
          : activated;
      },
    );
    if (!loaded.ok && loaded.error.code === "not_found") return ok(undefined);
    return loaded;
  }

  async save(
    expectedRevision: number | undefined,
    draft: RegistrationSetupSessionDraft,
    options: RegistrationSetupFencedMutationOptions,
  ) {
    if (
      !validFencedMutation(options) ||
      "revision" in draft ||
      !sessionSchema.safeParse({ ...draft, revision: 1 }).success
    ) {
      return err(domainError("invariant_violation"));
    }
    return withLock(
      this.#stateRoot,
      ["registration-setup", draft.setupSessionId],
      "state.lock",
      `registration-setup-session:${draft.setupSessionId}`,
      async (directory, lockCommitGuard, lockPublicationGuard) => {
        const ownership = await assertExecutionFence(directory, options.executionFence);
        if (!ownership.ok) return ownership;
        const activation = await readPrivate(directory, "activation.json", activationRecordSchema);
        const current = activation.ok
          ? ok(activation.value.session)
          : activation.error.code !== "not_found"
            ? activation
            : await readPrivate(directory, "session.json", sessionSchema);
        const normalizedCurrent =
          !current.ok && current.error.code === "not_found" ? ok(undefined) : current;
        if (!normalizedCurrent.ok) return normalizedCurrent;
        if (
          (expectedRevision === undefined && normalizedCurrent.value !== undefined) ||
          (expectedRevision !== undefined && normalizedCurrent.value?.revision !== expectedRevision)
        ) {
          return err(domainError("conflict"));
        }
        const session = sessionSchema.parse({
          ...draft,
          revision: (normalizedCurrent.value?.revision ?? 0) + 1,
        });
        const commitGuard = combineCommitGuards(
          lockCommitGuard,
          activeExecutionCommitGuard(options.executionFence),
          () => assertExecutionFence(directory, options.executionFence),
        );
        const publicationGuard = combinePublicationGuards(
          lockPublicationGuard,
          activeExecutionPublicationGuard(options.executionFence),
          () => assertExecutionFenceSync(directory, options.executionFence),
        );
        const persisted = await persistPrivate(directory, "session.json", sessionSchema, session, {
          store: this.#atomicStore,
          commitGuard,
          publicationGuard,
        });
        if (!persisted.ok) return persisted;
        const retained = await assertExecutionFence(directory, options.executionFence);
        return ok({
          durability: retained.ok ? persisted.value.durability : ("unknown" as const),
          session,
        });
      },
    );
  }

  async activate(
    expectedRevision: number,
    draft: RegistrationSetupSessionDraft,
    revisionSha: string,
    options: RegistrationSetupFencedMutationOptions,
  ) {
    if (
      !validFencedMutation(options) ||
      !shaPattern.test(revisionSha) ||
      draft.phase !== "activated" ||
      "revision" in draft ||
      draft.activatedRevisionSha?.toLowerCase() !== revisionSha.toLowerCase() ||
      !sessionSchema.safeParse({ ...draft, revision: 1 }).success
    ) {
      return err(domainError("invariant_violation"));
    }
    return withLock(
      this.#stateRoot,
      ["registration-setup", draft.setupSessionId],
      "state.lock",
      `registration-setup-activation:${draft.setupSessionId}`,
      async (directory, lockCommitGuard, lockPublicationGuard) => {
        const ownership = await assertExecutionFence(directory, options.executionFence);
        if (!ownership.ok) return ownership;
        const activation = await readPrivate(directory, "activation.json", activationRecordSchema);
        const current = activation.ok
          ? ok(activation.value.session)
          : activation.error.code !== "not_found"
            ? activation
            : await readPrivate(directory, "session.json", sessionSchema);
        if (!current.ok) return current;
        if (current.value.revision !== expectedRevision) return err(domainError("conflict"));
        const session = sessionSchema.parse({ ...draft, revision: expectedRevision + 1 });
        const marker = markerSchema.parse({
          schemaVersion: 1,
          source: "source_control_default_branch",
          setupSessionId: session.setupSessionId,
          projectId: session.project.id,
          authoritativeRevision: revisionSha,
          defaultBranch: session.project.defaultBranch,
          configDigest: session.configDigest,
        });
        const record = activationRecordSchema.parse({ schemaVersion: 1, session, marker });
        const persisted = await persistPrivate(
          directory,
          "activation.json",
          activationRecordSchema,
          record,
          {
            store: this.#atomicStore,
            commitGuard: combineCommitGuards(
              lockCommitGuard,
              activeExecutionCommitGuard(options.executionFence),
              () => assertExecutionFence(directory, options.executionFence),
            ),
            publicationGuard: combinePublicationGuards(
              lockPublicationGuard,
              activeExecutionPublicationGuard(options.executionFence),
              () => assertExecutionFenceSync(directory, options.executionFence),
            ),
          },
        );
        if (!persisted.ok) return persisted;
        const retained = await assertExecutionFence(directory, options.executionFence);
        return ok({
          durability: retained.ok ? persisted.value.durability : ("unknown" as const),
          session,
          marker,
        });
      },
    );
  }
}

export class LocalRegistrationSetupFileAdapter implements RegistrationSetupFilePort {
  readonly #atomicStore: AtomicFileStore;

  constructor(atomicStore: AtomicFileStore = new AtomicFileStore()) {
    this.#atomicStore = atomicStore;
  }

  async writeTrustedProjectConfig(
    command: Parameters<RegistrationSetupFilePort["writeTrustedProjectConfig"]>[0],
    options: MutationOptions,
  ) {
    if (
      !validMutation(options) ||
      command.path !== trustedProjectConfigPath ||
      !isAbsolute(command.worktree.path) ||
      command.worktree.branch !== registrationSetupBranch ||
      !digestPattern.test(command.contentDigest) ||
      hash(command.content) !== command.contentDigest
    ) {
      return err(domainError("invariant_violation"));
    }
    const existing = await this.readTrustedProjectConfig(command, options);
    if (
      existing.ok &&
      existing.value.content === command.content &&
      existing.value.contentDigest === command.contentDigest
    ) {
      return ok({ path: trustedProjectConfigPath, contentDigest: command.contentDigest });
    }
    if (!existing.ok && existing.error.code !== "not_found") return existing;
    const target = join(resolve(command.worktree.path), trustedProjectConfigPath);
    const executionCommitGuard =
      activeExecutionCommitGuard() ?? (() => Promise.resolve(err(domainError("conflict"))));
    const executionPublicationGuard =
      activeExecutionPublicationGuard() ?? (() => err(domainError("conflict")));
    const written = await this.#atomicStore.write(target, Buffer.from(command.content, "utf8"), {
      visibility: "project",
      commitGuard: executionCommitGuard,
      publicationGuard: executionPublicationGuard,
    });
    if (!written.ok) return written;
    if (written.value.durability !== "confirmed") return err(domainError("external_failure"));
    const retained = await executionCommitGuard();
    if (!retained.ok) return err(domainError("external_failure"));
    const readBack = await this.readTrustedProjectConfig(command, options);
    return readBack.ok &&
      readBack.value.content === command.content &&
      readBack.value.contentDigest === command.contentDigest
      ? ok({ path: trustedProjectConfigPath, contentDigest: command.contentDigest })
      : err(domainError("external_failure"));
  }

  async readTrustedProjectConfig(
    command: Parameters<RegistrationSetupFilePort["readTrustedProjectConfig"]>[0],
    options: ReadOptions = {},
  ) {
    if (
      options.signal?.aborted === true ||
      command.path !== trustedProjectConfigPath ||
      !isAbsolute(command.worktree.path)
    ) {
      return err(domainError("invariant_violation"));
    }
    try {
      const path = join(resolve(command.worktree.path), trustedProjectConfigPath);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const content = await handle.readFile("utf8");
        if (Buffer.byteLength(content, "utf8") > 1024 * 1024 || content.includes("\u0000")) {
          return err(domainError("invariant_violation"));
        }
        return ok({ path: trustedProjectConfigPath, content, contentDigest: hash(content) });
      } finally {
        await handle.close();
      }
    } catch (error) {
      return err(
        domainError(
          typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
            ? "not_found"
            : "external_failure",
        ),
      );
    }
  }
}

/** Durable, local-UI-only authority for the explicit preview-to-Draft-PR transition. */
export class FileLocalUiPreviewConfirmationAuthority implements RegistrationSetupPreviewConfirmationAuthorityPort {
  readonly #stateRoot: string;
  readonly #clock: Clock;
  readonly #atomicStore: AtomicFileStore;

  constructor(
    stateRoot: string,
    clock: Clock = createClock(),
    atomicStore: AtomicFileStore = new AtomicFileStore(),
  ) {
    if (!isAbsolute(stateRoot)) throw new Error("state_root_must_be_absolute");
    this.#stateRoot = resolve(stateRoot);
    this.#clock = clock;
    this.#atomicStore = atomicStore;
  }

  async #load(
    directory: HeldSecureDirectory,
  ): Promise<Result<PreviewConfirmationLedger, DomainError>> {
    const loaded = await readPrivate(
      directory,
      "preview-confirmations.json",
      previewConfirmationLedgerSchema,
    );
    return !loaded.ok && loaded.error.code === "not_found"
      ? ok({ schemaVersion: 1, revision: 0, grants: [] })
      : loaded;
  }

  #persist(
    ledger: PreviewConfirmationLedger,
    directory: HeldSecureDirectory,
    lockCommitGuard: CommitGuard,
    lockPublicationGuard: PublicationGuard,
  ) {
    return persistPrivate(
      directory,
      "preview-confirmations.json",
      previewConfirmationLedgerSchema,
      ledger,
      {
        store: this.#atomicStore,
        commitGuard: lockCommitGuard,
        publicationGuard: lockPublicationGuard,
      },
    );
  }

  async issue(
    binding: RegistrationSetupPreviewConfirmationBinding,
    trustedAuthorityDigest: string,
    options: MutationOptions,
  ) {
    if (
      !validMutation(options) ||
      !digestPattern.test(trustedAuthorityDigest) ||
      !previewConfirmationBindingSchema.safeParse(binding).success
    ) {
      return err(domainError("invariant_violation"));
    }
    return withLock<
      | Readonly<{
          state: "issued";
          grant: Readonly<{
            confirmation: RegistrationSetupPreviewConfirmation;
            expiresAt: string;
          }>;
        }>
      | Readonly<{ state: "rejected" | "unknown" }>
    >(
      this.#stateRoot,
      ["registration-setup", "preview-confirmation-authority"],
      "ledger.lock",
      "registration-setup-preview-confirmation-issue",
      async (directory, lockCommitGuard, lockPublicationGuard) => {
        const ledger = await this.#load(directory);
        if (!ledger.ok) return ledger;
        const operationDigest = hash(options.idempotencyKey);
        const existing = ledger.value.grants.find(
          (grant) => grant.issueOperationDigest === operationDigest,
        );
        if (existing !== undefined) {
          if (
            existing.state !== "pending" ||
            existing.authorityDigest !== trustedAuthorityDigest ||
            !sameValue(existing.binding, binding)
          ) {
            return ok({ state: "rejected" as const });
          }
          return ok({
            state: "issued" as const,
            grant: {
              confirmation: previewConfirmationSchema.parse({
                source: "local_ui",
                explicit: true,
                tokenId: existing.tokenId,
                ...existing.binding,
              }),
              expiresAt: existing.expiresAt,
            },
          });
        }
        const issuedAt = this.#clock.now();
        const duplicate = ledger.value.grants.some(
          (grant) =>
            grant.authorityDigest === trustedAuthorityDigest &&
            sameValue(grant.binding, binding) &&
            (grant.state === "consumed" || Date.parse(issuedAt) <= Date.parse(grant.expiresAt)),
        );
        if (duplicate) return ok({ state: "rejected" as const });
        const expiresAt = new Date(Date.parse(issuedAt) + 5 * 60_000).toISOString();
        const pending = pendingPreviewConfirmationSchema.parse({
          tokenId: `preview-${randomUUID()}`,
          issueOperationDigest: operationDigest,
          authorityDigest: trustedAuthorityDigest,
          binding,
          issuedAt,
          expiresAt,
          state: "pending",
        });
        const next = previewConfirmationLedgerSchema.parse({
          schemaVersion: 1,
          revision: ledger.value.revision + 1,
          grants: [...ledger.value.grants, pending],
        });
        const persisted = await this.#persist(
          next,
          directory,
          lockCommitGuard,
          lockPublicationGuard,
        );
        if (!persisted.ok) return persisted;
        return persisted.value.durability === "confirmed"
          ? ok({
              state: "issued" as const,
              grant: {
                confirmation: previewConfirmationSchema.parse({
                  source: "local_ui",
                  explicit: true,
                  tokenId: pending.tokenId,
                  ...pending.binding,
                }),
                expiresAt,
              },
            })
          : ok({ state: "unknown" as const });
      },
    );
  }

  async verify(
    token: RegistrationSetupPreviewConfirmation,
    trustedAuthorityDigest: string,
    options: MutationOptions,
  ) {
    if (
      !validMutation(options) ||
      !digestPattern.test(trustedAuthorityDigest) ||
      !previewConfirmationSchema.safeParse(token).success
    ) {
      return ok({ state: "rejected" as const });
    }
    return withLock<Readonly<{ state: "verified" | "rejected" }>>(
      this.#stateRoot,
      ["registration-setup", "preview-confirmation-authority"],
      "ledger.lock",
      "registration-setup-preview-confirmation-consume",
      async (directory, lockCommitGuard, lockPublicationGuard) => {
        const ledger = await this.#load(directory);
        if (!ledger.ok) return ledger;
        const index = ledger.value.grants.findIndex((grant) => grant.tokenId === token.tokenId);
        const grant = ledger.value.grants[index];
        const binding = {
          setupSessionId: token.setupSessionId,
          projectId: token.projectId,
          previewDigest: token.previewDigest,
        };
        if (
          grant?.authorityDigest !== trustedAuthorityDigest ||
          !sameValue(grant.binding, binding)
        ) {
          return ok({ state: "rejected" as const });
        }
        const operationDigest = hash(options.idempotencyKey);
        if (grant.state === "consumed") {
          return ok({
            state: grant.consumeOperationDigest === operationDigest ? "verified" : "rejected",
          } as const);
        }
        const consumedAt = this.#clock.now();
        if (Date.parse(consumedAt) > Date.parse(grant.expiresAt)) {
          return ok({ state: "rejected" as const });
        }
        const consumed = consumedPreviewConfirmationSchema.parse({
          ...grant,
          state: "consumed",
          consumeOperationDigest: operationDigest,
          consumedAt,
        });
        const grants = [...ledger.value.grants];
        grants[index] = consumed;
        const next = previewConfirmationLedgerSchema.parse({
          schemaVersion: 1,
          revision: ledger.value.revision + 1,
          grants,
        });
        const persisted = await this.#persist(
          next,
          directory,
          lockCommitGuard,
          lockPublicationGuard,
        );
        if (!persisted.ok) return persisted;
        return ok({
          state: persisted.value.durability === "confirmed" ? "verified" : "rejected",
        } as const);
      },
    );
  }
}

export class FileRegistrationSetupFinalApprovalAuthority implements RegistrationSetupFinalApprovalAuthorityPort {
  readonly #stateRoot: string;
  readonly #clock: Clock;
  readonly #atomicStore: AtomicFileStore;

  constructor(
    stateRoot: string,
    clock: Clock = createClock(),
    atomicStore: AtomicFileStore = new AtomicFileStore(),
  ) {
    if (!isAbsolute(stateRoot)) throw new Error("state_root_must_be_absolute");
    this.#stateRoot = resolve(stateRoot);
    this.#clock = clock;
    this.#atomicStore = atomicStore;
  }

  async #load(directory: HeldSecureDirectory): Promise<Result<ApprovalLedger, DomainError>> {
    const loaded = await readPrivate(directory, "ledger.json", ledgerSchema);
    return !loaded.ok && loaded.error.code === "not_found"
      ? ok({ schemaVersion: 1, revision: 0, grants: [] })
      : loaded;
  }

  async #persist(
    ledger: ApprovalLedger,
    directory: HeldSecureDirectory,
    lockCommitGuard: CommitGuard,
    lockPublicationGuard: PublicationGuard,
  ) {
    return persistPrivate(directory, "ledger.json", ledgerSchema, ledger, {
      store: this.#atomicStore,
      commitGuard: combineCommitGuards(lockCommitGuard, activeExecutionCommitGuard()),
      publicationGuard: combinePublicationGuards(
        lockPublicationGuard,
        activeExecutionPublicationGuard(),
      ),
    });
  }

  async issue(
    binding: RegistrationSetupApprovalBinding,
    authority: RegistrationSetupFinalApprovalAuthority,
    options: MutationOptions,
  ) {
    const rawAuthority = authority as unknown as Readonly<Record<string, unknown>>;
    if (
      !validMutation(options) ||
      !digestPattern.test(authority.authorityDigest) ||
      (rawAuthority["issuer"] !== "local_ui" &&
        rawAuthority["issuer"] !== "current_user_conversation") ||
      !approvalBindingSchema.safeParse(binding).success
    ) {
      return err(domainError("invariant_violation"));
    }
    return withLock<
      | Readonly<{ state: "issued"; grant: Readonly<{ approvalId: string; expiresAt: string }> }>
      | Readonly<{ state: "rejected" | "unknown" }>
    >(
      this.#stateRoot,
      ["registration-setup", "approval-authority"],
      "ledger.lock",
      "registration-setup-approval-issue",
      async (directory, lockCommitGuard, lockPublicationGuard) => {
        const ledger = await this.#load(directory);
        if (!ledger.ok) return ledger;
        const operationDigest = hash(options.idempotencyKey);
        const existing = ledger.value.grants.find(
          (grant) => grant.issueOperationDigest === operationDigest,
        );
        if (existing !== undefined) {
          return existing.state === "pending" &&
            existing.issuer === authority.issuer &&
            existing.authorityDigest === authority.authorityDigest &&
            sameValue(existing.binding, binding)
            ? ok({
                state: "issued" as const,
                grant: { approvalId: existing.approvalId, expiresAt: existing.expiresAt },
              })
            : ok({ state: "rejected" as const });
        }
        const issuedAt = this.#clock.now();
        const duplicateBinding = ledger.value.grants.find(
          (grant) =>
            grant.issuer === authority.issuer &&
            grant.authorityDigest === authority.authorityDigest &&
            sameValue(grant.binding, binding) &&
            (grant.state === "consumed" || Date.parse(issuedAt) <= Date.parse(grant.expiresAt)),
        );
        if (duplicateBinding !== undefined) return ok({ state: "rejected" as const });
        const expiresAt = new Date(Date.parse(issuedAt) + 5 * 60_000).toISOString();
        const grant = ledgerGrantSchema.parse({
          approvalId: `approval-${randomUUID()}`,
          issueOperationDigest: operationDigest,
          issuer: authority.issuer,
          authorityDigest: authority.authorityDigest,
          approvalNonceDigest: hash(randomBytes(32).toString("hex")),
          binding,
          issuedAt,
          expiresAt,
          state: "pending",
        });
        const next = ledgerSchema.parse({
          schemaVersion: 1,
          revision: ledger.value.revision + 1,
          grants: [...ledger.value.grants, grant],
        });
        const persisted = await this.#persist(
          next,
          directory,
          lockCommitGuard,
          lockPublicationGuard,
        );
        if (!persisted.ok) return persisted;
        return persisted.value.durability === "confirmed"
          ? ok({ state: "issued" as const, grant: { approvalId: grant.approvalId, expiresAt } })
          : ok({ state: "unknown" as const });
      },
    );
  }

  async verifyAndConsume(
    request: RegistrationSetupFinalApprovalRequest,
    expectedBinding: RegistrationSetupApprovalBinding,
    authority: RegistrationSetupFinalApprovalAuthority,
    options: MutationOptions,
  ) {
    const rawAuthority = authority as unknown as Readonly<Record<string, unknown>>;
    const requestKeys = Object.keys(request).sort();
    const rawRequest = request as unknown as Readonly<Record<string, unknown>>;
    if (
      !validMutation(options) ||
      !digestPattern.test(authority.authorityDigest) ||
      (rawAuthority["issuer"] !== "local_ui" &&
        rawAuthority["issuer"] !== "current_user_conversation") ||
      !approvalBindingSchema.safeParse(expectedBinding).success ||
      requestKeys.join("\0") !== "approvalId\0expectedSetupRevision\0userConfirmed" ||
      !identifierPattern.test(request.approvalId) ||
      rawRequest["userConfirmed"] !== true ||
      !Number.isSafeInteger(request.expectedSetupRevision) ||
      request.expectedSetupRevision <= 0
    ) {
      return ok({ state: "rejected" as const });
    }
    return withLock<
      | Readonly<{
          state: "verified_and_consumed";
          receipt: RegistrationSetupFinalApprovalReceipt;
        }>
      | Readonly<{ state: "replay" | "rejected" | "unknown" }>
    >(
      this.#stateRoot,
      ["registration-setup", "approval-authority"],
      "ledger.lock",
      "registration-setup-approval-consume",
      async (directory, lockCommitGuard, lockPublicationGuard) => {
        const ledger = await this.#load(directory);
        if (!ledger.ok) return ledger;
        const index = ledger.value.grants.findIndex(
          (candidate) => candidate.approvalId === request.approvalId,
        );
        const grant = ledger.value.grants[index];
        if (
          grant?.issuer !== authority.issuer ||
          grant.authorityDigest !== authority.authorityDigest ||
          request.expectedSetupRevision !== expectedBinding.setupSessionRevision ||
          !sameValue(grant.binding, expectedBinding)
        ) {
          return ok({ state: "rejected" as const });
        }
        const operationDigest = hash(options.idempotencyKey);
        if (grant.state === "consumed") {
          return grant.consumeOperationDigest === operationDigest
            ? ok({ state: "verified_and_consumed" as const, receipt: grant.receipt })
            : ok({ state: "replay" as const });
        }
        if (Date.parse(this.#clock.now()) > Date.parse(grant.expiresAt)) {
          return ok({ state: "rejected" as const });
        }
        const receipt = approvalReceiptSchema.parse({
          ...grant.binding,
          approvalId: grant.approvalId,
          issuer: grant.issuer,
          authorityDigest: grant.authorityDigest,
          approvalNonceDigest: grant.approvalNonceDigest,
          consumedAt: this.#clock.now(),
        });
        const consumed = consumedGrantSchema.parse({
          ...grant,
          state: "consumed",
          consumeOperationDigest: operationDigest,
          receipt,
        });
        const grants = [...ledger.value.grants];
        grants[index] = consumed;
        const next = ledgerSchema.parse({
          schemaVersion: 1,
          revision: ledger.value.revision + 1,
          grants,
        });
        const persisted = await this.#persist(
          next,
          directory,
          lockCommitGuard,
          lockPublicationGuard,
        );
        if (!persisted.ok) return persisted;
        return persisted.value.durability === "confirmed"
          ? ok({ state: "verified_and_consumed" as const, receipt })
          : ok({ state: "unknown" as const });
      },
    );
  }
}
