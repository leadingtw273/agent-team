import type { CliHandlers } from "../program.js";
import type { ProjectReadModel } from "../project/index.js";
import { projectListPayloadSchema } from "../project/schema.js";

import type {
  ControllerCycleProjectRunOutcome,
  ControllerCycleProjectsCounts,
  ControllerCycleProjectsStageReasonCode,
  ControllerCycleProjectsSummary,
  ControllerCycleStage,
  ControllerCycleStageContext,
  ControllerCycleStageOutcome,
} from "./index.js";

export interface CreateManualReconcileControllerCycleStageOptions {
  readonly reconcile: CliHandlers["reconcile"];
}

export interface CreateRegisteredProjectsControllerCycleStageOptions {
  readonly projectReadModel: Pick<ProjectReadModel, "read">;
  readonly run: CliHandlers["run"];
}

function emptyCounts(): ControllerCycleProjectsCounts {
  return Object.freeze({ registered: 0, attempted: 0, completed: 0, degraded: 0, failed: 0 });
}

function inventoryFailure(
  reasonCode: Extract<
    ControllerCycleProjectsStageReasonCode,
    "inventory_unavailable" | "inventory_invalid"
  >,
): ControllerCycleStageOutcome {
  return Object.freeze({
    state: "failed",
    projects: Object.freeze({
      counts: emptyCounts(),
      projects: Object.freeze([]),
      reasonCode,
    }),
  });
}

function compareProjectId(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

async function readRegisteredProjectIds(model: Pick<ProjectReadModel, "read">): Promise<
  | Readonly<{ state: "ready"; projectIds: readonly string[] }>
  | Readonly<{
      state: "failed";
      reasonCode: Extract<
        ControllerCycleProjectsStageReasonCode,
        "inventory_unavailable" | "inventory_invalid"
      >;
    }>
> {
  let result: Awaited<ReturnType<ProjectReadModel["read"]>>;
  try {
    result = await model.read(Object.freeze({}));
  } catch {
    return Object.freeze({ state: "failed", reasonCode: "inventory_unavailable" });
  }
  let payload: unknown;
  try {
    const candidate: unknown = result;
    if (typeof candidate !== "object" || candidate === null) {
      return Object.freeze({ state: "failed", reasonCode: "inventory_unavailable" });
    }
    const record = candidate as Readonly<{ state?: unknown; payload?: unknown }>;
    if (record.state !== "success") {
      return Object.freeze({ state: "failed", reasonCode: "inventory_unavailable" });
    }
    payload = record.payload;
  } catch {
    return Object.freeze({ state: "failed", reasonCode: "inventory_unavailable" });
  }

  let parsed: ReturnType<typeof projectListPayloadSchema.safeParse>;
  try {
    parsed = projectListPayloadSchema.safeParse(payload);
  } catch {
    return Object.freeze({ state: "failed", reasonCode: "inventory_invalid" });
  }
  if (!parsed.success) return Object.freeze({ state: "failed", reasonCode: "inventory_invalid" });
  if (parsed.data.inventory.state !== "available")
    return Object.freeze({ state: "failed", reasonCode: "inventory_unavailable" });
  if (parsed.data.inventory.rejectedDraftCount !== 0)
    return Object.freeze({ state: "failed", reasonCode: "inventory_invalid" });

  const allProjectIds = new Set<string>();
  for (const project of parsed.data.projects) {
    if (allProjectIds.has(project.id))
      return Object.freeze({ state: "failed", reasonCode: "inventory_invalid" });
    allProjectIds.add(project.id);
  }
  const projectIds = parsed.data.projects
    .filter(
      (project) =>
        project.registration.state === "registered" &&
        project.registration.reason === "trusted_config_verified" &&
        project.registration.trustedConfigRevision !== undefined,
    )
    .map((project) => project.id)
    .sort(compareProjectId);
  return Object.freeze({ state: "ready", projectIds: Object.freeze(projectIds) });
}

function projectRunOutcome(projectId: string, outcome: unknown): ControllerCycleProjectRunOutcome {
  try {
    const state = (outcome as Readonly<{ state?: unknown }>).state;
    switch (state) {
      case "success":
        return Object.freeze({ projectId, state: "completed" });
      case "blocked":
        return Object.freeze({ projectId, state: "degraded", reasonCode: "run_blocked" });
      case "interrupted":
        return Object.freeze({ projectId, state: "degraded", reasonCode: "run_interrupted" });
      case "rejected":
        return Object.freeze({ projectId, state: "failed", reasonCode: "run_rejected" });
      case "failed":
      default:
        return Object.freeze({ projectId, state: "failed", reasonCode: "run_failed" });
    }
  } catch {
    return Object.freeze({ projectId, state: "failed", reasonCode: "run_failed" });
  }
}

function countsFor(
  registered: number,
  projects: readonly ControllerCycleProjectRunOutcome[],
): ControllerCycleProjectsCounts {
  let completed = 0;
  let degraded = 0;
  let failed = 0;
  for (const project of projects) {
    if (project.state === "completed") completed += 1;
    else if (project.state === "degraded") degraded += 1;
    else failed += 1;
  }
  return Object.freeze({
    registered,
    attempted: projects.length,
    completed,
    degraded,
    failed,
  });
}

function projectsOutcome(
  registered: number,
  projects: readonly ControllerCycleProjectRunOutcome[],
): ControllerCycleStageOutcome {
  const counts = countsFor(registered, projects);
  const iterationInterrupted = counts.attempted < counts.registered;
  const state =
    iterationInterrupted || counts.degraded > 0 || counts.failed > 0 ? "degraded" : "completed";
  const summary: ControllerCycleProjectsSummary = Object.freeze({
    counts,
    projects: Object.freeze([...projects]),
    ...(iterationInterrupted ? { reasonCode: "project_iteration_interrupted" as const } : {}),
  });
  return Object.freeze({ state, projects: summary });
}

/**
 * Calls the existing manual-reconcile handler without inspecting its rendered JSON. The only
 * translation is the already-closed command outcome state into the cycle's three-state contract.
 */
export function createManualReconcileControllerCycleStage(
  options: CreateManualReconcileControllerCycleStageOptions,
): ControllerCycleStage {
  return Object.freeze({
    id: "reconcile",
    async run() {
      try {
        const result = await options.reconcile(Object.freeze({ all: true }));
        switch (result.state) {
          case "success":
            return Object.freeze({ state: "completed" });
          case "blocked":
            return Object.freeze({ state: "degraded" });
          case "failed":
          case "rejected":
          case "interrupted":
          default:
            return Object.freeze({ state: "failed" });
        }
      } catch {
        return Object.freeze({ state: "failed" });
      }
    },
  });
}

/**
 * Reads the strict public project-list projection, dispatches only trusted registered projects in
 * stable ID order, and keeps each run's private CLI payload outside the cycle's public summary.
 */
export function createRegisteredProjectsControllerCycleStage(
  options: CreateRegisteredProjectsControllerCycleStageOptions,
): ControllerCycleStage {
  return Object.freeze({
    id: "projects",
    async run(context: ControllerCycleStageContext) {
      const inventory = await readRegisteredProjectIds(options.projectReadModel);
      if (inventory.state === "failed") return inventoryFailure(inventory.reasonCode);

      const outcomes: ControllerCycleProjectRunOutcome[] = [];
      for (const projectId of inventory.projectIds) {
        if (isAborted(context.signal))
          return projectsOutcome(inventory.projectIds.length, outcomes);
        let result: unknown;
        try {
          result = await options.run(Object.freeze({ projectId }));
        } catch {
          result = Object.freeze({ state: "failed", message: "" });
        }
        const outcome = projectRunOutcome(projectId, result);
        outcomes.push(outcome);
        if (outcome.state === "degraded" && outcome.reasonCode === "run_interrupted")
          return projectsOutcome(inventory.projectIds.length, outcomes);
        if (isAborted(context.signal))
          return projectsOutcome(inventory.projectIds.length, outcomes);
      }
      return projectsOutcome(inventory.projectIds.length, outcomes);
    },
  });
}
