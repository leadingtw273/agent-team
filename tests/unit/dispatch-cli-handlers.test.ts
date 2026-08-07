/**
 * C015a acceptance remediation (FAIL-1): `createDispatchCliHandlers` (handlers.ts) and
 * `ephemeral-ports.ts` (66 lines) shipped with zero test coverage in the original C015a commit.
 * The load-bearing claim -- "`--dry-run` never touches the real lease/job repositories" -- was
 * asserted only by reading the source, never demonstrated. This file proves it with counter-
 * wrapped *real* `FileLeaseRepository`/`FileJobRepository` instances (not fakes standing in for
 * "the File version" -- literally the same classes production wires up), plus a real-mode
 * contrast test with non-zero counts, so the dry-run assertion cannot be a tautology (e.g. it
 * would still pass if the candidate were simply ineligible in both modes).
 *
 * `discoverReadyDispatchCandidates` is mocked to return one directly-built, fully-eligible
 * `DispatcherCandidate` (plus one skipped entry, to prove `discoverySkipped` flows through) for
 * determinism -- this file's job is to test the handler's dry-run/real-mode port switching, not
 * to re-prove eligibility parsing (dispatch-linear-discovery.test.ts already covers a genuine
 * Ready Gate description end to end). The candidate still uses `workKind:"mechanical"`/
 * `stage:"ci"` (see `eligibleCandidate()` below) to bypass model routing/routeObservations
 * entirely, so this handler-level test's outcome does not depend on whatever the real Claude
 * capability probe (wired into `dispatchOnce` as of item 2) happens to report in this
 * environment -- see `dispatch-once-lease-conflict.test.ts` for the identical technique and a
 * fuller explanation. Without an eligible candidate, the real-mode contrast test could never show
 * a non-zero write count, which would defeat its whole purpose (ruling out "always zero
 * regardless of branch").
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ok, parseIdentifier, type Identifier } from "../../src/domain/foundation/index.js";
import type { DomainError, Result } from "../../src/domain/foundation/index.js";
import { issueSchema, projectSchema, type Issue } from "../../src/domain/project/index.js";
import type { JobRepository, JobWriteReceipt } from "../../src/application/dispatch/index.js";
import type {
  LeaseMutation,
  LeaseRepository,
  LeaseTransactionReceipt,
} from "../../src/application/leases/index.js";
import type { ProjectRegistrySnapshot } from "../../src/application/projects/index.js";
import { trustedProjectConfigSchema } from "../../src/application/projects/index.js";
import type { ModelRoutingConfig } from "../../src/application/routing/index.js";
import type { Job, Lease } from "../../src/domain/jobs/index.js";
import { FileJobRepository } from "../../src/infrastructure/jobs/index.js";
import { FileLeaseRepository } from "../../src/infrastructure/leases/index.js";
import { FileJobProgressStore } from "../../src/adapters/dispatch/job-progress-store.js";
import { FileIssueAdmissionStore } from "../../src/adapters/dispatch/issue-admission-store.js";
import type { LinearReadModel } from "../../src/adapters/linear/read.js";
import type { BuildResumeCompositionResult } from "../../src/cli/dispatch/resume-full-composition.js";

const discoverSpy = vi.hoisted(() => vi.fn());

vi.mock("../../src/adapters/dispatch/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/adapters/dispatch/index.js")>();
  return {
    ...actual,
    discoverReadyDispatchCandidates: (
      ...args: Parameters<typeof actual.discoverReadyDispatchCandidates>
    ) => {
      discoverSpy(...args);
      return Promise.resolve(
        ok({
          candidates: [eligibleCandidate()],
          skipped: [
            Object.freeze({
              externalIssueId: "linear-issue-skipped",
              reason: Object.freeze({ code: "no_agent_role" as const }),
            }),
          ],
        }),
      );
    },
  };
});

// Imported *after* the vi.mock call above so the module graph it patches is already in place
// (vi.mock's hoisting makes this safe regardless of import order in source, but writing it below
// keeps the intent visible -- same convention as
// tests/unit/registration-cli-probe-composition-poll.test.ts).
const { createDispatchCliHandlers } = await import("../../src/cli/dispatch/handlers.js");

const temporaryDirectories: string[] = [];
afterEach(async () => {
  discoverSpy.mockClear();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryStateRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-dispatch-handlers-"));
  temporaryDirectories.push(directory);
  return directory;
}

const projectId = "project_018f47d2-77a4-7cc1-8ef2-0123456789ab";
const issueId = "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab";

function project() {
  return projectSchema.parse({
    schemaVersion: 1,
    id: projectId,
    displayName: "Sandbox",
    localRepositoryPath: "/tmp/sandbox",
    defaultBranch: "main",
    workManagement: { provider: "linear", containerId: "team-1", projectId: "linear-proj-1" },
    sourceControl: { provider: "github", repository: "owner/sandbox" },
  });
}

function trustedConfigFixture() {
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

function registry(): ProjectRegistrySnapshot {
  return {
    ready: [
      {
        state: "ready",
        project: project(),
        config: trustedConfigFixture(),
        revisionSha: "a".repeat(40),
      },
    ],
    rejected: [],
  };
}

/** Every field `evaluateEligibility` checks for is present -- unlike anything the real Linear
 * discovery bridge can currently produce (see file header). `agentRole:"code_reviewer"`
 * (deliberately *not* `"implementer"`): C015b's run-flow only drives the `ImplementerPipeline`
 * for `role:"implementer"` candidates (see handlers.ts's `case "dispatched"`), and this file's
 * job is strictly the dry-run/real-mode port-isolation question, not pipeline behavior (that has
 * its own dedicated test files) -- using a non-implementer role keeps this test hermetic without
 * needing to fake the pipeline composition too. */
function eligibleIssue(): Issue {
  return issueSchema.parse({
    schemaVersion: 1,
    id: issueId,
    projectId,
    externalId: "linear-issue-1",
    title: "Ship the thing",
    goal: "Deliver the requested behavior.",
    background: "Handler-level dry-run/real-mode contrast test needs a dispatchable candidate.",
    acceptanceCriteria: ["Dry-run never touches the real repositories."],
    inScope: ["CLI handler wiring"],
    outOfScope: ["Process execution"],
    dependencies: { kind: "none" },
    priority: "high",
    agentRole: "code_reviewer",
    reviewRequirement: "code_review",
    estimatedMinutes: 30,
  });
}

/**
 * `stage: "ci"` + `workKind: "mechanical"` (not the `implementation`/`model` shape a real
 * Linear-discovered candidate would carry) is a deliberate test-construction device: the real
 * `dispatchOnce` (unmocked in this file) always passes `routeObservations: []`
 * (composition.ts's own documented limitation), so a `workKind:"model"` candidate can *never*
 * reach `kind:"dispatched"` through it -- see `decision.ts`'s slot-selection logic. Mechanical
 * work bypasses model routing entirely, letting this test observe a genuine `dispatched` outcome
 * and so prove the ports wiring itself, independently of that separate, already-disclosed
 * limitation.
 */
function eligibleCandidate() {
  return Object.freeze({
    issue: eligibleIssue(),
    readyAt: "2026-08-07T00:00:00.000Z",
    stage: "ci" as const,
    workKind: "mechanical" as const,
  });
}

const routingConfig: ModelRoutingConfig = {
  schemaVersion: 1,
  routes: [
    { role: "team_lead", candidates: [{ provider: "codex", model: "lead" }] },
    { role: "implementer", candidates: [{ provider: "codex", model: "build" }] },
    { role: "code_reviewer", candidates: [{ provider: "codex", model: "review" }] },
    { role: "visual_reviewer", candidates: [{ provider: "gemini", model: "visual" }] },
    { role: "integration_engineer", candidates: [{ provider: "claude", model: "integrate" }] },
  ],
};

/** Counts every call, then delegates -- wraps the exact `FileLeaseRepository` production wires
 * up, so "never called" is proven against the real class, not a hand-rolled stand-in. */
class CountingLeaseRepository implements LeaseRepository {
  calls = 0;
  constructor(private readonly delegate: LeaseRepository) {}

  readAll(): Promise<Result<readonly Lease[], DomainError>> {
    this.calls += 1;
    return this.delegate.readAll();
  }

  transact<Value>(
    transactionHolderId: string,
    mutate: (leases: readonly Lease[]) => Result<LeaseMutation<Value>, DomainError>,
  ): Promise<Result<LeaseTransactionReceipt<Value>, DomainError>> {
    this.calls += 1;
    return this.delegate.transact(transactionHolderId, mutate);
  }
}

/** Counts every call, then delegates -- wraps the exact `FileJobRepository` production wires up.
 * `readAll`/`update` (C015c item 2's own additional requirement on `DispatchCompositionReady.jobs`)
 * pass straight through uncounted -- this fake's own job is only to prove `create` call counts,
 * unaffected by that later addition. */
class CountingJobRepository implements JobRepository {
  calls = 0;
  constructor(private readonly delegate: FileJobRepository) {}

  create(job: Job): Promise<Result<JobWriteReceipt, DomainError>> {
    this.calls += 1;
    return this.delegate.create(job);
  }

  readAll(): ReturnType<FileJobRepository["readAll"]> {
    return this.delegate.readAll();
  }

  update(
    ...arguments_: Parameters<FileJobRepository["update"]>
  ): ReturnType<FileJobRepository["update"]> {
    return this.delegate.update(...arguments_);
  }
}

/** `dispatchOnce` never invokes any method on `discovery.readModel` in this file:
 * `discoverReadyDispatchCandidates` itself is mocked above (see file header), so the real
 * discovery bridge -- the only production code that would ever call `readModel` -- never runs.
 * This stub only needs to satisfy the type; it is intentionally never exercised. */
const unusedReadModel = {
  readContext: () => Promise.reject(new Error("must never be called: discovery is mocked")),
  readIssue: () => Promise.reject(new Error("must never be called: discovery is mocked")),
  listIssueIdsInState: () => Promise.reject(new Error("must never be called: discovery is mocked")),
} as unknown as LinearReadModel;

/** `dispatchOnce` (item 2) now genuinely calls `observeClaudeRouteCandidates` on every
 * invocation, dry-run or not -- this fake reports a zero exit so the probe resolves cleanly. Its
 * result has no bearing on this file's assertions: `eligibleCandidate()` is `workKind:"mechanical"`
 * (see its own comment), which bypasses model routing/routeObservations entirely regardless of
 * what this probe reports. */
class ReadyProcessPort {
  spawn() {
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

function fakeBuildComposition(stateRoot: string) {
  const realLeases = new FileLeaseRepository(
    join(stateRoot, "leases.json"),
    join(stateRoot, "leases.lock"),
  );
  const realJobs = new FileJobRepository(
    join(stateRoot, "jobs.json"),
    join(stateRoot, "jobs.lock"),
  );
  const leases = new CountingLeaseRepository(realLeases);
  const jobs = new CountingJobRepository(realJobs);
  const buildComposition = () =>
    Promise.resolve({
      state: "ready" as const,
      value: {
        leases,
        jobs,
        registry: registry(),
        routingConfig,
        discovery: {
          teamId: "team-1",
          linearProjectId: "linear-proj-1",
          readModel: unusedReadModel,
          // Never exercised here: these handler tests stop at dry-run/dispatch outcomes, well
          // before `LifecyclePipeline` (C015c item 5) would ever consult a mutation client.
          mutationClient: {} as never,
        },
        project: project(),
        trustedConfig: trustedConfigFixture(),
        claude: {
          config: { executable: "claude", models: ["opus"], account: "default" },
          process: new ReadyProcessPort(),
        },
      },
    });
  return { buildComposition, leases, jobs, realLeases, realJobs };
}

describe("createDispatchCliHandlers dry-run vs real-mode port isolation (C015a FAIL-1)", () => {
  it("--dry-run never calls the real lease/job repositories, and reports the candidate/eligibility result", async () => {
    const stateRoot = await temporaryStateRoot();
    const { buildComposition, leases, jobs } = fakeBuildComposition(stateRoot);
    const handlers = createDispatchCliHandlers({ agentTeamHome: stateRoot, buildComposition });

    const outcome = await handlers.run({ projectId, dryRun: true });
    expect(outcome.state).toBe("success");
    const payload = JSON.parse(outcome.message ?? "{}") as {
      state: string;
      result: { kind: string };
      candidateSummaries: readonly { issueId: string }[];
      discoverySkipped: readonly { externalIssueId: string }[];
    };
    expect(payload.state).toBe("dry_run");
    // Discovery genuinely ran (this is what proves dry-run still evaluates candidates/eligibility
    // rather than short-circuiting): the mocked discovery's one candidate and one skipped entry
    // both surface in the output.
    expect(discoverSpy).toHaveBeenCalledTimes(1);
    expect(payload.candidateSummaries).toHaveLength(1);
    expect(payload.candidateSummaries[0]?.issueId).toBe(eligibleIssue().id);
    expect(payload.discoverySkipped).toEqual([
      { externalIssueId: "linear-issue-skipped", reason: { code: "no_agent_role" } },
    ]);
    // The engine ran too (against ephemeral in-memory ports) -- dry-run's prediction is a real
    // dispatch decision, not a guess.
    expect(payload.result.kind).toBe("dispatched");

    // The load-bearing assertion: the real File-backed repositories were never touched.
    expect(leases.calls).toBe(0);
    expect(jobs.calls).toBe(0);
    await expect(readdir(stateRoot)).resolves.toEqual([]);
  });

  it("a real (non-dry-run) run does call the real repositories -- proves the zero count above is not a tautology", async () => {
    const stateRoot = await temporaryStateRoot();
    const { buildComposition, leases, jobs, realJobs } = fakeBuildComposition(stateRoot);
    const handlers = createDispatchCliHandlers({ agentTeamHome: stateRoot, buildComposition });

    const outcome = await handlers.run({ projectId });
    expect(outcome.state).toBe("success");
    const payload = JSON.parse(outcome.message ?? "{}") as { state: string; jobId: string };
    expect(payload.state).toBe("dispatched");

    expect(leases.calls).toBeGreaterThan(0);
    expect(jobs.calls).toBeGreaterThan(0);
    const persistedJobs = await realJobs.readAll();
    expect(persistedJobs.ok).toBe(true);
    if (persistedJobs.ok) expect(persistedJobs.value).toHaveLength(1);
  });
});

function id<Scope extends string>(scope: Scope, value: string): Identifier<Scope> {
  const parsed = parseIdentifier(scope, value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

async function seedResumableProgressRecord(stateRoot: string): Promise<Identifier<"job">> {
  const progress = new FileJobProgressStore(join(stateRoot, "state", "dispatch", "progress"));
  const jobId = id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab");
  await progress.compareAndSwap(jobId, null, {
    jobId,
    projectId: id("project", projectId),
    issueId: id("issue", issueId),
    externalIssueId: "linear-issue-1",
    model: "claude-opus",
    stage: { kind: "ci_waiting" },
    branch: `agent-team/${jobId}`,
    worktreePath: "/tmp/does-not-need-to-exist-for-this-fake",
    changeRequestId: "42",
  });
  return jobId;
}

/** C015u decision 2/3: seeds a `requires_manual` record with a specific `cause.reasonCode` -- the
 * exact real-world shape `job_dbae5b6a` was stuck in (`auto_merge_not_enabled`) when C015u's own
 * real-world incident happened, and the negative-case shape (any reasonCode outside decision 3's
 * narrow whitelist) that must still fall through to ordinary discovery/admission. */
async function seedRequiresManualProgressRecord(
  stateRoot: string,
  reasonCode: "auto_merge_not_enabled" | "lifecycle_not_completed" | "change_request_unavailable",
): Promise<Identifier<"job">> {
  const progress = new FileJobProgressStore(join(stateRoot, "state", "dispatch", "progress"));
  const jobId = id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab");
  await progress.compareAndSwap(jobId, null, {
    jobId,
    projectId: id("project", projectId),
    issueId: id("issue", issueId),
    externalIssueId: "linear-issue-1",
    model: "claude-opus",
    stage: {
      kind: "requires_manual",
      cause: {
        stage: reasonCode === "change_request_unavailable" ? "setup" : "merge",
        reasonCode,
        attempts: { count: 1 },
      },
    },
    branch: `agent-team/${jobId}`,
    worktreePath: "/tmp/does-not-need-to-exist-for-this-fake",
    changeRequestId: "42",
  });
  return jobId;
}

/** C015u decision 2: claims and attaches an *active* admission claim for `(projectId, issueId)` --
 * the durable state a real dispatched-then-stuck job leaves behind, and the exact resource decision
 * 2's positive case must prove gets released, and its negative case must prove stays untouched
 * (and therefore still blocks a fresh dispatch attempt for the same issue). Real, file-backed
 * `FileIssueAdmissionStore` at the same `stateRoot` the handler itself builds one at -- so read-back
 * afterward is a genuine end-to-end check, not a fake standing in for one. */
async function seedActiveAdmissionClaim(
  stateRoot: string,
  jobId: Identifier<"job">,
): Promise<FileIssueAdmissionStore> {
  const admission = new FileIssueAdmissionStore(join(stateRoot, "state", "dispatch", "admission"));
  const claimed = await admission.claim(projectId, issueId);
  if (!claimed.ok) throw new Error(claimed.error.code);
  const attached = await admission.attachJob(projectId, issueId, claimed.value.revision, jobId);
  if (!attached.ok) throw new Error(attached.error.code);
  return admission;
}

/** C015u decision 2: a minimal, real `ChangeRequestSnapshot`-shaped fixture -- only the fields
 * `AutoMergeGate`/`LifecyclePipeline`/the reconcile readback itself actually read. */
function mergedChangeRequestFixture() {
  return {
    id: "PR_node_fixture",
    number: 7,
    url: "https://github.com/owner/sandbox/pull/7",
    state: "merged" as const,
    draft: false,
    baseBranch: "main",
    headBranch: "agent-team/job-1",
    headSha: "a".repeat(40),
    mergeability: "mergeable" as const,
    autoMergeEnabled: false,
    updatedAt: "2026-08-08T00:00:00.000Z",
  };
}

describe("createDispatchCliHandlers resume wiring (C015c item 2)", () => {
  it("--dry-run never touches or acts on an existing resumable job-progress record", async () => {
    const stateRoot = await temporaryStateRoot();
    const { buildComposition } = fakeBuildComposition(stateRoot);
    const jobId = await seedResumableProgressRecord(stateRoot);
    const handlers = createDispatchCliHandlers({
      agentTeamHome: stateRoot,
      buildComposition,
      buildResumeComposition: () => {
        throw new Error("must never be called: --dry-run must never attempt a resume");
      },
    });

    const outcome = await handlers.run({ projectId, dryRun: true });
    expect(outcome.state).toBe("success");
    const payload = JSON.parse(outcome.message ?? "{}") as { state: string };
    expect(payload.state).toBe("dry_run");

    const progress = new FileJobProgressStore(join(stateRoot, "state", "dispatch", "progress"));
    const reloaded = await progress.load(jobId);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) {
      expect(reloaded.value?.stage).toEqual({ kind: "ci_waiting" });
      expect(reloaded.value?.revision).toBe(0);
    }
  });

  it("resumes an existing job before considering a fresh dispatch, and never reaches discovery in the same invocation", async () => {
    const stateRoot = await temporaryStateRoot();
    const { buildComposition } = fakeBuildComposition(stateRoot);
    const jobId = await seedResumableProgressRecord(stateRoot);
    const handlers = createDispatchCliHandlers({
      agentTeamHome: stateRoot,
      buildComposition,
      buildResumeComposition: () =>
        Promise.resolve({
          state: "ready",
          value: {
            sourceControl: {
              getChangeRequest: () =>
                Promise.resolve({
                  ok: false,
                  error: { code: "external_failure", detail: undefined },
                }),
            },
            ciRecovery: { run: () => Promise.reject(new Error("unused")) },
            reviewer: { run: () => Promise.reject(new Error("unused")) },
            reviewStatus: {
              begin: () => Promise.reject(new Error("unused")),
              record: () => Promise.reject(new Error("unused")),
            },
            autoMerge: { enable: () => Promise.reject(new Error("unused")) },
            lifecycle: { run: () => Promise.reject(new Error("unused")) },
          },
        } as unknown as Promise<BuildResumeCompositionResult>),
      // Substituting `runResumeCycle` itself is not supported by the handler (it is a direct
      // module-level import, not an injected option) -- instead this test scripts the resume
      // composition's `sourceControl.getChangeRequest` to fail immediately, which is enough to
      // prove control genuinely reached `runResumeCycle` and returned *before* discovery, without
      // needing the full pipeline chain scripted (that full chain is covered by
      // dispatch-resume-composition.test.ts's own dedicated happy-path test).
    });

    const outcome = await handlers.run({ projectId });
    const payload = JSON.parse(outcome.message ?? "{}") as {
      state: string;
      resumed: readonly { jobId: string; outcome: string }[];
    };
    expect(payload.state).toBe("resumed");
    expect(payload.resumed).toEqual([
      { jobId, outcome: "requires_manual", reason: "change_request_read_failed" },
    ]);
    expect(discoverSpy).not.toHaveBeenCalled();
  });

  it("surfaces a blocked resume composition (e.g. GitHub auth unavailable) as state:blocked, without touching the progress record", async () => {
    const stateRoot = await temporaryStateRoot();
    const { buildComposition } = fakeBuildComposition(stateRoot);
    const jobId = await seedResumableProgressRecord(stateRoot);
    const handlers = createDispatchCliHandlers({
      agentTeamHome: stateRoot,
      buildComposition,
      buildResumeComposition: () =>
        Promise.resolve({ state: "blocked", reason: "github_authentication_unavailable" }),
    });

    const outcome = await handlers.run({ projectId });
    expect(outcome.state).toBe("blocked");
    const payload = JSON.parse(outcome.message ?? "{}") as { state: string; reason: string };
    expect(payload.state).toBe("blocked");
    expect(payload.reason).toBe("github_authentication_unavailable");
    expect(discoverSpy).not.toHaveBeenCalled();

    const progress = new FileJobProgressStore(join(stateRoot, "state", "dispatch", "progress"));
    const reloaded = await progress.load(jobId);
    if (reloaded.ok) expect(reloaded.value?.revision).toBe(0);
  });

  it("falls through to the ordinary dispatch flow when there is no resumable record", async () => {
    const stateRoot = await temporaryStateRoot();
    const { buildComposition } = fakeBuildComposition(stateRoot);
    const handlers = createDispatchCliHandlers({
      agentTeamHome: stateRoot,
      buildComposition,
      buildResumeComposition: () => {
        throw new Error("must never be called: nothing to resume");
      },
    });

    const outcome = await handlers.run({ projectId });
    const payload = JSON.parse(outcome.message ?? "{}") as { state: string };
    expect(payload.state).toBe("dispatched");
    expect(discoverSpy).toHaveBeenCalledTimes(1);
  });

  /**
   * C015u decision 2 (this ticket's own core deliverable): a real E101 run got stuck exactly this
   * way -- `job_dbae5b6a` sat at `requires_manual` with `cause.reasonCode: "auto_merge_not_enabled"`
   * (PR #7 had genuinely already merged), and `agent-team run` silently fell through to fresh
   * dispatch (`{"state":"waiting","reason":"no_eligible_candidates"}`) because `handlers.ts`'s own
   * pre-flight gate only ever checked `resumableStageKinds`, never `isMergeReconcilable`'s narrower
   * class. This test proves the fix through the *production* handler entry point end to end --
   * not `runResumeCycle` directly (that path was always correct; C015o/C015q/C015r/C015s/C015t's own
   * unit tests already exhaustively cover it) -- with real, file-backed `FileJobProgressStore`/
   * `FileIssueAdmissionStore` instances at the same `stateRoot` the handler itself builds them at.
   */
  it("resumes a narrowly-reconcilable requires_manual record (C015u's own real-world incident), never reaching discovery, and releases admission on convergence", async () => {
    const stateRoot = await temporaryStateRoot();
    const { buildComposition } = fakeBuildComposition(stateRoot);
    const jobId = await seedRequiresManualProgressRecord(stateRoot, "auto_merge_not_enabled");
    const admission = await seedActiveAdmissionClaim(stateRoot, jobId);
    const claimBefore = await admission.load(projectId, issueId);
    expect(claimBefore).toMatchObject({ ok: true, value: { state: "active", jobId } });

    const handlers = createDispatchCliHandlers({
      agentTeamHome: stateRoot,
      buildComposition,
      buildResumeComposition: () =>
        Promise.resolve({
          state: "ready",
          value: {
            sourceControl: {
              getChangeRequest: () => Promise.resolve(ok(mergedChangeRequestFixture())),
            },
            ciRecovery: {
              run: () =>
                Promise.reject(new Error("must never be called: reconcile never re-runs CI")),
            },
            reviewer: {
              run: () =>
                Promise.reject(new Error("must never be called: reconcile never re-reviews")),
            },
            reviewStatus: {
              begin: () => Promise.reject(new Error("must never be called")),
              record: () => Promise.reject(new Error("must never be called")),
            },
            autoMerge: {
              enable: () =>
                Promise.reject(
                  new Error("must never be called: reconcile never re-enables auto-merge"),
                ),
            },
            lifecycle: {
              run: () =>
                Promise.resolve({
                  state: "completed",
                  merge: "authorized",
                  headSha: mergedChangeRequestFixture().headSha,
                  autoMergeDisposition: "not_required" as const,
                }),
            },
          },
        } as unknown as Promise<BuildResumeCompositionResult>),
    });

    const outcome = await handlers.run({ projectId });
    const payload = JSON.parse(outcome.message ?? "{}") as {
      state: string;
      resumed: readonly { jobId: string; outcome: string }[];
    };
    expect(payload.state).toBe("resumed");
    expect(payload.resumed).toEqual([{ jobId, outcome: "merge_reconciled" }]);
    expect(discoverSpy).not.toHaveBeenCalled();

    const progress = new FileJobProgressStore(join(stateRoot, "state", "dispatch", "progress"));
    const reloaded = await progress.load(jobId);
    expect(reloaded).toMatchObject({ ok: true, value: { stage: { kind: "completed" } } });

    const claimAfter = await admission.load(projectId, issueId);
    expect(claimAfter).toMatchObject({
      ok: true,
      value: { state: "released", releaseReason: "completed" },
    });
  });

  it("a requires_manual record outside decision 3's narrow whitelist never builds a resume composition -- falls through to discovery, correctly blocked by the still-active admission claim", async () => {
    const stateRoot = await temporaryStateRoot();
    const { buildComposition } = fakeBuildComposition(stateRoot);
    const jobId = await seedRequiresManualProgressRecord(stateRoot, "change_request_unavailable");
    const admission = await seedActiveAdmissionClaim(stateRoot, jobId);
    const handlers = createDispatchCliHandlers({
      agentTeamHome: stateRoot,
      buildComposition,
      buildResumeComposition: () => {
        throw new Error(
          "must never be called: change_request_unavailable is not in decision 3's whitelist",
        );
      },
    });

    const outcome = await handlers.run({ projectId });
    const payload = JSON.parse(outcome.message ?? "{}") as {
      state: string;
      admissionSkipped?: readonly { issueId: string; reason: string }[];
    };
    // Falls all the way through to ordinary discovery/dispatch -- the seeded requires_manual
    // record is simply never looked at again by this call (predicate correctly excludes it).
    expect(discoverSpy).toHaveBeenCalledTimes(1);
    expect(payload.admissionSkipped).toEqual([{ issueId, reason: "issue_claim_active" }]);

    // The requires_manual record itself, and its admission claim, are untouched -- proving the
    // predicate did not accidentally widen to "any requires_manual record".
    const progress = new FileJobProgressStore(join(stateRoot, "state", "dispatch", "progress"));
    const reloaded = await progress.load(jobId);
    expect(reloaded).toMatchObject({
      ok: true,
      value: { revision: 0, stage: { kind: "requires_manual" } },
    });
    const claim = await admission.load(projectId, issueId);
    expect(claim).toMatchObject({ ok: true, value: { state: "active", jobId } });
  });
});

/**
 * C015u decision 3: a small routing matrix over `agent-team run`'s *outer* path selection --
 * "does this input reach discovery, or a resume/reconcile composition, or neither" -- not a
 * re-test of what happens once inside either path (that is `dispatch-resume-composition.test.ts`'s
 * job for the resume/reconcile state machine, and `dispatch-once.test.ts`'s for discovery/dispatch).
 * Deliberately five rows, not a full cross-product of every handler entry point x every job stage
 * (codex's review explicitly warned that would be high-cost and brittle without adding real
 * coverage) -- rows ①④⑤ are already independently proven by
 * "resumes an existing job before considering a fresh dispatch..."/"falls through to the ordinary
 * dispatch flow..."/"--dry-run never touches or acts on an existing resumable job-progress
 * record" above; they are restated here, self-contained, so the whole matrix is visible and
 * auditable in one place rather than requiring a reader to reassemble it from three separate
 * `describe` blocks.
 */
describe("C015u decision 3: dispatch run routing matrix (outer path selection only)", () => {
  it("① a general resumable stage (ci_waiting) routes to resume composition/cycle, never discovery", async () => {
    const stateRoot = await temporaryStateRoot();
    const { buildComposition } = fakeBuildComposition(stateRoot);
    await seedResumableProgressRecord(stateRoot);
    let resumeCompositionBuilt = false;
    const handlers = createDispatchCliHandlers({
      agentTeamHome: stateRoot,
      buildComposition,
      buildResumeComposition: () => {
        resumeCompositionBuilt = true;
        return Promise.resolve({
          state: "blocked",
          reason: "github_authentication_unavailable",
        });
      },
    });

    await handlers.run({ projectId });
    expect(resumeCompositionBuilt).toBe(true);
    expect(discoverSpy).not.toHaveBeenCalled();
  });

  it("② a narrowly-reconcilable requires_manual routes to resume composition/reconcile, never discovery", async () => {
    const stateRoot = await temporaryStateRoot();
    const { buildComposition } = fakeBuildComposition(stateRoot);
    await seedRequiresManualProgressRecord(stateRoot, "lifecycle_not_completed");
    let resumeCompositionBuilt = false;
    const handlers = createDispatchCliHandlers({
      agentTeamHome: stateRoot,
      buildComposition,
      buildResumeComposition: () => {
        resumeCompositionBuilt = true;
        return Promise.resolve({
          state: "blocked",
          reason: "github_authentication_unavailable",
        });
      },
    });

    await handlers.run({ projectId });
    expect(resumeCompositionBuilt).toBe(true);
    expect(discoverSpy).not.toHaveBeenCalled();
  });

  it("③ a non-reconcilable requires_manual never routes to resume -- falls to discovery/admission", async () => {
    const stateRoot = await temporaryStateRoot();
    const { buildComposition } = fakeBuildComposition(stateRoot);
    await seedRequiresManualProgressRecord(stateRoot, "change_request_unavailable");
    let resumeCompositionBuilt = false;
    const handlers = createDispatchCliHandlers({
      agentTeamHome: stateRoot,
      buildComposition,
      buildResumeComposition: () => {
        resumeCompositionBuilt = true;
        return Promise.resolve({
          state: "blocked",
          reason: "github_authentication_unavailable",
        });
      },
    });

    await handlers.run({ projectId });
    expect(resumeCompositionBuilt).toBe(false);
    expect(discoverSpy).toHaveBeenCalledTimes(1);
  });

  it("④ no progress record at all routes straight to fresh dispatch", async () => {
    const stateRoot = await temporaryStateRoot();
    const { buildComposition } = fakeBuildComposition(stateRoot);
    let resumeCompositionBuilt = false;
    const handlers = createDispatchCliHandlers({
      agentTeamHome: stateRoot,
      buildComposition,
      buildResumeComposition: () => {
        resumeCompositionBuilt = true;
        return Promise.resolve({
          state: "blocked",
          reason: "github_authentication_unavailable",
        });
      },
    });

    await handlers.run({ projectId });
    expect(resumeCompositionBuilt).toBe(false);
    expect(discoverSpy).toHaveBeenCalledTimes(1);
  });

  it("⑤ --dry-run never resumes, even with an eligible resume candidate present, and makes zero external calls", async () => {
    const stateRoot = await temporaryStateRoot();
    const { buildComposition } = fakeBuildComposition(stateRoot);
    await seedRequiresManualProgressRecord(stateRoot, "auto_merge_not_enabled");
    const handlers = createDispatchCliHandlers({
      agentTeamHome: stateRoot,
      buildComposition,
      buildResumeComposition: () => {
        throw new Error("must never be called: --dry-run must never attempt a resume/reconcile");
      },
    });

    const outcome = await handlers.run({ projectId, dryRun: true });
    expect(outcome.state).toBe("success");
    const payload = JSON.parse(outcome.message ?? "{}") as { state: string };
    expect(payload.state).toBe("dry_run");
    expect(discoverSpy).toHaveBeenCalledTimes(1); // dry-run still previews discovery -- just never mutates.
  });
});
