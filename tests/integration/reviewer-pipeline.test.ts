import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { LocalGitAdapter } from "../../src/adapters/git/index.js";
import {
  ReviewerPipeline,
  type ReviewerPipelinePorts,
  type ReviewQualityDimension,
} from "../../src/application/pipelines/index.js";
import { trustedProjectConfigSchema } from "../../src/application/projects/index.js";
import type { ProviderRunHandle } from "../../src/application/ports/index.js";
import { ok, parseInstant, type Instant } from "../../src/domain/foundation/index.js";
import { jobSchema } from "../../src/domain/jobs/index.js";
import { issueSchema, projectSchema } from "../../src/domain/project/index.js";
import { createRequirementSnapshot, type ReviewIdentity } from "../../src/domain/review/index.js";

const run = promisify(execFile);
const temporaryDirectories: string[] = [];
const criterion = "The exact committed diff receives an independent code review.";
const qualityDimensions = [
  "test_effectiveness",
  "correctness",
  "error_handling",
  "boundaries",
  "security",
  "secrets",
  "readability",
  "module_boundaries",
  "maintainability",
  "duplication_overdesign",
  "compatibility",
  "scope",
  "documentation_migrations",
] as const satisfies readonly ReviewQualityDimension[];

async function git(cwd: string, arguments_: readonly string[]): Promise<string> {
  const result = await run("git", arguments_, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-reviewer-"));
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

function reviewerOutput(identity: ReviewIdentity) {
  return {
    schemaVersion: 1,
    role: "code_reviewer",
    verdict: "passed",
    requirementsDigest: identity.requirementsDigest,
    headSha: identity.headSha,
    diffDigest: identity.diffDigest,
    summary: "The committed diff and project quality rules passed review.",
    acceptanceCriteria: [
      {
        criterion,
        status: "passed",
        summary: "The exact committed diff was inspected.",
        evidenceSources: ["agent-team:diff"],
      },
    ],
    qualityChecks: qualityDimensions.map((dimension) => ({
      dimension,
      status: "passed",
      summary: `Reviewed ${dimension}.`,
      evidenceSources: ["agent-team:diff"],
    })),
    findings: [],
  };
}

describe("Reviewer Pipeline with a real temporary Git repository", () => {
  it("reviews a real effective diff in a clean read-only Worktree and marks Draft ready", async () => {
    const root = await temporaryDirectory();
    const repository = join(root, "repository");
    const worktreePath = join(root, "worktrees", "ENG-123");
    await mkdir(repository, { recursive: true });
    await mkdir(join(root, "worktrees"), { recursive: true });
    await git(repository, ["init", "-b", "main"]);
    await git(repository, ["config", "user.email", "agent-team@example.invalid"]);
    await git(repository, ["config", "user.name", "Agent Team Fixture"]);
    await writeFile(join(repository, "README.md"), "fixture\n", "utf8");
    await git(repository, ["add", "README.md"]);
    await git(repository, ["commit", "-m", "initial"]);
    const baseSha = await git(repository, ["rev-parse", "HEAD"]);

    const localGit = new LocalGitAdapter();
    const branch = "feature/ENG-123-review";
    const created = await localGit.createWorktree(
      { rootPath: repository, path: worktreePath, branch, startPoint: baseSha },
      { idempotencyKey: "integration:review:create" },
    );
    if (!created.ok) throw new Error(created.error.code);
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await writeFile(
      join(worktreePath, "src", "feature.ts"),
      "export const ready = true;\n",
      "utf8",
    );
    await git(worktreePath, ["add", "src/feature.ts"]);
    await git(worktreePath, ["commit", "-m", "feature"]);
    const headSha = await git(worktreePath, ["rev-parse", "HEAD"]);
    const worktree = { ...created.value, headSha };

    const now = instant("2026-08-05T00:00:00.000Z");
    const project = projectSchema.parse({
      schemaVersion: 1,
      id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
      displayName: "Reviewer Temp Repo",
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
      title: "Review real diff",
      goal: "Prove Reviewer Pipeline against real Git objects.",
      background: "The isolated branch has passed CI.",
      acceptanceCriteria: [criterion],
      inScope: ["src"],
      outOfScope: ["Implementer conversation"],
      dependencies: { kind: "none" },
      priority: "high",
      agentRole: "implementer",
      reviewRequirement: "code_review",
      estimatedMinutes: 30,
      changeRegions: [{ path: "src", coverage: "subtree" }],
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
      attempts: { processRecoveries: 0, ciFixRounds: 1, reviewerFixRounds: 0, reviewRuns: 0 },
    });
    const config = trustedProjectConfigSchema.parse({
      schemaVersion: 1,
      projectId: project.id,
      defaultBranch: "main",
      platforms: {
        workManagement: project.workManagement,
        sourceControl: project.sourceControl,
      },
      projectRules: ["Review only the exact committed diff."],
      roleInstructions: { code_reviewer: ["Inspect code quality independently."] },
      commands: {
        quality: [{ executable: "pnpm", arguments: ["test"] }],
        visualReview: [],
      },
    });

    let readyCalled = false;
    let persistedReviewRuns = 0;
    const providerHandle = (output: unknown): ProviderRunHandle => ({
      runId: "fresh-code-review",
      events: {
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          yield {
            kind: "output",
            observedAt: now,
            stream: "stdout",
            text: JSON.stringify(output),
          };
        },
      },
      completion: () => Promise.resolve(ok({ outcome: "completed", sessionId: "fresh-session" })),
      respondToToolRequest: () => Promise.resolve(ok(undefined)),
      interrupt: () => Promise.resolve(ok(undefined)),
    });
    const draft = {
      id: "PR_fixture",
      number: 7,
      url: "https://example.invalid/pull/7",
      state: "open" as const,
      draft: true,
      baseBranch: "main",
      headBranch: branch,
      headSha,
      mergeability: "mergeable" as const,
      autoMergeEnabled: false,
      updatedAt: now,
    };
    const ports: ReviewerPipelinePorts = {
      git: localGit,
      sourceControl: {
        getChangeRequest: () => Promise.resolve(ok(draft)),
        getCommitChecks: () =>
          Promise.resolve(
            ok({
              headSha,
              aggregate: "success",
              checks: [{ name: "quality", status: "completed", conclusion: "success" }],
            }),
          ),
        markChangeRequestReady: () => {
          readyCalled = true;
          return Promise.resolve(ok({ ...draft, draft: false }));
        },
      },
      codeReviewer: {
        inspectCapabilities: () =>
          Promise.resolve(
            ok({
              provider: "fixture",
              cliVersion: "1",
              models: ["review"],
              supportsResume: false,
              supportsStructuredEvents: true,
              supportsDynamicApproval: false,
              supportsVisualInput: false,
            }),
          ),
        start: (reviewRequest) => {
          const identityBlock = reviewRequest.externalData.find(
            (block) => block.source === "agent-team:review-identity" && block.kind === "text",
          );
          if (identityBlock?.kind !== "text") throw new Error("Missing review identity.");
          const identity = JSON.parse(identityBlock.content) as ReviewIdentity;
          expect(reviewRequest.workingDirectory).toBe(worktreePath);
          expect(reviewRequest.checkpoint).toBeUndefined();
          expect(reviewRequest.controllerDirective).toContain("fresh-context");
          return Promise.resolve(ok(providerHandle(reviewerOutput(identity))));
        },
      },
      toolDecisions: {
        decide: () =>
          Promise.resolve(ok({ response: "approve", pause: false, summary: "read-only" })),
      },
      evidenceIntegrity: {
        verify: () => Promise.resolve(ok({ verified: true, byteLength: 1 })),
      },
      jobs: {
        update: (updated) => {
          persistedReviewRuns = updated.attempts.reviewRuns;
          return Promise.resolve(ok({ durability: "confirmed" }));
        },
      },
      checkpoint: {
        preserve: () => Promise.resolve(ok({ checkpointId: "unused" })),
      },
    };

    const outcome = await new ReviewerPipeline(ports).run({
      job,
      project,
      trustedConfig: config,
      requirementSnapshot: snapshot.value,
      worktree,
      changeRequestId: "7",
      baseRevision: baseSha,
      expectedHeadSha: headSha,
      models: { code: "review" },
      evidence: [],
      deadlineAt: instant("2026-08-05T00:30:00.000Z"),
      idempotencyKeyPrefix: "integration:ENG-123:review",
    });

    expect(outcome).toMatchObject({
      state: "approved",
      job: { attempts: { ciFixRounds: 1, reviewRuns: 1 } },
      changeRequest: { draft: false, headSha },
      reports: [{ role: "code_reviewer", verdict: "passed" }],
    });
    expect(readyCalled).toBe(true);
    expect(persistedReviewRuns).toBe(1);
    expect(await git(worktreePath, ["status", "--porcelain"])).toBe("");
    expect(await git(worktreePath, ["rev-parse", "HEAD"])).toBe(headSha);
  });
});
