import { spawn } from "node:child_process";
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
import {
  AtomicFileStore,
  openHeldSecureDirectory,
  type AtomicWriteOptions,
  type HeldSecureDirectory,
  type SecureFileLockHandle,
} from "../../src/infrastructure/files/index.js";

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

class AbaReplacingWriter extends AtomicFileStore {
  readonly #root: string;
  replacement: SecureFileLockHandle | undefined;
  replacementDirectory: HeldSecureDirectory | undefined;
  #replaced = false;

  constructor(root: string) {
    super();
    this.#root = root;
  }

  override async write(targetPath: string, content: Uint8Array, options: AtomicWriteOptions = {}) {
    if (!targetPath.endsWith(`/${operationId}.json`) || this.#replaced) {
      return super.write(targetPath, content, options);
    }
    this.#replaced = true;
    const canonical = join(this.#root, `${operationId}.lock`);
    await rename(canonical, join(this.#root, `${operationId}.lock.displaced`));
    const opened = openHeldSecureDirectory(this.#root, [], { create: false });
    if (!opened.ok) return opened;
    this.replacementDirectory = opened.value;
    const replacement = await opened.value.acquireLock(`${operationId}.lock`, "replacement-owner");
    if (!replacement.ok) return replacement;
    this.replacement = replacement.value;
    return super.write(targetPath, content, options);
  }

  async close(): Promise<void> {
    if (this.replacement !== undefined) await this.replacement.release();
    if (this.replacementDirectory !== undefined) await this.replacementDirectory.close();
  }
}

class UnknownDurabilityWriter extends AtomicFileStore {
  override async write(targetPath: string, content: Uint8Array, options: AtomicWriteOptions = {}) {
    const written = await super.write(targetPath, content, options);
    return written.ok && targetPath.endsWith(`/${operationId}.json`)
      ? ok(Object.freeze({ durability: "unknown" as const }))
      : written;
  }
}

class AfterCommitReplacingWriter extends AtomicFileStore {
  readonly #root: string;
  replacement: SecureFileLockHandle | undefined;
  replacementDirectory: HeldSecureDirectory | undefined;

  constructor(root: string) {
    super();
    this.#root = root;
  }

  override async write(targetPath: string, content: Uint8Array, options: AtomicWriteOptions = {}) {
    const written = await super.write(targetPath, content, options);
    if (!written.ok || !targetPath.endsWith(`/${operationId}.json`)) return written;
    const canonical = join(this.#root, `${operationId}.lock`);
    await rename(canonical, join(this.#root, `${operationId}.lock.displaced`));
    const opened = openHeldSecureDirectory(this.#root, [], { create: false });
    if (!opened.ok) return opened;
    this.replacementDirectory = opened.value;
    const replacement = await opened.value.acquireLock(`${operationId}.lock`, "replacement-owner");
    if (!replacement.ok) return replacement;
    this.replacement = replacement.value;
    return written;
  }

  async close(): Promise<void> {
    if (this.replacement !== undefined) await this.replacement.release();
    if (this.replacementDirectory !== undefined) await this.replacementDirectory.close();
  }
}

class TransientRestoringWriter extends AtomicFileStore {
  readonly #root: string;
  #restored = false;

  constructor(root: string) {
    super();
    this.#root = root;
  }

  override async write(targetPath: string, content: Uint8Array, options: AtomicWriteOptions = {}) {
    if (targetPath.endsWith(`/${operationId}.json`) && !this.#restored) {
      this.#restored = true;
      const canonical = join(this.#root, `${operationId}.lock`);
      const displaced = join(this.#root, `${operationId}.lock.transient`);
      await rename(canonical, displaced);
      await rename(displaced, canonical);
    }
    return super.write(targetPath, content, options);
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

  it("fails closed when the constructor directory pathname is replaced", async () => {
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

    expect(result.ok).toBe(false);
    expect(await exists(join(heldOriginal, `${operationId}.json`))).toBe(false);
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

  it("holds the kernel lock across a store mutation so another instance waits for a later CAS", async () => {
    const root = await directory();
    const second = new FileGitHubPolicyOperationStore(root);
    const child = spawn(
      process.execPath,
      [
        join(process.cwd(), "tests/fixtures/github-policy-operation-store-child.mjs"),
        root,
        operationId,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", () => {
        if (stdout.includes("held\n")) resolve();
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (!stdout.includes("held\n")) {
          reject(new Error(`child exited before holding lock: ${String(code)} ${stderr}`));
        }
      });
    });

    expect(
      await second.compareAndSwap({
        operationId,
        expectedRevision: null,
        next: initial,
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await exists(join(root, `${operationId}.json`))).toBe(false);

    child.stdin.write("continue\n");
    const childExit = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    expect(childExit, stderr).toBe(0);
    const childResult = JSON.parse(stdout.trim().split("\n").at(-1) ?? "null") as unknown;
    expect(childResult).toMatchObject({ ok: true, value: { revision: 1 } });
    expect(
      await second.compareAndSwap({
        operationId,
        expectedRevision: 1,
        next: Object.freeze({ ...initial, phase: "mutation_started" }),
      }),
    ).toMatchObject({ ok: true, value: { revision: 2, phase: "mutation_started" } });
    await second.close();
  });

  it("uses the commit guard when a real writer replaces the lock before publishing", async () => {
    const root = await directory();
    const initialized = new FileGitHubPolicyOperationStore(root);
    expect(
      await initialized.compareAndSwap({
        operationId,
        expectedRevision: null,
        next: initial,
      }),
    ).toMatchObject({ ok: true, value: { revision: 1 } });
    await initialized.close();

    const writer = new AbaReplacingWriter(root);
    const store = new FileGitHubPolicyOperationStore(root, writer);

    const result = await store.compareAndSwap({
      operationId,
      expectedRevision: 1,
      next: Object.freeze({ ...initial, phase: "mutation_started" }),
    });

    expect(result).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(writer.replacement).toBeDefined();
    expect(await writer.replacement?.assertOwnership()).toEqual({ ok: true, value: undefined });
    const competitor = new FileGitHubPolicyOperationStore(root);
    expect(
      await competitor.compareAndSwap({
        operationId,
        expectedRevision: 1,
        next: Object.freeze({ ...initial, phase: "mutation_started" }),
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(JSON.parse(await readFile(join(root, `${operationId}.json`), "utf8"))).toMatchObject({
      revision: 1,
      phase: "reserved",
    });
    expect((await stat(join(root, `${operationId}.lock`))).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, `${operationId}.lock.displaced`))).mode & 0o777).toBe(0o600);

    await writer.close();
    expect(
      await competitor.compareAndSwap({
        operationId,
        expectedRevision: 1,
        next: Object.freeze({ ...initial, phase: "mutation_started" }),
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(JSON.parse(await readFile(join(root, `${operationId}.json`), "utf8"))).toMatchObject({
      revision: 1,
      phase: "reserved",
    });
    expect((await stat(join(root, `${operationId}.lock`))).mode & 0o777).toBe(0o600);
    await store.close();
    await competitor.close();
  });

  it("forces read-back and reports external failure after an unknown-durability publication", async () => {
    const root = await directory();
    const manifestOwner = new FileGitHubPolicyOperationStore(root);
    expect(await manifestOwner.read(operationId)).toEqual({ ok: true, value: undefined });
    await manifestOwner.close();
    const store = new FileGitHubPolicyOperationStore(root, new UnknownDurabilityWriter());

    expect(
      await store.compareAndSwap({
        operationId,
        expectedRevision: null,
        next: initial,
      }),
    ).toMatchObject({ ok: false, error: { code: "external_failure" } });
    expect(JSON.parse(await readFile(join(root, `${operationId}.json`), "utf8"))).toMatchObject({
      revision: 1,
      phase: "reserved",
    });
    await store.close();
  });

  it("never reports conflict after publication when ownership is lost after rename", async () => {
    const root = await directory();
    const initialized = new FileGitHubPolicyOperationStore(root);
    expect(
      await initialized.compareAndSwap({ operationId, expectedRevision: null, next: initial }),
    ).toMatchObject({ ok: true, value: { revision: 1 } });
    await initialized.close();
    const writer = new AfterCommitReplacingWriter(root);
    const store = new FileGitHubPolicyOperationStore(root, writer);

    expect(
      await store.compareAndSwap({
        operationId,
        expectedRevision: 1,
        next: Object.freeze({ ...initial, phase: "mutation_started" }),
      }),
    ).toMatchObject({ ok: false, error: { code: "external_failure" } });
    expect(JSON.parse(await readFile(join(root, `${operationId}.json`), "utf8"))).toMatchObject({
      revision: 2,
      phase: "mutation_started",
    });
    expect(await writer.replacement?.assertOwnership()).toEqual({ ok: true, value: undefined });
    await writer.close();
    await store.close();
  });

  it.each([
    [
      "strict-schema tamper",
      "invariant_violation",
      (value: Record<string, unknown>) => ({ ...value, extra: true }),
    ],
    [
      "identity mismatch",
      "conflict",
      (value: Record<string, unknown>) => ({
        ...value,
        device: Number(value["device"]) + 1,
      }),
    ],
  ] as const)(
    "fails closed for lock manifest %s without changing the journal",
    async (_kind, code, tamper) => {
      const root = await directory();
      const initialized = new FileGitHubPolicyOperationStore(root);
      expect(
        await initialized.compareAndSwap({ operationId, expectedRevision: null, next: initial }),
      ).toMatchObject({ ok: true, value: { revision: 1 } });
      await initialized.close();
      const manifestPath = join(root, `${operationId}.lock-identity.json`);
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
      await writeFile(manifestPath, `${JSON.stringify(tamper(manifest), null, 2)}\n`, {
        mode: 0o600,
      });
      const store = new FileGitHubPolicyOperationStore(root);

      expect(
        await store.compareAndSwap({
          operationId,
          expectedRevision: 1,
          next: Object.freeze({ ...initial, phase: "mutation_started" }),
        }),
      ).toMatchObject({ ok: false, error: { code } });
      expect(JSON.parse(await readFile(join(root, `${operationId}.json`), "utf8"))).toMatchObject({
        revision: 1,
        phase: "reserved",
      });
      await store.close();
    },
  );

  it("does not authorize another store while a lock path is replaced and later restored", async () => {
    const root = await directory();
    const initialized = new FileGitHubPolicyOperationStore(root);
    expect(
      await initialized.compareAndSwap({ operationId, expectedRevision: null, next: initial }),
    ).toMatchObject({ ok: true, value: { revision: 1 } });
    await initialized.close();
    const canonical = join(root, `${operationId}.lock`);
    const displaced = join(root, `${operationId}.lock.displaced`);
    const replacementPath = join(root, `${operationId}.lock.replacement`);
    await rename(canonical, displaced);
    const replacementDirectory = openHeldSecureDirectory(root, [], { create: false });
    if (!replacementDirectory.ok) throw new Error(replacementDirectory.error.code);
    const replacement = await replacementDirectory.value.acquireLock(
      `${operationId}.lock`,
      "replacement-owner",
    );
    if (!replacement.ok) throw new Error(replacement.error.code);
    const competitor = new FileGitHubPolicyOperationStore(root);

    expect(
      await competitor.compareAndSwap({
        operationId,
        expectedRevision: 1,
        next: Object.freeze({ ...initial, phase: "mutation_started" }),
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(JSON.parse(await readFile(join(root, `${operationId}.json`), "utf8"))).toMatchObject({
      revision: 1,
      phase: "reserved",
    });

    await replacement.value.release();
    await replacementDirectory.value.close();
    await rename(canonical, replacementPath);
    await rename(displaced, canonical);
    expect(
      await competitor.compareAndSwap({
        operationId,
        expectedRevision: 1,
        next: Object.freeze({ ...initial, phase: "mutation_started" }),
      }),
    ).toMatchObject({ ok: true, value: { revision: 2 } });
    await competitor.close();
  });

  it("allows one guarded mutation after a transient replace-restore but never a second CAS", async () => {
    const root = await directory();
    const initialized = new FileGitHubPolicyOperationStore(root);
    expect(
      await initialized.compareAndSwap({ operationId, expectedRevision: null, next: initial }),
    ).toMatchObject({ ok: true, value: { revision: 1 } });
    await initialized.close();
    const first = new FileGitHubPolicyOperationStore(root, new TransientRestoringWriter(root));
    const second = new FileGitHubPolicyOperationStore(root);

    expect(
      await first.compareAndSwap({
        operationId,
        expectedRevision: 1,
        next: Object.freeze({ ...initial, phase: "mutation_started" }),
      }),
    ).toMatchObject({ ok: true, value: { revision: 2 } });
    expect(
      await second.compareAndSwap({
        operationId,
        expectedRevision: 1,
        next: Object.freeze({ ...initial, phase: "mutation_started" }),
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(JSON.parse(await readFile(join(root, `${operationId}.json`), "utf8"))).toMatchObject({
      revision: 2,
      phase: "mutation_started",
    });
    await first.close();
    await second.close();
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
