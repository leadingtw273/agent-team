/**
 * E102-5 unit tests: `LinearVisualPublicationCoordinator` (src/adapters/dispatch/
 * linear-publication.ts) -- the application-level caller that wires the existing
 * `LinearUploadClient` (A004, adapters/linear/upload.ts, previously built-but-unwired) to a real
 * invocation. Every Linear-facing dependency here is a fake (a real `LinearGraphqlTransport`
 * round-trip is already covered by tests/contract/linear-upload.test.ts) -- this file's job is only
 * to prove the *orchestration*: uploads every PNG artifact, posts one manifest summary comment,
 * persists a receipt only once both succeed, reuses an existing valid receipt without re-uploading
 * anything (idempotent retry), and marks a post-upload failure as an identifiable orphan that never
 * reports success.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  LinearVisualPublicationCoordinator,
  renderManifestComment,
  sha256OfManifest,
  type LinearArtifactUploader,
} from "../../src/adapters/dispatch/linear-publication.js";
import {
  FileLinearPublicationStore,
  type LinearPublicationReceiptRecord,
  type LinearPublicationStorePort,
  type NewLinearPublicationReceipt,
} from "../../src/adapters/dispatch/linear-publication-store.js";
import type { LinearCommentWriter } from "../../src/adapters/linear/upload.js";
import type { LinearProjectContext } from "../../src/adapters/linear/model.js";
import type { VisualManifest } from "../../src/domain/checkpoint/index.js";
import {
  domainError,
  err,
  ok,
  parseIdentifier,
  parseInstant,
  type DomainError,
  type Identifier,
  type Instant,
  type Result,
} from "../../src/domain/foundation/index.js";
import { headShaSchema } from "../../src/domain/review/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-linear-publish-"));
  temporaryDirectories.push(directory);
  return directory;
}

function id<Scope extends string>(scope: Scope, value: string): Identifier<Scope> {
  const parsed = parseIdentifier(scope, value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function instant(value: string): Instant {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const now = instant("2026-08-08T00:00:00.000Z");
const projectId = id("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const issueId = id("issue", "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const headSha = (() => {
  const parsed = headShaSchema.safeParse("a".repeat(40));
  if (!parsed.success) throw new Error("fixture invariant violated");
  return parsed.data;
})();
const externalIssueId = "linear-issue-1";
const artifactRelativePath = `.agent-team/evidence/${issueId}/${headSha}/status-none.png`;
const pngBytes = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("fixture-png-bytes"),
]);
const artifactSha256 = createHash("sha256").update(pngBytes).digest("hex");

function context(): LinearProjectContext {
  return {
    team: { id: "team-1", name: "Team", key: "TM" },
    project: { id: "proj-1", name: "Project" },
    catalog: {} as never,
  };
}

function manifest(overrides: Partial<VisualManifest> = {}): VisualManifest {
  return {
    schemaVersion: 1,
    issueId,
    commitSha: headSha,
    generatedAt: now,
    environment: { runner: "fixture", operatingSystem: "linux" },
    artifacts: [
      {
        path: artifactRelativePath,
        mediaType: "image/png",
        sha256: artifactSha256,
        title: "Status page (healthy)",
        acceptanceCriteria: ["畫面正確顯示"],
      },
    ],
    ...overrides,
  };
}

async function seedWorktree(): Promise<string> {
  const worktreePath = await temporaryDirectory();
  await mkdir(join(worktreePath, ".agent-team", "evidence", issueId, headSha), { recursive: true });
  await writeFile(join(worktreePath, artifactRelativePath), pngBytes);
  return worktreePath;
}

class FakeUploader implements LinearArtifactUploader {
  readonly calls: { issueId: string; filename: string; idempotencyKey: string }[] = [];
  result: Result<
    { externalId: string; url: string; sha256: string; commentId: string; commentBody: string },
    DomainError
  > = ok({
    externalId: "asset-1",
    url: "https://uploads.linear.app/asset-1",
    sha256: artifactSha256,
    commentId: "comment-artifact-1",
    commentBody: "stored",
  });

  uploadArtifact(
    _context: LinearProjectContext,
    issueIdParam: string,
    artifact: { filename: string },
    idempotencyKey: string,
  ) {
    this.calls.push({ issueId: issueIdParam, filename: artifact.filename, idempotencyKey });
    return Promise.resolve(this.result);
  }
}

class FakeCommentWriter implements LinearCommentWriter {
  readonly calls: { issueId: string; body: string; idempotencyKey: string }[] = [];
  result: Result<{ id: string; body: string; createdAt: Instant; reused: boolean }, DomainError> =
    ok({
      id: "comment-manifest",
      body: "stored",
      createdAt: now,
      reused: false,
    });

  appendComment(
    _context: LinearProjectContext,
    issueIdParam: string,
    body: string,
    idempotencyKey: string,
  ) {
    this.calls.push({ issueId: issueIdParam, body, idempotencyKey });
    return Promise.resolve(this.result);
  }
}

class InMemoryStore implements LinearPublicationStorePort {
  #records = new Map<string, LinearPublicationReceiptRecord>();
  readonly createCalls: NewLinearPublicationReceipt[] = [];
  failCreateWith: DomainError | undefined;
  failLoadWith: DomainError | undefined;

  #key(projectIdValue: string, issueIdValue: string, headShaValue: string): string {
    return `${projectIdValue}__${issueIdValue}__${headShaValue}`;
  }

  load(projectIdValue: string, issueIdValue: string, headShaValue: string) {
    if (this.failLoadWith !== undefined) return Promise.resolve(err(this.failLoadWith));
    return Promise.resolve(
      ok(this.#records.get(this.#key(projectIdValue, issueIdValue, headShaValue))),
    );
  }

  create(record: NewLinearPublicationReceipt) {
    this.createCalls.push(record);
    if (this.failCreateWith !== undefined) return Promise.resolve(err(this.failCreateWith));
    const full: LinearPublicationReceiptRecord = { ...record, schemaVersion: 1, createdAt: now };
    this.#records.set(this.#key(record.projectId, record.issueId, record.headSha), full);
    return Promise.resolve(ok(full));
  }
}

describe("LinearVisualPublicationCoordinator.publish", () => {
  it("uploads every PNG artifact, posts one manifest comment, and persists a receipt on first publish", async () => {
    const worktreePath = await seedWorktree();
    const uploader = new FakeUploader();
    const comments = new FakeCommentWriter();
    const store = new InMemoryStore();
    const coordinator = new LinearVisualPublicationCoordinator(uploader, comments, store);

    const result = await coordinator.publish({
      context: context(),
      projectId,
      issueId,
      externalIssueId,
      worktreePath,
      visualManifest: manifest(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reused).toBe(false);
    expect(uploader.calls).toHaveLength(1);
    expect(uploader.calls[0]?.issueId).toBe(externalIssueId);
    expect(comments.calls).toHaveLength(1);
    expect(comments.calls[0]?.body).toBe(
      renderManifestComment(manifest(), [
        { path: artifactRelativePath, assetUrl: "https://uploads.linear.app/asset-1" },
      ]),
    );
    expect(store.createCalls).toHaveLength(1);
    expect(result.value.receipt.artifacts).toEqual([
      {
        path: artifactRelativePath,
        sha256: artifactSha256,
        assetUrl: "https://uploads.linear.app/asset-1",
        commentId: "comment-artifact-1",
      },
    ]);
    expect(result.value.receipt.manifestDigest).toBe(sha256OfManifest(manifest()));
  });

  it("idempotent retry: a second publish() for the identical manifest reuses the receipt and calls neither the uploader nor the comment writer", async () => {
    const worktreePath = await seedWorktree();
    const uploader = new FakeUploader();
    const comments = new FakeCommentWriter();
    const store = new InMemoryStore();
    const coordinator = new LinearVisualPublicationCoordinator(uploader, comments, store);
    const request = {
      context: context(),
      projectId,
      issueId,
      externalIssueId,
      worktreePath,
      visualManifest: manifest(),
    };

    const first = await coordinator.publish(request);
    expect(first.ok).toBe(true);
    const second = await coordinator.publish(request);

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.reused).toBe(true);
    expect(second.value.receipt).toEqual(first.ok ? first.value.receipt : undefined);
    // The whole point: no second upload, no second comment, no second store.create() call.
    expect(uploader.calls).toHaveLength(1);
    expect(comments.calls).toHaveLength(1);
    expect(store.createCalls).toHaveLength(1);
  });

  it("fails closed (never ok:true) and never marks an orphan when the upload itself fails before anything is created", async () => {
    const worktreePath = await seedWorktree();
    const uploader = new FakeUploader();
    uploader.result = err(domainError("external_failure"));
    const comments = new FakeCommentWriter();
    const store = new InMemoryStore();
    const coordinator = new LinearVisualPublicationCoordinator(uploader, comments, store);

    const result = await coordinator.publish({
      context: context(),
      projectId,
      issueId,
      externalIssueId,
      worktreePath,
      visualManifest: manifest(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe("upload_failed");
    expect(result.failure.orphan).toBe(false);
    expect(comments.calls).toHaveLength(0);
    expect(store.createCalls).toHaveLength(0);
  });

  it("marks an orphan when the manifest comment fails after every artifact already uploaded", async () => {
    const worktreePath = await seedWorktree();
    const uploader = new FakeUploader();
    const comments = new FakeCommentWriter();
    comments.result = err(domainError("external_failure"));
    const store = new InMemoryStore();
    const coordinator = new LinearVisualPublicationCoordinator(uploader, comments, store);

    const result = await coordinator.publish({
      context: context(),
      projectId,
      issueId,
      externalIssueId,
      worktreePath,
      visualManifest: manifest(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe("manifest_comment_failed");
    // The identifiable-orphan contract: at least one artifact really was uploaded to Linear, with
    // no durable receipt for it -- this must never be conflated with the "nothing happened yet"
    // failure class above.
    expect(result.failure.orphan).toBe(true);
    expect(uploader.calls).toHaveLength(1);
    expect(store.createCalls).toHaveLength(0);
  });

  it("marks an orphan when every Linear write succeeds but the receipt itself fails to persist", async () => {
    const worktreePath = await seedWorktree();
    const uploader = new FakeUploader();
    const comments = new FakeCommentWriter();
    const store = new InMemoryStore();
    store.failCreateWith = domainError("external_failure");
    const coordinator = new LinearVisualPublicationCoordinator(uploader, comments, store);

    const result = await coordinator.publish({
      context: context(),
      projectId,
      issueId,
      externalIssueId,
      worktreePath,
      visualManifest: manifest(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe("receipt_persist_failed");
    expect(result.failure.orphan).toBe(true);
    expect(uploader.calls).toHaveLength(1);
    expect(comments.calls).toHaveLength(1);
  });

  it("fails closed with receipt_conflict (never re-uploads) when an existing receipt's digest does not match the manifest being published now", async () => {
    const worktreePath = await seedWorktree();
    const uploader = new FakeUploader();
    const comments = new FakeCommentWriter();
    const store = new InMemoryStore();
    await store.create({
      projectId,
      issueId,
      externalIssueId,
      headSha,
      manifestDigest: "stale-digest-does-not-match".padEnd(64, "0"),
      manifestComment: { id: "comment-manifest-stale", sha256: "0".repeat(64) },
      artifacts: [
        {
          path: artifactRelativePath,
          sha256: artifactSha256,
          assetUrl: "https://uploads.linear.app/stale-asset",
          commentId: "comment-artifact-stale",
        },
      ],
    });
    const coordinator = new LinearVisualPublicationCoordinator(uploader, comments, store);

    const result = await coordinator.publish({
      context: context(),
      projectId,
      issueId,
      externalIssueId,
      worktreePath,
      visualManifest: manifest(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe("receipt_conflict");
    expect(result.failure.orphan).toBe(false);
    expect(uploader.calls).toHaveLength(0);
    expect(comments.calls).toHaveLength(0);
  });

  it("fails closed when an artifact's on-disk bytes no longer match its recorded sha256, without uploading it", async () => {
    const worktreePath = await seedWorktree();
    await writeFile(
      join(worktreePath, artifactRelativePath),
      Buffer.concat([pngBytes, Buffer.from("tampered")]),
    );
    const uploader = new FakeUploader();
    const comments = new FakeCommentWriter();
    const store = new InMemoryStore();
    const coordinator = new LinearVisualPublicationCoordinator(uploader, comments, store);

    const result = await coordinator.publish({
      context: context(),
      projectId,
      issueId,
      externalIssueId,
      worktreePath,
      visualManifest: manifest(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe("artifact_changed");
    expect(result.failure.orphan).toBe(false);
    expect(uploader.calls).toHaveLength(0);
  });
});

describe("using a real FileLinearPublicationStore (real disk, not a build)", () => {
  it("idempotent retry survives a fresh coordinator instance pointed at the same store directory", async () => {
    const worktreePath = await seedWorktree();
    const storeDirectory = await temporaryDirectory();
    const uploader = new FakeUploader();
    const comments = new FakeCommentWriter();
    const request = {
      context: context(),
      projectId,
      issueId,
      externalIssueId,
      worktreePath,
      visualManifest: manifest(),
    };

    const first = await new LinearVisualPublicationCoordinator(
      uploader,
      comments,
      new FileLinearPublicationStore(storeDirectory),
    ).publish(request);
    expect(first.ok).toBe(true);

    // A brand-new coordinator + store instance -- simulating a fresh `agent-team run` process --
    // reusing the on-disk receipt without ever calling the uploader/comment writer again.
    const secondUploader = new FakeUploader();
    const secondComments = new FakeCommentWriter();
    const second = await new LinearVisualPublicationCoordinator(
      secondUploader,
      secondComments,
      new FileLinearPublicationStore(storeDirectory),
    ).publish(request);

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.reused).toBe(true);
    expect(secondUploader.calls).toHaveLength(0);
    expect(secondComments.calls).toHaveLength(0);
  });
});
