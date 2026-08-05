import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalGitAdapter } from "../../src/adapters/git/index.js";
import {
  TrustedProjectConfigLoader,
  serializeTrustedProjectConfig,
  trustedProjectConfigPath,
  type TrustedProjectConfig,
} from "../../src/application/projects/index.js";
import { projectSchema, type Project } from "../../src/domain/project/index.js";
import { sha256Digest } from "../../src/domain/review/index.js";

const temporaryDirectories: string[] = [];

function git(cwd: string, arguments_: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", [...arguments_], { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error === null) resolve(stdout);
      else reject(new Error(stderr));
    });
  });
}

function config(project: Project, rule: string): TrustedProjectConfig {
  return {
    schemaVersion: 1,
    projectId: project.id,
    defaultBranch: project.defaultBranch,
    platforms: {
      workManagement: project.workManagement,
      sourceControl: project.sourceControl,
    },
    projectRules: [rule],
    roleInstructions: {},
    commands: {
      quality: [{ executable: "pnpm", arguments: ["test"] }],
      visualReview: [],
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("default-branch trusted project config", () => {
  it("ignores a committed feature-branch config until it is merged into default branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-project-registry-"));
    temporaryDirectories.push(root);
    const repository = join(root, "repository");
    await mkdir(join(repository, ".agent-team"), { recursive: true });
    await git(repository, ["init", "--initial-branch=main"]);
    await git(repository, ["config", "user.name", "Agent Team Test"]);
    await git(repository, ["config", "user.email", "agent-team@example.invalid"]);
    const project = projectSchema.parse({
      schemaVersion: 1,
      id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
      displayName: "Sandbox",
      localRepositoryPath: repository,
      defaultBranch: "main",
      workManagement: { provider: "linear", containerId: "workspace", projectId: "team" },
      sourceControl: { provider: "github", repository: "owner/sandbox" },
    });
    await writeFile(
      join(repository, trustedProjectConfigPath),
      `${JSON.stringify(config(project, "default-branch-rule"), null, 2)}\n`,
      "utf8",
    );
    await git(repository, ["add", "--", trustedProjectConfigPath]);
    await git(repository, ["commit", "-m", "trusted config"]);

    const adapter = new LocalGitAdapter();
    const primary = await adapter.inspectRepository({ rootPath: repository });
    if (!primary.ok) throw new Error(primary.error.code);
    const worktree = await adapter.createWorktree(
      {
        rootPath: repository,
        path: join(root, "feature-worktree"),
        branch: "feature/unmerged-config",
        startPoint: primary.value.headSha,
      },
      { idempotencyKey: "create:feature-config" },
    );
    if (!worktree.ok) throw new Error(worktree.error.code);
    await writeFile(
      join(worktree.value.path, trustedProjectConfigPath),
      `${JSON.stringify(config(project, "unmerged-feature-rule"), null, 2)}\n`,
      "utf8",
    );
    const staged = await adapter.stagePaths(worktree.value, [trustedProjectConfigPath], {
      idempotencyKey: "stage:feature-config",
    });
    if (!staged.ok) throw new Error(staged.error.code);
    const committed = await adapter.commit(
      {
        worktree: worktree.value,
        message: "unmerged config",
        expectedStagedPaths: [trustedProjectConfigPath],
      },
      { idempotencyKey: "commit:feature-config" },
    );
    if (!committed.ok) throw new Error(committed.error.code);

    const trusted = config(project, "default-branch-rule");
    const serialized = serializeTrustedProjectConfig(trusted);
    const markerDigest = sha256Digest("marker-binding");
    if (!serialized.ok || !markerDigest.ok) throw new Error("digest unavailable");
    const loaded = await new TrustedProjectConfigLoader(adapter, {
      read: () =>
        Promise.resolve({
          ok: true as const,
          value: {
            schemaVersion: 1 as const,
            source: "source_control_default_branch" as const,
            setupSessionId: "setup-session-1",
            projectId: project.id,
            repository: project.sourceControl.repository,
            changeRequestId: "PR_node_1",
            setupHeadSha: committed.value.sha,
            mergeCommitSha: primary.value.headSha,
            authoritativeRevision: primary.value.headSha,
            defaultBranch: project.defaultBranch,
            configDigest: serialized.value.contentDigest,
            linearAuditIssueId: "LINEAR-AUDIT-1",
            gateEvidenceDigest: markerDigest.value,
            auditReceiptsDigest: markerDigest.value,
            approvalSource: "local_ui" as const,
            approvalReferenceDigest: markerDigest.value,
            approvalConsumeOperationDigest: markerDigest.value,
            authorityDigest: markerDigest.value,
            approvalNonceDigest: markerDigest.value,
          },
        }),
    }).load(project);
    expect(loaded).toMatchObject({
      state: "ready",
      revisionSha: primary.value.headSha,
      config: { projectRules: ["default-branch-rule"] },
    });
    expect(loaded.state === "ready" ? loaded.revisionSha : undefined).not.toBe(committed.value.sha);
  });
});
