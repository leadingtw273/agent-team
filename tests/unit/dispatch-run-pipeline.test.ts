/**
 * C015b unit tests: `createDispatchCliHandlers`'s pipeline-driving branch (handlers.ts's
 * `case "dispatched"`) -- covers every `ImplementerPipelineOutcome` mapping (`ci_waiting`/
 * `paused`/`failed`), the `buildImplementerPipeline` composition itself being blocked (no real
 * `gh` auth), and the non-`implementer`-role scope boundary (`pipeline:"not_applicable_role"`,
 * where the pipeline is never even constructed). `discoverReadyDispatchCandidates` is mocked to
 * return one directly-built, fully-eligible, `workKind:"model"` candidate (unlike
 * dispatch-cli-handlers.test.ts's deliberately-`"mechanical"` fixture) so real model routing
 * genuinely selects it -- this file's job is specifically the pipeline hand-off, so the real
 * routing path matters here.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { domainError, err, ok } from "../../src/domain/foundation/index.js";
import { LocalGitAdapter } from "../../src/adapters/git/index.js";
import { FileJobProgressStore } from "../../src/adapters/dispatch/index.js";
import { defaultJobProgressDirectory } from "../../src/cli/dispatch/resume-composition.js";
import {
  issueSchema,
  projectSchema,
  type Issue,
  type Project,
} from "../../src/domain/project/index.js";
import type { ProjectRegistrySnapshot } from "../../src/application/projects/index.js";
import { trustedProjectConfigSchema } from "../../src/application/projects/index.js";
import type { ModelRoutingConfig } from "../../src/application/routing/index.js";
import type { ImplementerPipeline } from "../../src/application/pipelines/index.js";
import type { ProcessPort } from "../../src/application/ports/index.js";
import { FileJobRepository } from "../../src/infrastructure/jobs/index.js";
import { FileLeaseRepository } from "../../src/infrastructure/leases/index.js";
import type { LinearReadModel } from "../../src/adapters/linear/read.js";

const discoverSpy = vi.hoisted(() => vi.fn());
/** Lets one test (the `not_applicable_role` scope-boundary case) swap in a differently-rolled
 * candidate without duplicating the whole discovery-mocking setup. */
const candidateRoleOverride = vi.hoisted(() => ({ current: undefined as string | undefined }));

vi.mock("../../src/adapters/dispatch/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/adapters/dispatch/index.js")>();
  return {
    ...actual,
    discoverReadyDispatchCandidates: (
      ...args: Parameters<typeof actual.discoverReadyDispatchCandidates>
    ) => {
      discoverSpy(...args);
      const candidate = eligibleCandidate(candidateRoleOverride.current);
      return Promise.resolve(ok({ candidates: [candidate], skipped: [] }));
    },
  };
});

const { createDispatchCliHandlers } = await import("../../src/cli/dispatch/handlers.js");

const run = promisify(execFile);
async function git(cwd: string, arguments_: readonly string[]): Promise<string> {
  const result = await run("git", arguments_, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

const temporaryDirectories: string[] = [];
afterEach(async () => {
  discoverSpy.mockClear();
  candidateRoleOverride.current = undefined;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryStateRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-dispatch-run-pipeline-"));
  temporaryDirectories.push(directory);
  return directory;
}

/**
 * `handlers.ts`'s pipeline-driving branch resolves the project's real HEAD SHA via a real
 * `LocalGitAdapter().inspectRepository(...)` before building the `ImplementerPipelineRequest`
 * (see its own comment on why `baseRevision` must never be the branch name) -- there is no
 * injection seam for that call, so `project.localRepositoryPath` must point at a real,
 * initialized git repository for this handler-level test to get past it and reach the pipeline
 * hand-off this file actually wants to exercise. The pipeline itself is fully faked (see
 * `fakePipeline` below), so this repo is never staged/committed/pushed to -- read-only.
 */
async function temporaryRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-dispatch-run-pipeline-repo-"));
  temporaryDirectories.push(directory);
  await git(directory, ["init", "-b", "main"]);
  await git(directory, ["config", "user.email", "agent-team@example.invalid"]);
  await git(directory, ["config", "user.name", "Agent Team Fixture"]);
  await run("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: directory });
  return directory;
}

const projectId = "project_018f47d2-77a4-7cc1-8ef2-0123456789ab";
const issueId = "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab";

function project(repositoryPath: string) {
  return projectSchema.parse({
    schemaVersion: 1,
    id: projectId,
    displayName: "Sandbox",
    localRepositoryPath: repositoryPath,
    defaultBranch: "main",
    workManagement: { provider: "linear", containerId: "team-1", projectId: "linear-proj-1" },
    sourceControl: { provider: "github", repository: "owner/sandbox" },
  });
}

function trustedConfigFixture() {
  return trustedProjectConfigSchema.parse({
    schemaVersion: 1,
    projectId,
    defaultBranch: "main",
    platforms: {
      workManagement: { provider: "linear", containerId: "team-1", projectId: "linear-proj-1" },
      sourceControl: { provider: "github", repository: "owner/sandbox" },
    },
    projectRules: [],
    roleInstructions: {},
    commands: { quality: [{ executable: "pnpm", arguments: ["test"] }], visualReview: [] },
  });
}

function registry(repositoryPath: string): ProjectRegistrySnapshot {
  return {
    ready: [
      {
        state: "ready",
        project: project(repositoryPath),
        config: trustedConfigFixture(),
        revisionSha: "a".repeat(40),
      },
    ],
    rejected: [],
  };
}

/** A `workKind:"model"` candidate (unlike the mechanical-work trick used elsewhere) -- real model
 * routing must select it, which needs a "ready" Claude capability observation (below). `role`
 * defaults to `"implementer"`; the `not_applicable_role` test overrides it to prove the pipeline
 * is never even constructed for other roles. */
function eligibleIssue(role = "implementer"): Issue {
  return issueSchema.parse({
    schemaVersion: 1,
    id: issueId,
    projectId,
    externalId: "linear-issue-1",
    title: "Ship the thing",
    goal: "Deliver the requested behavior.",
    background: "Pipeline hand-off test needs a real model-routed dispatch.",
    acceptanceCriteria: ["Pipeline outcome is mapped correctly."],
    inScope: ["CLI handler wiring"],
    outOfScope: ["Process execution"],
    dependencies: { kind: "none" },
    priority: "high",
    agentRole: role,
    reviewRequirement: "code_review",
    estimatedMinutes: 30,
    changeRegions: [{ path: "src/feature.ts", coverage: "exact" }],
  });
}

function eligibleCandidate(role?: string) {
  return Object.freeze({
    issue: eligibleIssue(role),
    readyAt: "2026-08-07T00:00:00.000Z",
    stage: "implementation" as const,
    workKind: "model" as const,
  });
}

const routingConfig: ModelRoutingConfig = {
  schemaVersion: 1,
  routes: [
    { role: "team_lead", candidates: [{ provider: "codex", model: "lead" }] },
    { role: "implementer", candidates: [{ provider: "claude", model: "opus" }] },
    // `code_reviewer` deliberately routes to claude/opus too (not the more realistic codex) --
    // the fake Claude capability probe below only ever reports observations for
    // `claude.config.models` ("opus"), so the `not_applicable_role` test (which overrides the
    // candidate's role to "code_reviewer" to reach the dispatched-but-not-implementer branch)
    // needs its route to actually resolve to "ready"; the point of that test is the CLI handler's
    // role branch, not model routing, so this keeps it decoupled from a real codex observation
    // this fixture has no way to provide.
    { role: "code_reviewer", candidates: [{ provider: "claude", model: "opus" }] },
    { role: "visual_reviewer", candidates: [{ provider: "gemini", model: "visual" }] },
    { role: "integration_engineer", candidates: [{ provider: "claude", model: "integrate" }] },
  ],
};

/** Reports the Claude capability probe as alive. */
class ReadyProcessPort implements ProcessPort {
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

const unusedReadModel = {
  readContext: () => Promise.reject(new Error("must never be called: discovery is mocked")),
  readIssue: () => Promise.reject(new Error("must never be called: discovery is mocked")),
  listIssueIdsInState: () => Promise.reject(new Error("must never be called: discovery is mocked")),
} as unknown as LinearReadModel;

function buildHandlers(
  stateRoot: string,
  repositoryPath: string,
  buildImplementerPipeline: Parameters<
    typeof createDispatchCliHandlers
  >[0]["buildImplementerPipeline"],
  resolveAuthoritativeBase?: Parameters<
    typeof createDispatchCliHandlers
  >[0]["resolveAuthoritativeBase"],
) {
  const leases = new FileLeaseRepository(
    join(stateRoot, "leases.json"),
    join(stateRoot, "leases.lock"),
  );
  const jobs = new FileJobRepository(join(stateRoot, "jobs.json"), join(stateRoot, "jobs.lock"));
  const buildComposition = () =>
    Promise.resolve({
      state: "ready" as const,
      value: {
        leases,
        jobs,
        registry: registry(repositoryPath),
        routingConfig,
        discovery: {
          teamId: "team-1",
          linearProjectId: "linear-proj-1",
          readModel: unusedReadModel,
          // Never exercised here: these tests stop at pipeline-outcome mapping, well before
          // `LifecyclePipeline` (C015c item 5) would ever consult a mutation client.
          mutationClient: {} as never,
        },
        project: project(repositoryPath),
        trustedConfig: trustedConfigFixture(),
        claude: {
          config: { executable: "claude", models: ["opus"], account: "default" },
          process: new ReadyProcessPort(),
        },
      },
    });
  return createDispatchCliHandlers({
    agentTeamHome: stateRoot,
    buildComposition,
    resolveAuthoritativeBase:
      resolveAuthoritativeBase ?? fakeResolveAuthoritativeBase(repositoryPath),
    ...(buildImplementerPipeline === undefined ? {} : { buildImplementerPipeline }),
  });
}

function fakePipeline(run: ImplementerPipeline["run"]): ImplementerPipeline {
  return { ports: undefined as never, run } as unknown as ImplementerPipeline;
}

/**
 * C015x decision 1: this file's whole point is the pipeline hand-off *after* the worktree base is
 * resolved, not the resolution itself (that has its own dedicated unit tests,
 * authoritative-base-revision.test.ts) -- `temporaryRepository()` is a real, initialized git repo
 * with no `origin` remote and no GitHub credentials, so exercising the *real*
 * `resolveAuthoritativeBaseRevision` here would need both. This fake reproduces exactly what the
 * pre-C015x code path did (read the local repo's own real HEAD), preserving every existing
 * assertion in this file (including the one real `createWorktree` call whose `startPoint` must
 * still be a real, resolvable revision of `repositoryPath`).
 */
function fakeResolveAuthoritativeBase(repositoryPath: string) {
  return async (project: Project) => {
    const repo = await new LocalGitAdapter().inspectRepository({ rootPath: repositoryPath });
    if (!repo.ok) {
      return err({ reason: "authoritative_branch_unavailable" as const, error: repo.error });
    }
    return ok({ baseRevision: repo.value.headSha, defaultBranch: project.defaultBranch });
  };
}

describe("createDispatchCliHandlers pipeline hand-off (C015b item 5)", () => {
  it("maps a ci_waiting pipeline outcome to a success payload with the change request URL", async () => {
    const stateRoot = await temporaryStateRoot();
    const repositoryPath = await temporaryRepository();
    const handlers = buildHandlers(stateRoot, repositoryPath, () =>
      Promise.resolve({
        state: "ready",
        value: fakePipeline(() =>
          Promise.resolve({
            state: "ci_waiting",
            worktree: {
              repositoryRoot: "/tmp/sandbox",
              path: "/tmp/wt",
              branch: "b",
              headSha: "a".repeat(40),
            },
            commit: { sha: "b".repeat(40), branch: "b" },
            push: { sha: "b".repeat(40), branch: "b", remote: "origin" },
            changeRequest: {
              id: "PR_1",
              number: 1,
              url: "https://example.invalid/pull/1",
              state: "open",
              draft: true,
              baseBranch: "main",
              headBranch: "b",
              headSha: "b".repeat(40),
              mergeability: "unknown",
              autoMergeEnabled: false,
              updatedAt: "2026-08-07T00:00:00.000Z" as never,
            },
            checks: { headSha: "b".repeat(40), aggregate: "pending", checks: [] },
          }),
        ),
      }),
    );
    const outcome = await handlers.run({ projectId });
    expect(outcome.state).toBe("success");
    const payload = JSON.parse(outcome.message ?? "{}") as {
      pipeline: string;
      changeRequestUrl: string;
    };
    expect(payload.pipeline).toBe("ci_waiting");
    expect(payload.changeRequestUrl).toBe("https://example.invalid/pull/1");
  });

  it("maps a paused pipeline outcome to a success payload (a pause is not an error)", async () => {
    const stateRoot = await temporaryStateRoot();
    const repositoryPath = await temporaryRepository();
    const handlers = buildHandlers(stateRoot, repositoryPath, () =>
      Promise.resolve({
        state: "ready",
        value: fakePipeline(() =>
          Promise.resolve({
            state: "paused",
            reason: "scope_overrun",
            worktree: {
              repositoryRoot: "/tmp/sandbox",
              path: "/tmp/wt",
              branch: "b",
              headSha: "a".repeat(40),
            },
            checkpointId: "checkpoint_018f47d2-77a4-7cc1-8ef2-0123456789ab",
            findings: [{ code: "outside_declared_region", path: "src/x.ts" }],
          }),
        ),
      }),
    );
    const outcome = await handlers.run({ projectId });
    expect(outcome.state).toBe("success");
    const payload = JSON.parse(outcome.message ?? "{}") as {
      pipeline: string;
      pauseReason: string;
      checkpointId: string;
    };
    expect(payload.pipeline).toBe("paused");
    expect(payload.pauseReason).toBe("scope_overrun");
    expect(payload.checkpointId).toBe("checkpoint_018f47d2-77a4-7cc1-8ef2-0123456789ab");
  });

  /**
   * C016 fix: before this ticket, `handlers.ts` never persisted a job-progress record for a
   * `paused` pipeline outcome at all -- only the CLI's own JSON stdout (asserted above) carried
   * the checkpoint/reason, gone the instant the process exits. This is the exact defect that left
   * the per-issue admission claim (issue-admission-store.ts) durably, permanently unreleasable:
   * `dispatch resolve` (resolve-handlers.ts) always looks the job up by this record first, and
   * with none ever written, it can never find it. Reads the record back through a real
   * `FileJobProgressStore`, mirroring the `ci_waiting`-record test above (P0-5) that already
   * covers the sibling write this ticket's fix is symmetric with.
   */
  it("C016: persists a durable job-progress record for a paused pipeline outcome, with pauseReason and checkpointId both preserved -- the write dispatch resolve depends on to ever find this job again", async () => {
    const stateRoot = await temporaryStateRoot();
    const repositoryPath = await temporaryRepository();
    const handlers = buildHandlers(stateRoot, repositoryPath, () =>
      Promise.resolve({
        state: "ready",
        value: fakePipeline(() =>
          Promise.resolve({
            state: "paused",
            reason: "scope_overrun",
            worktree: {
              repositoryRoot: repositoryPath,
              path: "/tmp/wt",
              branch: "agent-team/job-1",
              headSha: "a".repeat(40),
            },
            checkpointId: "checkpoint_018f47d2-77a4-7cc1-8ef2-0123456789ab",
          }),
        ),
      }),
    );
    const outcome = await handlers.run({ projectId });
    expect(outcome.state).toBe("success");

    const progress = new FileJobProgressStore(defaultJobProgressDirectory(stateRoot));
    const records = await progress.listForProject(projectId);
    expect(records.ok).toBe(true);
    if (records.ok) {
      expect(records.value).toHaveLength(1);
      expect(records.value[0]).toMatchObject({
        stage: {
          kind: "paused",
          pauseReason: "scope_overrun",
          checkpointId: "checkpoint_018f47d2-77a4-7cc1-8ef2-0123456789ab",
        },
      });
    }
  });

  /**
   * C016 fix: `ImplementerPipelineOutcome`'s own `paused` variant explicitly allows *no*
   * checkpoint at all -- only `reason:"scope_overrun"` (via `ImplementerPreflightPort`) ever
   * captures one; `provider_interrupted`/`no_changes`/`safety_approval_required` never do. The
   * job-progress record must still be written (this is the entire point of this ticket's fix),
   * just with no `checkpointId` field at all rather than some placeholder value.
   */
  it("C016: persists a paused job-progress record with no checkpointId at all when the pipeline outcome carries none", async () => {
    const stateRoot = await temporaryStateRoot();
    const repositoryPath = await temporaryRepository();
    const handlers = buildHandlers(stateRoot, repositoryPath, () =>
      Promise.resolve({
        state: "ready",
        value: fakePipeline(() =>
          Promise.resolve({
            state: "paused",
            reason: "provider_interrupted",
            worktree: {
              repositoryRoot: repositoryPath,
              path: "/tmp/wt",
              branch: "agent-team/job-1",
              headSha: "a".repeat(40),
            },
          }),
        ),
      }),
    );
    const outcome = await handlers.run({ projectId });
    expect(outcome.state).toBe("success");

    const progress = new FileJobProgressStore(defaultJobProgressDirectory(stateRoot));
    const records = await progress.listForProject(projectId);
    expect(records.ok).toBe(true);
    if (records.ok) {
      expect(records.value).toHaveLength(1);
      expect(records.value[0]?.stage).toEqual({
        kind: "paused",
        pauseReason: "provider_interrupted",
      });
    }
  });

  /**
   * C016 fix: symmetric to the existing `ci_waiting` fail-closed test below (P0-5) -- a malformed
   * `checkpointId` on the pipeline's own outcome (never expected in production; `checkpointIdSchema`
   * is this process's own internal invariant, not external input) must fail closed to
   * `job_progress_write_failed` and leave *no* progress record at all, never a partial or
   * malformed one that a later `dispatch resolve` could misread.
   */
  it("C016: fails closed to job_progress_write_failed, writing no progress record at all, when the paused outcome's own checkpointId fails checkpointIdSchema's guard", async () => {
    const stateRoot = await temporaryStateRoot();
    const repositoryPath = await temporaryRepository();
    const handlers = buildHandlers(stateRoot, repositoryPath, () =>
      Promise.resolve({
        state: "ready",
        value: fakePipeline(() =>
          Promise.resolve({
            state: "paused",
            reason: "scope_overrun",
            worktree: {
              repositoryRoot: repositoryPath,
              path: "/tmp/wt",
              branch: "agent-team/job-1",
              headSha: "a".repeat(40),
            },
            // Deliberately not a real `checkpoint_<uuid>`-shaped identifier.
            checkpointId: "not-a-real-checkpoint-id",
          }),
        ),
      }),
    );
    const outcome = await handlers.run({ projectId });
    expect(outcome.state).toBe("failed");
    const payload = JSON.parse(outcome.message ?? "{}") as {
      pipeline: string;
      pipelineReason: string;
      error: { code: string };
    };
    expect(payload.pipeline).toBe("failed");
    expect(payload.pipelineReason).toBe("job_progress_write_failed");
    expect(payload.error.code).toBe("invariant_violation");

    const progress = new FileJobProgressStore(defaultJobProgressDirectory(stateRoot));
    const records = await progress.listForProject(projectId);
    expect(records.ok).toBe(true);
    if (records.ok) expect(records.value).toEqual([]);
  });

  it("maps a failed pipeline outcome (e.g. the Claude process itself failing) to a failed payload, never crashing", async () => {
    const stateRoot = await temporaryStateRoot();
    const repositoryPath = await temporaryRepository();
    const handlers = buildHandlers(stateRoot, repositoryPath, () =>
      Promise.resolve({
        state: "ready",
        value: fakePipeline(() =>
          Promise.resolve({
            state: "failed",
            stage: "provider_run",
            error: {
              kind: "domain_error",
              code: "external_failure",
              category: "external",
              message: "The external operation failed.",
              retryable: false,
            },
          }),
        ),
      }),
    );
    const outcome = await handlers.run({ projectId });
    expect(outcome.state).toBe("failed");
    const payload = JSON.parse(outcome.message ?? "{}") as { pipeline: string; stage: string };
    expect(payload.pipeline).toBe("failed");
    expect(payload.stage).toBe("provider_run");
  });

  /**
   * C015j (side item): a `stage:"request"` pipeline failure (`ImplementerPipeline.run()`'s own
   * `requestShapeValid`/`validRequest` -- src/application/pipelines/implementer.ts -- always
   * returns a generic `domainError("invariant_violation")`, never anything more specific) must
   * still surface a fixed, diagnosable `pipelineReason` in this CLI layer's JSON output, on top
   * of (never replacing) the engine's own `error.code`.
   */
  it('adds a fixed, diagnosable pipelineReason for a stage:"request" pipeline failure', async () => {
    const stateRoot = await temporaryStateRoot();
    const repositoryPath = await temporaryRepository();
    const handlers = buildHandlers(stateRoot, repositoryPath, () =>
      Promise.resolve({
        state: "ready",
        value: fakePipeline(() =>
          Promise.resolve({
            state: "failed",
            stage: "request",
            error: domainError("invariant_violation"),
          }),
        ),
      }),
    );
    const outcome = await handlers.run({ projectId });
    expect(outcome.state).toBe("failed");
    const payload = JSON.parse(outcome.message ?? "{}") as {
      pipeline: string;
      stage: string;
      pipelineReason: string;
      error: { code: string };
    };
    expect(payload.pipeline).toBe("failed");
    expect(payload.stage).toBe("request");
    expect(payload.pipelineReason).toBe("implementer_pipeline_request_rejected");
    // The engine's own error code is preserved verbatim, not overwritten by the new CLI-layer
    // reason.
    expect(payload.error.code).toBe("invariant_violation");
  });

  it("maps a blocked pipeline composition (no gh auth) to a failed payload with the fixed message", async () => {
    const stateRoot = await temporaryStateRoot();
    const repositoryPath = await temporaryRepository();
    const handlers = buildHandlers(stateRoot, repositoryPath, () =>
      Promise.resolve({ state: "blocked", reason: "github_authentication_unavailable" }),
    );
    const outcome = await handlers.run({ projectId });
    expect(outcome.state).toBe("failed");
    const payload = JSON.parse(outcome.message ?? "{}") as {
      pipeline: string;
      pipelineReason: string;
    };
    expect(payload.pipeline).toBe("blocked");
    expect(payload.pipelineReason).toBe("github_authentication_unavailable");
  });

  it("never constructs a pipeline for a non-implementer role, reporting dispatched/not_applicable_role", async () => {
    candidateRoleOverride.current = "code_reviewer";
    const buildImplementerPipeline = vi.fn(() =>
      Promise.reject(new Error("must never be called for a non-implementer role")),
    );
    const stateRoot = await temporaryStateRoot();
    const repositoryPath = await temporaryRepository();
    const handlers = buildHandlers(stateRoot, repositoryPath, buildImplementerPipeline);
    const outcome = await handlers.run({ projectId });
    expect(outcome.state).toBe("success");
    const payload = JSON.parse(outcome.message ?? "{}") as { state: string; pipeline: string };
    expect(payload.state).toBe("dispatched");
    expect(payload.pipeline).toBe("not_applicable_role");
    expect(buildImplementerPipeline).not.toHaveBeenCalled();
  });

  /**
   * C015e: a genuinely fresh `AGENT_TEAM_HOME` (`temporaryStateRoot()` only ever `mkdtemp`s an
   * empty directory -- nothing under it, including `state/`, is ever pre-created by this test or
   * by `buildHandlers`). Every other test in this file fakes the pipeline's `run()` with a
   * canned JS object, so none of them ever exercise a *real* `LocalGitAdapter.createWorktree`
   * call at the real `request.worktreePath` handlers.ts computed -- this is exactly why E101's
   * second real run died here (`stage:"worktree"`, `failure("conflict")`, because
   * `${AGENT_TEAM_HOME}/state/dispatch/worktrees` never existed) while every existing test stayed
   * green. This test's fake pipeline is the one exception: it does a real `createWorktree` at the
   * real path, so it only passes if `ensureDispatchWorktreesDirectory` (handlers.ts, called right
   * before this pipeline hand-off) actually created that directory first.
   */
  it("creates the dispatch worktrees parent directory before the pipeline hand-off, on a genuinely fresh AGENT_TEAM_HOME", async () => {
    const stateRoot = await temporaryStateRoot();
    const repositoryPath = await temporaryRepository();
    const handlers = buildHandlers(stateRoot, repositoryPath, () =>
      Promise.resolve({
        state: "ready",
        value: fakePipeline(async (request) => {
          const created = await new LocalGitAdapter().createWorktree(
            {
              rootPath: request.repositoryRoot,
              path: request.worktreePath,
              branch: request.branch,
              startPoint: request.baseRevision,
            },
            { idempotencyKey: "c015e-real-worktree" },
          );
          if (!created.ok) {
            return { state: "failed", stage: "worktree", error: created.error, job: request.job };
          }
          return {
            state: "paused",
            reason: "provider_interrupted",
            job: request.job,
            worktree: created.value,
          };
        }),
      }),
    );

    const outcome = await handlers.run({ projectId });
    expect(outcome.state).toBe("success");
    const payload = JSON.parse(outcome.message ?? "{}") as {
      pipeline: string;
      stage?: string;
      error?: { code: string };
    };
    // If `ensureDispatchWorktreesDirectory` were missing (or broken), `createWorktree` would
    // return `failure("conflict")` and this would instead observe `pipeline:"failed"`,
    // `stage:"worktree"` -- exactly E101's real failure shape.
    expect(payload.pipeline).toBe("paused");
  });

  /**
   * C015x decision 1: the pipeline hand-off's `baseRevision` must be whatever
   * `resolveAuthoritativeBase` (injected here, deliberately different from
   * `fakeResolveAuthoritativeBase`'s own "read the real local repo HEAD" default) returned -- never
   * silently recomputed some other way. A distinct, made-up SHA proves the wiring is real, not a
   * coincidence of both paths happening to agree.
   */
  it("passes resolveAuthoritativeBase's own baseRevision straight through to the pipeline request", async () => {
    const stateRoot = await temporaryStateRoot();
    const repositoryPath = await temporaryRepository();
    const distinctiveBaseRevision = "9".repeat(40);
    let observedBaseRevision: string | undefined;
    const handlers = buildHandlers(
      stateRoot,
      repositoryPath,
      () =>
        Promise.resolve({
          state: "ready",
          value: fakePipeline((request) => {
            observedBaseRevision = request.baseRevision;
            return Promise.resolve({
              state: "paused",
              reason: "provider_interrupted",
              job: request.job,
              worktree: {
                repositoryRoot: repositoryPath,
                path: "/tmp/wt",
                branch: request.branch,
                headSha: distinctiveBaseRevision,
              },
            });
          }),
        }),
      () => Promise.resolve(ok({ baseRevision: distinctiveBaseRevision, defaultBranch: "main" })),
    );

    const outcome = await handlers.run({ projectId });
    expect(outcome.state).toBe("success");
    expect(observedBaseRevision).toBe(distinctiveBaseRevision);
  });

  /**
   * C015x decision 1: a failure at any of the five authoritative-base-resolution steps must fail
   * closed to `pipeline:"failed"`, never silently fall back to the local repo's own (possibly
   * stale) HEAD -- exactly the root-cause behavior this ticket exists to close.
   */
  it("fails closed with pipelineReason:authoritative_base_unavailable when resolveAuthoritativeBase fails, never falling back to a local HEAD read", async () => {
    const stateRoot = await temporaryStateRoot();
    const repositoryPath = await temporaryRepository();
    // The pipeline *composition* builder still succeeds (handlers.ts builds it before resolving
    // the authoritative base) -- what must never be reached is the pipeline's own `run()`, which
    // is where `baseRevision` would actually be consumed.
    const runSpy = vi.fn(() =>
      Promise.reject(new Error("must never run once the authoritative base fails")),
    );
    const handlers = buildHandlers(
      stateRoot,
      repositoryPath,
      () => Promise.resolve({ state: "ready", value: fakePipeline(runSpy) }),
      () =>
        Promise.resolve(
          err({
            reason: "default_branch_mismatch",
            githubDefaultBranch: "master",
            configuredDefaultBranch: "main",
          }),
        ),
    );

    const outcome = await handlers.run({ projectId });
    expect(outcome.state).toBe("failed");
    const payload = JSON.parse(outcome.message ?? "{}") as {
      pipeline: string;
      pipelineReason: string;
      reason: string;
    };
    expect(payload.pipeline).toBe("failed");
    expect(payload.pipelineReason).toBe("authoritative_base_unavailable");
    expect(payload.reason).toBe("default_branch_mismatch");
    expect(runSpy).not.toHaveBeenCalled();
  });

  /**
   * C015z decision (P0-5): `handlers.ts:553-565`'s CAS write of the new job-progress record --
   * including `baseRevision: dispatchBaseRevision.data`, the same authoritative SHA this dispatch
   * just pinned the worktree to -- had zero dedicated test coverage before this ticket (a resume
   * reading this record back has its own extensive coverage in dispatch-resume-composition.test.ts,
   * but nothing exercised the dispatch-time *write* itself). This reads the record back through a
   * real `FileJobProgressStore` against `stateRoot`, not merely asserting on `handlers.run`'s own
   * return payload.
   */
  it("persists the dispatch-time authoritative baseRevision durably on the new ci_waiting job-progress record -- a later resume must read this exact SHA back, never re-derive it", async () => {
    const stateRoot = await temporaryStateRoot();
    const repositoryPath = await temporaryRepository();
    const distinctiveBaseRevision = "9".repeat(40);
    const handlers = buildHandlers(
      stateRoot,
      repositoryPath,
      () =>
        Promise.resolve({
          state: "ready",
          value: fakePipeline(() =>
            Promise.resolve({
              state: "ci_waiting",
              worktree: {
                repositoryRoot: repositoryPath,
                path: "/tmp/wt",
                branch: "agent-team/job-1",
                headSha: distinctiveBaseRevision,
              },
              commit: { sha: "b".repeat(40), branch: "agent-team/job-1" },
              push: { sha: "b".repeat(40), branch: "agent-team/job-1", remote: "origin" },
              changeRequest: {
                id: "PR_3",
                number: 3,
                url: "https://example.invalid/pull/3",
                state: "open",
                draft: true,
                baseBranch: "main",
                headBranch: "agent-team/job-1",
                headSha: "b".repeat(40),
                mergeability: "unknown",
                autoMergeEnabled: false,
                updatedAt: "2026-08-07T00:00:00.000Z" as never,
              },
              checks: { headSha: "b".repeat(40), aggregate: "pending", checks: [] },
            }),
          ),
        }),
      () => Promise.resolve(ok({ baseRevision: distinctiveBaseRevision, defaultBranch: "main" })),
    );

    const outcome = await handlers.run({ projectId });
    expect(outcome.state).toBe("success");

    const progress = new FileJobProgressStore(defaultJobProgressDirectory(stateRoot));
    const records = await progress.listForProject(projectId);
    expect(records.ok).toBe(true);
    if (records.ok) {
      expect(records.value).toHaveLength(1);
      expect(records.value[0]).toMatchObject({
        stage: { kind: "ci_waiting" },
        changeRequestId: "3",
        headSha: "b".repeat(40),
        baseRevision: distinctiveBaseRevision,
      });
    }
  });

  /**
   * C015z decision (P0-5): the `headShaSchema.safeParse(authoritativeBase.value.baseRevision)`
   * guard (handlers.ts:542-552) -- `resolveAuthoritativeBaseRevision`'s own contract guarantees a
   * real git SHA in production, so this branch's own comment says it is "never expected to fail in
   * production"; this test is what exercises the one case that comment discloses (a malformed
   * *injected test fake*). Confirms the failure surfaces the fixed `job_progress_write_failed`
   * reason and, just as importantly, that no progress record is ever written at all -- not a
   * partial or malformed one.
   */
  it("fails closed to job_progress_write_failed, writing no progress record at all, when the authoritative base SHA fails headShaSchema's guard", async () => {
    const stateRoot = await temporaryStateRoot();
    const repositoryPath = await temporaryRepository();
    const handlers = buildHandlers(
      stateRoot,
      repositoryPath,
      () =>
        Promise.resolve({
          state: "ready",
          value: fakePipeline(() =>
            Promise.resolve({
              state: "ci_waiting",
              worktree: {
                repositoryRoot: repositoryPath,
                path: "/tmp/wt",
                branch: "agent-team/job-1",
                headSha: "a".repeat(40),
              },
              commit: { sha: "b".repeat(40), branch: "agent-team/job-1" },
              push: { sha: "b".repeat(40), branch: "agent-team/job-1", remote: "origin" },
              changeRequest: {
                id: "PR_4",
                number: 4,
                url: "https://example.invalid/pull/4",
                state: "open",
                draft: true,
                baseBranch: "main",
                headBranch: "agent-team/job-1",
                headSha: "b".repeat(40),
                mergeability: "unknown",
                autoMergeEnabled: false,
                updatedAt: "2026-08-07T00:00:00.000Z" as never,
              },
              checks: { headSha: "b".repeat(40), aggregate: "pending", checks: [] },
            }),
          ),
        }),
      // Deliberately not a well-formed 40/64-hex-char SHA.
      () => Promise.resolve(ok({ baseRevision: "not-a-real-sha", defaultBranch: "main" })),
    );

    const outcome = await handlers.run({ projectId });
    expect(outcome.state).toBe("failed");
    const payload = JSON.parse(outcome.message ?? "{}") as {
      pipeline: string;
      pipelineReason: string;
      error: { code: string };
    };
    expect(payload.pipeline).toBe("failed");
    expect(payload.pipelineReason).toBe("job_progress_write_failed");
    expect(payload.error.code).toBe("invariant_violation");

    const progress = new FileJobProgressStore(defaultJobProgressDirectory(stateRoot));
    const records = await progress.listForProject(projectId);
    expect(records.ok).toBe(true);
    if (records.ok) expect(records.value).toEqual([]);
  });
});
