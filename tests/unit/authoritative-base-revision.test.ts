/**
 * C015x decision 1 (acceptance criterion ①): unit tests for `resolveAuthoritativeBaseRevision`'s
 * own orchestration -- step ① (GitHub `default_branch` readback + cross-check against the
 * project's own trusted `defaultBranch`) happens here, before steps ②-⑤ (delegated to
 * `GitPort.resolveAuthoritativeBranch`, covered end to end against real git in
 * tests/integration/authoritative-branch.test.ts). Both ports are fakes here -- this file's job is
 * the orchestration's own fail-closed branching, not either adapter's real behavior.
 */
import { describe, expect, it } from "vitest";

import { resolveAuthoritativeBaseRevision } from "../../src/cli/dispatch/authoritative-base.js";
import { domainError, err, ok } from "../../src/domain/foundation/index.js";
import { projectSchema } from "../../src/domain/project/index.js";

const project = projectSchema.parse({
  schemaVersion: 1,
  id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  displayName: "Sandbox",
  localRepositoryPath: "/tmp/agent-team-fixture",
  defaultBranch: "main",
  workManagement: { provider: "linear", containerId: "team-1", projectId: "linear-proj-1" },
  sourceControl: { provider: "github", repository: "owner/sandbox" },
});

const sha = "a".repeat(40);

describe("resolveAuthoritativeBaseRevision (C015x decision 1)", () => {
  it("resolves the authoritative base once GitHub's own default_branch matches and the branch head resolves", async () => {
    const calls: unknown[] = [];
    const result = await resolveAuthoritativeBaseRevision(
      project,
      {
        sourceControl: {
          getRepositoryMetadata: () => Promise.resolve(ok({ defaultBranch: "main" })),
        },
        git: {
          resolveAuthoritativeBranch: (request) => {
            calls.push(request);
            return Promise.resolve(ok({ remote: "origin", branch: "main", sha }));
          },
        },
      },
      { idempotencyKey: "test-1" },
    );

    expect(result).toEqual({ ok: true, value: { baseRevision: sha, defaultBranch: "main" } });
    expect(calls).toEqual([
      {
        rootPath: project.localRepositoryPath,
        remote: "origin",
        branch: "main",
        expectedRepository: "owner/sandbox",
      },
    ]);
  });

  it("① fails closed when GitHub's own repository metadata is unavailable, never reaching step ②", async () => {
    const gitCalls: unknown[] = [];
    const result = await resolveAuthoritativeBaseRevision(
      project,
      {
        sourceControl: {
          getRepositoryMetadata: () => Promise.resolve(err(domainError("unavailable"))),
        },
        git: {
          resolveAuthoritativeBranch: (request) => {
            gitCalls.push(request);
            return Promise.resolve(ok({ remote: "origin", branch: "main", sha }));
          },
        },
      },
      { idempotencyKey: "test-2" },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("default_branch_metadata_unavailable");
    }
    expect(gitCalls).toEqual([]);
  });

  it("① fails closed when GitHub's own default_branch disagrees with the project's trusted config, never reaching step ②", async () => {
    const gitCalls: unknown[] = [];
    const result = await resolveAuthoritativeBaseRevision(
      project,
      {
        sourceControl: {
          getRepositoryMetadata: () => Promise.resolve(ok({ defaultBranch: "master" })),
        },
        git: {
          resolveAuthoritativeBranch: (request) => {
            gitCalls.push(request);
            return Promise.resolve(ok({ remote: "origin", branch: "main", sha }));
          },
        },
      },
      { idempotencyKey: "test-3" },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        reason: "default_branch_mismatch",
        githubDefaultBranch: "master",
        configuredDefaultBranch: "main",
      });
    }
    expect(gitCalls).toEqual([]);
  });

  it("steps ②-⑤ fail closed (via GitPort.resolveAuthoritativeBranch) once step ① has already passed", async () => {
    const result = await resolveAuthoritativeBaseRevision(
      project,
      {
        sourceControl: {
          getRepositoryMetadata: () => Promise.resolve(ok({ defaultBranch: "main" })),
        },
        git: {
          resolveAuthoritativeBranch: () => Promise.resolve(err(domainError("conflict"))),
        },
      },
      { idempotencyKey: "test-4" },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("authoritative_branch_unavailable");
      if (result.error.reason === "authoritative_branch_unavailable") {
        expect(result.error.error.code).toBe("conflict");
      }
    }
  });
});
