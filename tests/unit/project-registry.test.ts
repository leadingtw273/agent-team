import { describe, expect, it } from "vitest";

import {
  ProjectRegistry,
  TrustedProjectConfigLoader,
  trustedProjectConfigPath,
  type TrustedProjectConfig,
  type TrustedProjectGitPort,
} from "../../src/application/projects/index.js";
import { domainError, err, ok } from "../../src/domain/foundation/index.js";
import { projectSchema, type Project } from "../../src/domain/project/index.js";

const revisionSha = "a".repeat(40);

function project(overrides: Partial<Project> = {}): Project {
  return projectSchema.parse({
    schemaVersion: 1,
    id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    displayName: "Agent Team Sandbox",
    localRepositoryPath: "/tmp/agent-team-sandbox",
    defaultBranch: "main",
    workManagement: { provider: "linear", containerId: "workspace", projectId: "team" },
    sourceControl: { provider: "github", repository: "leadingtw273/agent-team-sandbox" },
    ...overrides,
  });
}

function config(value = project()): TrustedProjectConfig {
  return {
    schemaVersion: 1,
    projectId: value.id,
    defaultBranch: value.defaultBranch,
    platforms: {
      workManagement: value.workManagement,
      sourceControl: value.sourceControl,
    },
    projectRules: ["Run the quality gate before Push."],
    roleInstructions: { implementer: ["Keep changes inside the declared region."] },
    commands: {
      quality: [{ executable: "pnpm", arguments: ["test"] }],
      visualReview: [{ executable: "pnpm", arguments: ["run", "test:visual"] }],
    },
  };
}

function gitWith(value: unknown): TrustedProjectGitPort {
  const content = typeof value === "string" ? value : JSON.stringify(value);
  return {
    readTextFileAtRevision: (command) =>
      Promise.resolve(
        ok({
          revisionSha,
          path: command.path,
          content,
          byteLength: Buffer.byteLength(content, "utf8"),
        }),
      ),
  };
}

describe("trusted project config loader", () => {
  it("loads only the configured default-branch path and binds the exact revision", async () => {
    const requests: unknown[] = [];
    const git: TrustedProjectGitPort = {
      readTextFileAtRevision: (command) => {
        requests.push(command);
        const content = JSON.stringify(config());
        return Promise.resolve(
          ok({
            revisionSha,
            path: command.path,
            content,
            byteLength: Buffer.byteLength(content, "utf8"),
          }),
        );
      },
    };
    const result = await new TrustedProjectConfigLoader(git).load(project());

    expect(result).toMatchObject({ state: "ready", revisionSha });
    expect(requests).toEqual([
      expect.objectContaining({
        rootPath: "/tmp/agent-team-sandbox",
        revision: "refs/heads/main",
        path: trustedProjectConfigPath,
      }),
    ]);
  });

  it.each([
    ["trusted_config_invalid", "not-json"],
    ["trusted_config_invalid", { ...config(), schemaVersion: 2 }],
    [
      "project_id_mismatch",
      { ...config(), projectId: "project_018f47d2-77a4-7cc1-8ef2-1123456789ab" },
    ],
    ["default_branch_mismatch", { ...config(), defaultBranch: "develop" }],
    [
      "platform_mismatch",
      {
        ...config(),
        platforms: {
          ...config().platforms,
          sourceControl: { provider: "github", repository: "other/repository" },
        },
      },
    ],
  ] as const)("fails closed with %s", async (reason, value) => {
    await expect(
      new TrustedProjectConfigLoader(gitWith(value)).load(project()),
    ).resolves.toMatchObject({
      state: "rejected",
      reason,
    });
  });

  it("distinguishes a missing trusted file from an unavailable Git boundary", async () => {
    const missing = new TrustedProjectConfigLoader({
      readTextFileAtRevision: () => Promise.resolve(err(domainError("not_found"))),
    });
    const unavailable = new TrustedProjectConfigLoader({
      readTextFileAtRevision: () => Promise.resolve(err(domainError("external_failure"))),
    });

    await expect(missing.load(project())).resolves.toMatchObject({
      state: "rejected",
      reason: "trusted_config_missing",
    });
    await expect(unavailable.load(project())).resolves.toMatchObject({
      state: "rejected",
      reason: "trusted_config_unavailable",
    });
  });

  it("rejects shell commands and unknown config fields", async () => {
    const shell = {
      ...config(),
      commands: {
        ...config().commands,
        quality: [{ executable: "bash", arguments: ["-lc", "pnpm test"] }],
      },
    };
    const extra = { ...config(), weeklyQuota: 80 };

    await expect(
      new TrustedProjectConfigLoader(gitWith(shell)).load(project()),
    ).resolves.toMatchObject({
      state: "rejected",
      reason: "trusted_config_invalid",
    });
    await expect(
      new TrustedProjectConfigLoader(gitWith(extra)).load(project()),
    ).resolves.toMatchObject({
      state: "rejected",
      reason: "trusted_config_invalid",
    });
  });

  it("rejects recognizable Secrets and inconsistent adapter metadata", async () => {
    const secret = {
      ...config(),
      projectRules: ["token=github_pat_abcdefghijklmnopqrstuvwxyz123456"],
    };
    const inconsistent: TrustedProjectGitPort = {
      readTextFileAtRevision: () =>
        Promise.resolve(
          ok({
            revisionSha,
            path: "other.json",
            content: JSON.stringify(config()),
            byteLength: 1,
          }),
        ),
    };

    await expect(
      new TrustedProjectConfigLoader(gitWith(secret)).load(project()),
    ).resolves.toMatchObject({
      state: "rejected",
      reason: "secret_in_trusted_config",
    });
    await expect(
      new TrustedProjectConfigLoader(inconsistent).load(project()),
    ).resolves.toMatchObject({
      state: "rejected",
      reason: "trusted_config_unavailable",
    });
  });
});

describe("project registry", () => {
  it("isolates rejected projects without discarding an unrelated ready project", async () => {
    const first = project();
    const second = project({
      id: projectSchema.parse({
        ...first,
        id: "project_018f47d2-77a4-7cc1-8ef2-1123456789ab",
        localRepositoryPath: "/tmp/second",
        sourceControl: { provider: "github", repository: "owner/second" },
      }).id,
      localRepositoryPath: "/tmp/second",
      sourceControl: { provider: "github", repository: "owner/second" },
    });
    const loader = new TrustedProjectConfigLoader({
      readTextFileAtRevision: (command) => {
        const selected = command.rootPath === first.localRepositoryPath ? first : second;
        const value = selected === first ? config(first) : { ...config(second), schemaVersion: 2 };
        const content = JSON.stringify(value);
        return Promise.resolve(
          ok({
            revisionSha,
            path: command.path,
            content,
            byteLength: Buffer.byteLength(content, "utf8"),
          }),
        );
      },
    });
    const registry = await new ProjectRegistry(loader).load([first, second]);

    expect(registry.ready.map((entry) => entry.project.id)).toEqual([first.id]);
    expect(registry.rejected).toEqual([
      expect.objectContaining({ project: second, reason: "trusted_config_invalid" }),
    ]);
  });

  it("rejects duplicate IDs, local paths, or source repositories before Git reads", async () => {
    let reads = 0;
    const first = project();
    const duplicate = { ...first, displayName: "Duplicate" };
    const registry = await new ProjectRegistry(
      new TrustedProjectConfigLoader({
        readTextFileAtRevision: () => {
          reads += 1;
          return Promise.resolve(err(domainError("not_found")));
        },
      }),
    ).load([first, duplicate]);

    expect(registry.ready).toEqual([]);
    expect(registry.rejected).toHaveLength(2);
    expect(registry.rejected.every((entry) => entry.reason === "registry_conflict")).toBe(true);
    expect(reads).toBe(0);
  });
});
