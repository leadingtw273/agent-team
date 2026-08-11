import { createDiffDigest, type EffectiveTreeChange } from "../../../src/domain/review/diff.js";
import { FileJobProgressStore } from "../../../src/adapters/dispatch/job-progress-store.js";
import { jobSchema } from "../../../src/domain/jobs/index.js";
import { projectSchema } from "../../../src/domain/project/index.js";
import { FileJobRepository } from "../../../src/infrastructure/jobs/file-repository.js";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { digestIdentifier, type FirstSandboxLiveArtifact } from "./schema.js";

export const fixtureHeadSha = "0123456789abcdef0123456789abcdef01234567";
export const fixtureBaseSha = "89abcdef0123456789abcdef0123456789abcdef";
export const fixtureObjectId = "fedcba9876543210fedcba9876543210fedcba98";
export const fixtureProjectId = "project_018f47d2-77a4-7cc1-8ef2-0123456789ab";
export const fixtureJobId = "job_018f47d2-77a4-7cc1-8ef2-012345678901";
export const fixtureDomainIssueId = "issue_018f47d2-77a4-7cc1-8ef2-012345678901";
export const fixtureExternalIssueId = "linear-private-issue";
export const fixtureStartedAt = "2026-08-11T10:00:00.000Z";
export const fixtureDispatchAt = "2026-08-11T10:01:00.000Z";
export const fixtureMergeAt = "2026-08-11T10:02:00.000Z";
export const fixtureCompletedAt = "2026-08-11T10:03:00.000Z";
export const fixtureCapturedAt = "2026-08-11T10:04:00.000Z";
export const fixtureReviewHtmlUrl =
  "https://github.invalid/owner/repository/issues/42#issuecomment-99";
export const fixtureRequirementsDigest = "a".repeat(64);

export const fixtureChanges: readonly EffectiveTreeChange[] = [
  {
    before: null,
    after: {
      path: "src/sandbox.ts",
      mode: "100644",
      objectId: { algorithm: "sha1", value: fixtureObjectId },
    },
  },
];

export function fixtureDiffDigest(): string {
  const digest = createDiffDigest(fixtureChanges);
  if (!digest.ok) throw new Error("fixture_diff_failed");
  return digest.value;
}

export function fixtureProvenance(): FirstSandboxLiveArtifact["provenance"] {
  return {
    source: "production",
    producerTask: "T11",
    caseId: "first_sandbox_internal_canary",
    runDigest: "b".repeat(64),
    agentTeamRevision: "c".repeat(64),
    startedAt: fixtureStartedAt,
    capturedAt: fixtureCapturedAt,
  };
}

export function fixtureArtifact(): FirstSandboxLiveArtifact {
  const headDigest = digestIdentifier("github-head", fixtureHeadSha);
  return {
    schemaVersion: 1,
    kind: "first_sandbox_live_artifact",
    provenance: fixtureProvenance(),
    authorities: {
      linear: {
        status: "present",
        evidence: {
          issueAlias: "issue-1",
          issueCount: 1,
          workStatus: "completed",
          updatedAt: fixtureCompletedAt,
          timeline: [
            { kind: "dispatch_started", occurredAt: fixtureDispatchAt, count: 1 },
            { kind: "merge_completed", occurredAt: fixtureMergeAt, count: 1 },
            { kind: "linear_completed", occurredAt: fixtureCompletedAt, count: 1 },
          ],
        },
      },
      github: {
        status: "present",
        evidence: {
          pullRequestAlias: "pr-1",
          pullRequestCount: 1,
          state: "merged",
          headDigest,
          checks: [{ name: "CI", status: "completed", conclusion: "success", headDigest }],
          reviewStatus: { context: "agent-team/review", state: "success", headDigest },
          reviewer: {
            role: "code_reviewer",
            verdict: "passed",
            headDigest,
            requirementsDigest: fixtureRequirementsDigest,
            diffDigest: fixtureDiffDigest(),
          },
          merge: { state: "merged", headDigest, observedAt: fixtureMergeAt },
        },
      },
      local: {
        status: "present",
        evidence: {
          jobAlias: "job-1",
          issueAlias: "issue-1",
          jobsForIssue: 1,
          exactJob: { stage: "completed", updatedAt: fixtureCompletedAt },
          projectProgress: { state: "available", resumable: 0, blocked: 0, nonTerminal: 0 },
          leases: { state: "available", active: 0, expired: 0, observedAt: fixtureCapturedAt },
        },
      },
      git: {
        status: "present",
        evidence: {
          baseDigest: digestIdentifier("git-base", fixtureBaseSha),
          headDigest,
          effectiveDiffDigest: fixtureDiffDigest(),
        },
      },
    },
  };
}

export function fixtureLinear() {
  return {
    issues: [
      {
        id: fixtureExternalIssueId,
        identifier: "TEAM-999",
        title: "untrusted canary title",
        workStatus: "completed",
        updatedAt: fixtureCompletedAt,
        timeline: [
          { marker: "dispatch_started", occurredAt: fixtureDispatchAt, body: "untrusted" },
          { marker: "merge_completed", occurredAt: fixtureMergeAt, body: "untrusted" },
          { marker: "linear_completed", occurredAt: fixtureCompletedAt, body: "untrusted" },
        ],
      },
    ],
  };
}

export function fixtureGithub(targetUrl = fixtureReviewHtmlUrl) {
  return {
    pullRequests: [
      {
        number: 42,
        state: "merged",
        headSha: fixtureHeadSha,
        mergedAt: fixtureMergeAt,
        checks: [
          {
            name: "CI",
            status: "completed",
            conclusion: "success",
            headSha: fixtureHeadSha,
            url: "https://github.invalid/check/42",
          },
        ],
        statuses: [
          {
            context: "agent-team/review",
            state: "success",
            headSha: fixtureHeadSha,
            targetUrl,
            description: "untrusted status description",
          },
        ],
      },
    ],
  };
}

export function fixtureGit() {
  return { baseSha: fixtureBaseSha, headSha: fixtureHeadSha, changes: fixtureChanges };
}

export function fixtureReviewerBody(): string {
  const value = {
    schemaVersion: 1,
    kind: "agent_team_review",
    verdict: "approved",
    identity: {
      requirementsDigest: fixtureRequirementsDigest,
      headSha: fixtureHeadSha,
      diffDigest: fixtureDiffDigest(),
    },
    reports: [
      {
        role: "code_reviewer",
        verdict: "passed",
        summary: "untrusted summary",
        acceptanceCriteria: [],
        qualityChecks: [],
        findings: [],
      },
    ],
    findings: [],
  };
  return `\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n<!-- agent-team:review_evidence:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef -->`;
}

export async function createLocalHomeFixture(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "agent-team-t09-local-"));
  const project = projectSchema.parse({
    schemaVersion: 1,
    id: fixtureProjectId,
    displayName: "T09 Local",
    localRepositoryPath: join(home, "repository"),
    defaultBranch: "main",
    workManagement: { provider: "linear", containerId: "team", projectId: "linear-project" },
    sourceControl: { provider: "github", repository: "owner/repository" },
  });
  const config = {
    schemaVersion: 1,
    projectId: fixtureProjectId,
    defaultBranch: "main",
    platforms: { workManagement: project.workManagement, sourceControl: project.sourceControl },
    projectRules: [],
    roleInstructions: { implementer: ["test"] },
    commands: { quality: [{ executable: "pnpm", arguments: ["typecheck"] }], visualReview: [] },
  };
  await mkdir(join(home, "config", "registration"), { recursive: true });
  await writeFile(
    join(home, "config", "registration", `${fixtureProjectId}.draft.json`),
    JSON.stringify({ schemaVersion: 1, project, config, linearAuditIssueId: "audit" }),
  );
  const state = join(home, "state");
  const jobs = new FileJobRepository(join(state, "jobs.json"), join(state, "jobs.lock"));
  const progress = new FileJobProgressStore(join(state, "dispatch", "progress"));
  const job = jobSchema.parse({
    schemaVersion: 1,
    id: fixtureJobId,
    projectId: fixtureProjectId,
    issueId: fixtureDomainIssueId,
    createdAt: fixtureStartedAt,
    watchdogExtensionGranted: false,
    attempts: { processRecoveries: 0, ciFixRounds: 0, reviewerFixRounds: 0, reviewRuns: 0 },
  });
  const created = await jobs.create(job);
  if (!created.ok) throw new Error("fixture_job_create_failed");
  const stored = await progress.compareAndSwap(fixtureJobId, null, {
    jobId: job.id,
    projectId: job.projectId,
    issueId: job.issueId,
    externalIssueId: fixtureExternalIssueId,
    model: "fixture-model",
    stage: { kind: "completed" },
    branch: "agent-team/fixture",
    worktreePath: "/tmp/t09-fixture",
  });
  if (!stored.ok) throw new Error("fixture_progress_create_failed");
  return home;
}
