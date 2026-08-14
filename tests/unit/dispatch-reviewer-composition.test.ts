/**
 * C015c item 3 / E102-2 unit tests: `buildReviewerPipeline`
 * (src/cli/dispatch/reviewer-composition.ts) -- the fail-closed GitHub-authentication-first
 * prerequisite chain (mirroring dispatch-implementer-composition.test.ts's own convention), plus
 * E102-2's own dual-review provider wiring: `codeReviewer` must be a real `ClaudeRunner`,
 * `visualReviewer` must be a real `GeminiRunner` when `geminiConfig` is supplied, and must be
 * left unwired (never silently defaulted to Claude) when it is not -- proven both at the port
 * level and by actually running a `dual_review` request through the composed pipeline.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildReviewerPipeline } from "../../src/cli/dispatch/reviewer-composition.js";
import { FileJobRepository } from "../../src/infrastructure/jobs/index.js";
import {
  ok,
  err,
  domainError,
  parseInstant,
  type Instant,
} from "../../src/domain/foundation/index.js";
import { jobSchema } from "../../src/domain/jobs/index.js";
import { issueSchema, projectSchema } from "../../src/domain/project/index.js";
import { createRequirementSnapshot } from "../../src/domain/review/index.js";
import { visualManifestSchema } from "../../src/domain/checkpoint/index.js";
import { trustedProjectConfigSchema } from "../../src/application/projects/index.js";
import type { ReviewerPipelineRequest } from "../../src/application/pipelines/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-reviewer-composition-"));
  temporaryDirectories.push(directory);
  return directory;
}

function instant(value: string): Instant {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const claudeConfig = { executable: "claude", models: ["opus"], account: "default" };
const geminiConfig = {
  executable: "gemini",
  models: ["auto"],
  account: "default",
  adminPolicyPath: "/etc/agent-team/gemini-read-only.toml",
};
const authenticatedGithubTransport = {
  requestJson: () => Promise.reject(new Error("must never be called")),
  inspectAuthentication: () =>
    Promise.resolve(
      ok({ active: true as const, host: "github.com", accountFingerprint: "a".repeat(64) }),
    ),
};

const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const artifactSha = "d".repeat(64);
const acceptanceCriterion = "The review binds to exact evidence.";
const now = instant("2026-08-08T00:00:00.000Z");
const deadline = instant("2026-08-08T00:30:00.000Z");

const project = projectSchema.parse({
  schemaVersion: 1,
  id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  displayName: "Reviewer composition fixture",
  localRepositoryPath: "/tmp/reviewer-composition-repository",
  defaultBranch: "main",
  workManagement: { provider: "linear", containerId: "workspace", projectId: "team" },
  sourceControl: { provider: "github", repository: "owner/repository" },
});
const worktree = {
  repositoryRoot: project.localRepositoryPath,
  path: "/tmp/reviewer-composition-worktree",
  branch: "feature/ENG-999-review",
  headSha,
} as const;
const trustedConfig = trustedProjectConfigSchema.parse({
  schemaVersion: 1,
  projectId: project.id,
  defaultBranch: "main",
  platforms: {
    workManagement: project.workManagement,
    sourceControl: project.sourceControl,
  },
  projectRules: ["Review exact Head only."],
  roleInstructions: {
    code_reviewer: ["Check code quality."],
    visual_reviewer: ["Check observable visual evidence."],
  },
  commands: {
    quality: [{ executable: "pnpm", arguments: ["test"] }],
    visualReview: [{ executable: "pnpm", arguments: ["test:visual"] }],
  },
});

function reviewerRequest(
  reviewRequirement: "code_review" | "visual_review" | "dual_review",
): ReviewerPipelineRequest {
  const issue = issueSchema.parse({
    schemaVersion: 1,
    id: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    projectId: project.id,
    externalId: "ENG-999",
    title: "Review pipeline composition",
    goal: "Review an exact diff with fresh context.",
    background: "CI is green.",
    acceptanceCriteria: [acceptanceCriterion],
    inScope: ["src"],
    outOfScope: ["Implementer conversation"],
    dependencies: { kind: "none" },
    priority: "high",
    agentRole: "implementer",
    reviewRequirement,
    estimatedMinutes: 30,
    changeRegions: [{ path: "src", coverage: "subtree" }],
  });
  const snapshot = createRequirementSnapshot(issue, now);
  if (!snapshot.ok) throw new Error(snapshot.error.code);
  const needsCode = reviewRequirement !== "visual_review";
  const needsVisual = reviewRequirement !== "code_review";
  const visualManifest = needsVisual
    ? visualManifestSchema.parse({
        schemaVersion: 1 as const,
        issueId: issue.id,
        commitSha: headSha,
        generatedAt: now,
        environment: { runner: "fixture", operatingSystem: "linux" },
        artifacts: [
          {
            path: "evidence/screen.png",
            mediaType: "image/png",
            sha256: artifactSha,
            title: "Screen",
            acceptanceCriteria: [acceptanceCriterion],
          },
        ],
      })
    : undefined;
  const evidence = needsVisual
    ? [
        {
          kind: "file" as const,
          category: "visual_artifact" as const,
          source: "artifact:screen",
          mediaType: "image/png",
          path: "/tmp/reviewer-composition-worktree/evidence/screen.png",
          sha256: artifactSha,
          repositoryPath: "evidence/screen.png",
        },
      ]
    : [];
  return {
    job: jobSchema.parse({
      schemaVersion: 1,
      id: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
      projectId: project.id,
      issueId: issue.id,
      createdAt: now,
      watchdogExtensionGranted: false,
      attempts: { processRecoveries: 0, ciFixRounds: 0, reviewerFixRounds: 0, reviewRuns: 0 },
    }),
    project,
    trustedConfig,
    requirementSnapshot: snapshot.value,
    worktree,
    changeRequestId: "42",
    baseRevision: baseSha,
    expectedHeadSha: headSha,
    models: {
      ...(needsCode ? { code: "opus" } : {}),
      ...(needsVisual ? { visual: "auto" } : {}),
    },
    evidence,
    ...(visualManifest === undefined ? {} : { visualManifest }),
    deadlineAt: deadline,
    idempotencyKeyPrefix: "job:ENG-999:review",
  } satisfies ReviewerPipelineRequest;
}

describe("buildReviewerPipeline", () => {
  it("blocks with github_authentication_unavailable before constructing any port", async () => {
    const agentTeamHome = await temporaryHome();
    const jobs = new FileJobRepository(
      join(agentTeamHome, "jobs.json"),
      join(agentTeamHome, "jobs.lock"),
    );
    const result = await buildReviewerPipeline({
      agentTeamHome,
      claudeConfig,
      jobs,
      githubTransport: {
        requestJson: () => Promise.reject(new Error("must never be called")),
        inspectAuthentication: () => Promise.resolve(err(domainError("permission_denied"))),
      },
    });
    expect(result).toEqual({ state: "blocked", reason: "github_authentication_unavailable" });
  });

  it("wires a real ClaudeRunner for codeReviewer and a distinct real GeminiRunner for visualReviewer when geminiConfig is supplied", async () => {
    const agentTeamHome = await temporaryHome();
    const jobs = new FileJobRepository(
      join(agentTeamHome, "jobs.json"),
      join(agentTeamHome, "jobs.lock"),
    );
    const result = await buildReviewerPipeline({
      agentTeamHome,
      claudeConfig,
      geminiConfig,
      jobs,
      githubTransport: authenticatedGithubTransport,
    });
    expect(result.state).toBe("ready");
    if (result.state !== "ready") return;
    expect(result.value.ports.codeReviewer).toBeDefined();
    if (result.value.ports.codeReviewer === undefined) return;
    await expect(result.value.ports.codeReviewer.inspectCapabilities()).resolves.toMatchObject({
      ok: true,
      value: { provider: "claude" },
    });
    await expect(result.value.ports.visualReviewer?.inspectCapabilities()).resolves.toMatchObject({
      ok: true,
      value: { provider: "gemini" },
    });
    // C015c's original composition pointed both roles at the very same Claude instance -- this is
    // the exact regression E102-2 closes: the two providers must now be genuinely distinct.
    expect(result.value.ports.codeReviewer).not.toBe(result.value.ports.visualReviewer);
    expect(result.value.ports.git).toBeDefined();
    expect(result.value.ports.sourceControl).toBeDefined();
    expect(result.value.ports.toolDecisions).toBeDefined();
    expect(result.value.ports.evidenceIntegrity).toBeDefined();
    expect(result.value.ports.jobs).toBeDefined();
    expect(result.value.ports.checkpoint).toBeDefined();
  });

  it("leaves visualReviewer unwired -- never falls back to ClaudeRunner -- when geminiConfig is omitted", async () => {
    const agentTeamHome = await temporaryHome();
    const jobs = new FileJobRepository(
      join(agentTeamHome, "jobs.json"),
      join(agentTeamHome, "jobs.lock"),
    );
    const result = await buildReviewerPipeline({
      agentTeamHome,
      claudeConfig,
      jobs,
      githubTransport: authenticatedGithubTransport,
    });
    expect(result.state).toBe("ready");
    if (result.state !== "ready") return;
    expect(result.value.ports.codeReviewer).toBeDefined();
    if (result.value.ports.codeReviewer === undefined) return;
    await expect(result.value.ports.codeReviewer.inspectCapabilities()).resolves.toMatchObject({
      ok: true,
      value: { provider: "claude" },
    });
    expect(result.value.ports.visualReviewer).toBeUndefined();
  });

  it("fails closed (invariant_violation) for a dual_review job instead of substituting Claude for the visual role, when geminiConfig is omitted", async () => {
    const agentTeamHome = await temporaryHome();
    const jobs = new FileJobRepository(
      join(agentTeamHome, "jobs.json"),
      join(agentTeamHome, "jobs.lock"),
    );
    const result = await buildReviewerPipeline({
      agentTeamHome,
      claudeConfig,
      jobs,
      githubTransport: authenticatedGithubTransport,
    });
    expect(result.state).toBe("ready");
    if (result.state !== "ready") return;

    // The ports-presence check (reviewer.ts) runs before any real GitHub/git I/O, so this proves
    // the fail-closed outcome comes from the missing visual-review port itself, not from network
    // access being unavailable in this test environment.
    const outcome = await result.value.run(reviewerRequest("dual_review"));
    expect(outcome.state).toBe("failed");
    if (outcome.state !== "failed") return;
    expect(outcome.stage).toBe("request");
    expect(outcome.error.code).toBe("invariant_violation");
  });

  it("does not require geminiConfig for a code_review-only job -- it advances past the ports check", async () => {
    const agentTeamHome = await temporaryHome();
    const jobs = new FileJobRepository(
      join(agentTeamHome, "jobs.json"),
      join(agentTeamHome, "jobs.lock"),
    );
    const result = await buildReviewerPipeline({
      agentTeamHome,
      claudeConfig,
      jobs,
      githubTransport: {
        requestJson: () => Promise.resolve(err(domainError("unavailable"))),
        inspectAuthentication: () =>
          Promise.resolve(
            ok({ active: true as const, host: "github.com", accountFingerprint: "a".repeat(64) }),
          ),
      },
    });
    expect(result.state).toBe("ready");
    if (result.state !== "ready") return;

    const outcome = await result.value.run(reviewerRequest("code_review"));
    // Not blocked at the request/ports stage (that would mean codeReviewer was somehow missing,
    // or wrongly gated on gemini config); it reaches the real GitHubAdapter, which fails for an
    // unrelated, distinct reason (the fake transport's `requestJson` returning `unavailable`).
    expect(outcome.state).toBe("failed");
    if (outcome.state !== "failed") return;
    expect(outcome.stage).toBe("change_request");
  });
});
