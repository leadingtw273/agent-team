import { randomUUID } from "node:crypto";

import type { CliCommandOutcome, CliHandlers } from "../program.js";
import {
  acquireControllerCycleLock,
  type ControllerCycleLockAcquirer,
  type ControllerCycleLockHandle,
} from "./lock.js";

export const controllerCycleStageIds = [
  "webhook_health",
  "inbox",
  "reconcile",
  "projects",
] as const;

export type ControllerCycleStageId = (typeof controllerCycleStageIds)[number];

export type ControllerCycleStageOutcome = Readonly<
  { state: "completed" } | { state: "degraded" } | { state: "failed" }
>;

export interface ControllerCycleStageContext {
  readonly signal: AbortSignal;
}

export interface ControllerCycleStage {
  readonly id: ControllerCycleStageId;
  readonly run: (context: ControllerCycleStageContext) => Promise<ControllerCycleStageOutcome>;
}

/**
 * The sequence is deliberately named, rather than supplied as an arbitrary array: later work
 * packages can replace one no-op without changing the Controller's fixed safety order.
 */
export interface ControllerCycleStages {
  readonly webhookHealth: ControllerCycleStage;
  readonly inbox: ControllerCycleStage;
  readonly reconcile: ControllerCycleStage;
  readonly projects: ControllerCycleStage;
}

export interface ControllerCycleStageCounts {
  readonly completed: number;
  readonly degraded: number;
  readonly failed: number;
}

export type ControllerCycleFailureCode =
  "lock_acquire_failed" | "lock_release_failed" | "stage_execution_failed" | "stage_failed";

export type ControllerCycleResult = Readonly<
  | { state: "completed"; stageCounts: ControllerCycleStageCounts }
  | { state: "degraded"; stageCounts: ControllerCycleStageCounts }
  | { state: "interrupted"; stageCounts: ControllerCycleStageCounts }
  | { state: "already_running" }
  | {
      state: "failed";
      reasonCode: ControllerCycleFailureCode;
      stageCounts: ControllerCycleStageCounts;
    }
>;

export interface ControllerCycleSignalScope {
  readonly signal: AbortSignal;
  dispose(): void;
}

export interface CreateControllerCycleHandlerOptions {
  readonly agentTeamHome: string;
  readonly stages?: ControllerCycleStages;
  readonly acquireLock?: ControllerCycleLockAcquirer;
  readonly createHolderId?: () => string;
  readonly createSignalScope?: () => ControllerCycleSignalScope;
}

interface ControllerCycleExecutionOptions {
  readonly agentTeamHome: string;
  readonly stages: ControllerCycleStages;
  readonly acquireLock: ControllerCycleLockAcquirer;
  readonly holderId: string;
  readonly signal: AbortSignal;
}

function completedStage(): ControllerCycleStageOutcome {
  return Object.freeze({ state: "completed" });
}

function createNoopStage(id: ControllerCycleStageId): ControllerCycleStage {
  return Object.freeze({
    id,
    run: () => Promise.resolve(completedStage()),
  });
}

export function createNoopControllerCycleStages(): ControllerCycleStages {
  return Object.freeze({
    webhookHealth: createNoopStage("webhook_health"),
    inbox: createNoopStage("inbox"),
    reconcile: createNoopStage("reconcile"),
    projects: createNoopStage("projects"),
  });
}

function createStageCounts(): ControllerCycleStageCounts {
  return { completed: 0, degraded: 0, failed: 0 };
}

function incrementStageCount(
  counts: ControllerCycleStageCounts,
  state: ControllerCycleStageOutcome["state"],
): ControllerCycleStageCounts {
  return Object.freeze({ ...counts, [state]: counts[state] + 1 });
}

function isStageOutcome(value: unknown): value is ControllerCycleStageOutcome {
  return (
    typeof value === "object" &&
    value !== null &&
    "state" in value &&
    ((value as { readonly state?: unknown }).state === "completed" ||
      (value as { readonly state?: unknown }).state === "degraded" ||
      (value as { readonly state?: unknown }).state === "failed")
  );
}

function orderedStages(stages: ControllerCycleStages): readonly ControllerCycleStage[] {
  return Object.freeze([stages.webhookHealth, stages.inbox, stages.reconcile, stages.projects]);
}

function interrupted(stageCounts: ControllerCycleStageCounts): ControllerCycleResult {
  return Object.freeze({ state: "interrupted", stageCounts });
}

function failed(
  reasonCode: ControllerCycleFailureCode,
  stageCounts: ControllerCycleStageCounts,
): ControllerCycleResult {
  return Object.freeze({ state: "failed", reasonCode, stageCounts });
}

function verifyStageOrder(stages: readonly ControllerCycleStage[]): boolean {
  return stages.every((stage, index) => stage.id === controllerCycleStageIds[index]);
}

function isInterrupted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/** Executes only the injectable stage contract. It contains no Inbox, provider, or project wiring. */
export async function runControllerCycleStages(
  stages: ControllerCycleStages,
  signal: AbortSignal,
): Promise<ControllerCycleResult> {
  const sequence = orderedStages(stages);
  let stageCounts = createStageCounts();
  if (!verifyStageOrder(sequence)) return failed("stage_execution_failed", stageCounts);

  for (const stage of sequence) {
    if (isInterrupted(signal)) return interrupted(stageCounts);
    let stageOutcome: unknown;
    try {
      stageOutcome = await stage.run(Object.freeze({ signal }));
    } catch {
      return failed("stage_execution_failed", stageCounts);
    }
    if (!isStageOutcome(stageOutcome)) return failed("stage_execution_failed", stageCounts);
    stageCounts = incrementStageCount(stageCounts, stageOutcome.state);
    if (stageOutcome.state === "failed") return failed("stage_failed", stageCounts);
    if (isInterrupted(signal)) return interrupted(stageCounts);
  }

  return Object.freeze({
    state: stageCounts.degraded === 0 ? "completed" : "degraded",
    stageCounts,
  });
}

/**
 * C01's typed, injectable coordinator. Its default stages are deliberately no-ops; C02/C03/H02
 * may replace those dependencies only after their own production compositions are approved.
 */
export class ControllerCycleCoordinator {
  readonly #stages: ControllerCycleStages;

  constructor(stages: ControllerCycleStages = createNoopControllerCycleStages()) {
    this.#stages = stages;
  }

  run(signal: AbortSignal): Promise<ControllerCycleResult> {
    return runControllerCycleStages(this.#stages, signal);
  }
}

async function release(
  lock: ControllerCycleLockHandle,
  result: ControllerCycleResult,
): Promise<ControllerCycleResult> {
  try {
    const released = await lock.release();
    if (released.ok) return result;
  } catch {
    // Unknown release state must never be rendered as a successful cycle.
  }
  return failed(
    "lock_release_failed",
    "stageCounts" in result ? result.stageCounts : createStageCounts(),
  );
}

/**
 * Acquires one short-lived global lock around the fixed Controller sequence. The only success
 * interpretation of a lock conflict is an independently verified, active owner.
 */
export async function executeControllerCycle(
  options: ControllerCycleExecutionOptions,
): Promise<ControllerCycleResult> {
  const emptyCounts = createStageCounts();
  if (isInterrupted(options.signal)) return interrupted(emptyCounts);

  let acquired: Awaited<ReturnType<ControllerCycleLockAcquirer>>;
  try {
    acquired = await options.acquireLock(options.agentTeamHome, options.holderId);
  } catch {
    return failed("lock_acquire_failed", emptyCounts);
  }
  if (!acquired.ok) {
    return acquired.error.code === "conflict"
      ? Object.freeze({ state: "already_running" })
      : failed("lock_acquire_failed", emptyCounts);
  }

  let result: ControllerCycleResult;
  try {
    result = await new ControllerCycleCoordinator(options.stages).run(options.signal);
  } catch {
    result = failed("stage_execution_failed", emptyCounts);
  }
  return release(acquired.value, result);
}

function createProcessSignalScope(): ControllerCycleSignalScope {
  const controller = new AbortController();
  const abort = () => {
    controller.abort();
  };
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  return Object.freeze({
    signal: controller.signal,
    dispose: () => {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    },
  });
}

function renderCycleResult(result: ControllerCycleResult): CliCommandOutcome {
  switch (result.state) {
    case "completed":
      return Object.freeze({
        state: "success",
        message: JSON.stringify({
          operation: "controller_cycle",
          state: "completed",
          stageCounts: result.stageCounts,
        }),
      });
    case "degraded":
      return Object.freeze({
        state: "blocked",
        message: JSON.stringify({
          operation: "controller_cycle",
          state: "degraded",
          stageCounts: result.stageCounts,
        }),
      });
    case "interrupted":
      return Object.freeze({
        state: "interrupted",
        message: JSON.stringify({
          operation: "controller_cycle",
          state: "interrupted",
          stageCounts: result.stageCounts,
        }),
      });
    case "already_running":
      return Object.freeze({
        state: "success",
        message: JSON.stringify({ operation: "controller_cycle", state: "already_running" }),
      });
    case "failed":
      return Object.freeze({
        state: "failed",
        message: JSON.stringify({
          operation: "controller_cycle",
          state: "failed",
          reasonCode: result.reasonCode,
          stageCounts: result.stageCounts,
        }),
      });
  }
}

export function createControllerCycleHandler(
  options: CreateControllerCycleHandlerOptions,
): CliHandlers["cycle"] {
  const stages = options.stages ?? createNoopControllerCycleStages();
  const acquireLock = options.acquireLock ?? acquireControllerCycleLock;
  const createHolderId = options.createHolderId ?? (() => `controller-cycle:${randomUUID()}`);
  const createSignalScope = options.createSignalScope ?? createProcessSignalScope;

  return async () => {
    const scope = createSignalScope();
    try {
      return renderCycleResult(
        await executeControllerCycle({
          agentTeamHome: options.agentTeamHome,
          stages,
          acquireLock,
          holderId: createHolderId(),
          signal: scope.signal,
        }),
      );
    } finally {
      scope.dispose();
    }
  };
}
