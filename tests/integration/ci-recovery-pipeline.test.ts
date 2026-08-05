import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { GitPreflight, LocalGitAdapter } from "../../src/adapters/git/index.js";
import {
  CiRecoveryPipeline,
  type CiRecoveryPipelinePorts,
} from "../../src/application/pipelines/index.js";
import { trustedProjectConfigSchema } from "../../src/application/projects/index.js";
import type { ProviderRunHandle } from "../../src/application/ports/index.js";
import { ok, parseInstant, type Instant } from "../../src/domain/foundation/index.js";
import { jobSchema } from "../../src/domain/jobs/index.js";
import { issueSchema, projectSchema } from "../../src/domain/project/index.js";
import { createRequirementSnapshot } from "../../src/domain/review/index.js";

const run = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, arguments_: readonly string[]): Promise<string> {
  const result = await run("git", arguments_, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-ci-recovery-"));
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

describe("CI Recovery Pipeline with a real temporary Git repository", () => {
  it("repairs failed CI on the same Worktree and Branch, then pushes an exact-SHA diff", async () => {
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
      displayName: "CI recovery fixture",
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
      title: "Repair real CI failure",
      goal: "Push a scoped repair from the original Worktree.",
      background: "The first CI run failed.",
      acceptanceCriteria: ["The repair is pushed to the existing Branch."],
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
      attempts: { processRecoveries: 0, ciFixRounds: 0, reviewerFixRounds: 1, reviewRuns: 1 },
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
      roleInstructions: { implementer: ["Fix only CI evidence."] },
      commands: {
        quality: [{ executable: "node", arguments: ["--test"] }],
        visualReview: [],
      },
    });

    const localGit = new LocalGitAdapter();
    const branch = "feature/ENG-123-ci-repair";
    const created = await localGit.createWorktree(
      { rootPath: repository, path: worktreePath, branch, startPoint: baseSha },
      { idempotencyKey: "integration:ci:create" },
    );
    if (!created.ok) throw new Error(created.error.code);
    const initialPush = await localGit.push(created.value, "origin", {
      idempotencyKey: "integration:ci:initial-push",
    });
    if (!initialPush.ok) throw new Error(initialPush.error.code);

    const providerHandle: ProviderRunHandle = {
      runId: "fixture-ci-repair",
      events: {
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
        },
      },
      completion: () => Promise.resolve(ok({ outcome: "completed", sessionId: "same-agent" })),
      respondToToolRequest: () => Promise.resolve(ok(undefined)),
      interrupt: () => Promise.resolve(ok(undefined)),
    };
    const persistedCiRounds: number[] = [];
    let checkRead = 0;
    const ports: CiRecoveryPipelinePorts = {
      git: localGit,
      preflight: new GitPreflight(localGit),
      jobs: {
        update: (updated) => {
          persistedCiRounds.push(updated.attempts.ciFixRounds);
          return Promise.resolve(ok({ durability: "confirmed" }));
        },
      },
      provider: {
        inspectCapabilities: () =>
          Promise.resolve(
            ok({
              provider: "fixture",
              cliVersion: "1",
              models: ["fixture"],
              supportsResume: true,
              supportsStructuredEvents: true,
              supportsDynamicApproval: false,
              supportsVisualInput: false,
            }),
          ),
        start: async (runRequest) => {
          expect(runRequest.workingDirectory).toBe(worktreePath);
          expect(runRequest.job.attempts).toMatchObject({
            ciFixRounds: 0,
            reviewerFixRounds: 1,
            reviewRuns: 1,
          });
          await mkdir(join(worktreePath, "src", "feature"), { recursive: true });
          await writeFile(
            join(worktreePath, "src", "feature", "repair.ts"),
            "export const ciRepaired = true;\n",
            "utf8",
          );
          return ok(providerHandle);
        },
      },
      sourceControl: {
        getCommitChecks: (_repository, headSha) => {
          checkRead += 1;
          return Promise.resolve(
            ok({
              headSha,
              aggregate: checkRead === 1 ? "failure" : "pending",
              checks: [
                {
                  name: "test",
                  status: checkRead === 1 ? "completed" : "queued",
                  conclusion: checkRead === 1 ? "failure" : null,
                },
              ],
            }),
          );
        },
      },
      checkpoint: {
        preserve: () => Promise.resolve(ok({ checkpointId: "unused" })),
      },
      toolDecisions: {
        decide: () =>
          Promise.resolve(ok({ response: "approve", pause: false, summary: "ordinary" })),
      },
    };

    const outcome = await new CiRecoveryPipeline(ports).run({
      trigger: { kind: "polling" },
      job,
      project,
      trustedConfig: config,
      requirementSnapshot: snapshot.value,
      worktree: created.value,
      changeRequest: {
        id: "PR_fixture",
        number: 7,
        url: "https://example.invalid/pull/7",
        state: "open",
        draft: true,
        baseBranch: "main",
        headBranch: branch,
        headSha: baseSha,
        mergeability: "unknown",
        autoMergeEnabled: false,
        updatedAt: now,
      },
      model: "fixture",
      remote: "origin",
      commitMessage: "ENG-123 repair CI",
      controllerDirective: "Repair only the failed CI evidence.",
      externalData: [],
      deadlineAt: instant("2026-08-05T00:30:00.000Z"),
      expectedUntrackedPaths: ["src/feature/repair.ts"],
      idempotencyKeyPrefix: "integration:ENG-123:ci",
    });

    if (outcome.state !== "repair_pushed") throw new Error(JSON.stringify(outcome));
    expect(outcome).toMatchObject({
      state: "repair_pushed",
      job: { attempts: { ciFixRounds: 1, reviewerFixRounds: 1, reviewRuns: 1 } },
      checks: { headSha: outcome.commit.sha, aggregate: "pending" },
      providerSessionId: "same-agent",
    });
    expect(persistedCiRounds).toEqual([1]);
    expect(await git(worktreePath, ["status", "--porcelain"])).toBe("");
    const remoteSha = await git(root, ["--git-dir", remote, "rev-parse", `refs/heads/${branch}`]);
    expect(remoteSha).toBe(outcome.commit.sha);
  });
});
