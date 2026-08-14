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
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFixedClock,
  domainError,
  err,
  ok,
  parseInstant,
} from "../../src/domain/foundation/index.js";
import { LocalGitAdapter } from "../../src/adapters/git/index.js";
import { FileJobProgressStore } from "../../src/adapters/dispatch/index.js";
import { FileIssueAdmissionStore } from "../../src/adapters/dispatch/issue-admission-store.js";
import { FileOperatorCanaryAttestationStore } from "../../src/adapters/dispatch/operator-canary-attestation-store.js";
import {
  createDispatchResolveHandler,
  dispatchResolveConfirmationPhrase,
} from "../../src/cli/dispatch/resolve-handlers.js";
import {
  defaultIssueAdmissionDirectory,
  defaultJobProgressDirectory,
} from "../../src/cli/dispatch/resume-composition.js";
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
import type { NewJobQuotaAdmissionPort } from "../../src/application/quota/index.js";
import type { ProcessPort } from "../../src/application/ports/index.js";
import { FileJobRepository } from "../../src/infrastructure/jobs/index.js";
import { FileLeaseRepository } from "../../src/infrastructure/leases/index.js";
import type { LinearReadModel } from "../../src/adapters/linear/read.js";

const discoverSpy = vi.hoisted(() => vi.fn());
/** Lets one test (the `not_applicable_role` scope-boundary case) swap in a differently-rolled
 * candidate without duplicating the whole discovery-mocking setup. */
const candidateRoleOverride = vi.hoisted(() => ({ current: undefined as string | undefined }));
/** C019 fix (item 3): lets one test naturally reach `result.decision.model === undefined` for an
 * `implementer`-role candidate -- `decideNextDispatch` (application/dispatch/decision.ts) never
 * attempts model routing for `workKind:"mechanical"` at all (`route = candidate.workKind ===
 * "model" ? selectModelRoute(...) : undefined`), so this is a real, naturally-reachable trigger
 * for the `model ?? "unresolved"` fallback in handlers.ts's `implementer_request_invalid` write --
 * unlike the `issue === undefined` half of that same fallback, tested directly instead (see
 * `implementerRequestInvalidExternalIssueId`'s own header, handlers.ts). */
const candidateWorkKindOverride = vi.hoisted(() => ({
  current: undefined as "model" | "mechanical" | undefined,
}));
const candidateChangeRegionsOverride = vi.hoisted(() => ({
  current: undefined as Issue["changeRegions"],
}));

vi.mock("../../src/adapters/dispatch/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/adapters/dispatch/index.js")>();
  return {
    ...actual,
    discoverReadyDispatchCandidates: (
      ...args: Parameters<typeof actual.discoverReadyDispatchCandidates>
    ) => {
      discoverSpy(...args);
      const candidate = eligibleCandidate(
        candidateRoleOverride.current,
        candidateWorkKindOverride.current,
      );
      return Promise.resolve(ok({ candidates: [candidate], skipped: [] }));
    },
  };
});

const { createDispatchCliHandlers, implementerRequestInvalidExternalIssueId } =
  await import("../../src/cli/dispatch/handlers.js");

const run = promisify(execFile);
async function git(cwd: string, arguments_: readonly string[]): Promise<string> {
  const result = await run("git", arguments_, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

const temporaryDirectories: string[] = [];
afterEach(async () => {
  discoverSpy.mockClear();
  candidateRoleOverride.current = undefined;
  candidateWorkKindOverride.current = undefined;
  candidateChangeRegionsOverride.current = undefined;
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
    changeRegions: candidateChangeRegionsOverride.current ?? [
      { path: "src/feature.ts", coverage: "exact" },
    ],
  });
}

function eligibleCandidate(role?: string, workKind: "model" | "mechanical" = "model") {
  return Object.freeze({
    issue: eligibleIssue(role),
    readyAt: "2026-08-07T00:00:00.000Z",
    // `dispatchCandidateSchema`'s own `superRefine` (application/dispatch/model.ts) requires
    // mechanical work to be one of the `ci`/`webhook`/`health` stages -- `"ci"` here is
    // otherwise-arbitrary, chosen only to satisfy that constraint when the C019 fix's own
    // mechanical-workKind test overrides `workKind` below.
    stage: workKind === "mechanical" ? ("ci" as const) : ("implementation" as const),
    workKind,
  });
}

const routingConfig: ModelRoutingConfig = {
  schemaVersion: 1,
  routes: [
    { role: "team_lead", candidates: [{ provider: "codex", model: "lead" }] },
    { role: "implementer", candidates: [{ provider: "codex", model: "gpt-5.6-terra" }] },
    { role: "code_reviewer", candidates: [{ provider: "claude", model: "opus" }] },
    { role: "visual_reviewer", candidates: [{ provider: "gemini", model: "visual" }] },
    { role: "integration_engineer", candidates: [{ provider: "codex", model: "integrate" }] },
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

/** The normal liveness probe above intentionally ignores output. Q01's canary path must instead
 * persist and re-check the exact local `--version` line, so its fixture supplies that one line. */
class VersionedProcessPort implements ProcessPort {
  calls = 0;

  spawn(): ReturnType<ProcessPort["spawn"]> {
    this.calls += 1;
    return Promise.resolve(
      ok({
        pid: 2,
        output: (async function* () {
          await Promise.resolve();
          yield {
            sequence: 0,
            stream: "stdout" as const,
            bytes: new TextEncoder().encode("claude 2.1.0\n"),
            observedAt: "2026-08-07T00:00:00.000Z" as never,
          };
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
  quotaAdmission?: NewJobQuotaAdmissionPort,
  operatorCanaryStore?: FileOperatorCanaryAttestationStore,
  claudeProcess: ProcessPort = new ReadyProcessPort(),
  protectedRegionWorkManagement?: Parameters<
    typeof createDispatchCliHandlers
  >[0]["protectedRegionWorkManagement"],
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
          // E102-5: never exercised for the identical reason -- see `mutationClient` above.
          linearTransport: {} as never,
        },
        project: project(repositoryPath),
        trustedConfig: trustedConfigFixture(),
        claude: {
          config: { executable: "claude", models: ["opus"], account: "default" },
          process: claudeProcess,
        },
        codex: {
          config: {
            executable: "codex",
            models: ["lead", "gpt-5.6-terra", "integrate"],
            account: "default",
          },
          process: claudeProcess,
        },
        quotaAdmission: quotaAdmission ?? {
          resolve: () => Promise.resolve({ state: "ready" as const, reason: "test_fixture" }),
        },
        ...(operatorCanaryStore === undefined
          ? {}
          : { operatorCanary: { store: operatorCanaryStore } }),
      },
    });
  return createDispatchCliHandlers({
    agentTeamHome: stateRoot,
    buildComposition,
    resolveAuthoritativeBase:
      resolveAuthoritativeBase ?? fakeResolveAuthoritativeBase(repositoryPath),
    ...(buildImplementerPipeline === undefined ? {} : { buildImplementerPipeline }),
    ...(protectedRegionWorkManagement === undefined ? {} : { protectedRegionWorkManagement }),
  });
}

function fakePipeline(run: ImplementerPipeline["run"]): ImplementerPipeline {
  return { ports: undefined as never, run } as unknown as ImplementerPipeline;
}

async function* stdinOf(phrase: string): AsyncIterable<string> {
  await Promise.resolve();
  yield phrase;
}

/**
 * C018 fix: proves a `requires_manual` fallback record this ticket's fix leaves behind is not
 * merely schema-valid but genuinely *usable* -- `dispatch resolve --as cancelled` (the same real
 * `createDispatchResolveHandler`, resolve-handlers.ts, an operator would run) must find the job,
 * transition it to `cancelled`, and release the still-active admission claim so the issue becomes
 * dispatchable again. Constructs the handler directly against `stateRoot`'s own real
 * `FileJobProgressStore`/`FileIssueAdmissionStore` (mirroring dispatch-resolve-handlers.test.ts's
 * own pattern) rather than through `createDispatchCliHandlers`'s own `dispatchResolve` (which has
 * no stdin-injection seam of its own and always reads real `process.stdin`).
 */
async function resolveJob(
  stateRoot: string,
  jobId: string,
): Promise<{ resolved: string; admissionReleased: string }> {
  const resolve = createDispatchResolveHandler({
    progress: new FileJobProgressStore(defaultJobProgressDirectory(stateRoot)),
    admission: new FileIssueAdmissionStore(defaultIssueAdmissionDirectory(stateRoot)),
    stdin: stdinOf(dispatchResolveConfirmationPhrase),
  });
  const outcome = await resolve({ jobId, as: "cancelled" });
  const payload = JSON.parse(outcome.message ?? "{}") as {
    state?: string;
    admissionReleased?: string;
  };
  return {
    resolved: outcome.state === "success" ? (payload.state ?? "") : outcome.state,
    admissionReleased: payload.admissionReleased ?? "",
  };
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
  it("moves a protected implementer issue out of Ready before pipeline/worktree/provider start", async () => {
    const stateRoot = await temporaryStateRoot();
    const repositoryPath = await temporaryRepository();
    candidateChangeRegionsOverride.current = [
      { path: "src/feature.ts", coverage: "exact" },
      { path: ".github/workflows/ci.yml", coverage: "exact" },
    ];
    const calls: string[] = [];
    const protectedRegionWorkManagement = {
      setWorkStatus: (_reference: unknown, status: string) => {
        calls.push(`workflow:${status}`);
        return Promise.resolve(ok({} as never));
      },
      setAgentCondition: (_reference: unknown, condition: { status: string }) => {
        calls.push(`agent:${condition.status}`);
        return Promise.resolve(ok({} as never));
      },
      appendComment: (_reference: unknown, body: string) => {
        calls.push(`comment:${body}`);
        return Promise.resolve(ok({} as never));
      },
    } as never;
    const buildImplementerPipeline = vi.fn(() =>
      Promise.reject(new Error("protected work must never build a pipeline")),
    );
    const handlers = buildHandlers(
      stateRoot,
      repositoryPath,
      buildImplementerPipeline,
      undefined,
      undefined,
      undefined,
      new ReadyProcessPort(),
      protectedRegionWorkManagement,
    );

    const dryRun = await handlers.run({ projectId, dryRun: true });
    expect(JSON.parse(dryRun.message ?? "{}")).toMatchObject({
      state: "dry_run",
      protectedRegionPrediction: {
        state: "blocked",
        reason: "protected_region_requires_human",
      },
    });
    expect(calls).toEqual([]);
    expect(buildImplementerPipeline).not.toHaveBeenCalled();

    const result = await handlers.run({ projectId });
    const payload = JSON.parse(result.message ?? "{}") as {
      state: string;
      jobId: string;
      leaseId: string;
      pipelineReason: string;
      handoff: Readonly<Record<string, string>>;
    };
    expect(result.state).toBe("success");
    expect(payload).toMatchObject({
      state: "requires_manual",
      pipelineReason: "protected_region_requires_human",
      handoff: {
        workflowState: "confirmed",
        agentCondition: "confirmed",
        comment: "confirmed",
        leaseRelease: "confirmed",
      },
    });
    expect(calls.slice(0, 2)).toEqual(["workflow:requires_manual", "agent:blocked"]);
    expect(calls[2]).toContain("未啟動模型、未建立 PR");
    expect(calls[2]).not.toContain(".github/workflows/ci.yml");
    expect(buildImplementerPipeline).not.toHaveBeenCalled();
    await expect(readdir(join(stateRoot, "state", "dispatch", "worktrees"))).rejects.toThrow();

    const progress = new FileJobProgressStore(defaultJobProgressDirectory(stateRoot));
    await expect(progress.load(payload.jobId)).resolves.toMatchObject({
      ok: true,
      value: {
        stage: {
          kind: "requires_manual",
          cause: { reasonCode: "protected_region_requires_human" },
        },
        protectedRegionHandoff: {
          workflowState: "confirmed",
          agentCondition: "confirmed",
          comment: "confirmed",
          leaseRelease: "confirmed",
        },
      },
    });
    const leaseRepository = new FileLeaseRepository(
      join(stateRoot, "leases.json"),
      join(stateRoot, "leases.lock"),
    );
    const leases = await leaseRepository.readAll();
    expect(leases.ok).toBe(true);
    if (!leases.ok) throw new Error(leases.error.code);
    expect(leases.value[0]?.id).toBe(payload.leaseId);
    expect(leases.value[0]?.releasedAt).toEqual(expect.any(String));
    const admission = new FileIssueAdmissionStore(defaultIssueAdmissionDirectory(stateRoot));
    await expect(admission.load(projectId, issueId)).resolves.toMatchObject({
      ok: true,
      value: { state: "active", jobId: payload.jobId },
    });
  });

  it("replays an incomplete protected-region Linear handoff without re-running the model", async () => {
    const stateRoot = await temporaryStateRoot();
    const repositoryPath = await temporaryRepository();
    candidateChangeRegionsOverride.current = [
      { path: ".github/workflows/ci.yml", coverage: "exact" },
    ];
    let workflowAttempts = 0;
    const protectedRegionWorkManagement = {
      setWorkStatus: () => {
        workflowAttempts += 1;
        return Promise.resolve(
          workflowAttempts === 1 ? err(domainError("external_failure")) : ok({} as never),
        );
      },
      setAgentCondition: () => Promise.resolve(ok({} as never)),
      appendComment: () => Promise.resolve(ok({} as never)),
    } as never;
    const buildImplementerPipeline = vi.fn(() =>
      Promise.reject(new Error("protected work must never build a pipeline")),
    );
    const handlers = buildHandlers(
      stateRoot,
      repositoryPath,
      buildImplementerPipeline,
      undefined,
      undefined,
      undefined,
      new ReadyProcessPort(),
      protectedRegionWorkManagement,
    );

    const first = await handlers.run({ projectId });
    const firstPayload = JSON.parse(first.message ?? "{}") as {
      jobId: string;
      pipelineReason: string;
    };
    expect(first.state).toBe("failed");
    expect(firstPayload.pipelineReason).toBe("protected_region_sync_failed");

    const second = await handlers.run({ projectId });
    expect(second.state).toBe("success");
    expect(workflowAttempts).toBe(2);
    expect(buildImplementerPipeline).not.toHaveBeenCalled();
    const progress = new FileJobProgressStore(defaultJobProgressDirectory(stateRoot));
    await expect(progress.load(firstPayload.jobId)).resolves.toMatchObject({
      ok: true,
      value: {
        protectedRegionHandoff: {
          workflowState: "confirmed",
          agentCondition: "confirmed",
          comment: "confirmed",
          leaseRelease: "confirmed",
        },
      },
    });
  });

  it("Q01 without a record remains quota_unknown, with no version probe, pipeline, claim, or job", async () => {
    const stateRoot = await temporaryStateRoot();
    const repositoryPath = await temporaryRepository();
    const parsedCanaryNow = parseInstant("2026-08-12T12:00:00.000Z");
    if (!parsedCanaryNow.ok) throw new Error(parsedCanaryNow.error.code);
    const canaryStore = new FileOperatorCanaryAttestationStore(stateRoot, {
      clock: createFixedClock(parsedCanaryNow.value),
    });
    const versionedClaude = new VersionedProcessPort();
    const buildImplementerPipeline = vi.fn(() =>
      Promise.reject(new Error("must never build a pipeline without trusted quota")),
    );
    const handlers = buildHandlers(
      stateRoot,
      repositoryPath,
      buildImplementerPipeline,
      undefined,
      {
        resolve: () =>
          Promise.resolve({ state: "quota_unknown" as const, reason: "collector_unavailable" }),
      },
      canaryStore,
      versionedClaude,
    );

    const outcome = await handlers.run({ projectId });
    expect(outcome.state).toBe("success");
    const payload = JSON.parse(outcome.message ?? "{}") as {
      state: string;
      reason: string;
      admissionSkipped: readonly { issueId: string; reason: string }[];
    };
    expect(payload).toMatchObject({
      state: "waiting",
      reason: "no_dispatchable_candidate",
      admissionSkipped: [{ issueId, reason: "quota_unknown" }],
    });
    expect(buildImplementerPipeline).not.toHaveBeenCalled();
    expect(versionedClaude.calls).toBe(0);
    await expect(
      canaryStore.inspect({ projectId, linearExternalIssueId: "linear-issue-1" }),
    ).resolves.toEqual({ ok: true, value: { state: "absent" } });

    const jobs = new FileJobRepository(join(stateRoot, "jobs.json"), join(stateRoot, "jobs.lock"));
    const persistedJobs = await jobs.readAll();
    expect(persistedJobs).toEqual({ ok: true, value: [] });
    const admissions = new FileIssueAdmissionStore(defaultIssueAdmissionDirectory(stateRoot));
    const persistedAdmission = await admissions.load(projectId, issueId);
    expect(persistedAdmission).toEqual({ ok: true, value: undefined });
    const progress = new FileJobProgressStore(defaultJobProgressDirectory(stateRoot));
    const persistedProgress = await progress.listForProject(projectId);
    expect(persistedProgress).toEqual({ ok: true, value: [] });
  });

  it("Q01 never starts a provider or pipeline from an expired record", async () => {
    const stateRoot = await temporaryStateRoot();
    const repositoryPath = await temporaryRepository();
    const issuedAt = parseInstant("2026-08-12T12:00:00.000Z");
    const expiresAt = parseInstant("2026-08-12T12:15:00.000Z");
    if (!issuedAt.ok || !expiresAt.ok) throw new Error("fixture clock must be canonical");
    let currentCanaryTime = issuedAt.value;
    const canaryStore = new FileOperatorCanaryAttestationStore(stateRoot, {
      clock: { now: () => currentCanaryTime },
    });
    const issued = await canaryStore.issue({
      projectId,
      linearExternalIssueId: "linear-issue-1",
      claudeCliVersion: "claude 2.1.0",
    });
    if (!issued.ok) throw new Error(issued.error.code);
    currentCanaryTime = expiresAt.value;
    const versionedClaude = new VersionedProcessPort();
    const buildImplementerPipeline = vi.fn(() =>
      Promise.reject(new Error("expired canary must never construct a pipeline")),
    );
    const handlers = buildHandlers(
      stateRoot,
      repositoryPath,
      buildImplementerPipeline,
      undefined,
      {
        resolve: () => Promise.resolve({ state: "quota_unknown" as const, reason: "no_collector" }),
      },
      canaryStore,
      versionedClaude,
    );

    const outcome = await handlers.run({ projectId });
    expect(outcome).toMatchObject({ state: "success" });
    expect(versionedClaude.calls).toBe(0);
    expect(buildImplementerPipeline).not.toHaveBeenCalled();
    await expect(
      canaryStore.inspect({ projectId, linearExternalIssueId: "linear-issue-1" }),
    ).resolves.toEqual({ ok: true, value: { state: "expired" } });
  });

  it("Q01 leaves the superseded Claude canary untouched for Codex-primary execution", async () => {
    const stateRoot = await temporaryStateRoot();
    const repositoryPath = await temporaryRepository();
    const parsedCanaryNow = parseInstant("2026-08-12T12:00:00.000Z");
    if (!parsedCanaryNow.ok) throw new Error(parsedCanaryNow.error.code);
    const canaryStore = new FileOperatorCanaryAttestationStore(stateRoot, {
      clock: createFixedClock(parsedCanaryNow.value),
    });
    const issued = await canaryStore.issue({
      projectId,
      linearExternalIssueId: "linear-issue-1",
      claudeCliVersion: "claude 2.1.0",
    });
    if (!issued.ok) throw new Error(issued.error.code);
    const events: string[] = [];
    const originalConsume = canaryStore.consume.bind(canaryStore);
    (canaryStore as { consume: typeof canaryStore.consume }).consume = async (input) => {
      const consumed = await originalConsume(input);
      events.push("consume.end");
      return consumed;
    };
    const providerStart: ProcessPort = {
      spawn: () => {
        events.push("provider.spawn.begin");
        return Promise.resolve(
          ok({
            pid: 3,
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
      },
    };
    const buildImplementerPipeline = vi.fn(() =>
      Promise.resolve({
        state: "ready" as const,
        value: fakePipeline(async () => {
          await providerStart.spawn({
            executable: "claude",
            arguments: ["--print"],
            workingDirectory: repositoryPath,
            deadlineAt: "2026-08-07T00:00:00.000Z" as never,
            maxOutputBytes: 4096,
          });
          return {
            state: "ci_waiting" as const,
            worktree: {
              repositoryRoot: repositoryPath,
              path: "/tmp/q01-provider-worktree",
              branch: "agent-team/q01",
              headSha: "a".repeat(40),
            },
            commit: { sha: "b".repeat(40), branch: "agent-team/q01" },
            push: { sha: "b".repeat(40), branch: "agent-team/q01", remote: "origin" },
            changeRequest: {
              id: "PR_Q01",
              number: 1,
              url: "https://example.invalid/pull/1",
              state: "open" as const,
              draft: true,
              baseBranch: "main",
              headBranch: "agent-team/q01",
              headSha: "b".repeat(40),
              mergeability: "unknown" as const,
              autoMergeEnabled: false,
              updatedAt: "2026-08-07T00:00:00.000Z" as never,
            },
            checks: { headSha: "b".repeat(40), aggregate: "pending" as const, checks: [] },
          };
        }),
      }),
    );
    const versionedClaude = new VersionedProcessPort();
    const handlers = buildHandlers(
      stateRoot,
      repositoryPath,
      buildImplementerPipeline,
      undefined,
      {
        resolve: () => Promise.resolve({ state: "quota_unknown" as const, reason: "no_collector" }),
      },
      canaryStore,
      versionedClaude,
    );

    const dryRun = await handlers.run({ projectId, dryRun: true });
    expect(dryRun).toMatchObject({ state: "success" });
    expect(events).toEqual([]);
    expect(versionedClaude.calls).toBe(0);
    expect(buildImplementerPipeline).not.toHaveBeenCalled();
    await expect(
      canaryStore.inspect({ projectId, linearExternalIssueId: "linear-issue-1" }),
    ).resolves.toMatchObject({ ok: true, value: { state: "issued" } });

    const run = await handlers.run({ projectId });
    expect(run).toMatchObject({ state: "success" });
    expect(events).toEqual([]);
    expect(versionedClaude.calls).toBe(0);
    expect(buildImplementerPipeline).not.toHaveBeenCalled();
    await expect(
      canaryStore.inspect({ projectId, linearExternalIssueId: "linear-issue-1" }),
    ).resolves.toMatchObject({ ok: true, value: { state: "issued" } });
  });

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

  /**
   * C018 fix: `headShaSchema.safeParse(pipelineOutcome.commit.sha)` (handlers.ts) -- like its two
   * siblings elsewhere in this file (`baseRevision`/`checkpointId`), this is this process's own
   * internal invariant guard, never expected to fail against a real `ImplementerPipeline`, but had
   * zero dedicated test coverage before this ticket even though its old behavior (fail closed,
   * leave *no* progress record at all) was the exact same silent-no-op defect class as every other
   * exit this ticket closes. This is the one malformed-value branch of the three where the pipeline
   * outcome carries no valid SHA-shaped evidence *at all* (unlike the `baseRevision` sibling test,
   * which still has a real `headSha`) -- the fallback record can still keep the real
   * `changeRequestId`, since `pipelineOutcome.changeRequest.number` never depends on `commit.sha`.
   */
  it("C018: fails closed to job_progress_write_failed in this invocation's own response, but persists a resolvable requires_manual record (keeping the real changeRequestId) when the pipeline outcome's own commit.sha fails headShaSchema's guard", async () => {
    const stateRoot = await temporaryStateRoot();
    const repositoryPath = await temporaryRepository();
    const handlers = buildHandlers(stateRoot, repositoryPath, () =>
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
            // Deliberately not a well-formed 40/64-hex-char SHA.
            commit: { sha: "not-a-real-sha", branch: "agent-team/job-1" },
            push: { sha: "not-a-real-sha", branch: "agent-team/job-1", remote: "origin" },
            changeRequest: {
              id: "PR_2",
              number: 2,
              url: "https://example.invalid/pull/2",
              state: "open",
              draft: true,
              baseBranch: "main",
              headBranch: "agent-team/job-1",
              headSha: "not-a-real-sha",
              mergeability: "unknown",
              autoMergeEnabled: false,
              updatedAt: "2026-08-07T00:00:00.000Z" as never,
            },
            checks: { headSha: "not-a-real-sha", aggregate: "pending", checks: [] },
          }),
        ),
      }),
    );
    const outcome = await handlers.run({ projectId });
    expect(outcome.state).toBe("failed");
    const payload = JSON.parse(outcome.message ?? "{}") as {
      pipeline: string;
      pipelineReason: string;
      errorCode: string;
    };
    expect(payload.pipeline).toBe("failed");
    // C019 fix (item 2): the write itself succeeded here -- reporting
    // `job_progress_write_failed` would falsely tell an operator that nothing was persisted, when
    // a resolvable `requires_manual` record (asserted below) genuinely exists.
    expect(payload.pipelineReason).toBe("invalid_head_sha");
    expect(payload.errorCode).toBe("invariant_violation");

    const progress = new FileJobProgressStore(defaultJobProgressDirectory(stateRoot));
    const records = await progress.listForProject(projectId);
    expect(records.ok).toBe(true);
    if (records.ok) {
      expect(records.value).toHaveLength(1);
      expect(records.value[0]).toMatchObject({
        stage: {
          kind: "requires_manual",
          cause: { stage: "dispatch", reasonCode: "invalid_head_sha" },
        },
        changeRequestId: "2",
      });
      expect(records.value[0]?.headSha).toBeUndefined();
      expect(records.value[0]?.baseRevision).toBeUndefined();
    }
  });

  /**
   * C019 fix (item 2, the honest-reason fix's own negative case): unlike the test right above
   * (a malformed value where the fallback write itself genuinely succeeds), this test forces the
   * `requires_manual` write itself to fail -- by revoking write permission on the real
   * `FileJobProgressStore` directory `handlers.ts` builds internally (there is no injection seam
   * for it; `progress`/`stateRoot` are shared with every other store this handler writes through,
   * so a temporary root pointed only at this directory, chmod'd back before `afterEach`'s `rm`
   * runs, is the only way to reach a genuine store failure without touching any other store).
   * Confirms `job_progress_write_failed` is still reported *only* in this genuine-failure case,
   * and that nothing partial was ever persisted.
   */
  it("C019: reports job_progress_write_failed (not invalid_head_sha) when the requires_manual fallback write itself genuinely fails, and persists nothing", async () => {
    const stateRoot = await temporaryStateRoot();
    const repositoryPath = await temporaryRepository();
    const progressDirectory = defaultJobProgressDirectory(stateRoot);
    await mkdir(progressDirectory, { recursive: true });
    await chmod(progressDirectory, 0o500);
    try {
      const handlers = buildHandlers(stateRoot, repositoryPath, () =>
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
              commit: { sha: "not-a-real-sha", branch: "agent-team/job-1" },
              push: { sha: "not-a-real-sha", branch: "agent-team/job-1", remote: "origin" },
              changeRequest: {
                id: "PR_5",
                number: 5,
                url: "https://example.invalid/pull/5",
                state: "open",
                draft: true,
                baseBranch: "main",
                headBranch: "agent-team/job-1",
                headSha: "not-a-real-sha",
                mergeability: "unknown",
                autoMergeEnabled: false,
                updatedAt: "2026-08-07T00:00:00.000Z" as never,
              },
              checks: { headSha: "not-a-real-sha", aggregate: "pending", checks: [] },
            }),
          ),
        }),
      );
      const outcome = await handlers.run({ projectId });
      expect(outcome.state).toBe("failed");
      const payload = JSON.parse(outcome.message ?? "{}") as {
        pipeline: string;
        pipelineReason: string;
        errorCode: string;
      };
      expect(payload.pipeline).toBe("failed");
      expect(payload.pipelineReason).toBe("job_progress_write_failed");
      expect(payload.errorCode).toBe("permission_denied");
    } finally {
      await chmod(progressDirectory, 0o700);
    }

    const progress = new FileJobProgressStore(progressDirectory);
    const records = await progress.listForProject(projectId);
    expect(records.ok).toBe(true);
    if (records.ok) expect(records.value).toHaveLength(0);
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
   * C016 fix (superseded by C018 below): a malformed `checkpointId` on the pipeline's own outcome
   * (never expected in production; `checkpointIdSchema` is this process's own internal invariant,
   * not external input) must fail closed to `job_progress_write_failed` in this same invocation's
   * own response.
   *
   * C018 fix: before this ticket, this branch left *no* progress record at all -- the exact same
   * silent-no-op-with-an-active-claim defect class C016 closed for the normal `paused` write right
   * above, just reachable through this one malformed-value edge instead. This process still
   * cannot trust the malformed `checkpointId`, but it now writes a `requires_manual` fallback
   * record (`cause.reasonCode:"invalid_checkpoint_id"`) so the still-active admission claim (a real
   * `Job`+`Lease` already exist by this point) remains findable and resolvable via `dispatch
   * resolve`, rather than durably stuck forever.
   */
  it("C018: fails closed to job_progress_write_failed in this invocation's own response, but persists a resolvable requires_manual record, when the paused outcome's own checkpointId fails checkpointIdSchema's guard", async () => {
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
      errorCode: string;
    };
    expect(payload.pipeline).toBe("failed");
    // C019 fix (item 2): the write itself succeeded here -- see the sibling `invalid_head_sha`
    // test's own comment above for the full rationale.
    expect(payload.pipelineReason).toBe("invalid_checkpoint_id");
    expect(payload.errorCode).toBe("invariant_violation");

    const progress = new FileJobProgressStore(defaultJobProgressDirectory(stateRoot));
    const records = await progress.listForProject(projectId);
    expect(records.ok).toBe(true);
    if (records.ok) {
      expect(records.value).toHaveLength(1);
      expect(records.value[0]).toMatchObject({
        stage: {
          kind: "requires_manual",
          cause: { stage: "dispatch", reasonCode: "invalid_checkpoint_id" },
        },
      });
    }
  });

  /**
   * C019 fix (item 2, negative case): symmetric to the `invalid_head_sha` write-failure test
   * above -- forces the `requires_manual` fallback write itself to genuinely fail (permission
   * denied on the real progress directory), and confirms `job_progress_write_failed` is still
   * reported only in that genuine-failure case, with nothing partial persisted.
   */
  it("C019: reports job_progress_write_failed (not invalid_checkpoint_id) when the requires_manual fallback write itself genuinely fails, and persists nothing", async () => {
    const stateRoot = await temporaryStateRoot();
    const repositoryPath = await temporaryRepository();
    const progressDirectory = defaultJobProgressDirectory(stateRoot);
    await mkdir(progressDirectory, { recursive: true });
    await chmod(progressDirectory, 0o500);
    try {
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
        errorCode: string;
      };
      expect(payload.pipeline).toBe("failed");
      expect(payload.pipelineReason).toBe("job_progress_write_failed");
      expect(payload.errorCode).toBe("permission_denied");
    } finally {
      await chmod(progressDirectory, 0o700);
    }

    const progress = new FileJobProgressStore(progressDirectory);
    const records = await progress.listForProject(projectId);
    expect(records.ok).toBe(true);
    if (records.ok) expect(records.value).toHaveLength(0);
  });

  /**
   * C018 fix: this ticket's own packet names this the fifth, "normal failed path" exit --
   * `pipelineOutcome.state === "failed"` is the one branch among all five where the
   * `ImplementerPipeline` was genuinely invoked (every other exit this ticket closes fires
   * *before* `pipelineComposition.value.run()` is ever called). Before this ticket, `handlers.ts`
   * returned this exact payload with no job-progress record at all, leaving the already-attached
   * admission claim durably stuck -- this is the real defect `dispatch resolve` is now proven
   * (via `resolveJob` below) to be able to recover from.
   */
  it("maps a failed pipeline outcome (e.g. the Claude process itself failing) to a failed payload, never crashing, and persists a resolvable requires_manual record", async () => {
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
    const payload = JSON.parse(outcome.message ?? "{}") as {
      pipeline: string;
      stage: string;
      jobId: string;
    };
    expect(payload.pipeline).toBe("failed");
    expect(payload.stage).toBe("provider_run");

    const progress = new FileJobProgressStore(defaultJobProgressDirectory(stateRoot));
    const records = await progress.listForProject(projectId);
    expect(records.ok).toBe(true);
    if (records.ok) {
      expect(records.value).toHaveLength(1);
      expect(records.value[0]).toMatchObject({
        jobId: payload.jobId,
        stage: {
          kind: "requires_manual",
          cause: { stage: "dispatch", reasonCode: "implementer_pipeline_failed" },
        },
      });
    }

    // Acceptance criterion (4): `dispatch resolve` can genuinely find this record, transition it
    // to a terminal stage, and release the admission claim that would otherwise have stayed
    // durably, permanently stuck.
    const resolution = await resolveJob(stateRoot, payload.jobId);
    expect(resolution.resolved).toBe("resolved");
    expect(resolution.admissionReleased).toBe("released");
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
      errorCode: string;
    };
    expect(payload.pipeline).toBe("failed");
    expect(payload.stage).toBe("request");
    expect(payload.pipelineReason).toBe("implementer_pipeline_request_rejected");
    // The engine's own error code is preserved verbatim, not overwritten by the new CLI-layer
    // reason.
    expect(payload.errorCode).toBe("invariant_violation");
  });

  /**
   * C018 fix: before this ticket, a blocked `buildImplementerPipeline` composition (a real `Job`+
   * `Lease`+admission claim already exist by this point -- only the pipeline's own port wiring,
   * e.g. missing `gh` auth, is what actually blocked) left no job-progress record at all, so the
   * claim could never be found by `dispatch resolve` once `gh` auth was fixed. Now persists a
   * `requires_manual` fallback record first.
   */
  it("maps a blocked pipeline composition (no gh auth) to a failed payload with the fixed message, and persists a resolvable requires_manual record", async () => {
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
      jobId: string;
    };
    expect(payload.pipeline).toBe("blocked");
    expect(payload.pipelineReason).toBe("github_authentication_unavailable");

    const progress = new FileJobProgressStore(defaultJobProgressDirectory(stateRoot));
    const records = await progress.listForProject(projectId);
    expect(records.ok).toBe(true);
    if (records.ok) {
      expect(records.value).toHaveLength(1);
      expect(records.value[0]).toMatchObject({
        jobId: payload.jobId,
        stage: {
          kind: "requires_manual",
          cause: { stage: "dispatch", reasonCode: "implementer_composition_blocked" },
        },
      });
    }

    const resolution = await resolveJob(stateRoot, payload.jobId);
    expect(resolution.resolved).toBe("resolved");
    expect(resolution.admissionReleased).toBe("released");
  });

  /**
   * C019 fix (item 1, codex-reviewed "10th exit" defect from C018's own acceptance sweep): before
   * this ticket, this exact branch `return`ed a `success` payload with zero store writes, even
   * though `dispatchOnce` had already `attachJob`'d a real `Job`/`Lease` and claimed the per-issue
   * admission slot -- the same silent-claim-leak defect class C018 closed for every other exit in
   * this function, just more dangerous here because the CLI's own JSON *also* reports `success`,
   * giving an operator zero signal anything needs attention. Now persists a resolvable
   * `requires_manual` record (`reasonCode:"role_pipeline_unavailable"`) first, and the CLI payload
   * gains `requiresManual:true` so the still-`success`/`not_applicable_role` shape (kept verbatim,
   * per this ticket's own packet) no longer implies "nothing to do here."
   */
  it("never constructs a pipeline for a non-implementer role, reporting dispatched/not_applicable_role, but persists a resolvable requires_manual record and flags it in the response", async () => {
    candidateRoleOverride.current = "team_lead";
    const buildImplementerPipeline = vi.fn(() =>
      Promise.reject(new Error("must never be called for a non-implementer role")),
    );
    const stateRoot = await temporaryStateRoot();
    const repositoryPath = await temporaryRepository();
    const handlers = buildHandlers(stateRoot, repositoryPath, buildImplementerPipeline);
    const outcome = await handlers.run({ projectId });
    expect(outcome.state).toBe("success");
    const payload = JSON.parse(outcome.message ?? "{}") as {
      state: string;
      pipeline: string;
      jobId: string;
      requiresManual: boolean;
    };
    expect(payload.state).toBe("dispatched");
    expect(payload.pipeline).toBe("not_applicable_role");
    expect(payload.requiresManual).toBe(true);
    expect(buildImplementerPipeline).not.toHaveBeenCalled();

    const progress = new FileJobProgressStore(defaultJobProgressDirectory(stateRoot));
    const records = await progress.listForProject(projectId);
    expect(records.ok).toBe(true);
    if (records.ok) {
      expect(records.value).toHaveLength(1);
      expect(records.value[0]).toMatchObject({
        jobId: payload.jobId,
        stage: {
          kind: "requires_manual",
          cause: { stage: "dispatch", reasonCode: "role_pipeline_unavailable" },
        },
      });
    }

    // Acceptance criterion (1): the still-active admission claim this exit used to leave durably
    // stuck (a real `Job`+`Lease` already existed by the time this branch fired) is genuinely
    // findable and releasable by a later `dispatch resolve`, exactly like every other C018 fallback
    // record this file already round-trips.
    const resolution = await resolveJob(stateRoot, payload.jobId);
    expect(resolution.resolved).toBe("resolved");
    expect(resolution.admissionReleased).toBe("released");
  });

  /**
   * C019 fix (item 1, negative case): forces the `requires_manual` fallback write for the
   * non-implementer-role exit to genuinely fail (permission denied on the real progress
   * directory) -- unlike the happy-path test above, this must now report `state:"failed"` (not
   * `success`), since the claim is left durably active with nothing recorded for `dispatch
   * resolve` to ever find.
   */
  it("C019: reports a failed outcome (not success) when the role_pipeline_unavailable fallback write itself genuinely fails", async () => {
    candidateRoleOverride.current = "team_lead";
    const stateRoot = await temporaryStateRoot();
    const repositoryPath = await temporaryRepository();
    const progressDirectory = defaultJobProgressDirectory(stateRoot);
    await mkdir(progressDirectory, { recursive: true });
    await chmod(progressDirectory, 0o500);
    try {
      const buildImplementerPipeline = vi.fn(() =>
        Promise.reject(new Error("must never be called for a non-implementer role")),
      );
      const handlers = buildHandlers(stateRoot, repositoryPath, buildImplementerPipeline);
      const outcome = await handlers.run({ projectId });
      expect(outcome.state).toBe("failed");
      const payload = JSON.parse(outcome.message ?? "{}") as {
        pipeline: string;
        pipelineReason: string;
        errorCode: string;
      };
      expect(payload.pipeline).toBe("failed");
      expect(payload.pipelineReason).toBe("job_progress_write_failed");
      expect(payload.errorCode).toBe("permission_denied");
      expect(buildImplementerPipeline).not.toHaveBeenCalled();
    } finally {
      await chmod(progressDirectory, 0o700);
    }

    const progress = new FileJobProgressStore(progressDirectory);
    const records = await progress.listForProject(projectId);
    expect(records.ok).toBe(true);
    if (records.ok) expect(records.value).toHaveLength(0);
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
   * C018 fix: forces `ensureDispatchWorktreesDirectory` itself to fail (a plain *file*, not a
   * directory, pre-exists at `${stateRoot}/state` -- `mkdir(..., {recursive:true})` throws
   * `ENOTDIR` there) to reach this exit -- a real `Job`+`Lease`+admission claim already exist by
   * this point, only the worktree parent directory could not be created. Before this ticket, this
   * left no job-progress record at all; the pipeline's own `run()` must never even be reached
   * (mirrors the sibling `authoritative_base_unavailable` test's `runSpy` assertion).
   */
  it("fails closed with pipelineReason:worktree_directory_unavailable when ensureDispatchWorktreesDirectory itself fails, and persists a resolvable requires_manual record", async () => {
    const stateRoot = await temporaryStateRoot();
    const repositoryPath = await temporaryRepository();
    // `${stateRoot}/state/dispatch` is a real, pre-existing directory (the fallback
    // `requires_manual` write below needs its own sibling `${stateRoot}/state/dispatch/progress`
    // subdirectory, via the exact same `mkdir(..., {recursive:true})` `AtomicFileStore` itself
    // uses -- breaking `${stateRoot}/state` itself, as opposed to specifically `.../worktrees`,
    // would take that down too, and this test would no longer isolate the one failure it wants).
    // A plain *file*, not a directory, sits at `.../worktrees` itself: `mkdir(path,
    // {recursive:true})` throws `ENOTDIR` when the target path itself (not just an ancestor)
    // already exists as a non-directory.
    await mkdir(join(stateRoot, "state", "dispatch"), { recursive: true });
    await writeFile(join(stateRoot, "state", "dispatch", "worktrees"), "not a directory");
    const runSpy = vi.fn(() =>
      Promise.reject(new Error("must never run once the worktree directory fails")),
    );
    const handlers = buildHandlers(stateRoot, repositoryPath, () =>
      Promise.resolve({ state: "ready", value: fakePipeline(runSpy) }),
    );

    const outcome = await handlers.run({ projectId });
    expect(outcome.state).toBe("failed");
    const payload = JSON.parse(outcome.message ?? "{}") as {
      pipeline: string;
      pipelineReason: string;
      jobId: string;
    };
    expect(payload.pipeline).toBe("failed");
    expect(payload.pipelineReason).toBe("worktree_directory_unavailable");
    expect(runSpy).not.toHaveBeenCalled();

    // The job-progress store's own directory lives under `${stateRoot}/state/dispatch/progress`
    // -- reading it back needs the *store*, not the same broken `state` path handlers.ts tried
    // (and failed) to create; `FileJobProgressStore` creates its own directory lazily on write, so
    // the fallback write itself must have separately succeeded for this read to find anything.
    const progress = new FileJobProgressStore(defaultJobProgressDirectory(stateRoot));
    const records = await progress.listForProject(projectId);
    expect(records.ok).toBe(true);
    if (records.ok) {
      expect(records.value).toHaveLength(1);
      expect(records.value[0]).toMatchObject({
        jobId: payload.jobId,
        stage: {
          kind: "requires_manual",
          cause: { stage: "dispatch", reasonCode: "worktree_directory_unavailable" },
        },
      });
    }

    const resolution = await resolveJob(stateRoot, payload.jobId);
    expect(resolution.resolved).toBe("resolved");
    expect(resolution.admissionReleased).toBe("released");
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
   *
   * C018 fix: before this ticket, this exit (a real `Job`+`Lease`+admission claim already exist,
   * only `resolveAuthoritativeBase` itself failed) left no job-progress record at all. Now
   * persists a `requires_manual` fallback record first, proven resolvable via `resolveJob`.
   */
  it("fails closed with pipelineReason:authoritative_base_unavailable when resolveAuthoritativeBase fails, never falling back to a local HEAD read, and persists a resolvable requires_manual record", async () => {
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
      jobId: string;
    };
    expect(payload.pipeline).toBe("failed");
    expect(payload.pipelineReason).toBe("authoritative_base_unavailable");
    expect(payload.reason).toBe("default_branch_mismatch");
    expect(runSpy).not.toHaveBeenCalled();

    const progress = new FileJobProgressStore(defaultJobProgressDirectory(stateRoot));
    const records = await progress.listForProject(projectId);
    expect(records.ok).toBe(true);
    if (records.ok) {
      expect(records.value).toHaveLength(1);
      expect(records.value[0]).toMatchObject({
        jobId: payload.jobId,
        stage: {
          kind: "requires_manual",
          cause: { stage: "dispatch", reasonCode: "authoritative_base_unavailable" },
        },
      });
    }

    const resolution = await resolveJob(stateRoot, payload.jobId);
    expect(resolution.resolved).toBe("resolved");
    expect(resolution.admissionReleased).toBe("released");
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
   * C015z decision (P0-5, superseded by C018 below): the
   * `headShaSchema.safeParse(authoritativeBase.value.baseRevision)` guard --
   * `resolveAuthoritativeBaseRevision`'s own contract guarantees a real git SHA in production, so
   * this branch's own comment says it is "never expected to fail in production"; this test is
   * what exercises the one case that comment discloses (a malformed *injected test fake*).
   * Confirms the failure surfaces the fixed `job_progress_write_failed` reason in this
   * invocation's own response.
   *
   * C018 fix: before this ticket, this branch left *no* progress record at all -- the pipeline had
   * genuinely already produced a real Draft PR (`headSha`/`changeRequestId` both valid) by the
   * time only `baseRevision` failed to parse, yet the admission claim (a real `Job`+`Lease` already
   * exist) was left durably stuck with nothing to resolve against. This now writes a
   * `requires_manual` fallback record (`cause.reasonCode:"invalid_base_revision"`) that still keeps
   * the real `headSha`/`changeRequestId` -- a human resolving this later can still find the actual
   * PR even though this dispatch's own `baseRevision` bookkeeping failed.
   */
  it("C018: fails closed to job_progress_write_failed in this invocation's own response, but persists a resolvable requires_manual record (keeping the real changeRequestId/headSha) when the authoritative base SHA fails headShaSchema's guard", async () => {
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
      errorCode: string;
    };
    expect(payload.pipeline).toBe("failed");
    // C019 fix (item 2): the write itself succeeded here -- see `invalid_head_sha`'s own sibling
    // test comment above for the full rationale.
    expect(payload.pipelineReason).toBe("invalid_base_revision");
    expect(payload.errorCode).toBe("invariant_violation");

    const progress = new FileJobProgressStore(defaultJobProgressDirectory(stateRoot));
    const records = await progress.listForProject(projectId);
    expect(records.ok).toBe(true);
    if (records.ok) {
      expect(records.value).toHaveLength(1);
      expect(records.value[0]).toMatchObject({
        stage: {
          kind: "requires_manual",
          cause: { stage: "dispatch", reasonCode: "invalid_base_revision" },
        },
        changeRequestId: "4",
        headSha: "b".repeat(40),
      });
      expect(records.value[0]?.baseRevision).toBeUndefined();
    }
  });

  /**
   * C019 fix (item 2, negative case): symmetric to `invalid_head_sha`/`invalid_checkpoint_id`'s
   * own write-failure tests above -- forces the `requires_manual` fallback write itself to
   * genuinely fail (permission denied on the real progress directory), and confirms
   * `job_progress_write_failed` is still reported only in that genuine-failure case, with nothing
   * partial persisted.
   */
  it("C019: reports job_progress_write_failed (not invalid_base_revision) when the requires_manual fallback write itself genuinely fails, and persists nothing", async () => {
    const stateRoot = await temporaryStateRoot();
    const repositoryPath = await temporaryRepository();
    const progressDirectory = defaultJobProgressDirectory(stateRoot);
    await mkdir(progressDirectory, { recursive: true });
    await chmod(progressDirectory, 0o500);
    try {
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
                  id: "PR_6",
                  number: 6,
                  url: "https://example.invalid/pull/6",
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
        errorCode: string;
      };
      expect(payload.pipeline).toBe("failed");
      expect(payload.pipelineReason).toBe("job_progress_write_failed");
      expect(payload.errorCode).toBe("permission_denied");
    } finally {
      await chmod(progressDirectory, 0o700);
    }

    const progress = new FileJobProgressStore(progressDirectory);
    const records = await progress.listForProject(projectId);
    expect(records.ok).toBe(true);
    if (records.ok) expect(records.value).toHaveLength(0);
  });

  /**
   * C019 fix (item 3, coverage for the `model ?? "unresolved"` half of the
   * `implementer_request_invalid` fallback, handlers.ts): a genuinely `workKind:"mechanical"`
   * candidate routed to the `implementer` role naturally reaches this branch with `issue` defined
   * but `result.decision.model` undefined -- `decideNextDispatch` never attempts model routing for
   * mechanical work at all. Unlike `implementerRequestInvalidExternalIssueId`'s own `issue ===
   * undefined` case (tested directly below, with a header explaining why it cannot be reached this
   * way), this is a real end-to-end trigger through the public composition.
   */
  it('C019: falls back to model:"unresolved" and still persists a resolvable requires_manual record when a mechanical-work implementer candidate\'s decision carries no model at all', async () => {
    candidateWorkKindOverride.current = "mechanical";
    const buildImplementerPipeline = vi.fn(() =>
      Promise.reject(new Error("must never be called: no model means no pipeline request")),
    );
    const stateRoot = await temporaryStateRoot();
    const repositoryPath = await temporaryRepository();
    const handlers = buildHandlers(stateRoot, repositoryPath, buildImplementerPipeline);
    const outcome = await handlers.run({ projectId });
    expect(outcome.state).toBe("failed");
    const payload = JSON.parse(outcome.message ?? "{}") as {
      pipeline: string;
      pipelineReason: string;
      jobId: string;
    };
    expect(payload.pipeline).toBe("failed");
    expect(payload.pipelineReason).toBe("implementer_request_invalid");
    expect(buildImplementerPipeline).not.toHaveBeenCalled();

    const progress = new FileJobProgressStore(defaultJobProgressDirectory(stateRoot));
    const records = await progress.listForProject(projectId);
    expect(records.ok).toBe(true);
    if (records.ok) {
      expect(records.value).toHaveLength(1);
      expect(records.value[0]).toMatchObject({
        jobId: payload.jobId,
        model: "unresolved",
        externalIssueId: "linear-issue-1",
        stage: {
          kind: "requires_manual",
          cause: { stage: "dispatch", reasonCode: "implementer_request_invalid" },
        },
      });
    }

    // Acceptance criterion (3): the still-active admission claim is genuinely findable and
    // releasable, exactly like every other C018/C019 fallback record this file round-trips.
    const resolution = await resolveJob(stateRoot, payload.jobId);
    expect(resolution.resolved).toBe("resolved");
    expect(resolution.admissionReleased).toBe("released");
  });

  /**
   * C019 fix (item 3, direct unit coverage for the `issue === undefined` half of the same
   * fallback): see `implementerRequestInvalidExternalIssueId`'s own header, handlers.ts, for why
   * this specific half is tested directly rather than through an end-to-end fixture -- the
   * discovery/decision inconsistency it guards against cannot be produced through the public
   * `createDispatchCliHandlers` composition (`candidates.find(...)` and the dispatched candidate
   * are both always derived from the same single discovery call within one `dispatchOnce`
   * invocation).
   */
  describe("implementerRequestInvalidExternalIssueId", () => {
    it("returns the real issue's externalId when the issue lookup succeeds", () => {
      expect(
        implementerRequestInvalidExternalIssueId({ externalId: "linear-issue-1" }, "issue_1"),
      ).toBe("linear-issue-1");
    });

    it("falls back to the job's own derived issueId when the issue lookup comes back undefined", () => {
      expect(implementerRequestInvalidExternalIssueId(undefined, "issue_1")).toBe("issue_1");
    });
  });
});
