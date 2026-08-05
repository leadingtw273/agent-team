import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileGitHubPolicyOperationStore } from "../../src/adapters/registration/index.js";
import {
  createGitHubRegistrationPolicy,
  type GitHubPolicyOperationNext,
  type GitHubRegistrationInventory,
  type GitHubRegistrationPolicyPort,
} from "../../src/application/registration/index.js";
import { domainError, err, ok } from "../../src/domain/foundation/index.js";

const temporaryDirectories: string[] = [];
const operationId = "a".repeat(64);
const initial: GitHubPolicyOperationNext = Object.freeze({
  bindingRevision: "b".repeat(64),
  inventoryRevision: "c".repeat(64),
  phase: "reserved",
  reservationId: "reservation-o004",
  rulesetId: null,
  autoMergeAttempted: false,
  changed: false,
});
const target = Object.freeze({
  projectId: "project-o004-file-store",
  repository: "owner/repository",
  defaultBranch: "main",
});
const confirmation = Object.freeze({
  confirmationKey: Buffer.alloc(32, 4),
  confirmationContext: Object.freeze({ authorityDigest: "4".repeat(64) }),
});

function inventory(
  overrides: Partial<GitHubRegistrationInventory> = {},
): GitHubRegistrationInventory {
  return Object.freeze({
    revision: "d".repeat(64),
    permission: "admin",
    rulesets: "supported",
    autoMerge: "supported",
    autoMergeEnabled: false,
    activeRequiredChecks: Object.freeze([]),
    managedRulesetCollision: false,
    managedRulesetExact: false,
    ...overrides,
  });
}

async function command(useCase: ReturnType<typeof createGitHubRegistrationPolicy>) {
  const preview = await useCase.preview(target);
  if (preview.state !== "ready") throw new Error("expected ready file-store preview");
  return Object.freeze({
    ...target,
    operation: "apply_github_policy" as const,
    confirmationText: "套用 GitHub 合併保護" as const,
    expectedRevision: preview.expectedRevision,
    confirmationToken: preview.confirmationToken,
  });
}

async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "agent-team-github-policy-store-"));
  temporaryDirectories.push(value);
  return value;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((value) => rm(value, { recursive: true, force: true })),
  );
});

describe("O004 file GitHub policy operation store", () => {
  it("rejects a symlinked journal root instead of writing through it", async () => {
    const base = await directory();
    const target = join(base, "target");
    const linked = join(base, "linked");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, linked, "dir");

    const result = await new FileGitHubPolicyOperationStore(linked).compareAndSwap({
      operationId,
      expectedRevision: null,
      next: initial,
    });

    expect(result.ok).toBe(false);
    expect(await exists(join(target, `${operationId}.json`))).toBe(false);
  });

  it("rejects a symlinked parent component instead of creating a journal below it", async () => {
    const base = await directory();
    const targetParent = join(base, "target-parent");
    const linkedParent = join(base, "linked-parent");
    await mkdir(targetParent, { mode: 0o700 });
    await symlink(targetParent, linkedParent, "dir");

    const result = await new FileGitHubPolicyOperationStore(
      join(linkedParent, "journal"),
    ).compareAndSwap({
      operationId,
      expectedRevision: null,
      next: initial,
    });

    expect(result.ok).toBe(false);
    expect(await exists(join(targetParent, "journal", `${operationId}.json`))).toBe(false);
  });

  it("holds the constructor directory inode across a pathname replacement", async () => {
    const base = await directory();
    const root = join(base, "journal");
    const heldOriginal = join(base, "journal-original");
    await mkdir(root, { mode: 0o700 });
    const store = new FileGitHubPolicyOperationStore(root);
    await rename(root, heldOriginal);
    await mkdir(root, { mode: 0o700 });

    const result = await store.compareAndSwap({
      operationId,
      expectedRevision: null,
      next: initial,
    });

    expect(result.ok).toBe(true);
    expect(await exists(join(heldOriginal, `${operationId}.json`))).toBe(true);
    expect(await exists(join(root, `${operationId}.json`))).toBe(false);
    expect(await exists(join(root, `${operationId}.lock`))).toBe(false);
  });

  it("fails closed for direct journal and lock symlinks", async () => {
    const root = await directory();
    const outsideJournal = join(root, "outside-journal");
    const outsideLock = join(root, "outside-lock");
    const journalRoot = join(root, "journal");
    await mkdir(journalRoot, { mode: 0o700 });
    await writeFile(outsideJournal, "outside\n", { mode: 0o600 });
    await writeFile(outsideLock, "outside\n", { mode: 0o600 });
    await symlink(outsideJournal, join(journalRoot, `${operationId}.json`));
    await symlink(outsideLock, join(journalRoot, `${operationId}.lock`));

    const store = new FileGitHubPolicyOperationStore(journalRoot);
    expect((await store.read(operationId)).ok).toBe(false);
    expect(
      (
        await store.compareAndSwap({
          operationId,
          expectedRevision: null,
          next: initial,
        })
      ).ok,
    ).toBe(false);
    expect(await readFile(outsideJournal, "utf8")).toBe("outside\n");
    expect(await readFile(outsideLock, "utf8")).toBe("outside\n");
  });

  it("persists a strict private schema with store-owned monotonic revisions", async () => {
    const root = await directory();
    const firstProcess = new FileGitHubPolicyOperationStore(root);
    const reserved = await firstProcess.compareAndSwap({
      operationId,
      expectedRevision: null,
      next: initial,
    });
    expect(reserved).toMatchObject({
      ok: true,
      value: { revision: 1, phase: "reserved", rulesetId: null },
    });

    const path = join(root, `${operationId}.json`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      schemaVersion: 1,
      operationId,
      revision: 1,
    });

    const restarted = new FileGitHubPolicyOperationStore(root);
    const started = await restarted.compareAndSwap({
      operationId,
      expectedRevision: 1,
      next: Object.freeze({ ...initial, phase: "mutation_started" }),
    });
    expect(started).toMatchObject({
      ok: true,
      value: { revision: 2, phase: "mutation_started" },
    });
    expect(await firstProcess.read(operationId)).toMatchObject({
      ok: true,
      value: { revision: 2, phase: "mutation_started" },
    });
  });

  it("serializes cross-instance CAS and never clears the winning operation", async () => {
    const root = await directory();
    const first = new FileGitHubPolicyOperationStore(root);
    const second = new FileGitHubPolicyOperationStore(root);

    const outcomes = await Promise.all([
      first.compareAndSwap({ operationId, expectedRevision: null, next: initial }),
      second.compareAndSwap({ operationId, expectedRevision: null, next: initial }),
    ]);

    expect(outcomes.filter((result) => result.ok)).toHaveLength(1);
    expect(
      outcomes.filter((result) => !result.ok && result.error.code === "conflict"),
    ).toHaveLength(1);
    expect(await first.read(operationId)).toMatchObject({
      ok: true,
      value: { revision: 1, phase: "reserved" },
    });
  });

  it("fails closed for malformed or forward-unknown journal records", async () => {
    const root = await directory();
    await writeFile(
      join(root, `${operationId}.json`),
      `${JSON.stringify({ schemaVersion: 2, operationId, revision: 999, phase: "completed" })}\n`,
      { mode: 0o600 },
    );

    expect(await new FileGitHubPolicyOperationStore(root).read(operationId)).toMatchObject({
      ok: false,
      error: { code: "invariant_violation" },
    });
  });

  it("permits one POST across two use cases and two file-store instances", async () => {
    const root = await directory();
    let current = inventory();
    let postCount = 0;
    const port: GitHubRegistrationPolicyPort = {
      inspect: () => Promise.resolve(ok(current)),
      createManagedRuleset: () => {
        postCount += 1;
        current = inventory({
          revision: "e".repeat(64),
          managedRulesetExact: true,
          managedRulesetId: "99",
          activeRequiredChecks: Object.freeze(["CI", "agent-team/review"]),
        });
        return Promise.resolve(ok({ rulesetId: "99" }));
      },
      enableAutoMerge: () => {
        current = Object.freeze({
          ...current,
          revision: "f".repeat(64),
          autoMergeEnabled: true,
        });
        return Promise.resolve(ok({ changed: true }));
      },
    };
    const first = createGitHubRegistrationPolicy({
      port,
      operationStore: new FileGitHubPolicyOperationStore(root),
      ...confirmation,
    });
    const second = createGitHubRegistrationPolicy({
      port,
      operationStore: new FileGitHubPolicyOperationStore(root),
      ...confirmation,
    });
    const proof = await command(first);

    await Promise.all([first.apply(proof), second.apply(proof)]);

    expect(postCount).toBe(1);
  });

  it("survives process-style reconstruction after an unknown POST outcome", async () => {
    const root = await directory();
    let postCount = 0;
    const port: GitHubRegistrationPolicyPort = {
      inspect: () => Promise.resolve(ok(inventory())),
      createManagedRuleset: () => {
        postCount += 1;
        return Promise.resolve(err(domainError("timeout")));
      },
      enableAutoMerge: () => Promise.resolve(ok({ changed: true })),
    };
    const first = createGitHubRegistrationPolicy({
      port,
      operationStore: new FileGitHubPolicyOperationStore(root),
      ...confirmation,
    });
    const proof = await command(first);
    expect(await first.apply(proof)).toMatchObject({
      state: "blocked",
      reason: "operation_recovery_required",
    });

    const restarted = createGitHubRegistrationPolicy({
      port,
      operationStore: new FileGitHubPolicyOperationStore(root),
      ...confirmation,
    });
    expect(await restarted.apply(proof)).toMatchObject({
      state: "blocked",
      reason: "operation_recovery_required",
    });
    expect(postCount).toBe(1);
  });
});
