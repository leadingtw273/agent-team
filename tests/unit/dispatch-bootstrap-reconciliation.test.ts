import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileIssueAdmissionStore } from "../../src/adapters/dispatch/issue-admission-store.js";
import { FileJobProgressStore } from "../../src/adapters/dispatch/job-progress-store.js";
import { reconcileBootstrapClaims } from "../../src/cli/dispatch/bootstrap-reconciliation.js";
import { FileJobRepository } from "../../src/infrastructure/jobs/index.js";
import {
  parseIdentifier,
  parseInstant,
  type Identifier,
  type Instant,
} from "../../src/domain/foundation/index.js";
import { emptyAttemptCounters, type Job } from "../../src/domain/jobs/index.js";
import { projectSchema } from "../../src/domain/project/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-bootstrap-reconcile-"));
  temporaryDirectories.push(directory);
  return directory;
}

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

const projectId = id("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const issueId = id("issue", "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const jobId = id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const now = instant("2026-08-18T01:00:00.000Z");
const project = projectSchema.parse({
  schemaVersion: 1,
  id: projectId,
  displayName: "Sandbox",
  localRepositoryPath: "/tmp/sandbox",
  defaultBranch: "main",
  workManagement: { provider: "linear", containerId: "team-1", projectId: "linear-project-1" },
  sourceControl: { provider: "github", repository: "example/sandbox" },
});

function job(id = jobId): Job {
  return {
    schemaVersion: 1,
    id,
    projectId,
    issueId,
    createdAt: now,
    watchdogExtensionGranted: false,
    attempts: emptyAttemptCounters(),
  };
}

function stores(root: string) {
  return {
    admission: new FileIssueAdmissionStore(join(root, "admission")),
    progress: new FileJobProgressStore(join(root, "progress")),
    jobs: new FileJobRepository(join(root, "jobs.json"), join(root, "jobs.lock")),
  };
}

describe("reconcileBootstrapClaims", () => {
  it("quarantines the unique original Job and attaches its jobless claim without redispatch", async () => {
    const root = await temporaryDirectory();
    const state = stores(root);
    const claimed = await state.admission.claim(projectId, issueId, "linear-issue-1");
    if (!claimed.ok) throw new Error(claimed.error.code);
    await state.jobs.create(job());

    const result = await reconcileBootstrapClaims({
      agentTeamHome: root,
      project,
      ...state,
    });

    expect(result).toMatchObject({
      ok: true,
      value: [{ state: "quarantined", jobId }],
    });
    await expect(state.progress.load(jobId)).resolves.toMatchObject({
      ok: true,
      value: {
        externalIssueId: "linear-issue-1",
        stage: {
          kind: "requires_manual",
          cause: { stage: "dispatch", reasonCode: "bootstrap_incomplete" },
        },
      },
    });
    await expect(state.admission.load(projectId, issueId)).resolves.toMatchObject({
      ok: true,
      value: { state: "active", jobId },
    });
    await expect(state.jobs.readAll()).resolves.toMatchObject({ ok: true, value: [{ id: jobId }] });
  });

  it("repairs only the missing attach when the original progress already exists", async () => {
    const root = await temporaryDirectory();
    const state = stores(root);
    await state.admission.claim(projectId, issueId, "linear-issue-1");
    await state.jobs.create(job());
    await state.progress.compareAndSwap(jobId, null, {
      jobId,
      projectId,
      issueId,
      externalIssueId: "linear-issue-1",
      model: "gpt-5.6-terra",
      stage: { kind: "work_start_pending" },
      branch: `agent-team/${jobId}`,
      worktreePath: join(root, "state", "dispatch", "worktrees", jobId),
    });

    const result = await reconcileBootstrapClaims({
      agentTeamHome: root,
      project,
      ...state,
    });

    expect(result).toMatchObject({ ok: true, value: [{ state: "attached", jobId }] });
    await expect(state.admission.load(projectId, issueId)).resolves.toMatchObject({
      ok: true,
      value: { jobId },
    });
  });

  it("keeps ambiguous historical Jobs blocked and performs no automatic repair", async () => {
    const root = await temporaryDirectory();
    const state = stores(root);
    const secondJobId = id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ac");
    await state.admission.claim(projectId, issueId, "linear-issue-1");
    await state.jobs.create(job());
    await state.jobs.create(job(secondJobId));

    const result = await reconcileBootstrapClaims({
      agentTeamHome: root,
      project,
      ...state,
    });

    expect(result).toMatchObject({
      ok: true,
      value: [{ state: "blocked", reason: "job_identity_ambiguous" }],
    });
    await expect(state.progress.load(jobId)).resolves.toEqual({ ok: true, value: undefined });
    await expect(state.progress.load(secondJobId)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    const unchangedClaim = await state.admission.load(projectId, issueId);
    expect(unchangedClaim).toMatchObject({ ok: true, value: { state: "active" } });
    if (unchangedClaim.ok && unchangedClaim.value !== undefined) {
      expect(unchangedClaim.value).not.toHaveProperty("jobId");
    }
  });
});
