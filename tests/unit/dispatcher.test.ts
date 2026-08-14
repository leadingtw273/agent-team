import { describe, expect, it } from "vitest";

import {
  Dispatcher,
  type JobRepository,
  type JobWriteReceipt,
} from "../../src/application/dispatch/index.js";
import {
  LeaseCoordinator,
  type LeaseMutation,
  type LeaseRepository,
  type LeaseTransactionReceipt,
} from "../../src/application/leases/index.js";
import type { ProjectRegistrySnapshot } from "../../src/application/projects/index.js";
import { trustedProjectConfigSchema } from "../../src/application/projects/index.js";
import type { ModelRoutingConfig } from "../../src/application/routing/index.js";
import {
  domainError,
  err,
  ok,
  parseIdentifier,
  parseInstant,
  type DomainError,
  type Identifier,
  type Instant,
  type Result,
} from "../../src/domain/foundation/index.js";
import type { Job, Lease } from "../../src/domain/jobs/index.js";
import { issueSchema, projectSchema, type Issue } from "../../src/domain/project/index.js";

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
const otherProjectId = id("project", "project_018f47d2-77a4-7cc1-8ef2-1123456789ab");
const issueIds = [
  id("issue", "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab"),
  id("issue", "issue_018f47d2-77a4-7cc1-8ef2-1123456789ab"),
  id("issue", "issue_018f47d2-77a4-7cc1-8ef2-2123456789ab"),
] as const;
const jobIds = [
  id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab"),
  id("job", "job_018f47d2-77a4-7cc1-8ef2-1123456789ab"),
  id("job", "job_018f47d2-77a4-7cc1-8ef2-2123456789ab"),
] as const;
const leaseIds = [
  id("lease", "lease_018f47d2-77a4-7cc1-8ef2-0123456789ab"),
  id("lease", "lease_018f47d2-77a4-7cc1-8ef2-1123456789ab"),
  id("lease", "lease_018f47d2-77a4-7cc1-8ef2-2123456789ab"),
] as const;
const now = instant("2026-08-04T12:00:00.000Z");

function issue(index: number, overrides: Partial<Issue> = {}): Issue {
  const selectedId = issueIds[index];
  if (selectedId === undefined) throw new Error("missing fixture issue ID");
  return issueSchema.parse({
    schemaVersion: 1,
    id: selectedId,
    projectId,
    externalId: `ENG-${String(index + 1)}`,
    title: `Task ${String(index + 1)}`,
    goal: "Deliver the requested behavior.",
    background: "The dispatcher needs a deterministic candidate.",
    acceptanceCriteria: ["The task is dispatched safely."],
    inScope: ["Dispatcher behavior"],
    outOfScope: ["Process execution"],
    dependencies: { kind: "none" },
    priority: index === 0 ? "urgent" : "high",
    agentRole: "implementer",
    reviewRequirement: "code_review",
    estimatedMinutes: 30,
    changeRegions: [{ path: `src/task-${String(index)}.ts`, coverage: "exact" }],
    ...overrides,
  });
}

function registry(): ProjectRegistrySnapshot {
  const project = projectSchema.parse({
    schemaVersion: 1,
    id: projectId,
    displayName: "Test project",
    localRepositoryPath: "/tmp/test-project",
    defaultBranch: "main",
    workManagement: { provider: "linear", containerId: "workspace", projectId: "team" },
    sourceControl: { provider: "github", repository: "owner/repository" },
  });
  const config = trustedProjectConfigSchema.parse({
    schemaVersion: 1,
    projectId,
    defaultBranch: "main",
    platforms: {
      workManagement: project.workManagement,
      sourceControl: project.sourceControl,
    },
    projectRules: [],
    roleInstructions: {},
    commands: {
      quality: [{ executable: "pnpm", arguments: ["test"] }],
      visualReview: [],
    },
  });
  return {
    ready: [{ state: "ready", project, config, revisionSha: "a".repeat(40) }],
    rejected: [],
  };
}

const routingConfig = {
  schemaVersion: 1,
  routes: [
    { role: "team_lead", candidates: [{ provider: "codex", model: "lead" }] },
    { role: "implementer", candidates: [{ provider: "codex", model: "build" }] },
    { role: "code_reviewer", candidates: [{ provider: "claude", model: "review" }] },
    { role: "visual_reviewer", candidates: [{ provider: "gemini", model: "visual" }] },
    {
      role: "integration_engineer",
      candidates: [{ provider: "codex", model: "integrate" }],
    },
  ],
} as const satisfies ModelRoutingConfig;

const routeObservations = [
  { provider: "codex", model: "lead", state: "ready" },
  { provider: "codex", model: "build", state: "ready" },
  { provider: "claude", model: "review", state: "ready" },
  { provider: "gemini", model: "visual", state: "ready" },
  { provider: "codex", model: "integrate", state: "ready" },
] as const;

class MemoryLeaseRepository implements LeaseRepository {
  leases: readonly Lease[] = [];
  persistence: LeaseTransactionReceipt<unknown>["persistence"] = "confirmed";
  failure: DomainError | undefined;
  readonly events: string[];

  constructor(events: string[] = []) {
    this.events = events;
  }

  readAll(): Promise<Result<readonly Lease[], DomainError>> {
    return Promise.resolve(ok(this.leases));
  }

  transact<Value>(
    holderId: string,
    mutate: (leases: readonly Lease[]) => Result<LeaseMutation<Value>, DomainError>,
  ): Promise<Result<LeaseTransactionReceipt<Value>, DomainError>> {
    this.events.push(holderId);
    if (this.failure !== undefined) return Promise.resolve(err(this.failure));
    const mutation = mutate(this.leases);
    if (!mutation.ok) return Promise.resolve(mutation);
    if (mutation.value.changed) this.leases = mutation.value.leases;
    return Promise.resolve(
      ok({
        value: mutation.value.value,
        persistence: mutation.value.changed ? this.persistence : "unchanged",
        lockRelease: "confirmed",
      }),
    );
  }
}

class MemoryJobRepository implements JobRepository {
  readonly jobs: Job[] = [];
  readonly events: string[];
  readonly outcomes: Result<JobWriteReceipt, DomainError>[];

  constructor(
    events: string[] = [],
    outcomes: Result<JobWriteReceipt, DomainError>[] = [ok({ durability: "confirmed" })],
  ) {
    this.events = events;
    this.outcomes = outcomes;
  }

  create(job: Job): Promise<Result<JobWriteReceipt, DomainError>> {
    this.events.push(`job-create:${job.issueId}`);
    const outcome = this.outcomes.shift() ?? ok({ durability: "confirmed" as const });
    if (outcome.ok) this.jobs.push(job);
    return Promise.resolve(outcome);
  }
}

function sequence<Scope extends "job" | "lease">(
  values: readonly Identifier<Scope>[],
): () => Result<Identifier<Scope>, DomainError> {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    return value === undefined ? err(domainError("invariant_violation")) : ok(value);
  };
}

function createDispatcher(leases: MemoryLeaseRepository, jobs: MemoryJobRepository): Dispatcher {
  return new Dispatcher(
    {
      leases: new LeaseCoordinator(leases, {
        clock: { now: () => now },
        generateLeaseId: sequence(leaseIds),
      }),
      jobs,
    },
    { clock: { now: () => now }, generateJobId: sequence(jobIds) },
  );
}

function input(candidates: readonly Issue[]) {
  return {
    holderId: "dispatcher-a",
    candidates: candidates.map((candidate) => ({
      issue: candidate,
      readyAt: now,
      stage: "implementation" as const,
      workKind: "model" as const,
    })),
    registry: registry(),
    active: [],
    routingConfig,
    routeObservations,
  };
}

describe("Dispatcher use case", () => {
  it("runs Eligibility, trusted project, routing, Lease, then Job in order", async () => {
    const events: string[] = [];
    const leases = new MemoryLeaseRepository(events);
    const jobs = new MemoryJobRepository(events);

    const result = await createDispatcher(leases, jobs).dispatch(input([issue(0)]));

    expect(result).toMatchObject({
      kind: "dispatched",
      job: { id: jobIds[0], issueId: issueIds[0] },
      lease: { jobId: jobIds[0], issueId: issueIds[0], holderId: "dispatcher-a" },
      decision: {
        candidate: { repositoryId: "github:owner/repository" },
        model: { candidate: { provider: "codex", model: "build" } },
      },
    });
    expect(events).toEqual(["lease-acquire:dispatcher-a", `job-create:${issueIds[0]}`]);
    expect(jobs.jobs).toHaveLength(1);
    if (result.kind !== "dispatched") throw new Error("expected dispatch");
    expect(result.job).not.toHaveProperty("startedAt");
  });

  it("isolates ineligible and unregistered candidates, then dispatches a safe one", async () => {
    const leases = new MemoryLeaseRepository();
    const jobs = new MemoryJobRepository();
    const result = await createDispatcher(leases, jobs).dispatch(
      input([issue(0, { goal: undefined }), issue(1, { projectId: otherProjectId }), issue(2)]),
    );

    expect(result).toMatchObject({
      kind: "dispatched",
      job: { issueId: issueIds[2] },
      skipped: [
        { issueId: issueIds[0], reason: { code: "not_eligible" } },
        { issueId: issueIds[1], reason: { code: "project_not_ready" } },
      ],
    });
  });

  it("continues to the next safe candidate when Lease acquisition conflicts", async () => {
    const leases = new MemoryLeaseRepository();
    leases.leases = [
      {
        schemaVersion: 1,
        id: leaseIds[2],
        jobId: jobIds[2],
        issueId: issueIds[0],
        holderId: "other-dispatcher",
        acquiredAt: now,
        expiresAt: instant("2026-08-04T12:05:00.000Z"),
      },
    ];
    const result = await createDispatcher(leases, new MemoryJobRepository()).dispatch(
      input([issue(0), issue(1)]),
    );

    expect(result).toMatchObject({
      kind: "dispatched",
      job: { id: jobIds[1], issueId: issueIds[1] },
      skipped: [{ issueId: issueIds[0], reason: { code: "lease_conflict" } }],
    });
  });

  it("releases a failed candidate Lease before trying the next candidate", async () => {
    const leases = new MemoryLeaseRepository();
    const jobs = new MemoryJobRepository(
      [],
      [err(domainError("external_failure")), ok({ durability: "confirmed" })],
    );
    const result = await createDispatcher(leases, jobs).dispatch(input([issue(0), issue(1)]));

    expect(result).toMatchObject({
      kind: "dispatched",
      job: { issueId: issueIds[1] },
      skipped: [{ issueId: issueIds[0], reason: { code: "job_create_failed" } }],
    });
    expect(leases.leases).toMatchObject([
      { issueId: issueIds[0], releasedAt: now },
      { issueId: issueIds[1] },
    ]);
    expect(leases.leases[1]).not.toHaveProperty("releasedAt");
  });

  it("fails closed on ambiguous Lease or Job persistence", async () => {
    const unknownLeaseRepository = new MemoryLeaseRepository();
    unknownLeaseRepository.persistence = "unknown";
    await expect(
      createDispatcher(unknownLeaseRepository, new MemoryJobRepository()).dispatch(
        input([issue(0)]),
      ),
    ).resolves.toMatchObject({ kind: "blocked", reason: "lease_persistence_unknown" });

    const unknownJobRepository = new MemoryJobRepository([], [ok({ durability: "unknown" })]);
    await expect(
      createDispatcher(new MemoryLeaseRepository(), unknownJobRepository).dispatch(
        input([issue(0)]),
      ),
    ).resolves.toMatchObject({ kind: "blocked", reason: "job_persistence_unknown" });
  });

  it("waits without taking a Lease when routing has no safe Provider", async () => {
    const leases = new MemoryLeaseRepository();
    const jobs = new MemoryJobRepository();
    const blockedInput = {
      ...input([issue(0)]),
      routeObservations: routeObservations.map((observation) => ({
        ...observation,
        state: "quota_unknown" as const,
      })),
    };
    const result = await createDispatcher(leases, jobs).dispatch(blockedInput);

    expect(result).toMatchObject({
      kind: "waiting",
      reason: "no_dispatchable_candidate",
      skipped: [{ issueId: issueIds[0], reason: { code: "dispatch_blocked" } }],
    });
    expect(leases.leases).toEqual([]);
    expect(jobs.jobs).toEqual([]);
  });

  it("blocks on systemic Lease storage failure and malformed duplicate input", async () => {
    const brokenLeases = new MemoryLeaseRepository();
    brokenLeases.failure = domainError("external_failure");
    await expect(
      createDispatcher(brokenLeases, new MemoryJobRepository()).dispatch(input([issue(0)])),
    ).resolves.toMatchObject({ kind: "blocked", reason: "lease_store_failed" });

    await expect(
      createDispatcher(new MemoryLeaseRepository(), new MemoryJobRepository()).dispatch(
        input([issue(0), issue(0)]),
      ),
    ).resolves.toMatchObject({ kind: "blocked", reason: "invalid_runtime_input" });
  });
});
