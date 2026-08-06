/**
 * E006 unit tests: `E2eCaseManifestStore` -- the durable, 0600, marker-scoped journal that
 * `seed-reset.ts` is only ever allowed to read/mutate through. These tests use a real temporary
 * directory on disk (no fakes needed -- this module's only dependency is the filesystem) and
 * never touch Linear/GitHub.
 */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  E2eCaseManifestStore,
  caseRunIdPattern,
  generateCaseRunId,
} from "./seed-reset-manifest.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "e006-manifest-"));
  roots.push(value);
  return value;
}

const fixedNow = "2026-08-06T12:00:00.000Z";

describe("generateCaseRunId", () => {
  it("produces an e2e-<caseId>-<hex> id matching the bounded naming convention", () => {
    const caseRunId = generateCaseRunId("E101", () => "deadbeefcafef00d");
    expect(caseRunId).toBe("e2e-e101-deadbeefcafef00d");
    expect(caseRunIdPattern.test(caseRunId)).toBe(true);
  });

  it("normalizes non-alphanumeric characters out of the caseId", () => {
    const caseRunId = generateCaseRunId("E101_smoke test!", () => "abc12345");
    expect(caseRunId).toBe("e2e-e101smoketest-abc12345");
    expect(caseRunIdPattern.test(caseRunId)).toBe(true);
  });
});

describe("E2eCaseManifestStore", () => {
  it("returns undefined for a caseRunId with no manifest yet", async () => {
    const store = new E2eCaseManifestStore(await temporaryRoot());
    const loaded = await store.load("e2e-e101-abc12345");
    expect(loaded).toEqual({ ok: true, value: undefined });
  });

  it("creates the manifest on the first appendEntry and appends subsequent entries", async () => {
    const directory = await temporaryRoot();
    const store = new E2eCaseManifestStore(directory);
    const caseRunId = "e2e-e101-abc12345";

    const first = await store.appendEntry("E101", caseRunId, {
      kind: "linearIssue",
      provider: "linear",
      id: "issue-1",
      marker: "agent-team-e2e:e2e-e101-abc12345",
      createdAt: fixedNow,
      teamId: "team-1",
      projectId: "project-1",
      workflowStateId: "state-1",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.entries).toHaveLength(1);
    expect(first.value.caseId).toBe("E101");
    expect(first.value.caseRunId).toBe(caseRunId);

    const second = await store.appendEntry("E101", caseRunId, {
      kind: "localWorktree",
      provider: "local",
      id: "/tmp/some/worktree",
      marker: "agent-team-e2e:e2e-e101-abc12345",
      createdAt: fixedNow,
      repositoryRoot: "/tmp/some/repo",
      branch: "task/e101",
      headSha: "a".repeat(40),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.entries).toHaveLength(2);

    const reloaded = await store.load(caseRunId);
    expect(reloaded).toEqual({ ok: true, value: second.value });
  });

  it("writes the manifest file with private (0600) permissions", async () => {
    const directory = await temporaryRoot();
    const store = new E2eCaseManifestStore(directory);
    const caseRunId = "e2e-e101-abc12345";
    await store.appendEntry("E101", caseRunId, {
      kind: "linearIssue",
      provider: "linear",
      id: "issue-1",
      marker: "agent-team-e2e:e2e-e101-abc12345",
      createdAt: fixedNow,
      teamId: "team-1",
      projectId: "project-1",
      workflowStateId: "state-1",
    });
    const info = await stat(join(directory, `${caseRunId}.json`));
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("rejects a duplicate kind+id as a conflict, never silently overwriting", async () => {
    const directory = await temporaryRoot();
    const store = new E2eCaseManifestStore(directory);
    const caseRunId = "e2e-e101-abc12345";
    const entry = {
      kind: "linearIssue" as const,
      provider: "linear" as const,
      id: "issue-1",
      marker: "agent-team-e2e:e2e-e101-abc12345",
      createdAt: fixedNow,
      teamId: "team-1",
      projectId: "project-1",
      workflowStateId: "state-1",
    };
    const first = await store.appendEntry("E101", caseRunId, entry);
    expect(first.ok).toBe(true);
    const duplicate = await store.appendEntry("E101", caseRunId, entry);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.code).toBe("conflict");
  });

  it("rejects appending under a different caseId for the same caseRunId", async () => {
    const directory = await temporaryRoot();
    const store = new E2eCaseManifestStore(directory);
    const caseRunId = "e2e-e101-abc12345";
    await store.appendEntry("E101", caseRunId, {
      kind: "linearIssue",
      provider: "linear",
      id: "issue-1",
      marker: "agent-team-e2e:e2e-e101-abc12345",
      createdAt: fixedNow,
      teamId: "team-1",
      projectId: "project-1",
      workflowStateId: "state-1",
    });
    const mismatched = await store.appendEntry("E999-not-this-case", caseRunId, {
      kind: "localWorktree",
      provider: "local",
      id: "/tmp/some/worktree",
      marker: "agent-team-e2e:e2e-e101-abc12345",
      createdAt: fixedNow,
      repositoryRoot: "/tmp/some/repo",
      branch: "task/e101",
      headSha: "a".repeat(40),
    });
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) expect(mismatched.error.code).toBe("invariant_violation");
  });

  describe("recordResolution", () => {
    it("returns not_found for a caseRunId with no manifest", async () => {
      const store = new E2eCaseManifestStore(await temporaryRoot());
      const result = await store.recordResolution("e2e-e101-abc12345", "linearIssue", "issue-1", {
        state: "confirmed",
        resolvedAt: fixedNow,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("not_found");
    });

    it("returns not_found for an entry that was never recorded", async () => {
      const directory = await temporaryRoot();
      const store = new E2eCaseManifestStore(directory);
      const caseRunId = "e2e-e101-abc12345";
      await store.appendEntry("E101", caseRunId, {
        kind: "linearIssue",
        provider: "linear",
        id: "issue-1",
        marker: "agent-team-e2e:e2e-e101-abc12345",
        createdAt: fixedNow,
        teamId: "team-1",
        projectId: "project-1",
        workflowStateId: "state-1",
      });
      const result = await store.recordResolution(caseRunId, "linearIssue", "issue-999", {
        state: "confirmed",
        resolvedAt: fixedNow,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("not_found");
    });

    it("updates exactly the matching entry, leaving every other entry untouched", async () => {
      const directory = await temporaryRoot();
      const store = new E2eCaseManifestStore(directory);
      const caseRunId = "e2e-e101-abc12345";
      await store.appendEntry("E101", caseRunId, {
        kind: "linearIssue",
        provider: "linear",
        id: "issue-1",
        marker: "agent-team-e2e:e2e-e101-abc12345",
        createdAt: fixedNow,
        teamId: "team-1",
        projectId: "project-1",
        workflowStateId: "state-1",
      });
      await store.appendEntry("E101", caseRunId, {
        kind: "localWorktree",
        provider: "local",
        id: "/tmp/some/worktree",
        marker: "agent-team-e2e:e2e-e101-abc12345",
        createdAt: fixedNow,
        repositoryRoot: "/tmp/some/repo",
        branch: "task/e101",
        headSha: "a".repeat(40),
      });

      const resolved = await store.recordResolution(caseRunId, "linearIssue", "issue-1", {
        state: "confirmed",
        resolvedAt: "2026-08-06T13:00:00.000Z",
      });
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      const linearEntry = resolved.value.entries.find((entry) => entry.kind === "linearIssue");
      const worktreeEntry = resolved.value.entries.find((entry) => entry.kind === "localWorktree");
      expect(linearEntry?.resolution).toEqual({
        state: "confirmed",
        resolvedAt: "2026-08-06T13:00:00.000Z",
      });
      expect(worktreeEntry?.resolution).toBeUndefined();
    });
  });
});
