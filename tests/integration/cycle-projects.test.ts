import { describe, expect, it, vi } from "vitest";

import {
  createNoopControllerCycleStages,
  runControllerCycleStages,
  type ControllerCycleStage,
  type ControllerCycleStageContext,
} from "../../src/cli/cycle/index.js";
import {
  createManualReconcileControllerCycleStage,
  createRegisteredProjectsControllerCycleStage,
} from "../../src/cli/cycle/projects.js";
import type { CliHandlers } from "../../src/cli/program.js";
import type { ProjectReadModel } from "../../src/cli/project/index.js";
import { projectListPayloadSchema } from "../../src/cli/project/schema.js";

const projectA = "project_00000000-0000-4000-8000-000000000001";
const projectB = "project_00000000-0000-4000-8000-000000000002";
const projectC = "project_00000000-0000-4000-8000-000000000003";
const projectD = "project_00000000-0000-4000-8000-000000000004";

function registeredProject(id: string, displayName = "Registered project") {
  return {
    id,
    displayName,
    registration: {
      state: "registered" as const,
      reason: "trusted_config_verified" as const,
      trustedConfigRevision: "a".repeat(40),
    },
    nonTerminalProgressCount: null,
    activeLeaseCount: null,
  };
}

function incompleteProject(
  id: string,
  reason:
    | "registration_draft_conflict"
    | "trusted_config_invalid"
    | "activation_invalid"
    | "trusted_config_unavailable",
) {
  return {
    id,
    displayName: "Untrusted project",
    registration:
      reason !== "trusted_config_unavailable"
        ? { state: "configuration_incomplete" as const, reason }
        : { state: "unknown" as const, reason },
    nonTerminalProgressCount: null,
    activeLeaseCount: null,
  };
}

function availableList(
  projects: readonly unknown[],
  state: "completed" | "degraded" = "completed",
  rejectedDraftCount = 0,
) {
  return projectListPayloadSchema.parse({
    operation: "project_list",
    schemaVersion: 1,
    state,
    inventory: { state: "available", rejectedDraftCount },
    projects,
  });
}

function unavailableList() {
  return projectListPayloadSchema.parse({
    operation: "project_list",
    schemaVersion: 1,
    state: "degraded",
    inventory: {
      state: "unavailable",
      rejectedDraftCount: 0,
      reason: "registration_drafts_unavailable",
    },
    projects: [],
  });
}

function projectModel(payload: unknown): Pick<ProjectReadModel, "read"> {
  return {
    read: vi.fn(() =>
      Promise.resolve({
        state: "success" as const,
        payload: payload as Readonly<Record<string, unknown>>,
      }),
    ),
  };
}

function stageContext(signal = new AbortController().signal): ControllerCycleStageContext {
  return Object.freeze({ signal });
}

function withProjects(
  projects: ControllerCycleStage,
): ReturnType<typeof createNoopControllerCycleStages> {
  return Object.freeze({ ...createNoopControllerCycleStages(), projects });
}

function withReconcile(
  reconcile: ControllerCycleStage,
  projects: ControllerCycleStage,
): ReturnType<typeof createNoopControllerCycleStages> {
  return Object.freeze({ ...createNoopControllerCycleStages(), reconcile, projects });
}

function emptyProjectCounts() {
  return { registered: 0, attempted: 0, completed: 0, degraded: 0, failed: 0 };
}

describe("C03 registered-projects Controller cycle stage", () => {
  it.each([
    ["unavailable inventory", unavailableList(), "inventory_unavailable"],
    ["schema-invalid payload", { operation: "not_project_list" }, "inventory_invalid"],
    [
      "duplicate project IDs",
      availableList([registeredProject(projectA, "first"), registeredProject(projectA, "second")]),
      "inventory_invalid",
    ],
    [
      "rejected draft with a trusted registered sibling",
      availableList([registeredProject(projectA)], "degraded", 1),
      "inventory_invalid",
    ],
  ] as const)("fails closed with zero run for %s", async (_name, payload, reasonCode) => {
    const run = vi.fn<CliHandlers["run"]>();
    const stage = createRegisteredProjectsControllerCycleStage({
      projectReadModel: projectModel(payload),
      run,
    });

    const result = await runControllerCycleStages(
      withProjects(stage),
      new AbortController().signal,
    );

    expect(run).not.toHaveBeenCalled();
    expect(result).toEqual({
      state: "failed",
      reasonCode: "stage_failed",
      stageCounts: { completed: 3, degraded: 0, failed: 1 },
      stageOutcomes: [
        { stage: "webhook_health", state: "completed" },
        { stage: "inbox", state: "completed" },
        { stage: "reconcile", state: "completed" },
        {
          stage: "projects",
          state: "failed",
          counts: emptyProjectCounts(),
          projects: [],
          reasonCode,
        },
      ],
    });
  });

  it.each(["failed project reader", "throwing project reader"] as const)(
    "fails closed with zero run for a %s",
    async (kind) => {
      const run = vi.fn<CliHandlers["run"]>();
      const projectReadModel: Pick<ProjectReadModel, "read"> = {
        read: vi.fn(() =>
          kind === "throwing project reader"
            ? Promise.reject(new Error("private inventory failure"))
            : Promise.resolve({
                state: "failed" as const,
                payload: { operation: "project_detail", private: "private inventory failure" },
              }),
        ),
      };
      const stage = createRegisteredProjectsControllerCycleStage({ projectReadModel, run });

      const result = await runControllerCycleStages(
        withProjects(stage),
        new AbortController().signal,
      );

      expect(run).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        state: "failed",
        reasonCode: "stage_failed",
        stageOutcomes: [
          { stage: "webhook_health", state: "completed" },
          { stage: "inbox", state: "completed" },
          { stage: "reconcile", state: "completed" },
          {
            stage: "projects",
            state: "failed",
            counts: emptyProjectCounts(),
            projects: [],
            reasonCode: "inventory_unavailable",
          },
        ],
      });
      expect(JSON.stringify(result)).not.toContain("private inventory failure");
    },
  );

  it("filters only trusted registrations, ignores list degradation, and invokes existing run once in stable order", async () => {
    const run = vi.fn<CliHandlers["run"]>(({ projectId }) =>
      Promise.resolve(
        projectId === projectB
          ? { state: "blocked" as const, message: "private handler message" }
          : { state: "success" as const, message: "private handler message" },
      ),
    );
    const stage = createRegisteredProjectsControllerCycleStage({
      projectReadModel: projectModel(
        availableList(
          [
            registeredProject(projectB, "private display B"),
            incompleteProject(projectC, "activation_invalid"),
            registeredProject(projectA, "private display A"),
            incompleteProject(
              "project_00000000-0000-4000-8000-000000000004",
              "trusted_config_unavailable",
            ),
          ],
          "degraded",
        ),
      ),
      run,
    });

    const result = await runControllerCycleStages(
      withProjects(stage),
      new AbortController().signal,
    );

    expect(run.mock.calls.map(([input]) => input.projectId)).toEqual([projectA, projectB]);
    expect(run.mock.calls.map(([input]) => input)).toEqual([
      { projectId: projectA },
      { projectId: projectB },
    ]);
    expect(result).toEqual({
      state: "degraded",
      stageCounts: { completed: 3, degraded: 1, failed: 0 },
      stageOutcomes: [
        { stage: "webhook_health", state: "completed" },
        { stage: "inbox", state: "completed" },
        { stage: "reconcile", state: "completed" },
        {
          stage: "projects",
          state: "degraded",
          counts: { registered: 2, attempted: 2, completed: 1, degraded: 1, failed: 0 },
          projects: [
            { projectId: projectA, state: "completed" },
            { projectId: projectB, state: "degraded", reasonCode: "run_blocked" },
          ],
        },
      ],
    });
    const rendered = JSON.stringify(result);
    expect(rendered).not.toContain("private display");
    expect(rendered).not.toContain("private handler message");
  });

  it("skips every incomplete or unknown registration without dispatching a run", async () => {
    const run = vi.fn<CliHandlers["run"]>();
    const stage = createRegisteredProjectsControllerCycleStage({
      projectReadModel: projectModel(
        availableList([
          incompleteProject(projectA, "registration_draft_conflict"),
          incompleteProject(projectB, "trusted_config_invalid"),
          incompleteProject(projectC, "activation_invalid"),
          incompleteProject(projectD, "trusted_config_unavailable"),
        ]),
      ),
      run,
    });

    const result = await runControllerCycleStages(
      withProjects(stage),
      new AbortController().signal,
    );

    expect(run).not.toHaveBeenCalled();
    expect(result).toEqual({
      state: "completed",
      stageCounts: { completed: 4, degraded: 0, failed: 0 },
      stageOutcomes: [
        { stage: "webhook_health", state: "completed" },
        { stage: "inbox", state: "completed" },
        { stage: "reconcile", state: "completed" },
        {
          stage: "projects",
          state: "completed",
          counts: emptyProjectCounts(),
          projects: [],
        },
      ],
    });
  });

  it("isolates thrown, failed, rejected, and successful project runs without reflecting private handler data", async () => {
    const run = vi.fn<CliHandlers["run"]>(({ projectId }) => {
      if (projectId === projectA)
        return Promise.reject(new Error("https://private.example/secret"));
      if (projectId === projectB)
        return Promise.resolve({
          state: "rejected" as const,
          message: "issue private-title delivery secret",
        });
      if (projectId === projectC)
        return Promise.resolve({ state: "failed" as const, message: "private failure" });
      return Promise.resolve({ state: "success" as const, message: "private handler message" });
    });
    const stage = createRegisteredProjectsControllerCycleStage({
      projectReadModel: projectModel(
        availableList([
          registeredProject(projectD),
          registeredProject(projectA),
          registeredProject(projectB),
          registeredProject(projectC),
        ]),
      ),
      run,
    });

    const result = await runControllerCycleStages(
      withProjects(stage),
      new AbortController().signal,
    );

    expect(run.mock.calls.map(([input]) => input.projectId)).toEqual([
      projectA,
      projectB,
      projectC,
      projectD,
    ]);
    expect(result).toEqual({
      state: "degraded",
      stageCounts: { completed: 3, degraded: 1, failed: 0 },
      stageOutcomes: [
        { stage: "webhook_health", state: "completed" },
        { stage: "inbox", state: "completed" },
        { stage: "reconcile", state: "completed" },
        {
          stage: "projects",
          state: "degraded",
          counts: { registered: 4, attempted: 4, completed: 1, degraded: 0, failed: 3 },
          projects: [
            { projectId: projectA, state: "failed", reasonCode: "run_failed" },
            { projectId: projectB, state: "failed", reasonCode: "run_rejected" },
            { projectId: projectC, state: "failed", reasonCode: "run_failed" },
            { projectId: projectD, state: "completed" },
          ],
        },
      ],
    });
    const rendered = JSON.stringify(result);
    expect(rendered).not.toContain("private.example");
    expect(rendered).not.toContain("private-title");
    expect(rendered).not.toContain("secret");
  });

  it("stops before a next project for handler interruption and preserves the fixed interrupted summary", async () => {
    const run = vi.fn<CliHandlers["run"]>(() =>
      Promise.resolve({ state: "interrupted" as const, message: "private interruption" }),
    );
    const stage = createRegisteredProjectsControllerCycleStage({
      projectReadModel: projectModel(
        availableList([
          registeredProject(projectC),
          registeredProject(projectA),
          registeredProject(projectB),
        ]),
      ),
      run,
    });

    const result = await runControllerCycleStages(
      withProjects(stage),
      new AbortController().signal,
    );

    expect(run.mock.calls.map(([input]) => input.projectId)).toEqual([projectA]);
    expect(result).toEqual({
      state: "degraded",
      stageCounts: { completed: 3, degraded: 1, failed: 0 },
      stageOutcomes: [
        { stage: "webhook_health", state: "completed" },
        { stage: "inbox", state: "completed" },
        { stage: "reconcile", state: "completed" },
        {
          stage: "projects",
          state: "degraded",
          counts: { registered: 3, attempted: 1, completed: 0, degraded: 1, failed: 0 },
          projects: [{ projectId: projectA, state: "degraded", reasonCode: "run_interrupted" }],
          reasonCode: "project_iteration_interrupted",
        },
      ],
    });
  });

  it("does not start a next project after SIGINT/SIGTERM signal aborts during a run", async () => {
    const controller = new AbortController();
    const run = vi.fn<CliHandlers["run"]>(() => {
      controller.abort();
      return Promise.resolve({ state: "success" as const, message: "private handler message" });
    });
    const stage = createRegisteredProjectsControllerCycleStage({
      projectReadModel: projectModel(
        availableList([registeredProject(projectA), registeredProject(projectB)]),
      ),
      run,
    });

    const result = await runControllerCycleStages(withProjects(stage), controller.signal);

    expect(run.mock.calls.map(([input]) => input.projectId)).toEqual([projectA]);
    expect(result).toEqual({
      state: "interrupted",
      stageCounts: { completed: 3, degraded: 1, failed: 0 },
      stageOutcomes: [
        { stage: "webhook_health", state: "completed" },
        { stage: "inbox", state: "completed" },
        { stage: "reconcile", state: "completed" },
        {
          stage: "projects",
          state: "degraded",
          counts: { registered: 2, attempted: 1, completed: 1, degraded: 0, failed: 0 },
          projects: [{ projectId: projectA, state: "completed" }],
          reasonCode: "project_iteration_interrupted",
        },
      ],
    });
  });

  it("maps reconcile only from the existing closed CLI state and allows a blocked reconcile to continue projects", async () => {
    const order: string[] = [];
    const reconcile = createManualReconcileControllerCycleStage({
      reconcile: () => {
        order.push("reconcile");
        return Promise.resolve({
          state: "blocked" as const,
          message: "https://private.example/raw-reconcile-error",
        });
      },
    });
    const projects = createRegisteredProjectsControllerCycleStage({
      projectReadModel: projectModel(availableList([registeredProject(projectA)])),
      run: () => {
        order.push("run:registered");
        return Promise.resolve({ state: "success" as const, message: "private run message" });
      },
    });

    const result = await runControllerCycleStages(
      withReconcile(reconcile, projects),
      new AbortController().signal,
    );

    expect(order).toEqual(["reconcile", "run:registered"]);
    expect(result).toEqual({
      state: "degraded",
      stageCounts: { completed: 3, degraded: 1, failed: 0 },
      stageOutcomes: [
        { stage: "webhook_health", state: "completed" },
        { stage: "inbox", state: "completed" },
        { stage: "reconcile", state: "degraded" },
        {
          stage: "projects",
          state: "completed",
          counts: { registered: 1, attempted: 1, completed: 1, degraded: 0, failed: 0 },
          projects: [{ projectId: projectA, state: "completed" }],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("private.example");
  });

  it("fails reconcile closed and never starts projects for failed, rejected, interrupted, throw, or invalid outcome", async () => {
    const candidates: readonly unknown[] = [
      { state: "failed", message: "private" },
      { state: "rejected", message: "private" },
      { state: "interrupted", message: "private" },
      { state: "not_a_cli_outcome" },
      new Error("throw"),
    ];
    for (const candidate of candidates) {
      const projectsRan = vi.fn();
      const reconcile = createManualReconcileControllerCycleStage({
        reconcile: () =>
          candidate instanceof Error
            ? Promise.reject(candidate)
            : Promise.resolve(candidate as Awaited<ReturnType<CliHandlers["reconcile"]>>),
      });
      const projects: ControllerCycleStage = Object.freeze({
        id: "projects",
        run: () => {
          projectsRan();
          return Promise.resolve(Object.freeze({ state: "completed" as const }));
        },
      });

      const result = await runControllerCycleStages(
        withReconcile(reconcile, projects),
        new AbortController().signal,
      );

      expect(projectsRan).not.toHaveBeenCalled();
      expect(result).toEqual({
        state: "failed",
        reasonCode: "stage_failed",
        stageCounts: { completed: 2, degraded: 0, failed: 1 },
        stageOutcomes: [
          { stage: "webhook_health", state: "completed" },
          { stage: "inbox", state: "completed" },
          { stage: "reconcile", state: "failed" },
        ],
      });
    }
  });

  it.each([
    [
      "contradictory counts",
      {
        state: "completed",
        projects: {
          counts: { registered: 1, attempted: 1, completed: 0, degraded: 0, failed: 0 },
          projects: [{ projectId: projectA, state: "completed" }],
        },
      },
    ],
    [
      "duplicate project IDs",
      {
        state: "completed",
        projects: {
          counts: { registered: 2, attempted: 2, completed: 2, degraded: 0, failed: 0 },
          projects: [
            { projectId: projectA, state: "completed" },
            { projectId: projectA, state: "completed" },
          ],
        },
      },
    ],
    [
      "unstable project ordering",
      {
        state: "completed",
        projects: {
          counts: { registered: 2, attempted: 2, completed: 2, degraded: 0, failed: 0 },
          projects: [
            { projectId: projectB, state: "completed" },
            { projectId: projectA, state: "completed" },
          ],
        },
      },
    ],
    [
      "completed state carrying an inventory reason",
      {
        state: "completed",
        projects: {
          counts: emptyProjectCounts(),
          projects: [],
          reasonCode: "inventory_invalid",
        },
      },
    ],
    [
      "degraded state without a non-completed project",
      {
        state: "degraded",
        projects: {
          counts: { registered: 1, attempted: 1, completed: 1, degraded: 0, failed: 0 },
          projects: [{ projectId: projectA, state: "completed" }],
        },
      },
    ],
    [
      "failed state without its exact inventory failure shape",
      {
        state: "failed",
        projects: {
          counts: emptyProjectCounts(),
          projects: [],
          reasonCode: "project_iteration_interrupted",
        },
      },
    ],
  ] as const)("fails closed before rendering a %s projects summary", async (_name, outcome) => {
    const malformed: ControllerCycleStage = Object.freeze({
      id: "projects",
      run: () => Promise.resolve(outcome as never),
    });

    const result = await runControllerCycleStages(
      withProjects(malformed),
      new AbortController().signal,
    );

    expect(result).toEqual({
      state: "failed",
      reasonCode: "stage_execution_failed",
      stageCounts: { completed: 3, degraded: 0, failed: 0 },
      stageOutcomes: [
        { stage: "webhook_health", state: "completed" },
        { stage: "inbox", state: "completed" },
        { stage: "reconcile", state: "completed" },
      ],
    });
  });

  it("uses only the public stage context signal", async () => {
    const stage = createRegisteredProjectsControllerCycleStage({
      projectReadModel: projectModel(availableList([])),
      run: vi.fn(),
    });

    await expect(stage.run(stageContext())).resolves.toEqual({
      state: "completed",
      projects: { counts: emptyProjectCounts(), projects: [] },
    });
  });
});
