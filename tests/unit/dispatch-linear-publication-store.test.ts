/**
 * E102-5 unit tests: `FileLinearPublicationStore` (src/adapters/dispatch/
 * linear-publication-store.ts) -- the durable, write-once receipt store gating a
 * `visual_review`/`dual_review` job's Linear publication. Covers: `load()` on an empty store,
 * `create()` succeeding and being read back byte-identical, `create()` refusing to overwrite an
 * existing receipt (`conflict`) -- the store-level half of "idempotent retry reuses the same valid
 * receipt, never re-publishes" -- and the canonical digest (`canonicalLinearPublicationReceipt`/
 * `linearPublicationReceiptDigest`) being stable across two independently-built, field-order-varied
 * inputs and excluding `createdAt`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileLinearPublicationStore,
  canonicalLinearPublicationReceipt,
  linearPublicationReceiptDigest,
  type NewLinearPublicationReceipt,
} from "../../src/adapters/dispatch/linear-publication-store.js";
import { parseIdentifier, type Identifier } from "../../src/domain/foundation/index.js";
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
  const directory = await mkdtemp(join(tmpdir(), "agent-team-linear-publication-"));
  temporaryDirectories.push(directory);
  return directory;
}

function id<Scope extends string>(scope: Scope, value: string): Identifier<Scope> {
  const parsed = parseIdentifier(scope, value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const projectId = id("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const issueId = id("issue", "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const headSha = (() => {
  const parsed = headShaSchema.safeParse("a".repeat(40));
  if (!parsed.success) throw new Error("fixture invariant violated");
  return parsed.data;
})();

function receipt(
  overrides: Partial<NewLinearPublicationReceipt> = {},
): NewLinearPublicationReceipt {
  return {
    projectId,
    issueId,
    externalIssueId: "linear-issue-1",
    headSha,
    manifestDigest: "b".repeat(64),
    manifestComment: { id: "comment-manifest", sha256: "c".repeat(64) },
    artifacts: [
      {
        path: `.agent-team/evidence/${issueId}/${headSha}/status-none.png`,
        sha256: "d".repeat(64),
        assetUrl: "https://uploads.linear.app/asset-1",
        commentId: "comment-artifact-1",
      },
    ],
    ...overrides,
  };
}

describe("FileLinearPublicationStore", () => {
  it("load() reports undefined (never an error) when no receipt exists yet", async () => {
    const store = new FileLinearPublicationStore(await temporaryDirectory());
    const loaded = await store.load(projectId, issueId, headSha);
    expect(loaded).toEqual({ ok: true, value: undefined });
  });

  it("create() persists a receipt that reads back byte-identical via load()", async () => {
    const store = new FileLinearPublicationStore(await temporaryDirectory());
    const created = await store.create(receipt());
    expect(created.ok).toBe(true);
    const loaded = await store.load(projectId, issueId, headSha);
    expect(loaded).toEqual(created);
  });

  it("create() fails closed with conflict on a second call for the same (projectId, issueId, headSha) -- the idempotent-retry gate", async () => {
    const store = new FileLinearPublicationStore(await temporaryDirectory());
    const first = await store.create(receipt());
    expect(first.ok).toBe(true);
    const second = await store.create(receipt({ manifestDigest: "e".repeat(64) }));
    expect(second.ok ? "ok" : second.error.code).toBe("conflict");
    // The original receipt must survive untouched -- a rejected second `create()` never clobbers it.
    const reloaded = await store.load(projectId, issueId, headSha);
    expect(reloaded).toEqual(first);
  });

  it("two different headShas for the same issue get independent receipts", async () => {
    const store = new FileLinearPublicationStore(await temporaryDirectory());
    const otherHeadSha = (() => {
      const parsed = headShaSchema.safeParse("f".repeat(40));
      if (!parsed.success) throw new Error("fixture invariant violated");
      return parsed.data;
    })();
    await store.create(receipt());
    const second = await store.create(receipt({ headSha: otherHeadSha }));
    expect(second.ok).toBe(true);
    const first = await store.load(projectId, issueId, headSha);
    const reloadedSecond = await store.load(projectId, issueId, otherHeadSha);
    expect(first.ok && first.value?.headSha).toBe(headSha);
    expect(reloadedSecond.ok && reloadedSecond.value?.headSha).toBe(otherHeadSha);
  });
});

describe("canonicalLinearPublicationReceipt / linearPublicationReceiptDigest", () => {
  it("two independently-built records with the same content digest identically", async () => {
    const store = new FileLinearPublicationStore(await temporaryDirectory());
    const created = await store.create(receipt());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Reconstructed by hand (not read back from the store), field order deliberately scrambled --
    // proves the digest depends only on content, never on incidental object key order.
    const handBuilt = {
      schemaVersion: 1 as const,
      createdAt: created.value.createdAt,
      artifacts: [...created.value.artifacts],
      manifestComment: { ...created.value.manifestComment },
      manifestDigest: created.value.manifestDigest,
      headSha: created.value.headSha,
      externalIssueId: created.value.externalIssueId,
      issueId: created.value.issueId,
      projectId: created.value.projectId,
    };
    expect(linearPublicationReceiptDigest(handBuilt)).toBe(
      linearPublicationReceiptDigest(created.value),
    );
  });

  it("excludes createdAt -- two receipts differing only in createdAt digest identically", () => {
    const first = receipt();
    const withDifferentCreatedAt = {
      ...first,
      schemaVersion: 1 as const,
      createdAt: headSha, // any distinct string stand-in; only used to prove exclusion
    };
    const asIfCreatedNow = { ...first, schemaVersion: 1 as const, createdAt: "z".repeat(4) };
    expect(linearPublicationReceiptDigest(withDifferentCreatedAt as never)).toBe(
      linearPublicationReceiptDigest(asIfCreatedNow as never),
    );
  });

  it("canonical form never carries schemaVersion, projectId, or createdAt", async () => {
    const store = new FileLinearPublicationStore(await temporaryDirectory());
    const created = await store.create(receipt());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const canonical = canonicalLinearPublicationReceipt(created.value);
    expect(canonical).not.toHaveProperty("schemaVersion");
    expect(canonical).not.toHaveProperty("projectId");
    expect(canonical).not.toHaveProperty("createdAt");
  });

  it("a manifestDigest/artifact-content change produces a different digest", async () => {
    const store = new FileLinearPublicationStore(await temporaryDirectory());
    const created = await store.create(receipt());
    const createdOther = await store.create(
      receipt({
        headSha: (() => {
          const parsed = headShaSchema.safeParse("9".repeat(40));
          if (!parsed.success) throw new Error("fixture invariant violated");
          return parsed.data;
        })(),
        manifestDigest: "9".repeat(64),
      }),
    );
    expect(created.ok && createdOther.ok).toBe(true);
    if (!created.ok || !createdOther.ok) return;
    expect(linearPublicationReceiptDigest(created.value)).not.toBe(
      linearPublicationReceiptDigest(createdOther.value),
    );
  });
});
