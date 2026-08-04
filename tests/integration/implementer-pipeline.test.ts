import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { GitPreflight, LocalGitAdapter } from "../../src/adapters/git/index.js";
import {
  ImplementerPipeline,
  type ImplementerPipelinePorts,
} from "../../src/application/pipelines/index.js";
import { ok, parseInstant, type Instant } from "../../src/domain/foundation/index.js";
import { jobSchema } from "../../src/domain/jobs/index.js";
import { issueSchema, projectSchema } from "../../src/domain/project/index.js";
import { createRequirementSnapshot } from "../../src/domain/review/index.js";
import { trustedProjectConfigSchema } from "../../src/application/projects/index.js";
import type { ProviderRunHandle } from "../../src/application/ports/index.js";

const run = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, arguments_: readonly string[]): Promise<string> {
  const result = await run("git", arguments_, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-implementer-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function instant(value: string): Instant {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

describe("Implementer Pipeline with a real temporary Git repository", () => {
  it("creates an isolated Worktree, commits scoped Diff, pushes, and opens Draft before CI waiting", async () => {
    const root = await temporaryDirectory();
    const repository = join(root, "repository");
    const remote = join(root, "remote.git");
    const worktreePath = join(root, "worktrees", "ENG-123");
    await mkdir(repository, { recursive: true });
    await mkdir(join(root, "worktrees"), { recursive: true });
    await git(repository, ["init", "-b", "main"]);
    await git(repository, ["config", "user.email", "agent-team@example.invalid"]);
    await git(repository, ["config", "user.name", "Agent Team Fixture"]);
    await writeFile(join(repository, "README.md"), "fixture\n", "utf8");
    await git(repository, ["add", "README.md"]);
    await git(repository, ["commit", "-m", "initial"]);
    await git(root, ["init", "--bare", remote]);
    await git(repository, ["remote", "add", "origin", remote]);
    await git(repository, ["push", "-u", "origin", "main"]);
    const baseSha = await git(repository, ["rev-parse", "HEAD"]);

    const now = instant("2026-08-05T00:00:00.000Z");
    const project = projectSchema.parse({
      schemaVersion: 1,
      id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
      displayName: "Temp fixture",
      localRepositoryPath: repository,
      defaultBranch: "main",
      workManagement: { provider: "linear", containerId: "workspace", projectId: "team" },
      sourceControl: { provider: "github", repository: "owner/repository" },
    });
    const issue = issueSchema.parse({
      schemaVersion: 1,
      id: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab",
      projectId: project.id,
      externalId: "ENG-123",
      title: "Real Git flow",
      goal: "Prove the full local Git flow.",
      background: "C005 requires a Temp Repo integration test.",
      acceptanceCriteria: ["Draft waits for CI."],
      inScope: ["src/feature"],
      outOfScope: ["Reviewer"],
      dependencies: { kind: "none" },
      priority: "high",
      agentRole: "implementer",
      reviewRequirement: "code_review",
      estimatedMinutes: 30,
      changeRegions: [{ path: "src/feature", coverage: "subtree" }],
    });
    const snapshot = createRequirementSnapshot(issue, now);
    if (!snapshot.ok) throw new Error(snapshot.error.code);
    const job = jobSchema.parse({
      schemaVersion: 1,
      id: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
      projectId: project.id,
      issueId: issue.id,
      createdAt: now,
      watchdogExtensionGranted: false,
      attempts: { processRecoveries: 0, ciFixRounds: 0, reviewerFixRounds: 0, reviewRuns: 0 },
    });
    const config = trustedProjectConfigSchema.parse({
      schemaVersion: 1,
      projectId: project.id,
      defaultBranch: "main",
      platforms: {
        workManagement: project.workManagement,
        sourceControl: project.sourceControl,
      },
      projectRules: ["Stay in declared scope."],
      roleInstructions: {},
      commands: {
        quality: [{ executable: "node", arguments: ["--test"] }],
        visualReview: [],
      },
    });
    const localGit = new LocalGitAdapter();
    const providerHandle: ProviderRunHandle = {
      runId: "fixture-run",
      events: {
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
        },
      },
      completion: () => Promise.resolve(ok({ outcome: "completed" })),
      respondToToolRequest: () => Promise.resolve(ok(undefined)),
      interrupt: () => Promise.resolve(ok(undefined)),
    };
    const branch = "feature/ENG-123-real-flow";
    const ports: ImplementerPipelinePorts = {
      git: localGit,
      preflight: new GitPreflight(localGit),
      provider: {
        inspectCapabilities: () =>
          Promise.resolve(
            ok({
              provider: "fixture",
              cliVersion: "1",
              models: ["fixture"],
              supportsResume: false,
              supportsStructuredEvents: true,
              supportsDynamicApproval: false,
              supportsVisualInput: false,
            }),
          ),
        start: async () => {
          await mkdir(join(worktreePath, "src", "feature"), { recursive: true });
          await writeFile(
            join(worktreePath, "src", "feature", "index.ts"),
            "export const ready = true;\n",
            "utf8",
          );
          return ok(providerHandle);
        },
      },
      sourceControl: {
        createDraftChangeRequest: async () => {
          const headSha = await git(root, [
            "--git-dir",
            remote,
            "rev-parse",
            `refs/heads/${branch}`,
          ]);
          return ok({
            id: "PR_fixture",
            number: 1,
            url: "https://example.invalid/pull/1",
            state: "open",
            draft: true,
            baseBranch: "main",
            headBranch: branch,
            headSha,
            mergeability: "unknown",
            autoMergeEnabled: false,
            updatedAt: now,
          });
        },
        getCommitChecks: (_repository, headSha) =>
          Promise.resolve(ok({ headSha, aggregate: "pending", checks: [] })),
      },
      scopeCheckpoint: {
        preserve: () => Promise.resolve(ok({ checkpointId: "unused" })),
      },
      toolDecisions: {
        decide: () =>
          Promise.resolve(ok({ response: "approve", pause: false, summary: "ordinary" })),
      },
    };

    const outcome = await new ImplementerPipeline(ports).run({
      job,
      project,
      trustedConfig: config,
      requirementSnapshot: snapshot.value,
      role: "implementer",
      model: "fixture",
      repositoryRoot: repository,
      baseRevision: baseSha,
      worktreePath,
      branch,
      remote: "origin",
      commitMessage: "ENG-123 real flow",
      pullRequest: { title: "ENG-123 real flow", body: "Temp Repo acceptance evidence." },
      controllerDirective: "Create the fixture file only.",
      externalData: [],
      deadlineAt: instant("2026-08-05T00:30:00.000Z"),
      expectedUntrackedPaths: ["src/feature/index.ts"],
      idempotencyKeyPrefix: "integration:ENG-123",
    });

    if (outcome.state !== "ci_waiting") throw new Error(JSON.stringify(outcome));
    expect(outcome).toMatchObject({
      state: "ci_waiting",
      changeRequest: { draft: true, headBranch: branch },
      checks: { aggregate: "pending" },
    });
    expect(await git(worktreePath, ["status", "--porcelain"])).toBe("");
    const remoteSha = await git(root, ["--git-dir", remote, "rev-parse", `refs/heads/${branch}`]);
    expect(remoteSha).toBe(outcome.commit.sha);
  });
});
