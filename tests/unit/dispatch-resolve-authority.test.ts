import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FileJobProgressStore } from "../../src/adapters/dispatch/job-progress-store.js";
import { FileIssueAdmissionStore } from "../../src/adapters/dispatch/issue-admission-store.js";
import { LeaseCoordinator } from "../../src/application/leases/index.js";
import {
  appendPullRequestBackPointer,
  createJobPrLifecycleEvent,
  createPullRequestBackPointer,
  formatJobPrLifecycleComment,
  parseJobPrLifecycleComment,
} from "../../src/application/pipelines/index.js";
import type { SourceControlPort } from "../../src/application/ports/index.js";
import {
  createFixedClock,
  ok,
  parseIdentifier,
  parseInstant,
  type Identifier,
} from "../../src/domain/foundation/index.js";
import { issueSchema, projectSchema } from "../../src/domain/project/index.js";
import { headShaSchema } from "../../src/domain/review/index.js";
import { InMemoryLeaseRepository } from "../../src/cli/dispatch/ephemeral-ports.js";
import { DispatchResolveAuthority } from "../../src/cli/dispatch/resolve-authority.js";
import {
  createDispatchResolveHandler,
  dispatchResolveConfirmationPhrase,
} from "../../src/cli/dispatch/resolve-handlers.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function id<Scope extends string>(scope: Scope, value: string): Identifier<Scope> {
  const parsed = parseIdentifier(scope, value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

async function* confirmation(): AsyncIterable<string> {
  await Promise.resolve();
  yield dispatchResolveConfirmationPhrase;
}

describe("DispatchResolveAuthority", () => {
  it("repairs a legacy Job and a PR-create crash boundary before cancelling exactly once", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-resolve-legacy-"));
    directories.push(root);
    const now = parseInstant("2026-08-26T12:00:00.000Z");
    if (!now.ok) throw new Error(now.error.code);
    const projectId = id("project", "project_118f47d2-77a4-7cc1-8ef2-0123456789ab");
    const issueId = id("issue", "issue_118f47d2-77a4-7cc1-8ef2-0123456789ab");
    const jobId = id("job", "job_118f47d2-77a4-7cc1-8ef2-0123456789ab");
    const project = projectSchema.parse({
      schemaVersion: 1,
      id: projectId,
      displayName: "Legacy fixture",
      localRepositoryPath: "/tmp/fixture",
      defaultBranch: "main",
      workManagement: { provider: "linear", containerId: "team", projectId: "linear-project" },
      sourceControl: { provider: "github", repository: "owner/repository" },
    });
    const issue = issueSchema.parse({
      schemaVersion: 1,
      id: issueId,
      projectId,
      externalId: "ENG-LEGACY",
      title: "Recover legacy cancellation",
      acceptanceCriteria: ["Recover public identity before closing"],
      changeRegions: [{ path: "src", coverage: "subtree" }],
    });
    const branch = `agent-team/${projectId}/${issueId}/${jobId}`;
    const headSha = headShaSchema.parse("d".repeat(40));
    const pointer = createPullRequestBackPointer({
      schemaVersion: 1,
      projectId,
      issueId,
      jobId,
      branch,
    });
    if (!pointer.ok) throw new Error(pointer.error.code);
    const prBody = appendPullRequestBackPointer("legacy work", pointer.value);
    if (!prBody.ok) throw new Error(prBody.error.code);
    const progress = new FileJobProgressStore(
      join(root, "progress"),
      undefined,
      createFixedClock(now.value),
    );
    await progress.compareAndSwap(jobId, null, {
      jobId,
      projectId,
      issueId,
      externalIssueId: issue.externalId,
      model: "gpt-5.6-terra",
      stage: { kind: "requires_manual" },
      branch,
      worktreePath: "/tmp/worktree",
    });
    const comments: { id: string; body: string; createdAt: typeof now.value }[] = [];
    const workManagement = {
      getIssue: vi.fn(() =>
        Promise.resolve(
          ok({ issue, workStatus: "canceled" as const, updatedAt: now.value, revision: "r1" }),
        ),
      ),
      listComments: vi.fn(() => Promise.resolve(ok([...comments]))),
      appendComment: vi.fn((_reference, body: string) => {
        const receipt = { id: `c${String(comments.length + 1)}`, body, createdAt: now.value };
        comments.push(receipt);
        return Promise.resolve(ok(receipt));
      }),
    };
    let prState: "open" | "closed" = "open";
    const snapshot = () => ({
      id: "PR_91",
      number: 91,
      url: "https://example.test/pr/91",
      title: "Legacy",
      body: prBody.value,
      state: prState,
      draft: true,
      headBranch: branch,
      baseBranch: "main",
      headSha,
      baseSha: "e".repeat(40),
      mergeable: "mergeable" as const,
      mergeStateStatus: "clean" as const,
    });
    const close = vi.fn(() => {
      prState = "closed";
      return Promise.resolve(ok(snapshot()));
    });
    const sourceControl = {
      getChangeRequest: vi.fn(() => Promise.resolve(ok(snapshot()))),
      findOpenChangeRequestsByHead: vi.fn(() => Promise.resolve(ok([snapshot()]))),
      closeChangeRequest: close,
    } as unknown as SourceControlPort;
    const admission = new FileIssueAdmissionStore(join(root, "admission"));
    const claim = await admission.claim(projectId, issueId);
    if (!claim.ok) throw new Error(claim.error.code);
    await admission.attachJob(projectId, issueId, claim.value.revision, jobId);
    const authority = new DispatchResolveAuthority({
      project,
      progress,
      jobs: {} as never,
      leases: new LeaseCoordinator(new InMemoryLeaseRepository(), {
        clock: createFixedClock(now.value),
        generateLeaseId: () => ok(id("lease", "lease_118f47d2-77a4-7cc1-8ef2-0123456789ab")),
      }),
      workManagement,
      sourceControl,
      clock: createFixedClock(now.value),
      generateHolderId: () => "resolve-controller",
    });
    const resolved = await createDispatchResolveHandler({
      progress,
      admission,
      authority,
      stdin: confirmation(),
    })({ jobId, as: "cancelled" });

    expect(resolved.state).toBe("success");
    expect(close).toHaveBeenCalledTimes(1);
    expect(comments.map((comment) => parseJobPrLifecycleComment(comment.body)?.kind)).toEqual([
      "job_started",
      "pr_bound",
      "job_cancelled",
    ]);
    await expect(progress.load(jobId)).resolves.toMatchObject({
      ok: true,
      value: {
        changeRequestId: "91",
        headSha,
        stage: { kind: "cancelled" },
        controlFence: { ownershipEpoch: 1, state: "revoked" },
      },
    });
  });

  it("fails closed before an unsafe supersede handoff and publishes one public conflict", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-resolve-supersede-"));
    directories.push(root);
    const now = parseInstant("2026-08-26T12:00:00.000Z");
    if (!now.ok) throw new Error(now.error.code);
    const projectId = id("project", "project_218f47d2-77a4-7cc1-8ef2-0123456789ab");
    const issueId = id("issue", "issue_218f47d2-77a4-7cc1-8ef2-0123456789ab");
    const jobId = id("job", "job_218f47d2-77a4-7cc1-8ef2-0123456789ab");
    const successorId = id("job", "job_218f47d2-77a4-7cc1-8ef2-0123456789ac");
    const project = projectSchema.parse({
      schemaVersion: 1,
      id: projectId,
      displayName: "Supersede fixture",
      localRepositoryPath: "/tmp/fixture",
      defaultBranch: "main",
      workManagement: { provider: "linear", containerId: "team", projectId: "linear-project" },
      sourceControl: { provider: "github", repository: "owner/repository" },
    });
    const issue = issueSchema.parse({
      schemaVersion: 1,
      id: issueId,
      projectId,
      externalId: "ENG-SUPERSEDE",
      title: "Do not orphan a PR during supersede",
      acceptanceCriteria: ["Unsafe handoff stops publicly"],
      changeRegions: [{ path: "src", coverage: "subtree" }],
    });
    const branch = `agent-team/${projectId}/${issueId}/${jobId}`;
    const headSha = headShaSchema.parse("f".repeat(40));
    const pointer = createPullRequestBackPointer({
      schemaVersion: 1,
      projectId,
      issueId,
      jobId,
      branch,
    });
    const started = createJobPrLifecycleEvent({
      schemaVersion: 1,
      kind: "job_started",
      projectId,
      issueId,
      jobId,
    });
    const bound = createJobPrLifecycleEvent({
      schemaVersion: 1,
      kind: "pr_bound",
      projectId,
      issueId,
      jobId,
      prNumber: 92,
      branch,
      initialHeadSha: headSha,
      ownershipEpoch: 1,
    });
    if (!pointer.ok || !started.ok || !bound.ok) throw new Error("identity fixture failed");
    const prBody = appendPullRequestBackPointer("work", pointer.value);
    const startedBody = formatJobPrLifecycleComment("started", started.value);
    const boundBody = formatJobPrLifecycleComment("bound", bound.value);
    if (!prBody.ok || !startedBody.ok || !boundBody.ok) throw new Error("format fixture failed");
    const progress = new FileJobProgressStore(
      join(root, "progress"),
      undefined,
      createFixedClock(now.value),
    );
    await progress.compareAndSwap(jobId, null, {
      jobId,
      projectId,
      issueId,
      externalIssueId: issue.externalId,
      model: "gpt-5.6-terra",
      stage: { kind: "requires_manual" },
      branch,
      worktreePath: "/tmp/worktree",
      changeRequestId: "92",
      headSha,
      controlFence: {
        leaseId: id("lease", "lease_218f47d2-77a4-7cc1-8ef2-0123456789aa"),
        holderId: "old-session",
        leaseEpoch: 1,
        ownershipEpoch: 1,
        state: "active",
      },
    });
    const comments = [
      { id: "c1", body: startedBody.value, createdAt: now.value },
      { id: "c2", body: boundBody.value, createdAt: now.value },
    ];
    const baseIssueSnapshot = {
      issue,
      workStatus: "in_progress" as const,
      updatedAt: now.value,
      revision: "r1",
    };
    const blockedIssueSnapshot = {
      ...baseIssueSnapshot,
      agentCondition: {
        status: "blocked" as const,
        blockingReasons: ["integration_failure"] as const,
      },
    };
    const setAgentCondition = vi.fn(() => Promise.resolve(ok(blockedIssueSnapshot)));
    const workManagement = {
      getIssue: vi.fn(() => Promise.resolve(ok(baseIssueSnapshot))),
      listIssues: vi.fn(() => Promise.resolve(ok([baseIssueSnapshot]))),
      listComments: vi.fn(() => Promise.resolve(ok([...comments]))),
      setWorkStatus: vi.fn(() => Promise.resolve(ok(baseIssueSnapshot))),
      setAgentCondition,
      clearAgentCondition: vi.fn(() => Promise.resolve(ok(baseIssueSnapshot))),
      appendComment: vi.fn((_reference, body: string) => {
        const receipt = { id: `c${String(comments.length + 1)}`, body, createdAt: now.value };
        comments.push(receipt);
        return Promise.resolve(ok(receipt));
      }),
    };
    const snapshot = {
      id: "PR_92",
      number: 92,
      url: "https://example.test/pr/92",
      title: "Supersede",
      body: prBody.value,
      state: "open" as const,
      draft: true,
      headBranch: branch,
      baseBranch: "main",
      headSha,
      baseSha: "a".repeat(40),
      mergeable: "mergeable" as const,
      mergeStateStatus: "clean" as const,
    };
    const close = vi.fn(() => Promise.resolve(ok({ ...snapshot, state: "closed" as const })));
    const sourceControl = {
      getChangeRequest: vi.fn(() => Promise.resolve(ok(snapshot))),
      findOpenChangeRequestsByHead: vi.fn(() => Promise.resolve(ok([snapshot]))),
      closeChangeRequest: close,
    } as unknown as SourceControlPort;
    const authority = new DispatchResolveAuthority({
      project,
      progress,
      jobs: {} as never,
      leases: new LeaseCoordinator(new InMemoryLeaseRepository(), {
        clock: createFixedClock(now.value),
        generateLeaseId: () => ok(id("lease", "lease_218f47d2-77a4-7cc1-8ef2-0123456789ab")),
      }),
      workManagement,
      lifecycleWorkManagement: workManagement,
      sourceControl,
      clock: createFixedClock(now.value),
      generateHolderId: () => "resolve-controller",
    });
    const loaded = await progress.load(jobId);
    if (!loaded.ok || loaded.value === undefined) throw new Error("missing fixture");
    const result = await authority.converge(loaded.value, {
      jobId,
      as: "superseded",
      supersededByJobId: successorId,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(close).not.toHaveBeenCalled();
    expect(setAgentCondition).toHaveBeenCalledTimes(1);
    const kinds = comments.map((comment) => parseJobPrLifecycleComment(comment.body)?.kind);
    expect(kinds.filter((kind) => kind === "authority_conflict")).toHaveLength(1);
    expect(kinds).not.toContain("pr_handoff");
    expect(kinds).not.toContain("job_superseded");
    await expect(progress.load(jobId)).resolves.toMatchObject({
      ok: true,
      value: {
        stage: { kind: "requires_manual" },
        controlFence: { state: "active", ownershipEpoch: 1 },
      },
    });
  });

  it("closes the exact PR and publishes cancellation before terminal progress and releases", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-resolve-authority-"));
    directories.push(root);
    const now = parseInstant("2026-08-26T12:00:00.000Z");
    if (!now.ok) throw new Error(now.error.code);
    const projectId = id("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab");
    const issueId = id("issue", "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab");
    const jobId = id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab");
    const oldLeaseId = id("lease", "lease_018f47d2-77a4-7cc1-8ef2-0123456789aa");
    const project = projectSchema.parse({
      schemaVersion: 1,
      id: projectId,
      displayName: "Fixture",
      localRepositoryPath: "/tmp/fixture",
      defaultBranch: "main",
      workManagement: { provider: "linear", containerId: "team", projectId: "linear-project" },
      sourceControl: { provider: "github", repository: "owner/repository" },
    });
    const issue = issueSchema.parse({
      schemaVersion: 1,
      id: issueId,
      projectId,
      externalId: "ENG-1",
      title: "Cancel exact PR",
      acceptanceCriteria: ["PR closes before local terminal"],
      changeRegions: [{ path: "src", coverage: "subtree" }],
    });
    const branch = `agent-team/${projectId}/${issueId}/${jobId}`;
    const headSha = headShaSchema.parse("a".repeat(40));
    const pointer = createPullRequestBackPointer({
      schemaVersion: 1,
      projectId,
      issueId,
      jobId,
      branch,
    });
    const started = createJobPrLifecycleEvent({
      schemaVersion: 1,
      kind: "job_started",
      projectId,
      issueId,
      jobId,
    });
    const bound = createJobPrLifecycleEvent({
      schemaVersion: 1,
      kind: "pr_bound",
      projectId,
      issueId,
      jobId,
      prNumber: 42,
      branch,
      initialHeadSha: headSha,
      ownershipEpoch: 1,
    });
    if (!pointer.ok || !started.ok || !bound.ok) throw new Error("identity fixture failed");
    const prBody = appendPullRequestBackPointer("work", pointer.value);
    const startedBody = formatJobPrLifecycleComment("started", started.value);
    const boundBody = formatJobPrLifecycleComment("bound", bound.value);
    if (!prBody.ok || !startedBody.ok || !boundBody.ok) throw new Error("format fixture failed");

    const progress = new FileJobProgressStore(
      join(root, "progress"),
      undefined,
      createFixedClock(now.value),
    );
    await progress.compareAndSwap(jobId, null, {
      jobId,
      projectId,
      issueId,
      externalIssueId: "ENG-1",
      model: "gpt-5.6-terra",
      stage: { kind: "requires_manual" },
      branch,
      worktreePath: "/tmp/worktree",
      changeRequestId: "42",
      headSha,
      controlFence: {
        leaseId: oldLeaseId,
        holderId: "old-session",
        leaseEpoch: 1,
        ownershipEpoch: 1,
        state: "active",
      },
    });
    const comments = [
      { id: "c1", body: startedBody.value, createdAt: now.value },
      { id: "c2", body: boundBody.value, createdAt: now.value },
    ];
    const workManagement = {
      getIssue: vi.fn(() =>
        Promise.resolve(
          ok({ issue, workStatus: "canceled" as const, updatedAt: now.value, revision: "r1" }),
        ),
      ),
      listComments: vi.fn(() => Promise.resolve(ok([...comments]))),
      appendComment: vi.fn((_reference, body: string) => {
        const receipt = { id: `c${String(comments.length + 1)}`, body, createdAt: now.value };
        comments.push(receipt);
        return Promise.resolve(ok(receipt));
      }),
    };
    let prState: "open" | "closed" = "open";
    const snapshot = () => ({
      id: "PR_42",
      number: 42,
      url: "https://example.test/pr/42",
      title: "Cancel exact PR",
      body: prBody.value,
      state: prState,
      draft: true,
      headBranch: branch,
      baseBranch: "main",
      headSha,
      baseSha: "b".repeat(40),
      mergeable: "mergeable" as const,
      mergeStateStatus: "clean" as const,
    });
    const close = vi.fn(() => {
      prState = "closed";
      return Promise.resolve(ok(snapshot()));
    });
    const sourceControl = {
      getChangeRequest: vi.fn(() => Promise.resolve(ok(snapshot()))),
      findOpenChangeRequestsByHead: vi.fn(() => Promise.resolve(ok([]))),
      closeChangeRequest: close,
    } as unknown as SourceControlPort;
    const admission = new FileIssueAdmissionStore(join(root, "admission"));
    const claim = await admission.claim(projectId, issueId);
    if (!claim.ok) throw new Error(claim.error.code);
    await admission.attachJob(projectId, issueId, claim.value.revision, jobId);
    const leases = new LeaseCoordinator(new InMemoryLeaseRepository(), {
      clock: createFixedClock(now.value),
      generateLeaseId: () => ok(id("lease", "lease_018f47d2-77a4-7cc1-8ef2-0123456789ab")),
    });
    const authority = new DispatchResolveAuthority({
      project,
      progress,
      jobs: {} as never,
      leases,
      workManagement: workManagement,
      sourceControl,
      clock: createFixedClock(now.value),
      generateHolderId: () => "resolve-controller",
    });
    const handler = createDispatchResolveHandler({
      progress,
      admission,
      authority,
      stdin: confirmation(),
    });
    const resolved = await handler({ jobId, as: "cancelled" });

    expect(resolved.state).toBe("success");
    expect(close).toHaveBeenCalledTimes(1);
    expect(prState).toBe("closed");
    expect(
      comments.some(
        (comment) => parseJobPrLifecycleComment(comment.body)?.kind === "job_cancelled",
      ),
    ).toBe(true);
    await expect(progress.load(jobId)).resolves.toMatchObject({
      ok: true,
      value: { stage: { kind: "cancelled" }, controlFence: { state: "revoked" } },
    });
    await expect(admission.load(projectId, issueId)).resolves.toMatchObject({
      ok: true,
      value: { state: "released", releaseReason: "cancelled" },
    });
  });

  it("preserves an external merge, publishes provenance, and leaves cancellation non-terminal", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-resolve-external-merge-"));
    directories.push(root);
    const now = parseInstant("2026-08-26T12:00:00.000Z");
    if (!now.ok) throw new Error(now.error.code);
    const projectId = id("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab");
    const issueId = id("issue", "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab");
    const jobId = id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab");
    const project = projectSchema.parse({
      schemaVersion: 1,
      id: projectId,
      displayName: "Fixture",
      localRepositoryPath: "/tmp/fixture",
      defaultBranch: "main",
      workManagement: { provider: "linear", containerId: "team", projectId: "linear-project" },
      sourceControl: { provider: "github", repository: "owner/repository" },
    });
    const issue = issueSchema.parse({
      schemaVersion: 1,
      id: issueId,
      projectId,
      externalId: "ENG-2",
      title: "Observe an external merge",
      acceptanceCriteria: ["Do not claim cancellation closed or merged the PR."],
      changeRegions: [{ path: "src", coverage: "subtree" }],
    });
    const branch = `agent-team/${projectId}/${issueId}/${jobId}`;
    const headSha = headShaSchema.parse("a".repeat(40));
    const mergeCommitSha = headShaSchema.parse("c".repeat(40));
    const pointer = createPullRequestBackPointer({
      schemaVersion: 1,
      projectId,
      issueId,
      jobId,
      branch,
    });
    const started = createJobPrLifecycleEvent({
      schemaVersion: 1,
      kind: "job_started",
      projectId,
      issueId,
      jobId,
    });
    const bound = createJobPrLifecycleEvent({
      schemaVersion: 1,
      kind: "pr_bound",
      projectId,
      issueId,
      jobId,
      prNumber: 43,
      branch,
      initialHeadSha: headSha,
      ownershipEpoch: 1,
    });
    if (!pointer.ok || !started.ok || !bound.ok) throw new Error("identity fixture failed");
    const prBody = appendPullRequestBackPointer("work", pointer.value);
    const startedBody = formatJobPrLifecycleComment("started", started.value);
    const boundBody = formatJobPrLifecycleComment("bound", bound.value);
    if (!prBody.ok || !startedBody.ok || !boundBody.ok) throw new Error("format fixture failed");

    const progress = new FileJobProgressStore(
      join(root, "progress"),
      undefined,
      createFixedClock(now.value),
    );
    await progress.compareAndSwap(jobId, null, {
      jobId,
      projectId,
      issueId,
      externalIssueId: "ENG-2",
      model: "gpt-5.6-terra",
      stage: { kind: "requires_manual" },
      branch,
      worktreePath: "/tmp/worktree",
      changeRequestId: "43",
      headSha,
      controlFence: {
        leaseId: id("lease", "lease_018f47d2-77a4-7cc1-8ef2-0123456789aa"),
        holderId: "old-session",
        leaseEpoch: 1,
        ownershipEpoch: 1,
        state: "active",
      },
    });
    const comments = [
      { id: "c1", body: startedBody.value, createdAt: now.value },
      { id: "c2", body: boundBody.value, createdAt: now.value },
    ];
    const issueSnapshot = {
      issue,
      workStatus: "canceled" as const,
      updatedAt: now.value,
      revision: "r1",
    };
    const workManagement = {
      getIssue: vi.fn(() => Promise.resolve(ok(issueSnapshot))),
      listIssues: vi.fn(() => Promise.resolve(ok([issueSnapshot]))),
      listComments: vi.fn(() => Promise.resolve(ok([...comments]))),
      setWorkStatus: vi.fn(() => Promise.resolve(ok(issueSnapshot))),
      setAgentCondition: vi.fn(() => Promise.resolve(ok(issueSnapshot))),
      clearAgentCondition: vi.fn(() => Promise.resolve(ok(issueSnapshot))),
      appendComment: vi.fn((_reference, body: string) => {
        const receipt = { id: `c${String(comments.length + 1)}`, body, createdAt: now.value };
        comments.push(receipt);
        return Promise.resolve(ok(receipt));
      }),
    };
    const snapshot = {
      id: "PR_43",
      number: 43,
      url: "https://example.test/pr/43",
      body: prBody.value,
      state: "merged" as const,
      draft: false,
      headBranch: branch,
      baseBranch: "main",
      headSha,
      baseSha: "b".repeat(40),
      mergeCommitSha,
      mergedAt: now.value,
      mergeability: "mergeable" as const,
      mergeStateStatus: "clean" as const,
      autoMergeEnabled: false,
      updatedAt: now.value,
    };
    const close = vi.fn(() => Promise.resolve(ok(snapshot)));
    const sourceControl = {
      getChangeRequest: vi.fn(() => Promise.resolve(ok(snapshot))),
      findOpenChangeRequestsByHead: vi.fn(() => Promise.resolve(ok([]))),
      closeChangeRequest: close,
    } as unknown as SourceControlPort;
    const admission = new FileIssueAdmissionStore(join(root, "admission"));
    const claim = await admission.claim(projectId, issueId);
    if (!claim.ok) throw new Error(claim.error.code);
    await admission.attachJob(projectId, issueId, claim.value.revision, jobId);
    const leases = new LeaseCoordinator(new InMemoryLeaseRepository(), {
      clock: createFixedClock(now.value),
      generateLeaseId: () => ok(id("lease", "lease_018f47d2-77a4-7cc1-8ef2-0123456789ab")),
    });
    let lifecycleCalls = 0;
    const authority = new DispatchResolveAuthority({
      project,
      progress,
      jobs: {} as never,
      leases,
      workManagement,
      lifecycleWorkManagement: workManagement,
      sourceControl,
      buildLifecycle: ({ workManagement: fencedWorkManagement }) => ({
        run: async ({ idempotencyKeyPrefix }) => {
          lifecycleCalls += 1;
          await fencedWorkManagement.appendComment(
            { project, externalIssueId: "ENG-2" },
            "外部合併稽核留言。",
            { idempotencyKey: `${idempotencyKeyPrefix}:audit` },
          );
          return { state: "blocked" as const, reason: "cancellation_after_merge" as const };
        },
      }),
      clock: createFixedClock(now.value),
      generateHolderId: () => "resolve-controller",
    });
    const handler = createDispatchResolveHandler({
      progress,
      admission,
      authority,
      stdin: confirmation(),
    });

    const resolved = await handler({ jobId, as: "cancelled" });

    expect(resolved.state).toBe("blocked");
    expect(JSON.parse(resolved.message ?? "{}")).toMatchObject({
      reason: "cancellation_after_merge",
    });
    expect(close).not.toHaveBeenCalled();
    expect(lifecycleCalls).toBe(1);
    expect(
      comments.some(
        (comment) => parseJobPrLifecycleComment(comment.body)?.kind === "external_merge_observed",
      ),
    ).toBe(true);
    await expect(progress.load(jobId)).resolves.toMatchObject({
      ok: true,
      value: { stage: { kind: "requires_manual" } },
    });
    await expect(admission.load(projectId, issueId)).resolves.toMatchObject({
      ok: true,
      value: { state: "active", jobId },
    });
  });
});
