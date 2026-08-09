import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileRegistrationSetupFinalApprovalAuthority,
  FileRegistrationSetupActivationRegistry,
  FileRegistrationSetupExecutionStore,
  FileRegistrationSetupJournalStore,
  FileRegistrationSetupSessionStore,
  LocalRegistrationSetupFileAdapter,
} from "../../src/adapters/registration/index.js";
import {
  createRegistrationSetupPreview,
  registrationSetupActivationMarkerDigest,
  registrationSetupBranchFor,
  type RegistrationSetupApprovalBinding,
  type RegistrationSetupExecutionLease,
  type RegistrationSetupJournalDraft,
  type RegistrationSetupSessionDraft,
} from "../../src/application/registration/index.js";
import {
  serializeTrustedProjectConfig,
  TrustedProjectConfigLoader,
  trustedProjectConfigSchema,
} from "../../src/application/projects/index.js";
import { createFixedClock, ok, parseInstant } from "../../src/domain/foundation/index.js";
import { projectSchema } from "../../src/domain/project/index.js";
import { sha256Digest } from "../../src/domain/review/index.js";
import { AtomicFileStore, type AtomicWriteOptions } from "../../src/infrastructure/files/index.js";

const roots: string[] = [];
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const mergedSha = "c".repeat(40);
const authorityDigest = "1".repeat(64);

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-team-setup-"));
  roots.push(root);
  return root;
}

async function withExecution<Value>(
  root: string,
  action: (lease: RegistrationSetupExecutionLease) => Promise<Value>,
): Promise<Value> {
  return withExecutionFor(root, preview.setupSessionId, action);
}

// C026(C): a session-scoped variant of `withExecution` -- needed to exercise a *second* session
// (its own setupSessionId, its own execution lease) for the same project, e.g. a re-approval.
async function withExecutionFor<Value>(
  root: string,
  setupSessionId: string,
  action: (lease: RegistrationSetupExecutionLease) => Promise<Value>,
): Promise<Value> {
  const result = await new FileRegistrationSetupExecutionStore(root).runExclusive(
    setupSessionId,
    action,
  );
  if (!result.ok) throw new Error(result.error.code);
  if (result.value.state !== "completed") throw new Error("execution_in_progress");
  return result.value.value;
}

class HookedAtomicFileStore extends AtomicFileStore {
  readonly #beforeCommit: ((targetPath: string) => Promise<void>) | undefined;
  readonly #beforePublication: ((targetPath: string) => void) | undefined;
  readonly #afterCommit: ((targetPath: string) => Promise<void>) | undefined;

  constructor(options: {
    beforeCommit?: (targetPath: string) => Promise<void>;
    beforePublication?: (targetPath: string) => void;
    afterCommit?: (targetPath: string) => Promise<void>;
  }) {
    super();
    this.#beforeCommit = options.beforeCommit;
    this.#beforePublication = options.beforePublication;
    this.#afterCommit = options.afterCommit;
  }

  override async write(targetPath: string, content: Uint8Array, options: AtomicWriteOptions = {}) {
    const originalGuard = options.commitGuard;
    const originalPublicationGuard = options.publicationGuard;
    const guardedOptions: AtomicWriteOptions =
      originalGuard === undefined
        ? options
        : {
            ...options,
            commitGuard: async () => {
              await this.#beforeCommit?.(targetPath);
              return originalGuard();
            },
          };
    const publicationOptions: AtomicWriteOptions =
      originalPublicationGuard === undefined
        ? guardedOptions
        : {
            ...guardedOptions,
            publicationGuard: () => {
              this.#beforePublication?.(targetPath);
              return originalPublicationGuard();
            },
          };
    const result = await super.write(targetPath, content, publicationOptions);
    if (result.ok && result.value.durability === "confirmed") {
      await this.#afterCommit?.(targetPath);
    }
    return result;
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const project = projectSchema.parse({
  schemaVersion: 1,
  id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  displayName: "Sandbox",
  localRepositoryPath: "/tmp/sandbox",
  defaultBranch: "main",
  workManagement: { provider: "linear", containerId: "workspace", projectId: "linear-project" },
  sourceControl: { provider: "github", repository: "owner/sandbox" },
});
const config = trustedProjectConfigSchema.parse({
  schemaVersion: 1,
  projectId: project.id,
  defaultBranch: project.defaultBranch,
  platforms: { workManagement: project.workManagement, sourceControl: project.sourceControl },
  projectRules: ["Run quality checks."],
  roleInstructions: { implementer: ["Stay in scope."] },
  commands: { quality: [{ executable: "pnpm", arguments: ["test"] }], visualReview: [] },
});
const setupSessionId = "setup-session-1";
const previewResult = createRegistrationSetupPreview({
  schemaVersion: 1,
  setupSessionId,
  project,
  config,
  baseRevision: baseSha,
  worktreePath: "/tmp/setup-worktree",
  branch: registrationSetupBranchFor(setupSessionId),
  remote: "origin",
  linearAuditIssueId: "LINEAR-AUDIT-1",
});
if (!previewResult.ok) throw new Error(previewResult.error.code);
const preview = previewResult.value;
const unavailableFence = {
  schemaVersion: 1 as const,
  setupSessionId: preview.setupSessionId,
  epoch: 1,
  lockIdentity: {
    device: 1,
    inode: 1,
    generation: "00000000-0000-4000-8000-000000000001",
    ownerDigest: preview.previewDigest,
    changeEpoch: "1",
  },
  ownerDigest: preview.previewDigest,
};
const serialized = serializeTrustedProjectConfig(config);
if (!serialized.ok) throw new Error(serialized.error.code);
const serializedConfig = serialized.value;
const testDigestResult = sha256Digest({ test: "registration-setup" });
if (!testDigestResult.ok) throw new Error(testDigestResult.error.code);
const testDigest = testDigestResult.value;
function mustDigest(value: unknown) {
  const result = sha256Digest(value);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
function rawDigest(value: string): typeof testDigest {
  return createHash("sha256").update(value, "utf8").digest("hex") as typeof testDigest;
}
const gateEvidenceBinding = Object.freeze({
  schemaVersion: 1 as const,
  source: "source_control" as const,
  projectId: project.id,
  repository: project.sourceControl.repository,
  changeRequestId: "42", // O009c fix: decimal PR number, not the opaque node id.
  headSha,
  requirementsDigest: preview.requirementsDigest,
  diffDigest: testDigest,
  ciChecksDigest: testDigest,
  reviewContext: "agent-team/review" as const,
  reviewEvidenceUrl: "https://review.test/evidence",
});
const gateEvidenceReceipt = Object.freeze({
  ...gateEvidenceBinding,
  evidenceDigest: mustDigest({ kind: "registration_setup_gate_evidence", ...gateEvidenceBinding }),
});
const localApprovalAuthority = Object.freeze({
  issuer: "local_ui" as const,
  authorityDigest,
});
const updatedAtResult = parseInstant("2026-08-05T12:00:00.000Z");
if (!updatedAtResult.ok) throw new Error(updatedAtResult.error.code);
const updatedAt = updatedAtResult.value;

function testAuditReceipt(destination: "linear" | "pull_request") {
  const body = [
    "Agent Team registration Setup PR is waiting for explicit user approval.",
    `project=${project.id}`,
    `setup_session=${preview.setupSessionId}`,
    `preview_digest=${preview.previewDigest}`,
    "change_request=PR_node_1",
    `head_sha=${headSha}`,
    `requirements_digest=${preview.requirementsDigest}`,
    `diff_digest=${testDigest}`,
    `linear_audit_issue=${preview.linearAuditIssueId}`,
    `gate_evidence_digest=${gateEvidenceReceipt.evidenceDigest}`,
    `review_evidence=${gateEvidenceReceipt.reviewEvidenceUrl}`,
    "merge=squash",
    "authority=local UI or trusted current-user conversation only",
  ].join("\n");
  const idempotencyKey = `setup-audit:${preview.setupSessionId}:${gateEvidenceReceipt.evidenceDigest.slice(0, 16)}:${destination}`;
  return Object.freeze({
    schemaVersion: 1 as const,
    destination,
    setupSessionId: preview.setupSessionId,
    projectId: project.id,
    repository: project.sourceControl.repository,
    linearAuditIssueId: preview.linearAuditIssueId,
    changeRequestId: "42", // O009c fix: decimal PR number, not the opaque node id.
    headSha,
    requirementsDigest: preview.requirementsDigest,
    diffDigest: testDigest,
    evidenceDigest: gateEvidenceReceipt.evidenceDigest,
    bodyDigest: mustDigest(body),
    externalCommentId: `${destination}-comment-1`,
    idempotencyKeyDigest: mustDigest(idempotencyKey),
    createdAt: updatedAt,
    reused: false,
  });
}

function approvalReferenceFor(approvalId: string) {
  return mustDigest({
    schemaVersion: 1,
    kind: "registration_setup_approval_reference",
    approvalId,
  });
}

function testMergeState(approvalReferenceDigest = testDigest) {
  const mergeIdempotencyKey = `setup-merge:${preview.setupSessionId}:${approvalReferenceDigest.slice(0, 16)}`;
  const mergeIntentBinding = Object.freeze({
    schemaVersion: 1 as const,
    projectId: project.id,
    repository: project.sourceControl.repository,
    changeRequestId: "42", // O009c fix: decimal PR number, not the opaque node id.
    expectedHeadSha: headSha,
    mergeMethod: "SQUASH" as const,
    idempotencyKey: mergeIdempotencyKey,
  });
  const mergeIntent = Object.freeze({
    ...mergeIntentBinding,
    mergeIntentDigest: mustDigest({
      kind: "registration_setup_merge_intent",
      ...mergeIntentBinding,
    }),
  });
  const { idempotencyKey: _mergeIdempotencyKey, ...mergeReceiptBinding } = mergeIntent;
  void _mergeIdempotencyKey;
  return {
    mergeIntent,
    mergeReceipt: Object.freeze({
      ...mergeReceiptBinding,
      state: "merged" as const,
      idempotencyKeyDigest: mustDigest(mergeIdempotencyKey),
    }),
  };
}

function plannedJournal(): RegistrationSetupJournalDraft {
  return {
    schemaVersion: 1,
    setupSessionId: preview.setupSessionId,
    preview,
    configDigest: serializedConfig.contentDigest,
    completed: {},
  };
}

function sessionDraft(
  phase: "ci_waiting" | "activated" = "ci_waiting",
  approvalReceipt?: import("../../src/application/registration/index.js").RegistrationSetupFinalApprovalReceipt,
): RegistrationSetupSessionDraft {
  const approvalReferenceDigest =
    approvalReceipt === undefined ? testDigest : approvalReferenceFor(approvalReceipt.approvalId);
  const merge = testMergeState(approvalReferenceDigest);
  return {
    schemaVersion: 1,
    phase,
    setupSessionId: preview.setupSessionId,
    project,
    config,
    baseRevision: baseSha,
    worktree: {
      repositoryRoot: project.localRepositoryPath,
      path: preview.worktreePath,
      branch: preview.branch,
      headSha: baseSha,
    },
    remote: "origin",
    previewDigest: preview.previewDigest,
    requirementsDigest: preview.requirementsDigest,
    diffDigest: testDigest,
    configDigest: serializedConfig.contentDigest,
    headSha,
    changeRequest: {
      id: "PR_node_1",
      number: 42,
      url: "https://github.test/owner/sandbox/pull/42",
      state: phase === "activated" ? "merged" : "open",
      draft: phase !== "activated",
      baseBranch: "main",
      headBranch: preview.branch,
      headSha,
      mergeability: "mergeable",
      autoMergeEnabled: phase === "activated",
      updatedAt,
    },
    linearAuditIssueId: preview.linearAuditIssueId,
    ...(phase === "activated"
      ? {
          gateEvidenceReceipt,
          audit: {
            linearReceipt: testAuditReceipt("linear"),
            pullRequestReceipt: testAuditReceipt("pull_request"),
          },
        }
      : {}),
    evidence:
      phase === "activated"
        ? ([
            {
              code: "setup_user_approval_consumed",
              projectId: project.id,
              setupSessionId: preview.setupSessionId,
              previewDigest: preview.previewDigest,
              requirementsDigest: preview.requirementsDigest,
              headSha,
              diffDigest: testDigest,
              changeRequestId: "42", // O009c fix: decimal PR number, not the opaque node id.
            },
            {
              code: "setup_merge_verified",
              projectId: project.id,
              setupSessionId: preview.setupSessionId,
              previewDigest: preview.previewDigest,
              requirementsDigest: preview.requirementsDigest,
              headSha,
              diffDigest: testDigest,
              changeRequestId: "42", // O009c fix: decimal PR number, not the opaque node id.
            },
            {
              code: "trusted_config_activated",
              projectId: project.id,
              setupSessionId: preview.setupSessionId,
              previewDigest: preview.previewDigest,
              requirementsDigest: preview.requirementsDigest,
              headSha,
              diffDigest: testDigest,
              changeRequestId: "42", // O009c fix: decimal PR number, not the opaque node id.
            },
          ] as const)
        : [],
    ...(phase === "activated"
      ? {
          approvalReferenceDigest,
          approvalConsumeOperationDigest:
            approvalReceipt === undefined
              ? testDigest
              : rawDigest(
                  `activation-anchor:consume:${String(approvalReceipt.setupSessionRevision)}`,
                ),
          approvalNonceDigest: approvalReceipt?.approvalNonceDigest ?? testDigest,
          approvalAuthorityDigest: approvalReceipt?.authorityDigest ?? testDigest,
          approvalSource: approvalReceipt?.issuer ?? ("local_ui" as const),
          approvalSetupRevision: approvalReceipt?.setupSessionRevision ?? 1,
          mergeIntent: merge.mergeIntent,
          mergeReceipt: merge.mergeReceipt,
          mergedConfigReceipt: {
            schemaVersion: 1 as const,
            source: "source_control_default_branch" as const,
            projectId: project.id,
            repository: project.sourceControl.repository,
            changeRequestId: "42", // O009c fix: decimal PR number, not the opaque node id.
            setupHeadSha: headSha,
            mergeCommitSha: mergedSha,
            defaultBranch: project.defaultBranch,
            authoritativeRevision: mergedSha,
            path: ".agent-team/project.json" as const,
            configDigest: serializedConfig.contentDigest,
            config,
          },
          activatedRevisionSha: mergedSha,
        }
      : {}),
  };
}

async function createConsumedApproval(
  root: string,
  revision = 1,
): Promise<
  import("../../src/application/registration/index.js").RegistrationSetupFinalApprovalReceipt
> {
  const authority = new FileRegistrationSetupFinalApprovalAuthority(root);
  const issued = await authority.issue(binding(revision), localApprovalAuthority, {
    idempotencyKey: `activation-anchor:issue:${String(revision)}`,
  });
  if (!issued.ok || issued.value.state !== "issued") throw new Error("approval_issue_failed");
  const consumed = await authority.verifyAndConsume(
    {
      approvalId: issued.value.grant.approvalId,
      userConfirmed: true,
      expectedSetupRevision: revision,
    },
    binding(revision),
    localApprovalAuthority,
    { idempotencyKey: `activation-anchor:consume:${String(revision)}` },
  );
  if (!consumed.ok || consumed.value.state !== "verified_and_consumed") {
    throw new Error("approval_consume_failed");
  }
  return consumed.value.receipt;
}

async function createActivatedFixture(root: string) {
  const approvalReceipt = await createConsumedApproval(root);
  const sessions = new FileRegistrationSetupSessionStore(root);
  const initial = await withExecution(root, (lease) =>
    sessions.save(undefined, sessionDraft(), {
      idempotencyKey: "tamper:create",
      executionFence: lease.fence,
    }),
  );
  if (!initial.ok) throw new Error(initial.error.code);
  const activated = await withExecution(root, (lease) =>
    sessions.activate(
      initial.value.session.revision,
      sessionDraft("activated", approvalReceipt),
      mergedSha,
      {
        idempotencyKey: "tamper:activate",
        executionFence: lease.fence,
      },
    ),
  );
  if (!activated.ok) throw new Error(activated.error.code);
  const registry = new FileRegistrationSetupActivationRegistry(root);
  const published = await registry.publish(activated.value.marker, {
    idempotencyKey: "tamper:publish",
  });
  if (!published.ok) throw new Error(published.error.code);
  return { sessions, activated, registry };
}

interface MutableActivationRecord {
  marker: Record<string, unknown>;
  session: {
    approvalConsumeOperationDigest: string;
    approvalNonceDigest: string;
    mergedConfigReceipt: {
      projectId: string;
      repository: string;
      path: string;
      config: { projectRules: string[] };
    };
  };
}

async function tamperActivationRecord(
  sessions: FileRegistrationSetupSessionStore,
  mutate: (record: MutableActivationRecord) => void,
) {
  const path = sessions.paths(preview.setupSessionId).activation;
  const record = JSON.parse(await readFile(path, "utf8")) as MutableActivationRecord;
  mutate(record);
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

async function expectLoaderActivationUnavailable(
  registry: FileRegistrationSetupActivationRegistry,
) {
  const loader = new TrustedProjectConfigLoader(
    {
      readTextFileAtRevision: (command) =>
        Promise.resolve(
          ok({
            revisionSha: mergedSha,
            path: command.path,
            content: serializedConfig.content,
            byteLength: Buffer.byteLength(serializedConfig.content, "utf8"),
          }),
        ),
    },
    registry,
  );
  await expect(loader.load(project)).resolves.toMatchObject({
    state: "rejected",
    reason: "activation_unavailable",
  });
}

function binding(revision = 2): RegistrationSetupApprovalBinding {
  return {
    schemaVersion: 1,
    setupSessionId: preview.setupSessionId,
    setupSessionRevision: revision,
    projectId: project.id,
    previewDigest: preview.previewDigest,
    changeRequestId: "42", // O009c fix: decimal PR number, not the opaque node id.
    headSha,
    requirementsDigest: preview.requirementsDigest,
    diffDigest: testDigest,
    linearAuditIssueId: preview.linearAuditIssueId,
    gateEvidenceDigest: gateEvidenceReceipt.evidenceDigest,
  };
}

describe("file-backed registration setup state", () => {
  it("assigns journal revisions under lock, enforces CAS, and keeps private permissions", async () => {
    const root = await temporaryRoot();
    const store = new FileRegistrationSetupJournalStore(root);
    const planned = await withExecution(root, (lease) =>
      store.save(undefined, plannedJournal(), {
        idempotencyKey: "journal:plan",
        executionFence: lease.fence,
      }),
    );
    expect(planned).toMatchObject({
      ok: true,
      value: { durability: "confirmed", journal: { revision: 1 } },
    });
    if (!planned.ok) throw new Error(planned.error.code);

    const intent = {
      ...plannedJournal(),
      pending: { step: "worktree" as const, idempotencyKey: "setup:worktree" },
    };
    const advanced = await withExecution(root, (lease) =>
      store.save(planned.value.journal.revision, intent, {
        idempotencyKey: "journal:intent:worktree",
        executionFence: lease.fence,
      }),
    );
    expect(advanced).toMatchObject({ ok: true, value: { journal: { revision: 2 } } });
    await expect(
      withExecution(root, (lease) =>
        store.save(planned.value.journal.revision, plannedJournal(), {
          idempotencyKey: "stale",
          executionFence: lease.fence,
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: "conflict" } });
    await expect(
      withExecution(root, (lease) =>
        store.save(
          undefined,
          { ...plannedJournal(), revision: 99 } as unknown as RegistrationSetupJournalDraft,
          { idempotencyKey: "caller-revision", executionFence: lease.fence },
        ),
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: "invariant_violation" } });

    const paths = store.paths(preview.setupSessionId);
    expect((await stat(paths.journal)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.root)).mode & 0o777).toBe(0o700);
  });

  it("fails closed for a held lock, malformed authoritative JSON, and unsafe permissions", async () => {
    const root = await temporaryRoot();
    const store = new FileRegistrationSetupJournalStore(root);
    const paths = store.paths(preview.setupSessionId);
    await mkdir(paths.root, { recursive: true, mode: 0o700 });
    await writeFile(paths.lock, "held", { mode: 0o600 });
    await expect(
      store.save(undefined, plannedJournal(), {
        idempotencyKey: "locked",
        executionFence: unavailableFence,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "external_failure" } });

    await rm(paths.lock);
    await writeFile(paths.journal, "{", { mode: 0o600 });
    await expect(store.load(preview.setupSessionId)).resolves.toMatchObject({
      ok: false,
      error: { code: "invariant_violation" },
    });
    await writeFile(paths.journal, JSON.stringify({ schemaVersion: 99 }), { mode: 0o600 });
    await chmod(paths.journal, 0o644);
    await expect(store.load(preview.setupSessionId)).resolves.toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });
  });

  it("ignores an orphan partial file and reads only the schema-valid authoritative journal", async () => {
    const root = await temporaryRoot();
    const store = new FileRegistrationSetupJournalStore(root);
    const saved = await withExecution(root, (lease) =>
      store.save(undefined, plannedJournal(), {
        idempotencyKey: "journal:partial",
        executionFence: lease.fence,
      }),
    );
    if (!saved.ok) throw new Error(saved.error.code);
    const paths = store.paths(preview.setupSessionId);
    await writeFile(join(paths.root, ".journal.json.crash.tmp"), "{", { mode: 0o600 });
    await expect(store.load(preview.setupSessionId)).resolves.toEqual({
      ok: true,
      value: saved.value.journal,
    });
  });

  it("recovers activation from one atomic record containing the session and revision marker", async () => {
    const root = await temporaryRoot();
    const store = new FileRegistrationSetupSessionStore(root);
    const initial = await withExecution(root, (lease) =>
      store.save(undefined, sessionDraft(), {
        idempotencyKey: "session:create",
        executionFence: lease.fence,
      }),
    );
    if (!initial.ok) throw new Error(initial.error.code);
    const activated = await withExecution(root, (lease) =>
      store.activate(initial.value.session.revision, sessionDraft("activated"), mergedSha, {
        idempotencyKey: "session:activate",
        executionFence: lease.fence,
      }),
    );
    expect(activated).toMatchObject({
      ok: true,
      value: {
        durability: "confirmed",
        session: { phase: "activated", revision: 2 },
        marker: { authoritativeRevision: mergedSha },
      },
    });
    expect((await stat(store.paths(preview.setupSessionId).session)).mode & 0o777).toBe(0o600);
    await rm(store.paths(preview.setupSessionId).session);
    await expect(store.load(preview.setupSessionId)).resolves.toMatchObject({
      ok: true,
      value: { phase: "activated", activatedRevisionSha: mergedSha },
    });
    expect((await stat(store.paths(preview.setupSessionId).activation)).mode & 0o777).toBe(0o600);
  });

  it("publishes a digest-keyed project activation index with idempotent CAS", async () => {
    const root = await temporaryRoot();
    const approvalReceipt = await createConsumedApproval(root);
    const sessions = new FileRegistrationSetupSessionStore(root);
    const initial = await withExecution(root, (lease) =>
      sessions.save(undefined, sessionDraft(), {
        idempotencyKey: "activation-index:create",
        executionFence: lease.fence,
      }),
    );
    if (!initial.ok) throw new Error(initial.error.code);
    const activated = await withExecution(root, (lease) =>
      sessions.activate(
        initial.value.session.revision,
        sessionDraft("activated", approvalReceipt),
        mergedSha,
        {
          idempotencyKey: "activation-index:marker",
          executionFence: lease.fence,
        },
      ),
    );
    if (!activated.ok) throw new Error(activated.error.code);
    const registry = new FileRegistrationSetupActivationRegistry(root);
    await expect(
      registry.publish(activated.value.marker, { idempotencyKey: "activation-index:publish" }),
    ).resolves.toMatchObject({ ok: true, value: { state: "confirmed" } });
    await expect(
      registry.publish(activated.value.marker, { idempotencyKey: "activation-index:retry" }),
    ).resolves.toMatchObject({ ok: true, value: { state: "reused" } });
    await expect(registry.read(project.id)).resolves.toEqual({
      ok: true,
      value: activated.value.marker,
    });
    await expect(
      registry.publish(
        { ...activated.value.marker, configDigest: testDigest },
        { idempotencyKey: "activation-index:conflict" },
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: "conflict" } });
    const keys = await readdir(join(root, "registration-setup-activation"));
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/u);
    expect(keys[0]).not.toContain(project.id);
    await rm(sessions.paths(preview.setupSessionId).activation);
    await expect(registry.read(project.id)).resolves.toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
  });

  it("C026(C): rejects publish with an expectedPriorMarkerDigest when no index exists yet", async () => {
    const root = await temporaryRoot();
    const approvalReceipt = await createConsumedApproval(root);
    const sessions = new FileRegistrationSetupSessionStore(root);
    const initial = await withExecution(root, (lease) =>
      sessions.save(undefined, sessionDraft(), {
        idempotencyKey: "activation-index:cas-no-index:create",
        executionFence: lease.fence,
      }),
    );
    if (!initial.ok) throw new Error(initial.error.code);
    const activated = await withExecution(root, (lease) =>
      sessions.activate(
        initial.value.session.revision,
        sessionDraft("activated", approvalReceipt),
        mergedSha,
        {
          idempotencyKey: "activation-index:cas-no-index:marker",
          executionFence: lease.fence,
        },
      ),
    );
    if (!activated.ok) throw new Error(activated.error.code);
    const registry = new FileRegistrationSetupActivationRegistry(root);
    // Nothing has ever been published for this project -- expecting a prior digest that doesn't
    // exist must be a conflict (the caller believed there was already an index; there is none: a
    // deletion/rollback happened, or the caller is simply wrong), never silently treated as a
    // first write.
    await expect(
      registry.publish(activated.value.marker, {
        idempotencyKey: "activation-index:cas-no-index:publish",
        expectedPriorMarkerDigest: "f".repeat(64),
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "conflict" } });
    await expect(registry.read(project.id)).resolves.toEqual({ ok: true, value: undefined });
  });

  it("C026(C): CAS-replaces the published marker for a re-approval, and rejects a stale expectedPriorMarkerDigest", async () => {
    const root = await temporaryRoot();
    const first = await createActivatedFixture(root);
    const firstDigest = registrationSetupActivationMarkerDigest(first.activated.value.marker);
    if (!firstDigest.ok) throw new Error(firstDigest.error.code);

    // Build a second, independently activated session for the *same* project -- the re-approval
    // scenario C026(B) makes possible (its own session-scoped setup branch) and this CAS replace
    // is meant to accept. Session-store verification (`sessions.load`/`readActivation`) is real;
    // only the approval ledger is faked here, to bind a second receipt without re-running the real
    // issue/consume ledger dance a second time (already covered by the other O005/F-2 tests).
    const secondSetupSessionId = "setup-session-1-reapproval";
    const secondApprovalId = "approval-grant-reapproval";
    const secondRevision = 2;
    const secondApprovalReferenceDigest = approvalReferenceFor(secondApprovalId);
    const secondConsumeOperationDigest = rawDigest("cas-reapproval:consume-operation");
    const secondNonceDigest = rawDigest("cas-reapproval:nonce");
    const secondBranch = registrationSetupBranchFor(secondSetupSessionId);
    // Mirrors `testMergeState()` above, but keyed to `secondSetupSessionId` -- production's
    // `createMergeIntent()` derives `idempotencyKey` from the *owning* session's own id, so reusing
    // the session-1-scoped helper here would silently produce a mismatched merge intent/receipt.
    const secondMergeIdempotencyKey = `setup-merge:${secondSetupSessionId}:${secondApprovalReferenceDigest.slice(0, 16)}`;
    const secondMergeIntentBinding = Object.freeze({
      schemaVersion: 1 as const,
      projectId: project.id,
      repository: project.sourceControl.repository,
      changeRequestId: "42",
      expectedHeadSha: headSha,
      mergeMethod: "SQUASH" as const,
      idempotencyKey: secondMergeIdempotencyKey,
    });
    const secondMergeIntent = Object.freeze({
      ...secondMergeIntentBinding,
      mergeIntentDigest: mustDigest({
        kind: "registration_setup_merge_intent",
        ...secondMergeIntentBinding,
      }),
    });
    const { idempotencyKey: _secondMergeIdempotencyKey, ...secondMergeReceiptBinding } =
      secondMergeIntent;
    void _secondMergeIdempotencyKey;
    const secondMerge = {
      mergeIntent: secondMergeIntent,
      mergeReceipt: Object.freeze({
        ...secondMergeReceiptBinding,
        state: "merged" as const,
        idempotencyKeyDigest: mustDigest(secondMergeIdempotencyKey),
      }),
    };
    const secondChangeRequest = {
      id: "PR_node_1",
      number: 42,
      url: "https://github.test/owner/sandbox/pull/42",
      state: "merged" as const,
      draft: false,
      baseBranch: "main",
      headBranch: secondBranch,
      headSha,
      mergeability: "mergeable" as const,
      autoMergeEnabled: true,
      updatedAt,
    };
    const secondWorktree = {
      repositoryRoot: project.localRepositoryPath,
      path: `${preview.worktreePath}-reapproval`,
      branch: secondBranch,
      headSha: baseSha,
    };
    const ciWaitingDraft: RegistrationSetupSessionDraft = {
      schemaVersion: 1,
      phase: "ci_waiting",
      setupSessionId: secondSetupSessionId,
      project,
      config,
      baseRevision: baseSha,
      worktree: secondWorktree,
      remote: "origin",
      previewDigest: preview.previewDigest,
      requirementsDigest: preview.requirementsDigest,
      diffDigest: testDigest,
      configDigest: serializedConfig.contentDigest,
      headSha,
      changeRequest: { ...secondChangeRequest, state: "open", draft: true },
      linearAuditIssueId: preview.linearAuditIssueId,
      evidence: [],
    };
    const secondEvidenceBinding = {
      projectId: project.id,
      setupSessionId: secondSetupSessionId,
      previewDigest: preview.previewDigest,
      requirementsDigest: preview.requirementsDigest,
      headSha,
      diffDigest: testDigest,
      changeRequestId: "42",
    };
    // Mirrors `auditIntent()`'s body/idempotencyKey construction in setup.ts, keyed to
    // `secondSetupSessionId` -- `auditReceiptMatches()` recomputes both digests from the session's
    // own fields, so this must match byte-for-byte or activation fails closed.
    const secondAuditBody = [
      "Agent Team registration Setup PR is waiting for explicit user approval.",
      `project=${project.id}`,
      `setup_session=${secondSetupSessionId}`,
      `preview_digest=${preview.previewDigest}`,
      `change_request=${secondChangeRequest.id}`,
      `head_sha=${headSha}`,
      `requirements_digest=${preview.requirementsDigest}`,
      `diff_digest=${testDigest}`,
      `linear_audit_issue=${preview.linearAuditIssueId}`,
      `gate_evidence_digest=${gateEvidenceReceipt.evidenceDigest}`,
      `review_evidence=${gateEvidenceReceipt.reviewEvidenceUrl}`,
      "merge=squash",
      "authority=local UI or trusted current-user conversation only",
    ].join("\n");
    function secondAuditIdempotencyKey(destination: "linear" | "pull_request") {
      return `setup-audit:${secondSetupSessionId}:${gateEvidenceReceipt.evidenceDigest.slice(0, 16)}:${destination}`;
    }
    const secondAuditReceiptBinding = {
      setupSessionId: secondSetupSessionId,
      projectId: project.id,
      repository: project.sourceControl.repository,
      linearAuditIssueId: preview.linearAuditIssueId,
      changeRequestId: "42",
      headSha,
      requirementsDigest: preview.requirementsDigest,
      diffDigest: testDigest,
      evidenceDigest: gateEvidenceReceipt.evidenceDigest,
      bodyDigest: mustDigest(secondAuditBody),
      createdAt: updatedAt,
      reused: false as const,
    };
    const activatedDraft: RegistrationSetupSessionDraft = {
      ...ciWaitingDraft,
      phase: "activated",
      changeRequest: secondChangeRequest,
      gateEvidenceReceipt,
      audit: {
        linearReceipt: {
          schemaVersion: 1,
          destination: "linear",
          externalCommentId: "linear-comment-reapproval",
          idempotencyKeyDigest: mustDigest(secondAuditIdempotencyKey("linear")),
          ...secondAuditReceiptBinding,
        },
        pullRequestReceipt: {
          schemaVersion: 1,
          destination: "pull_request",
          externalCommentId: "pull_request-comment-reapproval",
          idempotencyKeyDigest: mustDigest(secondAuditIdempotencyKey("pull_request")),
          ...secondAuditReceiptBinding,
        },
      },
      evidence: [
        { code: "setup_user_approval_consumed", ...secondEvidenceBinding },
        { code: "setup_merge_verified", ...secondEvidenceBinding },
        { code: "trusted_config_activated", ...secondEvidenceBinding },
      ],
      approvalReferenceDigest: secondApprovalReferenceDigest,
      approvalConsumeOperationDigest: secondConsumeOperationDigest,
      approvalNonceDigest: secondNonceDigest,
      approvalAuthorityDigest: authorityDigest,
      approvalSource: "local_ui",
      approvalSetupRevision: secondRevision,
      mergeIntent: secondMerge.mergeIntent,
      mergeReceipt: secondMerge.mergeReceipt,
      mergedConfigReceipt: {
        schemaVersion: 1,
        source: "source_control_default_branch",
        projectId: project.id,
        repository: project.sourceControl.repository,
        changeRequestId: "42",
        setupHeadSha: headSha,
        mergeCommitSha: mergedSha,
        defaultBranch: project.defaultBranch,
        authoritativeRevision: mergedSha,
        path: ".agent-team/project.json",
        configDigest: serializedConfig.contentDigest,
        config,
      },
      activatedRevisionSha: mergedSha,
    };
    const secondSessions = new FileRegistrationSetupSessionStore(root);
    const secondInitial = await withExecutionFor(root, secondSetupSessionId, (lease) =>
      secondSessions.save(undefined, ciWaitingDraft, {
        idempotencyKey: "activation-index:cas-second:create",
        executionFence: lease.fence,
      }),
    );
    if (!secondInitial.ok) throw new Error(secondInitial.error.code);
    const secondActivated = await withExecutionFor(root, secondSetupSessionId, (lease) =>
      secondSessions.activate(secondInitial.value.session.revision, activatedDraft, mergedSha, {
        idempotencyKey: "activation-index:cas-second:marker",
        executionFence: lease.fence,
      }),
    );
    if (!secondActivated.ok) throw new Error(secondActivated.error.code);
    const secondMarker = secondActivated.value.marker;
    const secondAnchor = {
      receipt: {
        schemaVersion: 1 as const,
        setupSessionId: secondSetupSessionId,
        setupSessionRevision: secondRevision,
        projectId: project.id,
        previewDigest: preview.previewDigest,
        changeRequestId: "42",
        headSha,
        requirementsDigest: preview.requirementsDigest,
        diffDigest: testDigest,
        linearAuditIssueId: preview.linearAuditIssueId,
        gateEvidenceDigest: gateEvidenceReceipt.evidenceDigest,
        approvalId: secondApprovalId,
        issuer: "local_ui" as const,
        authorityDigest,
        approvalNonceDigest: secondNonceDigest,
        consumedAt: updatedAt,
      },
      consumeOperationDigest: secondConsumeOperationDigest,
    };
    // Only session 2's anchor is faked; anything else (e.g. re-verifying session 1's already
    // real-ledger-issued marker, which `read()`/`publish()` also re-verify) falls through to the
    // real ledger this same `root` already holds from `createActivatedFixture()` above.
    const realLedger = new FileRegistrationSetupFinalApprovalAuthority(root);
    const registryForSecond = new FileRegistrationSetupActivationRegistry(
      root,
      new AtomicFileStore(),
      secondSessions,
      {
        readConsumed: (approvalReferenceDigest, options) =>
          approvalReferenceDigest === secondApprovalReferenceDigest
            ? Promise.resolve(ok(secondAnchor))
            : realLedger.readConsumed(approvalReferenceDigest, options),
      },
    );

    // Stale/wrong expectedPriorMarkerDigest: reject, and the index must be untouched.
    await expect(
      registryForSecond.publish(secondMarker, {
        idempotencyKey: "activation-index:cas-second:stale",
        expectedPriorMarkerDigest: mustDigest("not-the-real-prior-digest"),
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "conflict" } });
    await expect(registryForSecond.read(project.id)).resolves.toEqual({
      ok: true,
      value: first.activated.value.marker,
    });

    // Correct expectedPriorMarkerDigest (the first marker's own digest, read immediately before
    // this call, exactly as the real caller in setup.ts does): CAS replace succeeds.
    await expect(
      registryForSecond.publish(secondMarker, {
        idempotencyKey: "activation-index:cas-second:replace",
        expectedPriorMarkerDigest: firstDigest.value,
      }),
    ).resolves.toMatchObject({ ok: true, value: { state: "replaced", marker: secondMarker } });
    await expect(registryForSecond.read(project.id)).resolves.toEqual({
      ok: true,
      value: secondMarker,
    });

    // Idempotent retry of the same replace (e.g. resumed after an unknown-durability response):
    // reused, not another replace, and not a conflict.
    await expect(
      registryForSecond.publish(secondMarker, {
        idempotencyKey: "activation-index:cas-second:retry",
        expectedPriorMarkerDigest: firstDigest.value,
      }),
    ).resolves.toMatchObject({ ok: true, value: { state: "reused", marker: secondMarker } });
  });

  it.each(["authorityDigest", "approvalNonceDigest"] as const)(
    "rejects a valid-format activation marker %s substitution across registry and loader",
    async (field) => {
      const root = await temporaryRoot();
      const { sessions, registry } = await createActivatedFixture(root);
      await tamperActivationRecord(sessions, (record) => {
        record.marker[field] = mustDigest(`tampered-${field}`);
      });
      await expect(sessions.load(preview.setupSessionId)).resolves.toMatchObject({ ok: false });
      await expect(registry.read(project.id)).resolves.toMatchObject({ ok: false });
      await expectLoaderActivationUnavailable(registry);
    },
  );

  it("rejects another valid consume operation digest from the independent ledger across registry and loader", async () => {
    const root = await temporaryRoot();
    const { sessions, registry } = await createActivatedFixture(root);
    const ledgerPath = join(root, "registration-setup", "approval-authority", "ledger.json");
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as {
      grants: Record<string, unknown>[];
    };
    const consumed = ledger.grants.find((grant) => grant["state"] === "consumed");
    if (consumed === undefined) throw new Error("consumed approval missing");
    consumed["consumeOperationDigest"] = rawDigest("another-legal-consume-operation");
    await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });

    await expect(sessions.load(preview.setupSessionId)).resolves.toMatchObject({ ok: true });
    await expect(registry.read(project.id)).resolves.toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    await expectLoaderActivationUnavailable(registry);
  });

  it("rejects synchronized valid nonce substitution across session, marker, and project index", async () => {
    const root = await temporaryRoot();
    const { sessions, registry } = await createActivatedFixture(root);
    const substitutedNonce = mustDigest("synchronized-nonce-substitution");
    await tamperActivationRecord(sessions, (record) => {
      record.session.approvalNonceDigest = substitutedNonce;
      record.marker["approvalNonceDigest"] = substitutedNonce;
    });
    const projectKey = mustDigest({
      kind: "registration_setup_activation_project",
      projectId: project.id,
    });
    const indexPath = join(root, "registration-setup-activation", projectKey, "index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8")) as {
      marker: Record<string, unknown>;
      markerDigest: string;
    };
    index.marker["approvalNonceDigest"] = substitutedNonce;
    index.markerDigest = mustDigest({
      kind: "registration_setup_activation_marker",
      marker: index.marker,
    });
    await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });

    await expect(sessions.load(preview.setupSessionId)).resolves.toMatchObject({ ok: true });
    await expect(registry.read(project.id)).resolves.toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    await expectLoaderActivationUnavailable(registry);
  });

  it("rejects synchronized consume operation substitution across session, marker, and project index", async () => {
    const root = await temporaryRoot();
    const { sessions, registry } = await createActivatedFixture(root);
    const substitutedOperation = rawDigest("synchronized-consume-operation-substitution");
    await tamperActivationRecord(sessions, (record) => {
      record.session.approvalConsumeOperationDigest = substitutedOperation;
      record.marker["approvalConsumeOperationDigest"] = substitutedOperation;
    });
    const projectKey = mustDigest({
      kind: "registration_setup_activation_project",
      projectId: project.id,
    });
    const indexPath = join(root, "registration-setup-activation", projectKey, "index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8")) as {
      marker: Record<string, unknown>;
      markerDigest: string;
    };
    index.marker["approvalConsumeOperationDigest"] = substitutedOperation;
    index.markerDigest = mustDigest({
      kind: "registration_setup_activation_marker",
      marker: index.marker,
    });
    await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });

    await expect(sessions.load(preview.setupSessionId)).resolves.toMatchObject({ ok: true });
    await expect(registry.read(project.id)).resolves.toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    await expectLoaderActivationUnavailable(registry);
  });

  it.each(["project", "repository", "path", "config"] as const)(
    "rejects an activated W2 receipt with exact-binding %s tampering",
    async (field) => {
      const root = await temporaryRoot();
      const { sessions, registry } = await createActivatedFixture(root);
      await tamperActivationRecord(sessions, (record) => {
        const receipt = record.session.mergedConfigReceipt;
        if (field === "project") receipt.projectId = "project_other";
        if (field === "repository") receipt.repository = "other/repository";
        if (field === "path") receipt.path = ".agent-team/other.json";
        if (field === "config") receipt.config.projectRules = ["Tampered rule."];
      });
      await expect(sessions.readActivation(preview.setupSessionId)).resolves.toMatchObject({
        ok: false,
      });
      await expect(registry.read(project.id)).resolves.toMatchObject({ ok: false });
      await expectLoaderActivationUnavailable(registry);
    },
  );

  it.each(["state-root", "registration-parent", "session-child"] as const)(
    "rejects a %s symlink without following it",
    async (attack) => {
      const container = await temporaryRoot();
      const actual = join(container, "actual");
      const stateRoot = join(container, "state");
      await mkdir(actual, { mode: 0o700 });
      if (attack === "state-root") {
        await symlink(actual, stateRoot, "dir");
      } else {
        await mkdir(stateRoot, { mode: 0o700 });
        if (attack === "registration-parent") {
          await symlink(actual, join(stateRoot, "registration-setup"), "dir");
        } else {
          const registrationRoot = join(stateRoot, "registration-setup");
          await mkdir(registrationRoot, { mode: 0o700 });
          await symlink(actual, join(registrationRoot, preview.setupSessionId), "dir");
        }
      }

      const store = new FileRegistrationSetupJournalStore(stateRoot);
      await expect(
        store.save(undefined, plannedJournal(), {
          idempotencyKey: `symlink:${attack}`,
          executionFence: unavailableFence,
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: "permission_denied" } });
      await expect(readFile(join(actual, "journal.json"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("rejects unsafe private directory permissions", async () => {
    const root = await temporaryRoot();
    await chmod(root, 0o755);
    const store = new FileRegistrationSetupJournalStore(root);
    await expect(
      store.save(undefined, plannedJournal(), {
        idempotencyKey: "unsafe-root-mode",
        executionFence: unavailableFence,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "permission_denied" } });
  });

  it("holds the execution lease across coordinators and anchors it through a directory swap", async () => {
    const root = await temporaryRoot();
    const firstStore = new FileRegistrationSetupExecutionStore(root);
    const secondStore = new FileRegistrationSetupExecutionStore(root);
    let release = (): void => undefined;
    let announce = (): void => undefined;
    const reached = new Promise<void>((resolveReached) => {
      announce = resolveReached;
    });
    const barrier = new Promise<void>((resolveBarrier) => {
      release = resolveBarrier;
    });
    let effects = 0;
    const first = firstStore.runExclusive(preview.setupSessionId, async () => {
      effects += 1;
      announce();
      await barrier;
      return "done";
    });
    await reached;
    await expect(
      secondStore.runExclusive(preview.setupSessionId, () => {
        effects += 1;
        return Promise.resolve("duplicate");
      }),
    ).resolves.toEqual({ ok: true, value: { state: "in_progress" } });
    expect(effects).toBe(1);
    release();
    await expect(first).resolves.toEqual({
      ok: true,
      value: { state: "completed", value: "done" },
    });

    const paths = new FileRegistrationSetupJournalStore(root).paths(preview.setupSessionId);
    const moved = `${paths.root}.moved`;
    const swapped = firstStore.runExclusive(preview.setupSessionId, async () => {
      await rename(paths.root, moved);
      await mkdir(paths.root, { mode: 0o700 });
      expect((await stat(join(moved, "execution.lock"))).mode & 0o777).toBe(0o600);
      await expect(stat(join(paths.root, "execution.lock"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      return "anchored";
    });
    await expect(swapped).resolves.toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect((await stat(join(moved, "execution.lock"))).mode & 0o777).toBe(0o600);
    await expect(stat(join(paths.root, "execution.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("takes over only after fd close and advances the store-owned execution epoch", async () => {
    const root = await temporaryRoot();
    const firstStore = new FileRegistrationSetupExecutionStore(root);
    const secondStore = new FileRegistrationSetupExecutionStore(root);
    const first = await firstStore.runExclusive(preview.setupSessionId, (lease) =>
      Promise.resolve(lease.fence),
    );
    if (!first.ok || first.value.state !== "completed") throw new Error("first owner failed");
    const second = await secondStore.runExclusive(preview.setupSessionId, (lease) =>
      Promise.resolve(lease.fence),
    );
    expect(second).toMatchObject({
      ok: true,
      value: { state: "completed", value: { epoch: first.value.value.epoch + 1 } },
    });
    if (!second.ok || second.value.state !== "completed") throw new Error("second owner failed");
    expect(second.value.value.lockIdentity).toEqual(first.value.value.lockIdentity);
    expect(second.value.value.ownerDigest).not.toBe(first.value.value.ownerDigest);
    const paths = new FileRegistrationSetupJournalStore(root).paths(preview.setupSessionId);
    expect((await stat(paths.executionLock)).mode & 0o777).toBe(0o600);
  });

  it.each(["malformed", "mismatch"] as const)(
    "rejects an execution manifest with a %s lock ownerDigest",
    async (attack) => {
      const root = await temporaryRoot();
      const executionStore = new FileRegistrationSetupExecutionStore(root);
      const first = await executionStore.runExclusive(preview.setupSessionId, (lease) =>
        Promise.resolve(lease.fence),
      );
      if (!first.ok || first.value.state !== "completed") throw new Error("first owner failed");
      const paths = new FileRegistrationSetupJournalStore(root).paths(preview.setupSessionId);
      const manifest = JSON.parse(await readFile(paths.execution, "utf8")) as Record<
        string,
        unknown
      >;
      const identity = manifest["lockIdentity"] as Record<string, unknown>;
      await writeFile(
        paths.execution,
        `${JSON.stringify(
          {
            ...manifest,
            lockIdentity: {
              ...identity,
              ownerDigest:
                attack === "malformed"
                  ? "not-a-digest"
                  : identity["ownerDigest"] === "f".repeat(64)
                    ? "e".repeat(64)
                    : "f".repeat(64),
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await expect(
        executionStore.runExclusive(preview.setupSessionId, () => Promise.resolve("unexpected")),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: attack === "malformed" ? "invariant_violation" : "conflict" },
      });
    },
  );

  it("rejects every stale-owner journal CAS after a newer execution epoch takes ownership", async () => {
    const root = await temporaryRoot();
    const firstStore = new FileRegistrationSetupExecutionStore(root);
    const secondStore = new FileRegistrationSetupExecutionStore(root);
    const journal = new FileRegistrationSetupJournalStore(root);
    const first = await firstStore.runExclusive(preview.setupSessionId, (lease) =>
      Promise.resolve(lease.fence),
    );
    if (!first.ok || first.value.state !== "completed") throw new Error("first owner failed");

    let announce = (): void => undefined;
    let release = (): void => undefined;
    const reached = new Promise<void>((resolveReached) => {
      announce = resolveReached;
    });
    const barrier = new Promise<void>((resolveBarrier) => {
      release = resolveBarrier;
    });
    const second = secondStore.runExclusive(preview.setupSessionId, async () => {
      announce();
      await barrier;
      return "new-owner-complete";
    });
    await reached;

    await expect(
      journal.save(undefined, plannedJournal(), {
        idempotencyKey: "journal:stale-owner",
        executionFence: first.value.value,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "conflict" } });
    await expect(journal.load(preview.setupSessionId)).resolves.toEqual({
      ok: true,
      value: undefined,
    });

    release();
    await expect(second).resolves.toEqual({
      ok: true,
      value: { state: "completed", value: "new-owner-complete" },
    });
  });

  it.each(["writer_lock", "session_directory"] as const)(
    "does not publish when the %s is swapped immediately before rename",
    async (attack) => {
      const root = await temporaryRoot();
      const paths = new FileRegistrationSetupJournalStore(root).paths(preview.setupSessionId);
      const movedRoot = `${paths.root}.moved`;
      const displacedLock = `${paths.lock}.displaced`;
      const attackedStore = new HookedAtomicFileStore({
        beforeCommit: async () => {
          if (attack === "writer_lock") {
            await rename(paths.lock, displacedLock);
          } else {
            await rename(paths.root, movedRoot);
            await mkdir(paths.root, { mode: 0o700 });
          }
        },
      });
      const journal = new FileRegistrationSetupJournalStore(root, attackedStore);
      const execution = await new FileRegistrationSetupExecutionStore(root).runExclusive(
        preview.setupSessionId,
        (lease) =>
          journal.save(undefined, plannedJournal(), {
            idempotencyKey: `journal:pre-rename-${attack}`,
            executionFence: lease.fence,
          }),
      );

      if (attack === "writer_lock") {
        expect(execution).toMatchObject({
          ok: true,
          value: { state: "completed", value: { ok: false, error: { code: "conflict" } } },
        });
        await expect(readFile(paths.journal, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(execution).toMatchObject({ ok: false, error: { code: "conflict" } });
        await expect(readFile(join(movedRoot, "journal.json"), "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(readFile(paths.journal, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it.each(["writer_lock", "session_directory"] as const)(
    "blocks a %s swap at the synchronous publicationGuard-to-rename boundary",
    async (attack) => {
      const root = await temporaryRoot();
      const paths = new FileRegistrationSetupJournalStore(root).paths(preview.setupSessionId);
      const movedRoot = `${paths.root}.publication-moved`;
      const displacedLock = `${paths.lock}.publication-displaced`;
      const attackedStore = new HookedAtomicFileStore({
        beforePublication: () => {
          if (attack === "writer_lock") {
            renameSync(paths.lock, displacedLock);
          } else {
            renameSync(paths.root, movedRoot);
            mkdirSync(paths.root, { mode: 0o700 });
          }
        },
      });
      const journal = new FileRegistrationSetupJournalStore(root, attackedStore);
      const execution = await new FileRegistrationSetupExecutionStore(root).runExclusive(
        preview.setupSessionId,
        (lease) =>
          journal.save(undefined, plannedJournal(), {
            idempotencyKey: `journal:publication-${attack}`,
            executionFence: lease.fence,
          }),
      );

      expect(execution).toMatchObject(
        attack === "writer_lock"
          ? {
              ok: true,
              value: { state: "completed", value: { ok: false, error: { code: "conflict" } } },
            }
          : { ok: false, error: { code: "conflict" } },
      );
      const authoritativeRoot = attack === "session_directory" ? movedRoot : paths.root;
      await expect(readFile(join(authoritativeRoot, "journal.json"), "utf8")).rejects.toMatchObject(
        { code: "ENOENT" },
      );
      await expect(readFile(paths.journal, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("detects a transient lock-record replacement even when the original bytes are restored", async () => {
    const root = await temporaryRoot();
    const paths = new FileRegistrationSetupJournalStore(root).paths(preview.setupSessionId);
    const attackedStore = new HookedAtomicFileStore({
      beforePublication: () => {
        const original = readFileSync(paths.lock);
        const record = JSON.parse(original.toString("utf8")) as Record<string, unknown>;
        writeFileSync(
          paths.lock,
          `${JSON.stringify({ ...record, ownerDigest: "f".repeat(64) })}\n`,
        );
        writeFileSync(paths.lock, original);
      },
    });
    const journal = new FileRegistrationSetupJournalStore(root, attackedStore);

    const execution = await new FileRegistrationSetupExecutionStore(root).runExclusive(
      preview.setupSessionId,
      (lease) =>
        journal.save(undefined, plannedJournal(), {
          idempotencyKey: "journal:publication-transient-restore",
          executionFence: lease.fence,
        }),
    );

    expect(execution).toMatchObject({
      ok: true,
      value: { state: "completed", value: { ok: false, error: { code: "conflict" } } },
    });
    await expect(readFile(paths.journal, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["writer_lock", "execution_lock"] as const)(
    "reports unknown durability when %s ownership is lost after rename",
    async (attack) => {
      const root = await temporaryRoot();
      const paths = new FileRegistrationSetupJournalStore(root).paths(preview.setupSessionId);
      const attackedPath = attack === "writer_lock" ? paths.lock : paths.executionLock;
      const attackedStore = new HookedAtomicFileStore({
        afterCommit: () => rename(attackedPath, `${attackedPath}.displaced`),
      });
      const journal = new FileRegistrationSetupJournalStore(root, attackedStore);
      let writeResult: Awaited<ReturnType<typeof journal.save>> | undefined;

      const execution = await new FileRegistrationSetupExecutionStore(root).runExclusive(
        preview.setupSessionId,
        async (lease) => {
          writeResult = await journal.save(undefined, plannedJournal(), {
            idempotencyKey: `journal:post-rename-${attack}-loss`,
            executionFence: lease.fence,
          });
        },
      );

      expect(writeResult).toMatchObject({ ok: true, value: { durability: "unknown" } });
      expect(JSON.parse(await readFile(paths.journal, "utf8"))).toMatchObject({ revision: 1 });
      expect(execution).toMatchObject(
        attack === "writer_lock"
          ? { ok: true, value: { state: "completed" } }
          : { ok: false, error: { code: "conflict" } },
      );
    },
  );

  it("isolates execution leases across nested concurrent callbacks and clears context afterward", async () => {
    const root = await temporaryRoot();
    const secondPreviewResult = createRegistrationSetupPreview({
      schemaVersion: 1,
      setupSessionId: "setup-session-2",
      project,
      config,
      baseRevision: baseSha,
      worktreePath: "/tmp/setup-worktree-2",
      branch: registrationSetupBranchFor("setup-session-2"),
      remote: "origin",
      linearAuditIssueId: "LINEAR-AUDIT-2",
    });
    if (!secondPreviewResult.ok) throw new Error(secondPreviewResult.error.code);
    const secondPreview = secondPreviewResult.value;
    const firstJournal = new FileRegistrationSetupJournalStore(root);
    const secondJournal = new FileRegistrationSetupJournalStore(root);
    let arrivals = 0;
    let release = (): void => undefined;
    const rendezvous = new Promise<void>((resolveRendezvous) => {
      release = resolveRendezvous;
    });
    const nestedRendezvous = async () => {
      await Promise.resolve();
      arrivals += 1;
      if (arrivals === 2) release();
      await rendezvous;
      await Promise.resolve();
    };
    let retainedFirstLease: RegistrationSetupExecutionLease | undefined;

    const [first, second] = await Promise.all([
      new FileRegistrationSetupExecutionStore(root).runExclusive(
        preview.setupSessionId,
        async (lease) => {
          retainedFirstLease = lease;
          await nestedRendezvous();
          return firstJournal.save(undefined, plannedJournal(), {
            idempotencyKey: "journal:als:first",
            executionFence: lease.fence,
          });
        },
      ),
      new FileRegistrationSetupExecutionStore(root).runExclusive(
        secondPreview.setupSessionId,
        async (lease) => {
          await nestedRendezvous();
          return secondJournal.save(
            undefined,
            {
              schemaVersion: 1,
              setupSessionId: secondPreview.setupSessionId,
              preview: secondPreview,
              configDigest: serializedConfig.contentDigest,
              completed: {},
            },
            { idempotencyKey: "journal:als:second", executionFence: lease.fence },
          );
        },
      ),
    ]);

    expect(first).toMatchObject({
      ok: true,
      value: { state: "completed", value: { ok: true, value: { durability: "confirmed" } } },
    });
    expect(second).toMatchObject({
      ok: true,
      value: { state: "completed", value: { ok: true, value: { durability: "confirmed" } } },
    });
    if (retainedFirstLease === undefined) throw new Error("first lease was not captured");

    await expect(
      firstJournal.save(1, plannedJournal(), {
        idempotencyKey: "journal:als:after-callback",
        executionFence: retainedFirstLease.fence,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "conflict" } });
    await expect(firstJournal.load(preview.setupSessionId)).resolves.toMatchObject({
      ok: true,
      value: { revision: 1 },
    });
  });
});

describe("registration setup local adapters", () => {
  it("writes the exact trusted config path atomically and verifies its digest", async () => {
    const root = await temporaryRoot();
    const worktreePath = join(root, "worktree");
    await mkdir(worktreePath);
    const adapter = new LocalRegistrationSetupFileAdapter();
    const result = await withExecution(root, () =>
      adapter.writeTrustedProjectConfig(
        {
          worktree: {
            repositoryRoot: join(root, "repository"),
            path: worktreePath,
            branch: registrationSetupBranchFor(preview.setupSessionId),
            headSha: baseSha,
          },
          path: ".agent-team/project.json",
          content: serializedConfig.content,
          contentDigest: serializedConfig.contentDigest,
        },
        { idempotencyKey: "write:config" },
      ),
    );
    expect(result).toEqual({
      ok: true,
      value: { path: ".agent-team/project.json", contentDigest: serializedConfig.contentDigest },
    });
    expect(await readFile(join(worktreePath, ".agent-team/project.json"), "utf8")).toBe(
      serializedConfig.content,
    );
  });

  it("issues a server-bound grant and atomically returns the same receipt only for the same consume operation", async () => {
    const root = await temporaryRoot();
    const instant = parseInstant("2026-08-05T12:00:00.000Z");
    if (!instant.ok) throw new Error(instant.error.code);
    const authority = new FileRegistrationSetupFinalApprovalAuthority(
      root,
      createFixedClock(instant.value),
    );
    const issued = await authority.issue(binding(), localApprovalAuthority, {
      idempotencyKey: "issue:1",
    });
    if (!issued.ok || issued.value.state !== "issued") throw new Error("grant not issued");
    expect(typeof issued.value.grant.approvalId).toBe("string");
    expect(Object.keys(issued.value.grant).sort()).toEqual(["approvalId", "expiresAt"]);
    expect(
      (await stat(join(root, "registration-setup", "approval-authority", "ledger.json"))).mode &
        0o777,
    ).toBe(0o600);
    await expect(
      authority.issue({ ...binding(), headSha: "d".repeat(40) }, localApprovalAuthority, {
        idempotencyKey: "issue:1",
      }),
    ).resolves.toEqual({ ok: true, value: { state: "rejected" } });
    await expect(
      authority.issue(binding(), localApprovalAuthority, { idempotencyKey: "issue:different" }),
    ).resolves.toEqual({ ok: true, value: { state: "rejected" } });

    const request = {
      approvalId: issued.value.grant.approvalId,
      userConfirmed: true as const,
      expectedSetupRevision: 2,
    };
    const consumed = await authority.verifyAndConsume(request, binding(), localApprovalAuthority, {
      idempotencyKey: "consume:1",
    });
    const retried = await authority.verifyAndConsume(request, binding(), localApprovalAuthority, {
      idempotencyKey: "consume:1",
    });
    expect(consumed).toMatchObject({ ok: true, value: { state: "verified_and_consumed" } });
    expect(retried).toEqual(consumed);
    if (!consumed.ok || consumed.value.state !== "verified_and_consumed") {
      throw new Error("approval_not_consumed");
    }
    await expect(authority.readConsumed(approvalReferenceFor(request.approvalId))).resolves.toEqual(
      {
        ok: true,
        value: {
          receipt: consumed.value.receipt,
          consumeOperationDigest: createHash("sha256").update("consume:1", "utf8").digest("hex"),
        },
      },
    );
    await expect(authority.readConsumed(mustDigest("unknown-approval"))).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(
      authority.verifyAndConsume(
        request,
        { ...binding(), diffDigest: "9".repeat(64) as typeof testDigest },
        localApprovalAuthority,
        { idempotencyKey: "consume:1" },
      ),
    ).resolves.toEqual({ ok: true, value: { state: "rejected" } });
    await expect(
      authority.verifyAndConsume(request, binding(), localApprovalAuthority, {
        idempotencyKey: "consume:different",
      }),
    ).resolves.toEqual({ ok: true, value: { state: "replay" } });
  });

  it("rejects wrong authority, binding, session revision, and non-explicit confirmation", async () => {
    const root = await temporaryRoot();
    const authority = new FileRegistrationSetupFinalApprovalAuthority(root);
    const issued = await authority.issue(binding(), localApprovalAuthority, {
      idempotencyKey: "issue:2",
    });
    if (!issued.ok || issued.value.state !== "issued") throw new Error("grant not issued");
    const baseRequest = {
      approvalId: issued.value.grant.approvalId,
      userConfirmed: true as const,
      expectedSetupRevision: 2,
    };
    for (const attempt of [
      () =>
        authority.verifyAndConsume(
          baseRequest,
          binding(),
          { ...localApprovalAuthority, authorityDigest: "9".repeat(64) },
          {
            idempotencyKey: "wrong:authority",
          },
        ),
      () =>
        authority.verifyAndConsume(
          baseRequest,
          { ...binding(), headSha: "d".repeat(40) },
          localApprovalAuthority,
          { idempotencyKey: "wrong:binding" },
        ),
      () =>
        authority.verifyAndConsume(
          baseRequest,
          { ...binding(), setupSessionId: "other-session" },
          localApprovalAuthority,
          { idempotencyKey: "wrong:session" },
        ),
      () =>
        authority.verifyAndConsume(
          { ...baseRequest, expectedSetupRevision: 3 },
          binding(),
          localApprovalAuthority,
          { idempotencyKey: "wrong:revision" },
        ),
      () =>
        authority.verifyAndConsume(
          { ...baseRequest, userConfirmed: false as true },
          binding(),
          localApprovalAuthority,
          { idempotencyKey: "wrong:confirmation" },
        ),
    ]) {
      await expect(attempt()).resolves.toEqual({ ok: true, value: { state: "rejected" } });
    }
  });
});
