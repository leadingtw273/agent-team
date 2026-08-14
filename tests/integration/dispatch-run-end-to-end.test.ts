/**
 * C015b end-to-end integration test (decision-layer Q3 requirement): proves the *entire* chain
 * from a Linear issue's raw description all the way to `ImplementerPipeline` reaching
 * `ci_waiting` is genuinely unbroken -- not individually-mocked pieces that merely compile
 * together. Real: `parseReadyGateTemplate` (via the real, unmocked `discoverReadyDispatchCandidates`),
 * `evaluateEligibility`/`decideNextDispatch` (via the real, unmocked `Dispatcher.dispatch()`
 * inside the real `dispatchOnce`), `FileLeaseRepository`/`FileJobRepository` (temp dir),
 * `buildImplementerPipelineRequest`, and `LocalGitAdapter`+`GitPreflight` against a real temporary
 * git repository and bare remote (same technique as
 * tests/integration/implementer-pipeline.test.ts, which already independently proves that git
 * leg needs no adapter). Fake, per the task packet's own item-6 instruction ("fake ProcessPort
 * 腳本化 Claude 輸出、fake GitHub/Linear transport"): the Claude capability probe's `ProcessPort`
 * (scripted zero-exit), the `ImplementerPipeline`'s `provider` (a scripted fake standing in for
 * real Claude output) and `sourceControl` (no real GitHub calls). `scopeCheckpoint`/
 * `toolDecisions` are unreachable in this happy path (no scope overrun, no tool_request) and are
 * fakes that would throw if ever called, as a tripwire.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { GitPreflight, LocalGitAdapter } from "../../src/adapters/git/index.js";
import type { LinearDiscoveryReadModel } from "../../src/adapters/dispatch/linear-discovery.js";
import {
  buildLinearReadCatalog,
  linearAgentRoleNames,
  linearAgentStatusNames,
  linearBlockingReasonNames,
  linearReviewRequirementNames,
  linearWorkStatusNames,
  type LinearLabelRecord,
  type LinearProjectContext,
  type LinearWorkflowStateRecord,
} from "../../src/adapters/linear/model.js";
import { agentRoleSchema, reviewRequirementSchema } from "../../src/domain/project/index.js";
import { agentStatuses, blockingReasons } from "../../src/domain/workflow/index.js";
import { readyGateTemplateHeadings } from "../../src/application/registration/linear-provision-model.js";
import { dispatchOnce, type DispatchCompositionReady } from "../../src/cli/dispatch/composition.js";
import { buildImplementerPipelineRequest } from "../../src/cli/dispatch/implementer-request.js";
import { LeaseCoordinator } from "../../src/application/leases/index.js";
import {
  ImplementerPipeline,
  type ImplementerPipelinePorts,
} from "../../src/application/pipelines/index.js";
import type { ProcessPort, ProviderRunHandle } from "../../src/application/ports/index.js";
import type { ModelRoutingConfig } from "../../src/application/routing/index.js";
import { ok, parseInstant, type Instant } from "../../src/domain/foundation/index.js";
import { projectSchema } from "../../src/domain/project/index.js";
import { trustedProjectConfigSchema } from "../../src/application/projects/index.js";
import { FileJobRepository } from "../../src/infrastructure/jobs/index.js";
import { FileLeaseRepository } from "../../src/infrastructure/leases/index.js";
import { FileJobProgressStore } from "../../src/adapters/dispatch/job-progress-store.js";
import { FileIssueAdmissionStore } from "../../src/adapters/dispatch/issue-admission-store.js";
import { headShaSchema } from "../../src/domain/review/index.js";

const run = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, arguments_: readonly string[]): Promise<string> {
  const result = await run("git", arguments_, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-c015b-e2e-"));
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

/** A real, fully-compliant Ready Gate template description -- exactly what a human is asked to
 * fill in by the "Agent Team｜需求受理" template provisioned to Linear (readyGateTemplateHeadings,
 * src/application/registration/linear-provision-model.ts). `changeRegions` names the one file the
 * fake provider below actually writes, so `GitPreflight`'s scope check genuinely passes. */
function readyGateDescription(): string {
  return `## ${readyGateTemplateHeadings.goal}
證明從 Linear 描述到 CI waiting 全鏈無縫。

## ${readyGateTemplateHeadings.background}
C015b 決策層 Q3 要求至少一條端到端測試走真解析器。

## ${readyGateTemplateHeadings.acceptanceCriteria}
- pipeline 到達 ci_waiting

## ${readyGateTemplateHeadings.inScope}
- src/feature

## ${readyGateTemplateHeadings.outOfScope}
- reviewer pipeline

## ${readyGateTemplateHeadings.dependencies}
無

## ${readyGateTemplateHeadings.estimatedMinutes}
30

## ${readyGateTemplateHeadings.constraints}

## ${readyGateTemplateHeadings.risks}

## ${readyGateTemplateHeadings.changeRegions}
- src/feature/index.ts
`;
}

/** Builds a genuinely complete, `buildLinearReadCatalog`-validated catalog -- same technique
 * tests/unit/dispatch-linear-discovery.test.ts uses -- so this fixture is exactly as strict as
 * the real `LinearReadModel.readContext` would produce. */
function linearProjectContext(): LinearProjectContext {
  const states: LinearWorkflowStateRecord[] = Object.entries(linearWorkStatusNames).map(
    ([status, name], index) => ({ id: `state-${status}-${String(index)}`, name, type: status }),
  );
  function group(groupName: string, id: string): LinearLabelRecord {
    return { id, name: groupName, isGroup: true, parentId: null };
  }
  function child(name: string, parentId: string, id: string): LinearLabelRecord {
    return { id, name, isGroup: false, parentId };
  }
  const groupIds = {
    agentRole: "label-group-agent-role",
    reviewRequirement: "label-group-review-requirement",
    agentStatus: "label-group-agent-status",
    blockingReason: "label-group-blocking-reason",
  };
  const labels: LinearLabelRecord[] = [
    group("Agent 角色", groupIds.agentRole),
    ...agentRoleSchema.options.map((key, index) =>
      child(linearAgentRoleNames[key], groupIds.agentRole, `label-agent-role-${String(index)}`),
    ),
    group("審查需求", groupIds.reviewRequirement),
    ...reviewRequirementSchema.options.map((key, index) =>
      child(
        linearReviewRequirementNames[key],
        groupIds.reviewRequirement,
        `label-review-requirement-${String(index)}`,
      ),
    ),
    group("Agent 狀態", groupIds.agentStatus),
    ...agentStatuses.map((key, index) =>
      child(
        linearAgentStatusNames[key],
        groupIds.agentStatus,
        `label-agent-status-${String(index)}`,
      ),
    ),
    group("阻塞原因", groupIds.blockingReason),
    ...blockingReasons.map((key, index) =>
      child(
        linearBlockingReasonNames[key],
        groupIds.blockingReason,
        `label-blocking-reason-${String(index)}`,
      ),
    ),
  ];
  const catalog = buildLinearReadCatalog(states, labels);
  if (!catalog.ok) throw new Error("fixture invariant violated: catalog must build cleanly");
  return Object.freeze({
    team: Object.freeze({ id: "team-1", name: "Team", key: "TM" }),
    project: Object.freeze({ id: "linear-proj-1", name: "Project" }),
    catalog: catalog.value,
  });
}

const validRoutingConfig: ModelRoutingConfig = {
  schemaVersion: 1,
  routes: [
    { role: "team_lead", candidates: [{ provider: "codex", model: "lead" }] },
    { role: "implementer", candidates: [{ provider: "codex", model: "gpt-5.6-terra" }] },
    { role: "code_reviewer", candidates: [{ provider: "claude", model: "opus" }] },
    { role: "visual_reviewer", candidates: [{ provider: "gemini", model: "visual" }] },
    { role: "integration_engineer", candidates: [{ provider: "codex", model: "integrate" }] },
  ],
};

/** Reports the Claude capability probe as alive without spawning any real process. */
class ReadyClaudeProcessPort implements ProcessPort {
  spawn(): ReturnType<ProcessPort["spawn"]> {
    return Promise.resolve(
      ok({
        pid: 1,
        output: (async function* () {
          await Promise.resolve();
        })(),
        writeStdin: () => Promise.resolve(ok(undefined)),
        closeStdin: () => Promise.resolve(ok(undefined)),
        sendSignal: () => Promise.resolve(ok(undefined)),
        wait: () =>
          Promise.resolve(
            ok({
              exitCode: 0,
              signal: null,
              startedAt: "2026-08-07T00:00:00.000Z" as never,
              exitedAt: "2026-08-07T00:00:00.000Z" as never,
              outputTruncated: false,
            }),
          ),
      }),
    );
  }
}

describe("C015b end to end: Ready Gate description -> dispatch -> ImplementerPipeline ci_waiting", () => {
  it("carries a real Linear description all the way to a real ci_waiting outcome", async () => {
    const root = await temporaryDirectory();
    const repository = join(root, "repository");
    const remote = join(root, "remote.git");
    await mkdir(repository, { recursive: true });
    await git(repository, ["init", "-b", "main"]);
    await git(repository, ["config", "user.email", "agent-team@example.invalid"]);
    await git(repository, ["config", "user.name", "Agent Team Fixture"]);
    await writeFile(join(repository, "README.md"), "fixture\n", "utf8");
    await git(repository, ["add", "README.md"]);
    await git(repository, ["commit", "-m", "initial"]);
    await git(root, ["init", "--bare", remote]);
    await git(repository, ["remote", "add", "origin", remote]);
    await git(repository, ["push", "-u", "origin", "main"]);

    const projectId = "project_018f47d2-77a4-7cc1-8ef2-0123456789ab";
    const project = projectSchema.parse({
      schemaVersion: 1,
      id: projectId,
      displayName: "E2E fixture",
      localRepositoryPath: repository,
      defaultBranch: "main",
      workManagement: { provider: "linear", containerId: "team-1", projectId: "linear-proj-1" },
      sourceControl: { provider: "github", repository: "owner/repository" },
    });
    const trustedConfig = trustedProjectConfigSchema.parse({
      schemaVersion: 1,
      projectId,
      defaultBranch: "main",
      platforms: { workManagement: project.workManagement, sourceControl: project.sourceControl },
      projectRules: [],
      roleInstructions: {},
      commands: { quality: [{ executable: "pnpm", arguments: ["test"] }], visualReview: [] },
    });

    const readModel: LinearDiscoveryReadModel = {
      readContext: () => Promise.resolve(ok(linearProjectContext())),
      listIssueIdsInState: () => Promise.resolve(ok(["linear-issue-e2e"])),
      readIssue: () =>
        Promise.resolve(
          ok({
            id: "linear-issue-e2e",
            identifier: "ENG-E2E",
            title: "Prove the full C015b chain",
            description: readyGateDescription(),
            updatedAt: instant("2026-08-07T00:00:00.000Z"),
            teamId: "team-1",
            projectId: "linear-proj-1",
            workStatus: "ready" as const,
            agentRole: "implementer" as const,
            reviewRequirement: "code_review" as const,
            priority: "high" as const,
            otherLabelIds: [],
            relations: [],
            comments: [],
          }),
        ),
    };

    // Deliberately not pre-created with a plain `mkdir` (0755): `FileLeaseRepository`/
    // `FileJobRepository`'s underlying lock directory fails closed (permission_denied) on a
    // world-readable parent -- it creates its own secure (0700) directory on first use, the same
    // way tests/unit/dispatch-once-lease-conflict.test.ts's temp roots do.
    const stateRoot = join(root, "state");
    const leases = new FileLeaseRepository(
      join(stateRoot, "leases.json"),
      join(stateRoot, "leases.lock"),
    );
    const jobs = new FileJobRepository(join(stateRoot, "jobs.json"), join(stateRoot, "jobs.lock"));

    const ready: DispatchCompositionReady = {
      leases,
      jobs,
      registry: {
        ready: [{ state: "ready", project, config: trustedConfig, revisionSha: "a".repeat(40) }],
        rejected: [],
      },
      routingConfig: validRoutingConfig,
      discovery: {
        teamId: "team-1",
        linearProjectId: "linear-proj-1",
        readModel: readModel as never,
        // Never exercised by this test: the E2E chain stops at `ci_waiting`, well before
        // `LifecyclePipeline` (C015c item 5) would ever consult a mutation client.
        mutationClient: {} as never,
        // E102-5: never exercised for the identical reason -- see `mutationClient` above.
        linearTransport: {} as never,
      },
      project,
      trustedConfig,
      claude: {
        config: { executable: "claude", models: ["opus"], account: "default" },
        process: new ReadyClaudeProcessPort(),
      },
      codex: {
        config: { executable: "codex", models: ["gpt-5.6-terra"], account: "default" },
        process: new ReadyClaudeProcessPort(),
      },
      quotaAdmission: {
        resolve: () => Promise.resolve({ state: "ready" as const, reason: "test_fixture" }),
      },
    };

    // === Real discovery (real parseReadyGateTemplate) -> real eligibility -> real dispatch ===
    // C015o decision 3: a real, file-backed admission store (same temp root as everything else
    // this fixture already uses), never the ephemeral in-memory one -- this is the genuine-run
    // path, not `--dry-run`.
    const admission = new FileIssueAdmissionStore(join(root, "state", "dispatch", "admission"));
    const dispatched = await dispatchOnce(
      ready,
      { leases: new LeaseCoordinator(leases), jobs, admission },
      "holder-e2e",
    );
    if (dispatched.outcome !== "ran") {
      throw new Error(`expected discovery to succeed: ${JSON.stringify(dispatched)}`);
    }
    if (dispatched.result.kind !== "dispatched") {
      throw new Error(`expected a real dispatch: ${JSON.stringify(dispatched.result)}`);
    }
    const dispatchResult = dispatched.result;
    expect(dispatchResult.decision.candidate.role).toBe("implementer");
    expect(dispatchResult.decision.model?.candidate).toEqual({
      provider: "codex",
      model: "gpt-5.6-terra",
    });

    const issue = dispatched.candidates.find(
      (candidate) => candidate.issue.id === dispatchResult.job.issueId,
    )?.issue;
    if (issue === undefined) throw new Error("dispatched issue missing from candidates");
    // Proves the real parser actually ran: every field it extracted from the raw description is
    // present on the domain Issue the Dispatcher accepted as eligible.
    expect(issue.goal).toBe("證明從 Linear 描述到 CI waiting 全鏈無縫。");
    expect(issue.changeRegions).toEqual([{ path: "src/feature/index.ts", coverage: "exact" }]);
    expect(issue.dependencies).toEqual({ kind: "none" });

    // === Real baseRevision resolution + real request construction ===
    const localGit = new LocalGitAdapter();
    const repositorySnapshot = await localGit.inspectRepository({ rootPath: repository });
    if (!repositorySnapshot.ok) throw new Error(repositorySnapshot.error.code);

    const worktreePath = join(root, "worktrees", dispatchResult.job.id);
    await mkdir(join(root, "worktrees"), { recursive: true });
    const branch = `agent-team/${dispatchResult.job.id}`;
    const request = buildImplementerPipelineRequest({
      job: dispatchResult.job,
      issue,
      project,
      trustedConfig,
      model: "opus",
      agentTeamHome: root,
      clock: { now: () => instant("2026-08-07T00:05:00.000Z") },
      baseRevision: repositorySnapshot.value.headSha,
    });
    if (!request.ok) throw new Error(`expected a valid request: ${JSON.stringify(request.error)}`);
    // Override the worktree path/branch to this test's own layout (buildImplementerPipelineRequest
    // derives them from agentTeamHome/job.id, which is correct production behavior, but this test
    // wants full control of the directory layout it just created above).
    const pipelineRequest = { ...request.value, worktreePath, branch };

    // === Real Git leg (real temp repo + bare remote), fake provider/sourceControl ===
    const providerHandle: ProviderRunHandle = {
      runId: "e2e-fixture-run",
      events: {
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
        },
      },
      completion: () => Promise.resolve(ok({ outcome: "completed" })),
      respondToToolRequest: () =>
        Promise.reject(new Error("must never be called: no tool_request in this happy path")),
      interrupt: () =>
        Promise.reject(new Error("must never be called: no interruption in this happy path")),
    };
    const ports: ImplementerPipelinePorts = {
      git: localGit,
      preflight: new GitPreflight(localGit),
      provider: {
        inspectCapabilities: () =>
          Promise.reject(new Error("must never be called by ImplementerPipeline.run")),
        start: async () => {
          // Scripted Claude output (task packet item 6: "fake ProcessPort 腳本化 Claude 輸出"):
          // the one file the Ready Gate description declared as in scope.
          await mkdir(join(worktreePath, "src", "feature"), { recursive: true });
          await writeFile(
            join(worktreePath, "src", "feature", "index.ts"),
            "export const ready = true;\n",
            "utf8",
          );
          return ok(providerHandle);
        },
      },
      sourceControl: {
        createDraftChangeRequest: async () => {
          const headSha = await git(root, [
            "--git-dir",
            remote,
            "rev-parse",
            `refs/heads/${branch}`,
          ]);
          return ok({
            id: "PR_e2e_fixture",
            number: 1,
            url: "https://example.invalid/pull/1",
            state: "open" as const,
            draft: true,
            baseBranch: "main",
            headBranch: branch,
            headSha,
            mergeability: "unknown" as const,
            autoMergeEnabled: false,
            updatedAt: instant("2026-08-07T00:10:00.000Z"),
          });
        },
        getCommitChecks: (_repository, headSha) =>
          Promise.resolve(ok({ headSha, aggregate: "pending" as const, checks: [] })),
      },
      scopeCheckpoint: {
        preserve: () => Promise.reject(new Error("must never be called: no scope overrun")),
      },
      toolDecisions: {
        decide: () => Promise.reject(new Error("must never be called: no tool_request")),
      },
    };

    const outcome = await new ImplementerPipeline(ports).run(pipelineRequest);

    if (outcome.state !== "ci_waiting") {
      throw new Error(`expected ci_waiting, got: ${JSON.stringify(outcome)}`);
    }
    expect(outcome.changeRequest.draft).toBe(true);
    expect(outcome.checks.aggregate).toBe("pending");
    expect(await git(worktreePath, ["status", "--porcelain"])).toBe("");
    const remoteSha = await git(root, ["--git-dir", remote, "rev-parse", `refs/heads/${branch}`]);
    expect(remoteSha).toBe(outcome.commit.sha);

    // === The job/lease this real dispatch created are genuinely on disk ===
    const persistedJobs = await jobs.readAll();
    expect(persistedJobs.ok).toBe(true);
    if (persistedJobs.ok) expect(persistedJobs.value).toHaveLength(1);

    // === C015c item 2's own backport: the real ci_waiting outcome's fields (changeRequest.number,
    // commit.sha) round-trip through the real FileJobProgressStore exactly the way
    // handlers.ts's own backport write uses them (same schema, same required fields). This proves
    // the *data contract* a genuine ImplementerPipeline outcome offers is actually compatible with
    // what the job-progress schema requires -- handlers.ts's own field mapping is a few lines of
    // straight-line code covered by the type checker; what could genuinely surprise us is whether
    // a real `commit.sha`/`changeRequest.number` shape ever fails to satisfy the schema, which this
    // proves it does not. ===
    const progressDirectory = join(root, "state", "dispatch", "progress");
    const progress = new FileJobProgressStore(progressDirectory);
    const headSha = headShaSchema.parse(outcome.commit.sha);
    const recorded = await progress.compareAndSwap(dispatchResult.job.id, null, {
      jobId: dispatchResult.job.id,
      projectId: project.id,
      issueId: dispatchResult.job.issueId,
      externalIssueId: issue.externalId,
      model: "opus",
      stage: { kind: "ci_waiting" },
      branch: pipelineRequest.branch,
      worktreePath: pipelineRequest.worktreePath,
      changeRequestId: String(outcome.changeRequest.number),
      headSha,
    });
    expect(recorded.ok).toBe(true);
    const reloaded = await progress.load(dispatchResult.job.id);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toEqual({ kind: "ci_waiting" });
      expect(reloaded.value?.changeRequestId).toBe("1");
      expect(reloaded.value?.headSha).toBe(outcome.commit.sha);
    }
  });
});
