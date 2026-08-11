import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileJobProgressStore } from "../../../src/adapters/dispatch/job-progress-store.js";
import { projectSchema } from "../../../src/domain/project/index.js";
import { jobSchema } from "../../../src/domain/jobs/index.js";
import { createProjectReadModel } from "../../../src/cli/project/index.js";
import { FileJobRepository } from "../../../src/infrastructure/jobs/file-repository.js";
import { readProductionLocalAuthority } from "./local-authority.js";

const roots: string[] = [];
const projectId = "project_018f47d2-77a4-7cc1-8ef2-0123456789ab";
const jobId = "job_018f47d2-77a4-7cc1-8ef2-012345678901";
const issueId = "issue_018f47d2-77a4-7cc1-8ef2-012345678901";
const externalIssueId = "linear-private-issue";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(withProgress = true) {
  const home = await mkdtemp(join(tmpdir(), "agent-team-t09-local-"));
  roots.push(home);
  const project = projectSchema.parse({
    schemaVersion: 1,
    id: projectId,
    displayName: "T09 Local",
    localRepositoryPath: join(home, "repository"),
    defaultBranch: "main",
    workManagement: { provider: "linear", containerId: "team", projectId: "linear-project" },
    sourceControl: { provider: "github", repository: "owner/repository" },
  });
  const config = {
    schemaVersion: 1,
    projectId,
    defaultBranch: "main",
    platforms: { workManagement: project.workManagement, sourceControl: project.sourceControl },
    projectRules: [],
    roleInstructions: { implementer: ["test"] },
    commands: { quality: [{ executable: "pnpm", arguments: ["typecheck"] }], visualReview: [] },
  };
  await mkdir(join(home, "config", "registration"), { recursive: true });
  await writeFile(
    join(home, "config", "registration", `${projectId}.draft.json`),
    JSON.stringify({ schemaVersion: 1, project, config, linearAuditIssueId: "audit" }),
  );
  const state = join(home, "state");
  const jobs = new FileJobRepository(join(state, "jobs.json"), join(state, "jobs.lock"));
  const progress = new FileJobProgressStore(join(state, "dispatch", "progress"));
  const job = jobSchema.parse({
    schemaVersion: 1,
    id: jobId,
    projectId,
    issueId,
    createdAt: "2026-08-11T10:00:00.000Z",
    watchdogExtensionGranted: false,
    attempts: { processRecoveries: 0, ciFixRounds: 0, reviewerFixRounds: 0, reviewRuns: 0 },
  });
  const created = await jobs.create(job);
  if (!created.ok) throw new Error("fixture_job_create_failed");
  if (withProgress) {
    const stored = await progress.compareAndSwap(job.id, null, {
      jobId: job.id,
      projectId: job.projectId,
      issueId: job.issueId,
      externalIssueId,
      model: "fixture-model",
      stage: { kind: "completed" },
      branch: "agent-team/fixture",
      worktreePath: "/tmp/t09-fixture",
    });
    if (!stored.ok) throw new Error("fixture_progress_create_failed");
  }
  return { home, jobs, progress, job };
}

describe("T09 production local authority", () => {
  it("uses T05 factory and production stores, then projects only the exact trusted job binding", async () => {
    const { home } = await fixture();
    const result = await readProductionLocalAuthority({
      projectId,
      expectedLinearIssueId: externalIssueId,
      expectedCanaryJobId: jobId,
      agentTeamHome: home,
    });
    expect(result).toMatchObject({
      status: "present",
      evidence: {
        jobAlias: "job-1",
        issueAlias: "issue-1",
        jobsForIssue: 1,
        exactJob: { stage: "completed" },
        projectProgress: { resumable: 0, blocked: 0, nonTerminal: 0 },
        leases: { active: 0, expired: 0 },
      },
    });
    expect(JSON.stringify(result)).not.toContain(jobId);
    expect(JSON.stringify(result)).not.toContain(externalIssueId);
    const detail = await createProjectReadModel({ agentTeamHome: home }).read({ projectId });
    expect(detail.state).toBe("success");
  });

  it("fails closed for expected job and external issue binding mismatches", async () => {
    const { home } = await fixture();
    await expect(
      readProductionLocalAuthority({
        projectId,
        expectedLinearIssueId: externalIssueId,
        expectedCanaryJobId: "job_018f47d2-77a4-7cc1-8ef2-012345678999",
        agentTeamHome: home,
      }),
    ).resolves.toEqual({ status: "missing", reasonCode: "not_found" });
    await expect(
      readProductionLocalAuthority({
        projectId,
        expectedLinearIssueId: "wrong-external",
        expectedCanaryJobId: jobId,
        agentTeamHome: home,
      }),
    ).resolves.toEqual({ status: "missing", reasonCode: "binding_missing" });
  });

  it("rejects duplicate domain jobs/progress and a non-completed expected canary", async () => {
    const { home, jobs, progress, job } = await fixture();
    const duplicate = jobSchema.parse({
      ...job,
      id: "job_018f47d2-77a4-7cc1-8ef2-012345678902",
    });
    expect(await jobs.create(duplicate)).toMatchObject({ ok: true });
    expect(
      await progress.compareAndSwap(duplicate.id, null, {
        jobId: duplicate.id,
        projectId: duplicate.projectId,
        issueId: duplicate.issueId,
        externalIssueId,
        model: "fixture-model",
        stage: { kind: "completed" },
        branch: "agent-team/fixture-duplicate",
        worktreePath: "/tmp/t09-fixture-duplicate",
      }),
    ).toMatchObject({ ok: true });
    await expect(
      readProductionLocalAuthority({
        projectId,
        expectedLinearIssueId: externalIssueId,
        expectedCanaryJobId: jobId,
        agentTeamHome: home,
      }),
    ).resolves.toEqual({ status: "missing", reasonCode: "duplicate_result" });

    const separate = await fixture();
    const existing = await separate.progress.load(jobId);
    if (!existing.ok || existing.value === undefined) throw new Error("fixture_progress_missing");
    expect(
      await separate.progress.compareAndSwap(jobId, existing.value.revision, {
        ...existing.value,
        stage: { kind: "implementing" },
      }),
    ).toMatchObject({ ok: true });
    await expect(
      readProductionLocalAuthority({
        projectId,
        expectedLinearIssueId: externalIssueId,
        expectedCanaryJobId: jobId,
        agentTeamHome: separate.home,
      }),
    ).resolves.toEqual({ status: "missing", reasonCode: "binding_missing" });
  });

  it("fails closed when the expected Job has no matching durable progress", async () => {
    const { home } = await fixture(false);
    await expect(
      readProductionLocalAuthority({
        projectId,
        expectedLinearIssueId: externalIssueId,
        expectedCanaryJobId: jobId,
        agentTeamHome: home,
      }),
    ).resolves.toEqual({ status: "missing", reasonCode: "not_found" });
  });
});
