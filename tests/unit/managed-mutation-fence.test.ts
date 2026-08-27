import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FileJobProgressStore } from "../../src/adapters/dispatch/job-progress-store.js";
import type {
  GitPort,
  SourceControlPort,
  WorkManagementPort,
} from "../../src/application/ports/index.js";
import {
  FileManagedMutationAuthority,
  ProjectManagedMutationAuthority,
  fenceGitPort,
  fenceSourceControlPort,
  fenceWorkManagementPort,
  type ManagedMutationGate,
} from "../../src/cli/dispatch/managed-mutation-authority.js";
import { createJobPrAuthorityValidator } from "../../src/cli/dispatch/job-pr-authority-validator.js";
import {
  createFixedClock,
  domainError,
  err,
  ok,
  parseIdentifier,
  parseInstant,
  type Identifier,
  type Instant,
} from "../../src/domain/foundation/index.js";
import { projectSchema } from "../../src/domain/project/index.js";
import { issueSchema } from "../../src/domain/project/index.js";
import type { AgentCondition } from "../../src/domain/workflow/index.js";
import {
  appendPullRequestBackPointer,
  createJobPrLifecycleEvent,
  createPullRequestBackPointer,
  formatJobPrLifecycleComment,
  parseJobPrLifecycleComment,
} from "../../src/application/pipelines/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-mutation-fence-"));
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

const now = instant("2026-08-26T12:00:00.000Z");
const projectId = id("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const issueId = id("issue", "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const jobId = id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const leaseId = id("lease", "lease_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const project = projectSchema.parse({
  schemaVersion: 1,
  id: projectId,
  displayName: "Fixture",
  localRepositoryPath: "/tmp/fixture",
  defaultBranch: "main",
  workManagement: { provider: "linear", containerId: "team", projectId: "linear-project" },
  sourceControl: { provider: "github", repository: "owner/repository" },
});

describe("managed mutation fenced port decorators", () => {
  it("blocks every managed provider write before the underlying port is called", async () => {
    const intents: string[] = [];
    const gate: ManagedMutationGate = {
      execute: (_request) => {
        intents.push(_request.intent);
        return Promise.resolve(err(domainError("permission_denied")));
      },
    };
    const sourceMutation = vi.fn(() => Promise.resolve(ok(undefined)));
    const source = fenceSourceControlPort(
      {
        getChangeRequest: vi.fn(),
        findOpenChangeRequestsByHead: vi.fn(),
        getCommitChecks: vi.fn(),
        getCommitStatuses: vi.fn(),
        createDraftChangeRequest: sourceMutation,
        setCommitStatus: sourceMutation,
        appendChangeRequestComment: sourceMutation,
        markChangeRequestReady: sourceMutation,
        enableAutoMerge: sourceMutation,
        closeChangeRequest: sourceMutation,
      } as unknown as SourceControlPort,
      gate,
    );
    const mutation = { idempotencyKey: "fixture" };
    await source.createDraftChangeRequest(
      { project, title: "T", body: "B", baseBranch: "main", headBranch: "task" },
      mutation,
    );
    await source.setCommitStatus(
      {
        project,
        headSha: "a".repeat(40),
        context: "agent-team/review",
        state: "success",
        description: "ok",
      },
      mutation,
    );
    await source.appendChangeRequestComment(
      {
        changeRequest: { project, changeRequestId: "42" },
        expectedHeadSha: "a".repeat(40),
        kind: "automation",
        body: "audit",
      },
      mutation,
    );
    await source.markChangeRequestReady(
      { project, changeRequestId: "42" },
      "a".repeat(40),
      mutation,
    );
    await source.enableAutoMerge({ project, changeRequestId: "42" }, "a".repeat(40), mutation);
    await source.closeChangeRequest({ project, changeRequestId: "42" }, mutation);

    const gitPush = vi.fn(() => Promise.resolve(ok(undefined)));
    const git = fenceGitPort({ push: gitPush } as unknown as GitPort, gate);
    await git.push(
      {
        repositoryRoot: "/tmp/fixture",
        path: "/tmp/worktree",
        branch: "task",
        headSha: "a".repeat(40),
      },
      "origin",
      mutation,
    );

    const linearMutation = vi.fn(() => Promise.resolve(ok(undefined)));
    const work = fenceWorkManagementPort(
      {
        setWorkStatus: linearMutation,
        setAgentCondition: linearMutation,
        clearAgentCondition: linearMutation,
        appendComment: linearMutation,
        uploadArtifact: linearMutation,
      } as unknown as WorkManagementPort,
      gate,
    );
    const issue = { project, externalIssueId: "linear-issue-id" };
    await work.setWorkStatus(issue, "in_progress", mutation);
    await work.setAgentCondition(issue, { status: "executing", blockingReasons: [] }, mutation);
    await work.clearAgentCondition(issue, mutation);
    await work.appendComment(issue, "audit", mutation);
    await work.uploadArtifact(
      issue,
      {
        filename: "evidence.txt",
        mediaType: "text/plain",
        sha256: "b".repeat(64),
        content: new Uint8Array(),
      },
      mutation,
    );

    expect(sourceMutation).not.toHaveBeenCalled();
    expect(gitPush).not.toHaveBeenCalled();
    expect(linearMutation).not.toHaveBeenCalled();
    expect(intents).toEqual([
      "pr_create",
      "review_status",
      "pr_comment",
      "pr_ready",
      "auto_merge",
      "pr_close",
      "git_push",
      "linear_work_status",
      "linear_agent_condition",
      "linear_agent_condition",
      "linear_lifecycle",
      "linear_lifecycle",
    ]);
  });
});

describe("FileManagedMutationAuthority", () => {
  it("persists before send and allows at most initial plus one retry across instances", async () => {
    const directory = await temporaryDirectory();
    const progress = new FileJobProgressStore(directory, undefined, createFixedClock(now));
    await progress.compareAndSwap(jobId, null, {
      jobId,
      projectId,
      issueId,
      externalIssueId: "linear-issue-id",
      model: "gpt-5.6-terra",
      stage: { kind: "ci_waiting" },
      branch: "agent-team/project/issue/job",
      worktreePath: "/tmp/worktree",
      controlFence: {
        leaseId,
        holderId: "controller",
        leaseEpoch: 1,
        ownershipEpoch: 1,
        state: "active",
      },
    });
    const makeAuthority = () =>
      new FileManagedMutationAuthority({
        progress,
        jobId,
        expectedFence: { leaseId, holderId: "controller", leaseEpoch: 1, ownershipEpoch: 1 },
        clock: createFixedClock(now),
        validateAuthority: () => Promise.resolve(ok(undefined)),
      });
    const provider = vi
      .fn()
      .mockResolvedValueOnce(err(domainError("timeout")))
      .mockResolvedValueOnce(ok("closed"));
    const request = {
      intent: "pr_close" as const,
      idempotencyKey: "close:42",
      identity: { projectId, issueId, prNumber: 42, headSha: "a".repeat(40) },
    };

    await expect(makeAuthority().execute(request, provider)).resolves.toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
    await expect(makeAuthority().execute(request, provider)).resolves.toEqual({
      ok: true,
      value: "closed",
    });
    await expect(makeAuthority().execute(request, provider)).resolves.toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });
    expect(provider).toHaveBeenCalledTimes(2);

    const loaded = await progress.load(jobId);
    expect(loaded).toMatchObject({
      ok: true,
      value: {
        mutationAttempts: [
          {
            intent: "pr_close",
            attempts: [
              { ordinal: 1, outcome: "sent_unknown" },
              { ordinal: 2, outcome: "confirmed" },
            ],
          },
        ],
      },
    });
  });

  it("rejects an old holder or lease epoch with zero provider calls", async () => {
    const directory = await temporaryDirectory();
    const progress = new FileJobProgressStore(directory, undefined, createFixedClock(now));
    await progress.compareAndSwap(jobId, null, {
      jobId,
      projectId,
      issueId,
      externalIssueId: "linear-issue-id",
      model: "gpt-5.6-terra",
      stage: { kind: "ci_waiting" },
      branch: "agent-team/project/issue/job",
      worktreePath: "/tmp/worktree",
      controlFence: {
        leaseId,
        holderId: "current",
        leaseEpoch: 2,
        ownershipEpoch: 1,
        state: "active",
      },
    } as never);
    const provider = vi.fn(() => Promise.resolve(ok("must-not-run")));
    const authority = new FileManagedMutationAuthority({
      progress,
      jobId,
      expectedFence: { leaseId, holderId: "old", leaseEpoch: 1, ownershipEpoch: 1 },
      clock: createFixedClock(now),
      validateAuthority: () => Promise.resolve(ok(undefined)),
    });

    await expect(
      authority.execute(
        { intent: "git_push", idempotencyKey: "push", identity: { branch: "task" } },
        provider,
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: "permission_denied" } });
    expect(provider).not.toHaveBeenCalled();
  });

  it("publishes one safe escalation and blocks Linear after two sent-unknown attempts", async () => {
    const directory = await temporaryDirectory();
    const progress = new FileJobProgressStore(directory, undefined, createFixedClock(now));
    const branch = `agent-team/${projectId}/${issueId}/${jobId}`;
    await progress.compareAndSwap(jobId, null, {
      jobId,
      projectId,
      issueId,
      externalIssueId: "ENG-2",
      model: "gpt-5.6-terra",
      stage: { kind: "implementing" },
      branch,
      worktreePath: "/tmp/worktree",
      controlFence: {
        leaseId,
        holderId: "controller",
        leaseEpoch: 1,
        ownershipEpoch: 0,
        state: "active",
      },
    });
    const started = createJobPrLifecycleEvent({
      schemaVersion: 1,
      kind: "job_started",
      projectId,
      issueId,
      jobId,
    });
    if (!started.ok) throw new Error(started.error.code);
    const startedBody = formatJobPrLifecycleComment("started", started.value);
    if (!startedBody.ok) throw new Error(startedBody.error.code);
    const issue = issueSchema.parse({
      schemaVersion: 1,
      id: issueId,
      projectId,
      externalId: "ENG-2",
      title: "Escalate exhausted mutation",
      acceptanceCriteria: ["Public evidence is safe and idempotent."],
      changeRegions: [{ path: "src", coverage: "subtree" }],
    });
    const comments = [{ id: "c1", body: startedBody.value, createdAt: now }];
    const baseSnapshot = {
      issue,
      workStatus: "in_progress" as const,
      updatedAt: now,
      revision: "linear-r1",
    };
    const setAgentCondition = vi.fn((_reference: unknown, condition: AgentCondition) =>
      Promise.resolve(ok({ ...baseSnapshot, agentCondition: condition })),
    );
    const workManagement = {
      getIssue: vi.fn(() => Promise.resolve(ok(baseSnapshot))),
      listIssues: vi.fn(() => Promise.resolve(ok([baseSnapshot]))),
      listComments: vi.fn(() => Promise.resolve(ok([...comments]))),
      setWorkStatus: vi.fn(() => Promise.resolve(ok(baseSnapshot))),
      setAgentCondition,
      clearAgentCondition: vi.fn(() => Promise.resolve(ok(baseSnapshot))),
      appendComment: vi.fn((_reference, body: string) => {
        const receipt = { id: `c${String(comments.length + 1)}`, body, createdAt: now };
        comments.push(receipt);
        return Promise.resolve(ok(receipt));
      }),
    };
    const sourceControl = {
      getChangeRequest: vi.fn(() => Promise.resolve(err(domainError("not_found")))),
      findOpenChangeRequestsByHead: vi.fn(() => Promise.resolve(ok([]))),
    };
    const makeAuthority = () =>
      new FileManagedMutationAuthority({
        progress,
        jobId,
        expectedFence: { leaseId, holderId: "controller", leaseEpoch: 1, ownershipEpoch: 0 },
        clock: createFixedClock(now),
        validateAuthority: () => Promise.resolve(ok(undefined)),
        escalation: {
          project,
          workManagement,
          sourceControl,
        },
      });
    const provider = vi.fn(() => Promise.resolve(err(domainError("timeout"))));
    const request = {
      intent: "git_push" as const,
      idempotencyKey: "push",
      identity: { branch, headSha: "a".repeat(40) },
    };

    await makeAuthority().execute(request, provider);
    await expect(makeAuthority().execute(request, provider)).resolves.toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
    await expect(makeAuthority().execute(request, provider)).resolves.toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });

    expect(provider).toHaveBeenCalledTimes(2);
    expect(
      comments.filter(
        (comment) => parseJobPrLifecycleComment(comment.body)?.kind === "escalation_requested",
      ),
    ).toHaveLength(1);
    expect(setAgentCondition).toHaveBeenCalledTimes(1);
    expect(setAgentCondition.mock.calls[0]?.[1]).toEqual({
      status: "blocked",
      blockingReasons: ["integration_failure"],
    });
  });

  it("publishes a safe authority conflict and blocks before the rejected provider call", async () => {
    const directory = await temporaryDirectory();
    const progress = new FileJobProgressStore(directory, undefined, createFixedClock(now));
    const branch = `agent-team/${projectId}/${issueId}/${jobId}`;
    await progress.compareAndSwap(jobId, null, {
      jobId,
      projectId,
      issueId,
      externalIssueId: "ENG-CONFLICT",
      model: "gpt-5.6-terra",
      stage: { kind: "implementing" },
      branch,
      worktreePath: "/tmp/worktree",
      controlFence: {
        leaseId,
        holderId: "controller",
        leaseEpoch: 1,
        ownershipEpoch: 0,
        state: "active",
      },
    });
    const issue = issueSchema.parse({
      schemaVersion: 1,
      id: issueId,
      projectId,
      externalId: "ENG-CONFLICT",
      title: "Publish authority conflict",
      acceptanceCriteria: ["Provider call stays zero"],
      changeRegions: [{ path: "src", coverage: "subtree" }],
    });
    const baseSnapshot = {
      issue,
      workStatus: "in_progress" as const,
      updatedAt: now,
      revision: "linear-r1",
    };
    const comments: { id: string; body: string; createdAt: Instant }[] = [];
    const setAgentCondition = vi.fn((_reference: unknown, condition: AgentCondition) =>
      Promise.resolve(ok({ ...baseSnapshot, agentCondition: condition })),
    );
    const workManagement = {
      getIssue: vi.fn(() => Promise.resolve(ok(baseSnapshot))),
      listIssues: vi.fn(() => Promise.resolve(ok([baseSnapshot]))),
      listComments: vi.fn(() => Promise.resolve(ok([...comments]))),
      setWorkStatus: vi.fn(() => Promise.resolve(ok(baseSnapshot))),
      setAgentCondition,
      clearAgentCondition: vi.fn(() => Promise.resolve(ok(baseSnapshot))),
      appendComment: vi.fn((_reference, body: string) => {
        const receipt = { id: `c${String(comments.length + 1)}`, body, createdAt: now };
        comments.push(receipt);
        return Promise.resolve(ok(receipt));
      }),
    };
    const authority = new FileManagedMutationAuthority({
      progress,
      jobId,
      expectedFence: { leaseId, holderId: "controller", leaseEpoch: 1, ownershipEpoch: 0 },
      clock: createFixedClock(now),
      validateAuthority: (_record, request) => {
        if (request.intent === "linear_agent_condition") return Promise.resolve(ok(undefined));
        if (request.intent === "linear_lifecycle") {
          const identity = request.identity as Readonly<Record<string, unknown>>;
          const body = identity["body"];
          if (
            typeof body === "string" &&
            parseJobPrLifecycleComment(body)?.kind === "authority_conflict"
          ) {
            return Promise.resolve(ok(undefined));
          }
        }
        return Promise.resolve(err(domainError("conflict")));
      },
      escalation: {
        project,
        workManagement,
        sourceControl: {
          getChangeRequest: vi.fn(),
          findOpenChangeRequestsByHead: vi.fn(),
        },
      },
    });
    const provider = vi.fn(() => Promise.resolve(ok(undefined)));
    const result = await authority.execute(
      {
        intent: "git_push",
        idempotencyKey: "push",
        identity: { branch, headSha: "a".repeat(40) },
      },
      provider,
    );

    expect(result).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(provider).not.toHaveBeenCalled();
    expect(
      comments.filter(
        (comment) => parseJobPrLifecycleComment(comment.body)?.kind === "authority_conflict",
      ),
    ).toHaveLength(1);
    expect(setAgentCondition).toHaveBeenCalledTimes(1);
  });

  it("publishes one conflict and returns when the authoritative issue was archived", async () => {
    const directory = await temporaryDirectory();
    const progress = new FileJobProgressStore(directory, undefined, createFixedClock(now));
    const branch = `agent-team/${projectId}/${issueId}/${jobId}`;
    await progress.compareAndSwap(jobId, null, {
      jobId,
      projectId,
      issueId,
      externalIssueId: "ENG-ARCHIVED",
      model: "gpt-5.6-terra",
      stage: { kind: "implementing" },
      branch,
      worktreePath: "/tmp/worktree",
      controlFence: {
        leaseId,
        holderId: "controller",
        leaseEpoch: 1,
        ownershipEpoch: 0,
        state: "active",
      },
    });
    const issue = issueSchema.parse({
      schemaVersion: 1,
      id: issueId,
      projectId,
      externalId: "ENG-ARCHIVED",
      title: "Archived authority conflict",
      acceptanceCriteria: ["The command returns after one safe projection"],
      changeRegions: [{ path: "src", coverage: "subtree" }],
    });
    const baseSnapshot = {
      issue,
      workStatus: "in_progress" as const,
      archivedAt: now,
      updatedAt: now,
      revision: "linear-r1",
    };
    const comments: { id: string; body: string; createdAt: Instant }[] = [];
    const setAgentCondition = vi.fn((_reference: unknown, condition: AgentCondition) =>
      Promise.resolve(ok({ ...baseSnapshot, agentCondition: condition })),
    );
    const workManagement = {
      getIssue: vi.fn(() => Promise.resolve(ok(baseSnapshot))),
      listIssues: vi.fn(() => Promise.resolve(ok([baseSnapshot]))),
      listComments: vi.fn(() => Promise.resolve(ok([...comments]))),
      setWorkStatus: vi.fn(() => Promise.resolve(ok(baseSnapshot))),
      setAgentCondition,
      clearAgentCondition: vi.fn(() => Promise.resolve(ok(baseSnapshot))),
      appendComment: vi.fn((_reference, body: string) => {
        const receipt = { id: `c${String(comments.length + 1)}`, body, createdAt: now };
        comments.push(receipt);
        return Promise.resolve(ok(receipt));
      }),
    };
    const sourceControl = {
      getChangeRequest: vi.fn(),
      findOpenChangeRequestsByHead: vi.fn(() => Promise.resolve(ok([]))),
    };
    const authority = new FileManagedMutationAuthority({
      progress,
      jobId,
      expectedFence: { leaseId, holderId: "controller", leaseEpoch: 1, ownershipEpoch: 0 },
      clock: createFixedClock(now),
      validateAuthority: createJobPrAuthorityValidator({
        project,
        workManagement,
        sourceControl,
      }),
      escalation: {
        project,
        workManagement,
        sourceControl,
      },
    });
    const provider = vi.fn(() => Promise.resolve(ok(undefined)));

    await expect(
      authority.execute(
        {
          intent: "git_push",
          idempotencyKey: "push",
          identity: { branch, headSha: "a".repeat(40) },
        },
        provider,
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: "conflict" } });

    expect(provider).not.toHaveBeenCalled();
    expect(
      comments.filter(
        (comment) => parseJobPrLifecycleComment(comment.body)?.kind === "authority_conflict",
      ),
    ).toHaveLength(1);
    expect(setAgentCondition).toHaveBeenCalledTimes(1);
    expect(setAgentCondition.mock.calls[0]?.[1]).toEqual({
      status: "blocked",
      blockingReasons: ["integration_failure"],
    });
  });
});

describe("ProjectManagedMutationAuthority", () => {
  it("resolves one public owner for post-PR status writes and rejects a stale process holder", async () => {
    const directory = await temporaryDirectory();
    const progress = new FileJobProgressStore(directory, undefined, createFixedClock(now));
    const branch = `agent-team/${projectId}/${issueId}/${jobId}`;
    const headSha = "a".repeat(40);
    await progress.compareAndSwap(jobId, null, {
      jobId,
      projectId,
      issueId,
      externalIssueId: "ENG-1",
      model: "gpt-5.6-terra",
      stage: { kind: "awaiting_review" },
      branch,
      worktreePath: "/tmp/worktree",
      changeRequestId: "42",
      headSha,
      controlFence: {
        leaseId,
        holderId: "resume-controller",
        leaseEpoch: 1,
        ownershipEpoch: 1,
        state: "active",
      },
    } as never);
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
    const pointer = createPullRequestBackPointer({
      schemaVersion: 1,
      projectId,
      issueId,
      jobId,
      branch,
    });
    if (!started.ok || !bound.ok || !pointer.ok) throw new Error("fixture identity failed");
    const startedBody = formatJobPrLifecycleComment("started", started.value);
    const boundBody = formatJobPrLifecycleComment("bound", bound.value);
    const prBody = appendPullRequestBackPointer("work", pointer.value);
    if (!startedBody.ok || !boundBody.ok || !prBody.ok) throw new Error("fixture format failed");
    const issue = issueSchema.parse({
      schemaVersion: 1,
      id: issueId,
      projectId,
      externalId: "ENG-1",
      title: "Authority",
      acceptanceCriteria: ["One owner"],
      changeRegions: [{ path: "src", coverage: "subtree" }],
    });
    const workManagement = {
      getIssue: vi.fn(() =>
        Promise.resolve(
          ok({ issue, workStatus: "in_review" as const, updatedAt: now, revision: "linear-r1" }),
        ),
      ),
      listComments: vi.fn(() =>
        Promise.resolve(
          ok([
            { id: "c1", body: startedBody.value, createdAt: now },
            { id: "c2", body: boundBody.value, createdAt: now },
          ]),
        ),
      ),
    };
    const providerWrite = vi.fn(() => Promise.resolve(ok(undefined)));
    const sourceControl = {
      getChangeRequest: vi.fn(() =>
        Promise.resolve(
          ok({
            id: "PR_42",
            number: 42,
            url: "https://example.test/pr/42",
            title: "Authority",
            body: prBody.value,
            state: "open" as const,
            draft: true,
            headBranch: branch,
            baseBranch: "main",
            headSha,
            baseSha: "b".repeat(40),
            mergeable: "mergeable" as const,
            mergeStateStatus: "clean" as const,
          }),
        ),
      ),
      findOpenChangeRequestsByHead: vi.fn(() => Promise.resolve(ok([]))),
      setCommitStatus: providerWrite,
    };
    const currentGate = new ProjectManagedMutationAuthority({
      progress,
      project,
      holderId: "resume-controller",
      workManagement,
      sourceControl: sourceControl as never,
      clock: createFixedClock(now),
    });
    const current = fenceSourceControlPort(sourceControl as never, currentGate);
    await expect(
      current.setCommitStatus(
        {
          project,
          headSha,
          context: "agent-team/review",
          state: "success",
          description: "approved",
        },
        { idempotencyKey: "status" },
      ),
    ).resolves.toEqual(ok(undefined));
    expect(providerWrite).toHaveBeenCalledTimes(1);

    const stale = fenceSourceControlPort(
      sourceControl as never,
      new ProjectManagedMutationAuthority({
        progress,
        project,
        holderId: "old-controller",
        workManagement,
        sourceControl: sourceControl as never,
      }),
    );
    await expect(
      stale.setCommitStatus(
        {
          project,
          headSha,
          context: "agent-team/review",
          state: "success",
          description: "approved",
        },
        { idempotencyKey: "stale" },
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: "permission_denied" } });
    expect(providerWrite).toHaveBeenCalledTimes(1);
  });
});
