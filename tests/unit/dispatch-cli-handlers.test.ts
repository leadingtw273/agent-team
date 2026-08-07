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

import { ok } from "../../src/domain/foundation/index.js";
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
import type { LinearReadModel } from "../../src/adapters/linear/read.js";

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

/** Counts every call, then delegates -- wraps the exact `FileJobRepository` production wires up. */
class CountingJobRepository implements JobRepository {
  calls = 0;
  constructor(private readonly delegate: JobRepository) {}

  create(job: Job): Promise<Result<JobWriteReceipt, DomainError>> {
    this.calls += 1;
    return this.delegate.create(job);
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
