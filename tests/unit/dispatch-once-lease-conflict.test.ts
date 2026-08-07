/**
 * C015a acceptance remediation (FAIL-2): proves the *actual* wiring `dispatchOnce`
 * (src/cli/dispatch/composition.ts) constructs -- `{ leases: new
 * LeaseCoordinator(FileLeaseRepository), jobs: FileJobRepository }` -- makes the per-issue lease
 * genuinely the single winner when the same ready issue is dispatched twice against real files on
 * disk. The unit suite the original C015a commit shipped with (dispatch-composition/
 * -linear-discovery/jobs-file-repository) never touched `Dispatcher`/`LeaseCoordinator` at all;
 * that was exactly this gap in the acceptance review.
 *
 * Why this constructs the candidate directly instead of going through
 * `discoverReadyDispatchCandidates`: the Linear discovery bridge's `toDomainIssue`
 * (src/adapters/dispatch/linear-discovery.ts) does not populate `goal`/`acceptanceCriteria`/
 * `inScope`/`outOfScope`/`estimatedMinutes` on the domain `Issue` it produces --
 * `LinearIssueSnapshot` (src/adapters/linear/model.ts) has no such fields at all -- so *no*
 * Linear-discovered candidate can pass `evaluateEligibility` today, and `dispatchOnce` can never
 * reach `kind:"dispatched"` against real Linear data as currently wired. That is a real,
 * separately-disclosed gap (see the completion report); closing it is a domain-judgment call
 * (how those fields are meant to be encoded in a Linear issue) outside this remediation's
 * assigned scope. This test therefore exercises `Dispatcher` with the exact ports shape
 * `dispatchOnce` builds, fed a directly-built fully-eligible `Issue` -- proving the file-
 * repository wiring itself enforces single-winner dispatch, independent of that separate gap.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Dispatcher, type DispatcherCandidate } from "../../src/application/dispatch/index.js";
import { LeaseCoordinator } from "../../src/application/leases/index.js";
import type { ProjectRegistrySnapshot } from "../../src/application/projects/index.js";
import { trustedProjectConfigSchema } from "../../src/application/projects/index.js";
import type { ModelRoutingConfig } from "../../src/application/routing/index.js";
import {
  parseIdentifier,
  parseInstant,
  type Identifier,
  type Instant,
} from "../../src/domain/foundation/index.js";
import { issueSchema, projectSchema, type Issue } from "../../src/domain/project/index.js";
import { FileJobRepository } from "../../src/infrastructure/jobs/index.js";
import { FileLeaseRepository } from "../../src/infrastructure/leases/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryStateRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-dispatch-once-lease-"));
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
const now = instant("2026-08-07T12:00:00.000Z");

function project() {
  return projectSchema.parse({
    schemaVersion: 1,
    id: projectId,
    displayName: "Sandbox",
    localRepositoryPath: "/tmp/sandbox",
    defaultBranch: "main",
    workManagement: { provider: "linear", containerId: "team-1", projectId: "proj-1" },
    sourceControl: { provider: "github", repository: "owner/sandbox" },
  });
}

function registry(): ProjectRegistrySnapshot {
  const projectValue = project();
  const config = trustedProjectConfigSchema.parse({
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
  return {
    ready: [{ state: "ready", project: projectValue, config, revisionSha: "a".repeat(40) }],
    rejected: [],
  };
}

/** A fully-eligible `Issue` -- every field `evaluateEligibility` checks for is present, so this
 * candidate genuinely reaches `kind:"dispatched"` on the first call (unlike anything
 * `discoverReadyDispatchCandidates` can currently produce; see file header). */
function eligibleIssue(): Issue {
  return issueSchema.parse({
    schemaVersion: 1,
    id: issueId,
    projectId,
    externalId: "linear-issue-1",
    title: "Ship the thing",
    goal: "Deliver the requested behavior.",
    background: "Real-file lease-conflict wiring test needs a deterministic candidate.",
    acceptanceCriteria: ["The second dispatch attempt loses the lease race."],
    inScope: ["Dispatcher wiring"],
    outOfScope: ["Process execution"],
    dependencies: { kind: "none" },
    priority: "high",
    agentRole: "implementer",
    reviewRequirement: "code_review",
    estimatedMinutes: 30,
  });
}

function candidates(): readonly DispatcherCandidate[] {
  return [
    Object.freeze({
      issue: eligibleIssue(),
      readyAt: now,
      stage: "implementation" as const,
      workKind: "model" as const,
    }),
  ];
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

const routeObservations = [
  { provider: "codex", model: "lead", state: "ready" },
  { provider: "codex", model: "build", state: "ready" },
  { provider: "codex", model: "review", state: "ready" },
  { provider: "gemini", model: "visual", state: "ready" },
  { provider: "claude", model: "integrate", state: "ready" },
] as const;

function dispatchInput(holderId: string) {
  return {
    holderId,
    candidates: candidates(),
    registry: registry(),
    active: [],
    routingConfig,
    routeObservations,
  };
}

/** Builds the exact ports shape `dispatchOnce` (composition.ts) constructs for a genuine
 * (non-dry-run) `agent-team run`: a real `FileLeaseRepository` wrapped in `LeaseCoordinator`, and
 * a real `FileJobRepository` -- both pointed at the same on-disk `stateRoot`. */
function realFileBackedDispatcher(stateRoot: string): {
  dispatcher: Dispatcher;
  jobs: FileJobRepository;
} {
  const leases = new FileLeaseRepository(
    join(stateRoot, "leases.json"),
    join(stateRoot, "leases.lock"),
  );
  const jobs = new FileJobRepository(join(stateRoot, "jobs.json"), join(stateRoot, "jobs.lock"));
  return { dispatcher: new Dispatcher({ leases: new LeaseCoordinator(leases), jobs }), jobs };
}

describe("Dispatcher wired to real file-backed lease/job repositories (C015a FAIL-2)", () => {
  it("dispatches the ready issue exactly once across two dispatch calls against the same on-disk state root", async () => {
    const stateRoot = await temporaryStateRoot();
    const { dispatcher, jobs } = realFileBackedDispatcher(stateRoot);

    const first = await dispatcher.dispatch(dispatchInput("holder-run-1"));
    expect(first.kind).toBe("dispatched");
    if (first.kind !== "dispatched") throw new Error("expected the first run to dispatch");
    expect(first.job.issueId).toBe(issueId);

    const second = await dispatcher.dispatch(dispatchInput("holder-run-2"));
    expect(second).toMatchObject({
      kind: "waiting",
      reason: "no_dispatchable_candidate",
      skipped: [{ issueId, reason: { code: "lease_conflict" } }],
    });

    const allJobs = await jobs.readAll();
    expect(allJobs.ok).toBe(true);
    if (allJobs.ok) expect(allJobs.value).toHaveLength(1);
  });

  it("dispatches the ready issue exactly once when two dispatch calls race concurrently", async () => {
    const stateRoot = await temporaryStateRoot();
    const { dispatcher, jobs } = realFileBackedDispatcher(stateRoot);

    const [first, second] = await Promise.all([
      dispatcher.dispatch(dispatchInput("holder-race-1")),
      dispatcher.dispatch(dispatchInput("holder-race-2")),
    ]);

    const outcomes = [first, second];
    const dispatched = outcomes.filter((outcome) => outcome.kind === "dispatched");
    const waiting = outcomes.filter((outcome) => outcome.kind === "waiting");
    expect(dispatched).toHaveLength(1);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({
      reason: "no_dispatchable_candidate",
      skipped: [{ issueId, reason: { code: "lease_conflict" } }],
    });

    const allJobs = await jobs.readAll();
    expect(allJobs.ok).toBe(true);
    if (allJobs.ok) expect(allJobs.value).toHaveLength(1);
  });
});
