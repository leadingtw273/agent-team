import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FileIssueAdmissionStore } from "../../src/adapters/dispatch/issue-admission-store.js";
import { FileJobProgressStore } from "../../src/adapters/dispatch/job-progress-store.js";
import { LeaseCoordinator } from "../../src/application/leases/index.js";
import type {
  ChangeRequestSnapshot,
  WorkManagementIssueSnapshot,
} from "../../src/application/ports/index.js";
import {
  LifecyclePipeline,
  createJobPrLifecycleEvent,
  formatJobPrLifecycleComment,
  parseJobPrLifecycleComment,
} from "../../src/application/pipelines/index.js";
import {
  createFixedClock,
  domainError,
  err,
  ok,
  parseIdentifier,
  parseInstant,
  type Identifier,
} from "../../src/domain/foundation/index.js";
import { issueSchema, projectSchema } from "../../src/domain/project/index.js";
import { headShaSchema } from "../../src/domain/review/index.js";
import { InMemoryLeaseRepository } from "../../src/cli/dispatch/ephemeral-ports.js";
import { ExternalMergeRecoveryAuthority } from "../../src/cli/dispatch/external-merge-recovery-authority.js";
import {
  acknowledgeExternalMergeConfirmationPhrase,
  acknowledgeExternalMergeWithoutAcceptanceConfirmationPhrase,
  createAcknowledgeExternalMergeHandler,
} from "../../src/cli/dispatch/external-merge-recovery-handlers.js";
import type { WorkManagementLifecyclePort } from "../../src/cli/dispatch/managed-mutation-authority.js";
import { rotateJobControlFence } from "../../src/cli/dispatch/managed-mutation-authority.js";

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
  yield `${acknowledgeExternalMergeConfirmationPhrase}\n`;
}

async function* acceptanceExceptionConfirmation(): AsyncIterable<string> {
  await Promise.resolve();
  yield `${acknowledgeExternalMergeWithoutAcceptanceConfirmationPhrase}\n`;
}

async function fixture(
  options: Readonly<{
    failFirstAdmissionRelease?: boolean;
    failFirstTerminalCas?: boolean;
    requiresHumanAcceptance?: boolean;
    hasAcceptanceIdentity?: boolean;
    prOverrides?: Partial<ChangeRequestSnapshot>;
    omitMergeCommit?: boolean;
  }> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "agent-team-external-merge-"));
  directories.push(root);
  const now = parseInstant("2026-08-27T00:00:00.000Z");
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
    title: "Recover a legacy external merge",
    acceptanceCriteria: ["Converge without GitHub writes"],
    changeRegions: [{ path: "src", coverage: "subtree" }],
  });
  const branch = `agent-team/${jobId}`;
  const oldHeadSha = headShaSchema.parse("a".repeat(40));
  const headSha = headShaSchema.parse("b".repeat(40));
  const mergeCommitSha = headShaSchema.parse("c".repeat(40));
  const progress = new FileJobProgressStore(
    join(root, "progress"),
    undefined,
    createFixedClock(now.value),
  );
  const created = await progress.compareAndSwap(jobId, null, {
    jobId,
    projectId,
    issueId,
    externalIssueId: issue.externalId,
    model: "gpt-5.6-terra",
    stage: { kind: "requires_manual" },
    branch,
    worktreePath: "/tmp/worktree",
    changeRequestId: "57",
    headSha: oldHeadSha,
    ...(options.requiresHumanAcceptance === true
      ? {
          humanDelivery: {
            acceptanceRequirement: "required" as const,
            verificationLevel: "light" as const,
            requirementDigest: "d".repeat(64),
            humanSummaryDigest: "d".repeat(64),
            ...(options.hasAcceptanceIdentity === true
              ? { acceptanceIdentityDigest: "e".repeat(64) }
              : {}),
          },
        }
      : {}),
  });
  if (!created.ok) throw new Error(created.error.code);
  if (options.failFirstTerminalCas === true) {
    const compareAndSwap = progress.compareAndSwap.bind(progress);
    let failFirstTerminalCas = true;
    vi.spyOn(progress, "compareAndSwap").mockImplementation(async (...args) => {
      if (failFirstTerminalCas && args[2].stage.kind === "completed") {
        failFirstTerminalCas = false;
        return err(domainError("conflict"));
      }
      return compareAndSwap(...args);
    });
  }
  const durableAdmission = new FileIssueAdmissionStore(
    join(root, "admission"),
    undefined,
    createFixedClock(now.value),
  );
  const claimed = await durableAdmission.claim(projectId, issueId, issue.externalId);
  if (!claimed.ok) throw new Error(claimed.error.code);
  const attached = await durableAdmission.attachJob(
    projectId,
    issueId,
    claimed.value.revision,
    jobId,
  );
  if (!attached.ok) throw new Error(attached.error.code);
  let failFirstRelease = options.failFirstAdmissionRelease === true;
  const admission = {
    load: durableAdmission.load.bind(durableAdmission),
    claim: durableAdmission.claim.bind(durableAdmission),
    attachJob: durableAdmission.attachJob.bind(durableAdmission),
    release: async (...args: Parameters<FileIssueAdmissionStore["release"]>) => {
      if (failFirstRelease) {
        failFirstRelease = false;
        return err(domainError("unavailable"));
      }
      return durableAdmission.release(...args);
    },
  };
  const comments: { id: string; body: string; createdAt: typeof now.value }[] = [];
  let issueSnapshot: WorkManagementIssueSnapshot = {
    issue,
    workStatus: "in_progress",
    updatedAt: now.value,
    revision: "r1",
  };
  const appendComment = vi.fn((_reference, body: string) => {
    const comment = { id: `comment-${String(comments.length + 1)}`, body, createdAt: now.value };
    comments.push(comment);
    return Promise.resolve(ok(comment));
  });
  const workManagement: WorkManagementLifecyclePort = {
    getIssue: vi.fn(() => Promise.resolve(ok(issueSnapshot))),
    listIssues: vi.fn(() => Promise.resolve(ok([issueSnapshot]))),
    listComments: vi.fn(() => Promise.resolve(ok([...comments]))),
    setWorkStatus: vi.fn((_reference, status: WorkManagementIssueSnapshot["workStatus"]) => {
      issueSnapshot = { ...issueSnapshot, workStatus: status, revision: "r2" };
      return Promise.resolve(ok(issueSnapshot));
    }),
    setAgentCondition: vi.fn(
      (_reference, condition: NonNullable<WorkManagementIssueSnapshot["agentCondition"]>) => {
        issueSnapshot = { ...issueSnapshot, agentCondition: condition, revision: "r3" };
        return Promise.resolve(ok(issueSnapshot));
      },
    ),
    clearAgentCondition: vi.fn(() => {
      const { agentCondition: _condition, ...rest } = issueSnapshot;
      void _condition;
      issueSnapshot = { ...rest, revision: "r4" };
      return Promise.resolve(ok(issueSnapshot));
    }),
    appendComment,
  };
  const basePr: ChangeRequestSnapshot = {
    id: "PR_57",
    number: 57,
    url: "https://example.test/pr/57",
    state: "merged" as const,
    draft: false,
    baseBranch: "main",
    headBranch: branch,
    headSha,
    body: "legacy PR without agent-team-pr:v1",
    mergeability: "unknown" as const,
    autoMergeEnabled: false,
    mergeCommitSha,
    mergedAt: now.value,
    updatedAt: now.value,
    ...options.prOverrides,
  };
  const pr: ChangeRequestSnapshot =
    options.omitMergeCommit === true
      ? (({ mergeCommitSha: _mergeCommitSha, ...rest }) => {
          void _mergeCommitSha;
          return rest;
        })(basePr)
      : basePr;
  const getChangeRequest = vi.fn(() => Promise.resolve(ok(pr)));
  const forbiddenGitHubWrites = {
    closeChangeRequest: vi.fn(),
    appendChangeRequestComment: vi.fn(),
    enableAutoMerge: vi.fn(),
    squashMergeChangeRequest: vi.fn(),
  };
  const leasesRepository = new InMemoryLeaseRepository();
  let leaseSequence = 0;
  const leases = new LeaseCoordinator(leasesRepository, {
    clock: createFixedClock(now.value),
    generateLeaseId: () => {
      leaseSequence += 1;
      return ok(
        id("lease", `lease_118f47d2-77a4-7cc1-8ef2-${String(leaseSequence).padStart(12, "0")}`),
      );
    },
  });
  const pauseAutoMerge = vi.fn(() =>
    Promise.resolve(ok({ state: "paused" as const, durability: "confirmed" as const })),
  );
  const authority = new ExternalMergeRecoveryAuthority({
    project,
    progress,
    admission,
    leases,
    workManagement,
    sourceControl: Object.assign({ getChangeRequest }, forbiddenGitHubWrites),
    buildLifecycle: ({ sourceControl, workManagement: lifecycleWorkManagement }) =>
      new LifecyclePipeline({
        sourceControl,
        workManagement: lifecycleWorkManagement,
        policy: { pauseAutoMerge },
        cancellation: {
          prepare: () => Promise.resolve(err(domainError("permission_denied"))),
        },
        leaseRelease: {
          release: () => Promise.resolve(err(domainError("permission_denied"))),
        },
      }),
    clock: createFixedClock(now.value),
    generateHolderId: () => "legacy-recovery-controller",
  });
  const input = {
    jobId,
    prNumber: 57,
    headSha,
    mergeCommitSha,
    allowMissingHumanAcceptance: false,
  } as const;
  return {
    authority,
    progress,
    durableAdmission,
    leasesRepository,
    workManagement,
    appendComment,
    comments,
    forbiddenGitHubWrites,
    input,
    jobId,
    projectId,
    issueId,
  };
}

describe("external merge recovery CLI contract", () => {
  it("keeps dry-run advisory and completely read-only", async () => {
    const setup = await fixture();
    const before = await setup.progress.load(setup.jobId);
    const result = await createAcknowledgeExternalMergeHandler({
      progress: setup.progress,
      authority: setup.authority,
    })({ ...setup.input, dryRun: true });

    expect(result.state).toBe("success");
    expect(JSON.parse(result.message ?? "{}")).toMatchObject({
      state: "admissible",
      mode: "recoverable",
      headDrift: true,
    });
    await expect(setup.progress.load(setup.jobId)).resolves.toEqual(before);
    await expect(setup.leasesRepository.readAll()).resolves.toEqual(ok([]));
    expect(setup.appendComment).not.toHaveBeenCalled();
    await expect(
      setup.durableAdmission.load(setup.projectId, setup.issueId),
    ).resolves.toMatchObject({
      ok: true,
      value: { state: "active" },
    });
  });

  it("converges an exact merged PR, records external provenance, and reruns idempotently", async () => {
    const setup = await fixture();
    const run = () =>
      createAcknowledgeExternalMergeHandler({
        progress: setup.progress,
        authority: setup.authority,
        stdin: confirmation(),
      })(setup.input);

    const first = await run();
    expect(first.state).toBe("success");
    expect(JSON.parse(first.message ?? "{}")).toMatchObject({ mode: "recovered", headDrift: true });
    await expect(setup.progress.load(setup.jobId)).resolves.toMatchObject({
      ok: true,
      value: { stage: { kind: "completed" }, controlFence: { state: "revoked" } },
    });
    await expect(
      setup.durableAdmission.load(setup.projectId, setup.issueId),
    ).resolves.toMatchObject({
      ok: true,
      value: { state: "released", releaseReason: "completed", jobId: setup.jobId },
    });
    const eventKinds = setup.comments.flatMap((comment) => {
      const event = parseJobPrLifecycleComment(comment.body);
      return event === undefined ? [] : [event.kind];
    });
    expect(eventKinds).toEqual(["external_merge_observed", "job_completed"]);
    expect(
      setup.comments.filter((comment) =>
        comment.body.includes("agent-team-external-merge-recovery:v1"),
      ),
    ).toHaveLength(1);
    expect(setup.comments.find((comment) => comment.body.includes("舊 Job Head="))?.body).toContain(
      "未宣稱由 Controller 授權",
    );
    Object.values(setup.forbiddenGitHubWrites).forEach((spy) => {
      expect(spy).not.toHaveBeenCalled();
    });
    const leases = await setup.leasesRepository.readAll();
    expect(leases.ok).toBe(true);
    if (!leases.ok) throw new Error(leases.error.code);
    expect(leases.value).toHaveLength(1);
    expect(leases.value[0]?.releasedAt).toBeDefined();

    const commentCount = setup.comments.length;
    const second = await run();
    expect(second.state).toBe("success");
    expect(JSON.parse(second.message ?? "{}")).toMatchObject({ mode: "already_finalized" });
    expect(setup.comments).toHaveLength(commentCount);
  });

  it("fails exact identity admission with zero mutation", async () => {
    const setup = await fixture();
    const before = await setup.progress.load(setup.jobId);
    const result = await createAcknowledgeExternalMergeHandler({
      progress: setup.progress,
      authority: setup.authority,
    })({ ...setup.input, headSha: "d".repeat(40), dryRun: true });

    expect(result.state).toBe("blocked");
    await expect(setup.progress.load(setup.jobId)).resolves.toEqual(before);
    expect(setup.appendComment).not.toHaveBeenCalled();
    await expect(setup.leasesRepository.readAll()).resolves.toEqual(ok([]));
  });

  it.each([
    ["wrong PR number", { number: 58 }],
    ["open PR", { state: "open" as const }],
    ["wrong base", { baseBranch: "release" }],
    ["wrong head branch", { headBranch: "other/job" }],
  ])("blocks %s before any mutation", async (_name, prOverrides) => {
    const setup = await fixture({ prOverrides });
    const before = await setup.progress.load(setup.jobId);
    const result = await createAcknowledgeExternalMergeHandler({
      progress: setup.progress,
      authority: setup.authority,
    })({ ...setup.input, dryRun: true });

    expect(result.state).toBe("blocked");
    await expect(setup.progress.load(setup.jobId)).resolves.toEqual(before);
    expect(setup.appendComment).not.toHaveBeenCalled();
    await expect(setup.leasesRepository.readAll()).resolves.toEqual(ok([]));
  });

  it("blocks a missing merge receipt before any mutation", async () => {
    const setup = await fixture({ omitMergeCommit: true });
    const before = await setup.progress.load(setup.jobId);
    const result = await createAcknowledgeExternalMergeHandler({
      progress: setup.progress,
      authority: setup.authority,
    })({ ...setup.input, dryRun: true });
    expect(result.state).toBe("blocked");
    await expect(setup.progress.load(setup.jobId)).resolves.toEqual(before);
    expect(setup.appendComment).not.toHaveBeenCalled();
  });

  it("allows only one of two concurrent recoveries to mutate", async () => {
    const setup = await fixture();
    const loaded = await setup.progress.load(setup.jobId);
    if (!loaded.ok || loaded.value === undefined) throw new Error("fixture missing");

    const outcomes = await Promise.all([
      setup.authority.recover(loaded.value, setup.input),
      setup.authority.recover(loaded.value, setup.input),
    ]);
    expect(outcomes.filter((result) => result.ok)).toHaveLength(1);
    expect(outcomes.filter((result) => !result.ok)).toHaveLength(1);
    expect(
      setup.comments.filter(
        (comment) => parseJobPrLifecycleComment(comment.body)?.kind === "external_merge_observed",
      ),
    ).toHaveLength(1);
    expect(
      setup.comments.filter(
        (comment) => parseJobPrLifecycleComment(comment.body)?.kind === "job_completed",
      ),
    ).toHaveLength(1);
  });

  it("recovers the terminal-after-CAS boundary without rotating a new fence", async () => {
    const setup = await fixture({ failFirstAdmissionRelease: true });
    const first = await createAcknowledgeExternalMergeHandler({
      progress: setup.progress,
      authority: setup.authority,
      stdin: confirmation(),
    })(setup.input);
    expect(first.state).toBe("failed");
    const terminal = await setup.progress.load(setup.jobId);
    expect(terminal.ok).toBe(true);
    if (!terminal.ok || terminal.value === undefined) throw new Error("fixture missing");
    expect(terminal.value.revision).toBeGreaterThan(0);
    expect(terminal.value.stage).toEqual({ kind: "completed" });
    expect(terminal.value.controlFence).toMatchObject({ state: "revoked", leaseEpoch: 1 });
    await expect(
      setup.durableAdmission.load(setup.projectId, setup.issueId),
    ).resolves.toMatchObject({
      ok: true,
      value: { state: "active" },
    });
    const beforeFinalize = await setup.progress.load(setup.jobId);

    const second = await createAcknowledgeExternalMergeHandler({
      progress: setup.progress,
      authority: setup.authority,
      stdin: confirmation(),
    })(setup.input);
    expect(second.state).toBe("success");
    expect(JSON.parse(second.message ?? "{}")).toMatchObject({ mode: "finalized" });
    await expect(setup.progress.load(setup.jobId)).resolves.toEqual(beforeFinalize);
    await expect(
      setup.durableAdmission.load(setup.projectId, setup.issueId),
    ).resolves.toMatchObject({
      ok: true,
      value: { state: "released", releaseReason: "completed" },
    });
    const leases = await setup.leasesRepository.readAll();
    expect(leases.ok).toBe(true);
    if (!leases.ok) throw new Error(leases.error.code);
    expect(leases.value).toHaveLength(1);
    expect(leases.value[0]?.releasedAt).toBeDefined();
  });

  it("reuses public lifecycle mutations after a crash before terminal CAS", async () => {
    const setup = await fixture({ failFirstTerminalCas: true });
    const run = () =>
      createAcknowledgeExternalMergeHandler({
        progress: setup.progress,
        authority: setup.authority,
        stdin: confirmation(),
      })(setup.input);

    const first = await run();
    expect(first.state).toBe("blocked");
    const commentCount = setup.comments.length;
    expect(commentCount).toBe(3);
    await expect(setup.progress.load(setup.jobId)).resolves.toMatchObject({
      ok: true,
      value: { stage: { kind: "requires_manual" }, controlFence: { state: "active" } },
    });

    const second = await run();
    expect(second.state).toBe("success");
    expect(JSON.parse(second.message ?? "{}")).toMatchObject({ mode: "recovered" });
    expect(setup.comments).toHaveLength(commentCount);
    Object.values(setup.forbiddenGitHubWrites).forEach((spy) => {
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it("blocks a required human acceptance that has no receipt", async () => {
    const setup = await fixture({ requiresHumanAcceptance: true });
    const loaded = await setup.progress.load(setup.jobId);
    if (!loaded.ok || loaded.value === undefined) throw new Error("fixture missing");

    await expect(setup.authority.inspect(loaded.value, setup.input)).resolves.toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect(setup.appendComment).not.toHaveBeenCalled();
  });

  it("does not treat a pending acceptance identity as an accepted decision", async () => {
    const setup = await fixture({ requiresHumanAcceptance: true, hasAcceptanceIdentity: true });
    const loaded = await setup.progress.load(setup.jobId);
    if (!loaded.ok || loaded.value === undefined) throw new Error("fixture missing");

    await expect(setup.authority.inspect(loaded.value, setup.input)).resolves.toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
  });

  it("requires an explicit audited exception for an already-merged required acceptance", async () => {
    const setup = await fixture({ requiresHumanAcceptance: true });
    const existingEvent = createJobPrLifecycleEvent({
      schemaVersion: 1,
      kind: "external_merge_observed",
      projectId: setup.projectId,
      issueId: setup.issueId,
      prNumber: setup.input.prNumber,
      mergeCommitSha: setup.input.mergeCommitSha,
    });
    if (!existingEvent.ok) throw new Error(existingEvent.error.code);
    const existingBody = formatJobPrLifecycleComment(
      "既有流程外合併事件，不含人工驗收例外揭露。",
      existingEvent.value,
    );
    if (!existingBody.ok) throw new Error(existingBody.error.code);
    const createdAt = parseInstant("2026-08-27T00:00:00.000Z");
    if (!createdAt.ok) throw new Error(createdAt.error.code);
    setup.comments.push({
      id: "existing-external",
      body: existingBody.value,
      createdAt: createdAt.value,
    });
    const result = await createAcknowledgeExternalMergeHandler({
      progress: setup.progress,
      authority: setup.authority,
      stdin: acceptanceExceptionConfirmation(),
    })({ ...setup.input, allowMissingHumanAcceptance: true });

    expect(result.state).toBe("success");
    expect(JSON.parse(result.message ?? "{}")).toMatchObject({
      mode: "recovered",
      humanAcceptanceException: true,
    });
    expect(
      setup.comments.find((comment) => comment.body.includes("recovery exception"))?.body,
    ).toContain("未宣稱人工驗收通過");
  });

  it("blocks a normally completed Job that lacks the exact public recovery marker", async () => {
    const setup = await fixture();
    const loaded = await setup.progress.load(setup.jobId);
    if (!loaded.ok || loaded.value === undefined) throw new Error("fixture missing");
    const lease = await new LeaseCoordinator(setup.leasesRepository, {
      generateLeaseId: () => ok(id("lease", "lease_218f47d2-77a4-7cc1-8ef2-0123456789ab")),
    }).acquire({ jobId: setup.jobId, issueId: setup.issueId, holderId: "normal-controller" });
    if (!lease.ok) throw new Error(lease.error.code);
    const fenced = await rotateJobControlFence(setup.progress, loaded.value, lease.value.value);
    if (!fenced.ok) throw new Error(fenced.error.code);
    const {
      schemaVersion: _schemaVersion,
      revision: _revision,
      updatedAt: _updatedAt,
      ...loadedMutation
    } = fenced.value;
    void _schemaVersion;
    void _revision;
    void _updatedAt;
    const activeFence = fenced.value.controlFence;
    if (activeFence === undefined) throw new Error("fixture fence missing");
    const written = await setup.progress.compareAndSwap(setup.jobId, fenced.value.revision, {
      ...loadedMutation,
      stage: { kind: "completed" },
      controlFence: {
        ...activeFence,
        state: "revoked",
      },
    });
    if (!written.ok) throw new Error(written.error.code);
    const completed = createJobPrLifecycleEvent({
      schemaVersion: 1,
      kind: "job_completed",
      projectId: setup.projectId,
      issueId: setup.issueId,
      jobId: setup.jobId,
      prNumber: setup.input.prNumber,
      mergeCommitSha: setup.input.mergeCommitSha,
    });
    if (!completed.ok) throw new Error(completed.error.code);
    const body = formatJobPrLifecycleComment("Normal completion", completed.value);
    if (!body.ok) throw new Error(body.error.code);
    const createdAt = parseInstant("2026-08-27T00:00:00.000Z");
    if (!createdAt.ok) throw new Error(createdAt.error.code);
    setup.comments.push({ id: "normal", body: body.value, createdAt: createdAt.value });

    await expect(setup.authority.inspect(written.value, setup.input)).resolves.toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
  });
});
