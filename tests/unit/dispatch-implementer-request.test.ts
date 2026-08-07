/**
 * C015b unit tests: `buildImplementerPipelineRequest` (src/cli/dispatch/implementer-request.ts).
 * Covers: the built request satisfies every schema `ImplementerPipeline.run()`'s own
 * `validRequest`/`requestShapeValid` checks apply (re-validated here directly against the real
 * schemas, not just trusted by construction); the 60-minute deadline never exceeds
 * `watchdogHardStopMs`; the directive/PR body are built from the issue's structured fields.
 */
import { describe, expect, it } from "vitest";

import { buildImplementerPipelineRequest } from "../../src/cli/dispatch/implementer-request.js";
import { watchdogHardStopMs } from "../../src/domain/jobs/index.js";
import {
  createFixedClock,
  parseIdentifier,
  parseInstant,
  type Identifier,
  type Instant,
} from "../../src/domain/foundation/index.js";
import { jobSchema, emptyAttemptCounters, type Job } from "../../src/domain/jobs/index.js";
import {
  issueSchema,
  projectSchema,
  type Issue,
  type Project,
} from "../../src/domain/project/index.js";
import {
  trustedProjectConfigSchema,
  type TrustedProjectConfig,
} from "../../src/application/projects/index.js";

function id<Scope extends string>(scope: Scope, value: string): Identifier<Scope> {
  const parsed = parseIdentifier(scope, value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function instant(value: string): Instant {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const now = instant("2026-08-07T12:00:00.000Z");
const projectId = id("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const issueId = id("issue", "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const jobId = id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab");

function project(): Project {
  return projectSchema.parse({
    schemaVersion: 1,
    id: projectId,
    displayName: "Sandbox",
    localRepositoryPath: "/tmp/sandbox",
    defaultBranch: "main",
    workManagement: { provider: "linear", containerId: "team-1", projectId: "proj-1" },
    sourceControl: { provider: "github", repository: "owner/sandbox" },
  });
}

function trustedConfig(): TrustedProjectConfig {
  const projectValue = project();
  return trustedProjectConfigSchema.parse({
    schemaVersion: 1,
    projectId,
    defaultBranch: "main",
    platforms: {
      workManagement: projectValue.workManagement,
      sourceControl: projectValue.sourceControl,
    },
    projectRules: [],
    roleInstructions: {},
    commands: { quality: [{ executable: "pnpm", arguments: ["test"] }], visualReview: [] },
  });
}

function job(): Job {
  return jobSchema.parse({
    schemaVersion: 1,
    id: jobId,
    projectId,
    issueId,
    createdAt: now,
    watchdogExtensionGranted: false,
    attempts: emptyAttemptCounters(),
  });
}

function issue(): Issue {
  return issueSchema.parse({
    schemaVersion: 1,
    id: issueId,
    projectId,
    externalId: "linear-issue-1",
    title: "Ship the thing",
    goal: "讓真實候選能跑到 CI waiting。",
    background: "C015b 補上執行段。",
    acceptanceCriteria: ["candidate reaches ci_waiting"],
    inScope: ["implementer pipeline wiring"],
    outOfScope: ["reviewer pipeline"],
    dependencies: { kind: "none" },
    priority: "high",
    agentRole: "implementer",
    reviewRequirement: "code_review",
    estimatedMinutes: 30,
    changeRegions: [{ path: "src/cli/dispatch/implementer-request.ts", coverage: "exact" }],
  });
}

describe("buildImplementerPipelineRequest", () => {
  it("builds a request whose every embedded document is schema-valid", () => {
    const result = buildImplementerPipelineRequest({
      job: job(),
      issue: issue(),
      project: project(),
      trustedConfig: trustedConfig(),
      model: "opus",
      agentTeamHome: "/tmp/agent-team-home",
      clock: createFixedClock(now),
      baseRevision: "a".repeat(40),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const request = result.value;

    expect(jobSchema.safeParse(request.job).success).toBe(true);
    expect(projectSchema.safeParse(request.project).success).toBe(true);
    expect(trustedProjectConfigSchema.safeParse(request.trustedConfig).success).toBe(true);
    expect(request.requirementSnapshot.issue.id).toBe(issueId);
    expect(request.requirementSnapshot.issue.changeRegions).toEqual([
      { path: "src/cli/dispatch/implementer-request.ts", coverage: "exact" },
    ]);
    expect(request.role).toBe("implementer");
    expect(request.model).toBe("opus");
    expect(request.repositoryRoot).toBe("/tmp/sandbox");
    expect(request.baseRevision).toBe("a".repeat(40));
    expect(request.worktreePath).toBe(`/tmp/agent-team-home/state/dispatch/worktrees/${jobId}`);
    expect(request.branch).toBe(`agent-team/${jobId}`);
    expect(request.remote).toBe("origin");
    expect(request.idempotencyKeyPrefix).toBe(`cli-dispatch:${jobId}`);
  });

  it("sets deadlineAt to exactly the 60-minute watchdog hard-stop boundary, never beyond it", () => {
    const result = buildImplementerPipelineRequest({
      job: job(),
      issue: issue(),
      project: project(),
      trustedConfig: trustedConfig(),
      model: "opus",
      agentTeamHome: "/tmp/agent-team-home",
      clock: createFixedClock(now),
      baseRevision: "a".repeat(40),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const deadlineMs = Date.parse(result.value.deadlineAt) - Date.parse(now);
    expect(deadlineMs).toBe(watchdogHardStopMs);
  });

  it("builds the directive/PR body from the issue's structured fields", () => {
    const result = buildImplementerPipelineRequest({
      job: job(),
      issue: issue(),
      project: project(),
      trustedConfig: trustedConfig(),
      model: "opus",
      agentTeamHome: "/tmp/agent-team-home",
      clock: createFixedClock(now),
      baseRevision: "a".repeat(40),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.controllerDirective).toContain("讓真實候選能跑到 CI waiting。");
    expect(result.value.controllerDirective).toContain("candidate reaches ci_waiting");
    expect(result.value.pullRequest.title).toBe("Ship the thing");
    expect(result.value.pullRequest.body).toBe(result.value.controllerDirective);
    expect(result.value.commitMessage).toBe("Ship the thing (linear-issue-1)");
  });

  it("falls back to a plain 請完成工單 directive when the issue has no structured fields at all", () => {
    const bareIssue = issueSchema.parse({
      schemaVersion: 1,
      id: issueId,
      projectId,
      externalId: "linear-issue-1",
      title: "Bare issue",
      dependencies: { kind: "none" },
      priority: "high",
      agentRole: "implementer",
      reviewRequirement: "code_review",
      estimatedMinutes: 30,
      changeRegions: [{ path: "src/x.ts", coverage: "exact" as const }],
    });
    const result = buildImplementerPipelineRequest({
      job: job(),
      issue: bareIssue,
      project: project(),
      trustedConfig: trustedConfig(),
      model: "opus",
      agentTeamHome: "/tmp/agent-team-home",
      clock: createFixedClock(now),
      baseRevision: "a".repeat(40),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.controllerDirective).toBe("請完成工單：Bare issue");
  });
});
