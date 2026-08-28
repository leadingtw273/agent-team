import { describe, expect, it } from "vitest";

import {
  DEFAULT_DISPATCH_SLOT_LIMITS,
  decideNextDispatch,
  type DispatchCandidate,
  type DispatchDecisionInput,
  type DispatchSlotLimits,
  type ModelExecutionOccupancy,
  type RepositoryReservation,
} from "../../src/application/dispatch/index.js";
import type {
  CandidateObservation,
  ModelRoutingConfig,
} from "../../src/application/routing/index.js";

const routingConfig = {
  schemaVersion: 1,
  routes: [
    {
      role: "team_lead",
      candidates: [{ provider: "codex", model: "lead" }],
    },
    {
      role: "implementer",
      candidates: [
        { provider: "codex", model: "balanced" },
        { provider: "codex", model: "backup" },
      ],
    },
    {
      role: "code_reviewer",
      candidates: [{ provider: "claude", model: "review" }],
    },
    {
      role: "visual_reviewer",
      candidates: [{ provider: "gemini", model: "visual" }],
    },
    {
      role: "integration_engineer",
      candidates: [{ provider: "codex", model: "integration" }],
    },
  ],
} as const satisfies ModelRoutingConfig;

const readyObservations: readonly CandidateObservation[] = [
  { provider: "codex", model: "lead", state: "ready" },
  { provider: "codex", model: "balanced", state: "ready" },
  { provider: "codex", model: "backup", state: "ready" },
  { provider: "claude", model: "review", state: "ready" },
  { provider: "gemini", model: "visual", state: "ready" },
  { provider: "codex", model: "integration", state: "ready" },
];

function candidate(id: string, overrides: Partial<DispatchCandidate> = {}): DispatchCandidate {
  return {
    id,
    projectId: "project-a",
    repositoryId: "repo-a",
    priority: "medium",
    readyAt: "2026-08-04T01:00:00.000Z",
    role: "implementer",
    workKind: "model",
    stage: "implementation",
    declaredRegions: [{ path: `src/${id}.ts`, coverage: "exact" }],
    ...overrides,
  };
}

function occupancy(
  jobId: string,
  overrides: Partial<ModelExecutionOccupancy> = {},
): ModelExecutionOccupancy {
  return {
    jobId,
    projectId: "active-project",
    provider: "codex",
    ...overrides,
  };
}

function reservation(
  jobId: string,
  overrides: Partial<RepositoryReservation> = {},
): RepositoryReservation {
  return {
    jobId,
    projectId: "active-project",
    repositoryId: "active-repo",
    stage: "implementation",
    declaredRegions: [{ path: `src/${jobId}.ts`, coverage: "exact" }],
    ...overrides,
  };
}

function input(
  candidates: readonly DispatchCandidate[],
  overrides: Partial<DispatchDecisionInput> = {},
): DispatchDecisionInput {
  return {
    candidates,
    executionOccupancy: [],
    repositoryReservations: [],
    routingConfig,
    routeObservations: readyObservations,
    ...overrides,
  };
}

function limits(overrides: Partial<DispatchSlotLimits>): DispatchSlotLimits {
  return {
    ...DEFAULT_DISPATCH_SLOT_LIMITS,
    ...overrides,
    perProviderModelJobs: {
      ...DEFAULT_DISPATCH_SLOT_LIMITS.perProviderModelJobs,
      ...overrides.perProviderModelJobs,
    },
  };
}

describe("dispatch candidate ordering", () => {
  it("lets a newly ready urgent job overtake lower-priority unstarted jobs", () => {
    const decision = decideNextDispatch(
      input([
        candidate("low", { priority: "low", readyAt: "2026-08-04T00:00:00.000Z" }),
        candidate("urgent", { priority: "urgent", readyAt: "2026-08-04T02:00:00.000Z" }),
        candidate("high", { priority: "high", readyAt: "2026-08-04T01:00:00.000Z" }),
      ]),
    );

    expect(decision).toMatchObject({ kind: "selected", candidate: { id: "urgent" } });
  });

  it("round-robins projects at the same priority before considering their second jobs", () => {
    const decision = decideNextDispatch(
      input(
        [
          candidate("a-first", {
            projectId: "project-a",
            priority: "high",
            readyAt: "2026-08-04T00:00:00.000Z",
          }),
          candidate("a-second", {
            projectId: "project-a",
            priority: "high",
            readyAt: "2026-08-04T00:01:00.000Z",
          }),
          candidate("b-first", {
            projectId: "project-b",
            priority: "high",
            readyAt: "2026-08-04T02:00:00.000Z",
          }),
        ],
        { rotation: { high: "project-a" } },
      ),
    );

    expect(decision).toMatchObject({
      kind: "selected",
      candidate: { id: "b-first" },
      nextRotation: { high: "project-b" },
    });
  });

  it("continues rotation after a cursor project whose queue has drained", () => {
    const decision = decideNextDispatch(
      input(
        [
          candidate("a", { projectId: "project-a", priority: "high" }),
          candidate("c", { projectId: "project-c", priority: "high" }),
        ],
        { rotation: { high: "project-b" } },
      ),
    );

    expect(decision).toMatchObject({ kind: "selected", candidate: { id: "c" } });
  });

  it("uses Ready time and then stable ID order within the selected project", () => {
    const decision = decideNextDispatch(
      input([
        candidate("later", { readyAt: "2026-08-04T02:00:00.000Z" }),
        candidate("z-same-time", { readyAt: "2026-08-04T00:00:00.000Z" }),
        candidate("a-same-time", { readyAt: "2026-08-04T00:00:00.000Z" }),
      ]),
    );

    expect(decision).toMatchObject({ kind: "selected", candidate: { id: "a-same-time" } });
  });
});

describe("model and project slots", () => {
  it("uses the canonical four-wide defaults with three Codex and one Claude slots", () => {
    expect(DEFAULT_DISPATCH_SLOT_LIMITS).toEqual({
      globalModelJobs: 4,
      perProviderModelJobs: { codex: 3, claude: 1, gemini: 1 },
      perProjectModelJobs: 4,
      perRepositoryIntegrationJobs: 1,
    });

    const decision = decideNextDispatch(
      input([candidate("review", { role: "code_reviewer" })], {
        executionOccupancy: [
          occupancy("codex-one", { projectId: "project-a" }),
          occupancy("codex-two", { projectId: "project-a" }),
          occupancy("codex-three", { projectId: "project-a" }),
        ],
      }),
    );

    expect(decision).toMatchObject({
      kind: "selected",
      candidate: { id: "review" },
      model: { candidate: { provider: "claude" } },
    });
  });

  it("does not cross providers when the Codex execution slot is occupied", () => {
    const decision = decideNextDispatch(
      input([candidate("next")], {
        executionOccupancy: [occupancy("running")],
        slotLimits: limits({
          perProviderModelJobs: { codex: 1, claude: 1, gemini: 1 },
        }),
      }),
    );

    expect(decision).toMatchObject({
      kind: "waiting",
      skipped: [
        {
          blocker: {
            code: "provider_route_unavailable",
            skipped: [
              { provider: "codex", model: "balanced", state: "provider_slot_full" },
              { provider: "codex", model: "backup", state: "provider_slot_full" },
            ],
          },
        },
      ],
    });
  });

  it("blocks model work at the global limit but still selects mechanical work", () => {
    const decision = decideNextDispatch(
      input(
        [
          candidate("urgent-model", { priority: "urgent" }),
          candidate("health", {
            projectId: "project-health",
            repositoryId: "repo-health",
            priority: "low",
            workKind: "mechanical",
            stage: "health",
          }),
        ],
        {
          executionOccupancy: [
            occupancy("one", { provider: "codex" }),
            occupancy("two", { provider: "claude" }),
          ],
          slotLimits: limits({ globalModelJobs: 2 }),
        },
      ),
    );

    expect(decision).toMatchObject({
      kind: "selected",
      candidate: { id: "health" },
      consumesModelSlot: false,
      skipped: [{ candidateId: "urgent-model", blocker: { code: "global_model_slot_full" } }],
    });
    if (decision.kind !== "selected") throw new Error("expected selected decision");
    expect(decision.model).toBeUndefined();
  });

  it("does not make mechanical health work consume or wait for repository scope slots", () => {
    const decision = decideNextDispatch(
      input(
        [
          candidate("health", {
            repositoryId: "shared",
            workKind: "mechanical",
            stage: "health",
            declaredRegions: undefined,
          }),
        ],
        {
          repositoryReservations: [
            reservation("running", {
              repositoryId: "shared",
              declaredRegions: undefined,
            }),
          ],
          slotLimits: limits({
            globalModelJobs: 3,
            perProviderModelJobs: { codex: 2, claude: 1, gemini: 1 },
          }),
        },
      ),
    );

    expect(decision).toMatchObject({
      kind: "selected",
      candidate: { id: "health" },
      consumesModelSlot: false,
    });
  });

  it("enforces a project limit independently from the wider global limit", () => {
    const decision = decideNextDispatch(
      input([candidate("same-project")], {
        executionOccupancy: [
          occupancy("one", { projectId: "project-a", provider: "codex" }),
          occupancy("two", { projectId: "project-a", provider: "claude" }),
        ],
        slotLimits: limits({
          globalModelJobs: 4,
          perProviderModelJobs: { codex: 3, claude: 3, gemini: 1 },
          perProjectModelJobs: 2,
        }),
      }),
    );

    expect(decision).toMatchObject({
      kind: "waiting",
      reason: "no_dispatchable_candidate",
      skipped: [{ candidateId: "same-project", blocker: { code: "project_model_slot_full" } }],
    });
  });

  it("does not preempt or reroute an active assignment when a primary recovers", () => {
    const running = occupancy("existing", { provider: "claude" });
    const decision = decideNextDispatch(
      input([candidate("new", { repositoryId: "new-repo" })], {
        executionOccupancy: [running],
      }),
    );

    expect(running.provider).toBe("claude");
    expect(decision).toMatchObject({
      kind: "selected",
      candidate: { id: "new" },
      model: { candidate: { provider: "codex" } },
    });
  });
});

describe("repository concurrency", () => {
  it("keeps a waiting work line reserved without consuming a model slot", () => {
    const decision = decideNextDispatch(
      input(
        [
          candidate("blocked", {
            repositoryId: "shared",
            declaredRegions: [{ path: "src/world", coverage: "subtree" }],
          }),
          candidate("safe", {
            repositoryId: "shared",
            declaredRegions: [{ path: "src/tank", coverage: "subtree" }],
          }),
        ],
        {
          executionOccupancy: [],
          repositoryReservations: [
            reservation("ci-waiting", {
              repositoryId: "shared",
              stage: "ci",
              declaredRegions: [{ path: "src/world", coverage: "subtree" }],
            }),
          ],
        },
      ),
    );

    expect(decision).toMatchObject({
      kind: "selected",
      candidate: { id: "safe" },
      skipped: [{ candidateId: "blocked", blocker: { code: "repository_scope_conflict" } }],
    });
  });

  it("allows declared non-overlapping exact regions in the same repository", () => {
    const decision = decideNextDispatch(
      input(
        [
          candidate("next", {
            repositoryId: "shared",
            declaredRegions: [{ path: "src/next.ts", coverage: "exact" }],
          }),
        ],
        {
          repositoryReservations: [
            reservation("running", {
              repositoryId: "shared",
              declaredRegions: [{ path: "src/running.ts", coverage: "exact" }],
            }),
          ],
          slotLimits: limits({
            globalModelJobs: 3,
            perProviderModelJobs: { codex: 2, claude: 1, gemini: 1 },
          }),
        },
      ),
    );

    expect(decision).toMatchObject({ kind: "selected", candidate: { id: "next" } });
  });

  it("serializes overlapping subtree regions", () => {
    const decision = decideNextDispatch(
      input(
        [
          candidate("next", {
            repositoryId: "shared",
            declaredRegions: [{ path: "src/domain/file.ts", coverage: "exact" }],
          }),
        ],
        {
          repositoryReservations: [
            reservation("running", {
              repositoryId: "shared",
              declaredRegions: [{ path: "src/domain", coverage: "subtree" }],
            }),
          ],
          slotLimits: limits({
            globalModelJobs: 3,
            perProviderModelJobs: { codex: 2, claude: 1, gemini: 1 },
          }),
        },
      ),
    );

    expect(decision).toMatchObject({
      kind: "waiting",
      skipped: [
        {
          blocker: {
            code: "repository_scope_conflict",
            repositoryId: "shared",
            activeJobId: "running",
          },
        },
      ],
    });
  });

  it("fails closed when either side lacks declared regions", () => {
    const decision = decideNextDispatch(
      input([candidate("unknown", { repositoryId: "shared", declaredRegions: undefined })], {
        repositoryReservations: [
          reservation("running", {
            repositoryId: "shared",
            declaredRegions: [{ path: "src/known.ts", coverage: "exact" }],
          }),
        ],
        slotLimits: limits({
          globalModelJobs: 3,
          perProviderModelJobs: { codex: 2, claude: 1, gemini: 1 },
        }),
      }),
    );

    expect(decision).toMatchObject({
      kind: "waiting",
      skipped: [{ blocker: { code: "repository_scope_conflict" } }],
    });
  });

  it("keeps integration and merge stages exclusive for a repository", () => {
    const decision = decideNextDispatch(
      input(
        [
          candidate("merge", {
            repositoryId: "shared",
            role: "integration_engineer",
            stage: "merge",
          }),
        ],
        {
          executionOccupancy: [occupancy("integration", { provider: "claude" })],
          repositoryReservations: [
            reservation("integration", {
              repositoryId: "shared",
              stage: "integration",
            }),
          ],
          slotLimits: limits({
            perProviderModelJobs: { codex: 1, claude: 2, gemini: 1 },
          }),
        },
      ),
    );

    expect(decision).toMatchObject({
      kind: "waiting",
      skipped: [{ blocker: { code: "repository_integration_slot_full" } }],
    });
  });
});

describe("fail-closed input and blocked candidate handling", () => {
  it("continues after a blocked higher-ranked candidate", () => {
    const decision = decideNextDispatch(
      input(
        [
          candidate("blocked", {
            projectId: "project-blocked",
            repositoryId: "shared",
            priority: "urgent",
            declaredRegions: undefined,
          }),
          candidate("safe", {
            projectId: "project-safe",
            repositoryId: "safe-repo",
            priority: "high",
          }),
        ],
        {
          repositoryReservations: [reservation("running", { repositoryId: "shared" })],
          slotLimits: limits({
            globalModelJobs: 3,
            perProviderModelJobs: { codex: 2, claude: 1, gemini: 1 },
          }),
        },
      ),
    );

    expect(decision).toMatchObject({
      kind: "selected",
      candidate: { id: "safe" },
      skipped: [{ candidateId: "blocked", blocker: { code: "repository_scope_conflict" } }],
    });
  });

  it("reports provider routing failures without consuming a slot", () => {
    const observations = readyObservations.map((observation) =>
      observation.provider === "codex" || observation.provider === "claude"
        ? { ...observation, state: "quota_unknown" as const }
        : observation,
    );
    const decision = decideNextDispatch(
      input([candidate("blocked")], { routeObservations: observations }),
    );

    expect(decision).toMatchObject({
      kind: "waiting",
      reason: "no_dispatchable_candidate",
      skipped: [
        {
          blocker: {
            code: "provider_route_unavailable",
            skipped: [{ state: "quota_unknown" }, { state: "quota_unknown" }],
          },
        },
      ],
    });
  });

  it.each([
    {},
    {
      candidates: [],
      executionOccupancy: [],
      repositoryReservations: [],
      routingConfig,
      routeObservations: [],
      unknown: true,
    },
    input([candidate("duplicate"), candidate("duplicate")]),
    input([candidate("bad-time", { readyAt: "not-a-time" })]),
    input([
      candidate("bad-mechanical", {
        workKind: "mechanical",
        stage: "implementation",
      }),
    ]),
  ])("rejects malformed input instead of guessing: %#", (invalidInput) => {
    expect(decideNextDispatch(invalidInput)).toEqual({
      kind: "waiting",
      reason: "invalid_input",
      skipped: [],
    });
  });

  it("distinguishes an empty queue from a fully blocked queue", () => {
    expect(decideNextDispatch(input([]))).toEqual({
      kind: "waiting",
      reason: "no_candidates",
      skipped: [],
    });
  });
});
