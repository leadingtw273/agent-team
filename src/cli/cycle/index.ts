import { randomUUID } from "node:crypto";

import type { InboxProcessingFailureStage } from "../../application/inbox/index.js";
import { domainErrorDefinitions, type DomainErrorCode } from "../../domain/foundation/index.js";
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

export type ControllerCycleStageState = "completed" | "degraded" | "failed";

export type ControllerCycleInboxFailureStage = "source" | InboxProcessingFailureStage;

export interface ControllerCycleInboxFailure {
  readonly stage: ControllerCycleInboxFailureStage;
  readonly reasonCode: DomainErrorCode;
  readonly count: number;
}

export interface ControllerCycleInboxCounts {
  readonly discovered: number;
  readonly processed: number;
  readonly alreadyCompleted: number;
  readonly failed: number;
}

export interface ControllerCycleInboxSummary {
  readonly counts: ControllerCycleInboxCounts;
  readonly failures: readonly ControllerCycleInboxFailure[];
}

/**
 * Stages may return only their fixed state, except for the concrete Inbox stage which may attach
 * the typed, redacted summary below. The coordinator validates and re-materializes this shape
 * before it ever reaches a public payload.
 */
export type ControllerCycleStageOutcome = Readonly<
  | { state: ControllerCycleStageState }
  | { state: ControllerCycleStageState; inbox: ControllerCycleInboxSummary }
>;

export type ControllerCycleStageOutcomeReport = Readonly<
  | { stage: ControllerCycleStageId; state: ControllerCycleStageState }
  | {
      stage: "inbox";
      state: ControllerCycleStageState;
      counts: ControllerCycleInboxCounts;
      failures: readonly ControllerCycleInboxFailure[];
    }
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
  | {
      state: "completed";
      stageCounts: ControllerCycleStageCounts;
      stageOutcomes: readonly ControllerCycleStageOutcomeReport[];
    }
  | {
      state: "degraded";
      stageCounts: ControllerCycleStageCounts;
      stageOutcomes: readonly ControllerCycleStageOutcomeReport[];
    }
  | {
      state: "interrupted";
      stageCounts: ControllerCycleStageCounts;
      stageOutcomes: readonly ControllerCycleStageOutcomeReport[];
    }
  | { state: "already_running" }
  | {
      state: "failed";
      reasonCode: ControllerCycleFailureCode;
      stageCounts: ControllerCycleStageCounts;
      stageOutcomes: readonly ControllerCycleStageOutcomeReport[];
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
  state: ControllerCycleStageState,
): ControllerCycleStageCounts {
  return Object.freeze({ ...counts, [state]: counts[state] + 1 });
}

function isPlainDataRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => "value" in descriptor,
  );
}

function hasExactOwnKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isStageState(value: unknown): value is ControllerCycleStageState {
  return value === "completed" || value === "degraded" || value === "failed";
}

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function sumSafeCounts(values: readonly number[]): number | undefined {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) return undefined;
  }
  return total;
}

function isInboxFailureStage(value: unknown): value is ControllerCycleInboxFailureStage {
  return (
    value === "source" ||
    value === "projection" ||
    value === "completion_read" ||
    value === "event_append" ||
    value === "use_case" ||
    value === "completion_write"
  );
}

function isDomainErrorCode(value: unknown): value is DomainErrorCode {
  return typeof value === "string" && Object.hasOwn(domainErrorDefinitions, value);
}

function compareInboxFailures(
  left: ControllerCycleInboxFailure,
  right: ControllerCycleInboxFailure,
): number {
  if (left.stage !== right.stage) return left.stage < right.stage ? -1 : 1;
  if (left.reasonCode !== right.reasonCode) return left.reasonCode < right.reasonCode ? -1 : 1;
  return 0;
}

function isCanonicalSourceFailure(
  counts: ControllerCycleInboxCounts,
  failures: readonly ControllerCycleInboxFailure[],
): boolean {
  const failure = failures.at(0);
  return (
    counts.discovered === 0 &&
    counts.processed === 0 &&
    counts.alreadyCompleted === 0 &&
    counts.failed === 1 &&
    failures.length === 1 &&
    failure?.stage === "source" &&
    failure.count === 1
  );
}

function readInboxSummary(value: unknown): ControllerCycleInboxSummary | undefined {
  if (!isPlainDataRecord(value) || !hasExactOwnKeys(value, ["counts", "failures"]))
    return undefined;
  if (!isPlainDataRecord(value["counts"]) || !Array.isArray(value["failures"])) return undefined;

  const counts = value["counts"];
  if (
    !hasExactOwnKeys(counts, ["discovered", "processed", "alreadyCompleted", "failed"]) ||
    !isSafeCount(counts["discovered"]) ||
    !isSafeCount(counts["processed"]) ||
    !isSafeCount(counts["alreadyCompleted"]) ||
    !isSafeCount(counts["failed"])
  ) {
    return undefined;
  }

  const failures: ControllerCycleInboxFailure[] = [];
  for (const candidate of value["failures"]) {
    if (
      !isPlainDataRecord(candidate) ||
      !hasExactOwnKeys(candidate, ["stage", "reasonCode", "count"])
    ) {
      return undefined;
    }
    if (
      !isInboxFailureStage(candidate["stage"]) ||
      !isDomainErrorCode(candidate["reasonCode"]) ||
      !isSafeCount(candidate["count"]) ||
      candidate["count"] === 0
    ) {
      return undefined;
    }
    failures.push(
      Object.freeze({
        stage: candidate["stage"],
        reasonCode: candidate["reasonCode"],
        count: candidate["count"],
      }),
    );
  }
  const parsedCounts: ControllerCycleInboxCounts = Object.freeze({
    discovered: counts["discovered"],
    processed: counts["processed"],
    alreadyCompleted: counts["alreadyCompleted"],
    failed: counts["failed"],
  });
  const failureTotal = sumSafeCounts(failures.map((failure) => failure.count));
  const completedTotal = sumSafeCounts([
    parsedCounts.processed,
    parsedCounts.alreadyCompleted,
    parsedCounts.failed,
  ]);
  if (
    failureTotal === undefined ||
    failureTotal !== parsedCounts.failed ||
    completedTotal === undefined ||
    (!isCanonicalSourceFailure(parsedCounts, failures) &&
      completedTotal !== parsedCounts.discovered) ||
    failures.some((failure, index) => {
      const previous = index === 0 ? undefined : failures.at(index - 1);
      return previous !== undefined && compareInboxFailures(previous, failure) >= 0;
    })
  ) {
    return undefined;
  }
  return Object.freeze({
    counts: parsedCounts,
    failures: Object.freeze(failures),
  });
}

function toStageOutcomeReport(
  stage: ControllerCycleStageId,
  value: unknown,
): ControllerCycleStageOutcomeReport | undefined {
  if (!isPlainDataRecord(value) || !isStageState(value["state"])) return undefined;
  if (hasExactOwnKeys(value, ["state"])) {
    return Object.freeze({ stage, state: value["state"] });
  }
  if (stage !== "inbox" || !hasExactOwnKeys(value, ["state", "inbox"])) return undefined;
  const inbox = readInboxSummary(value["inbox"]);
  const sourceFailure =
    inbox !== undefined && isCanonicalSourceFailure(inbox.counts, inbox.failures);
  if (
    inbox === undefined ||
    (value["state"] === "completed" && inbox.counts.failed !== 0) ||
    (value["state"] !== "completed" && inbox.counts.failed === 0) ||
    (sourceFailure && value["state"] !== "failed") ||
    (!sourceFailure && value["state"] === "failed")
  ) {
    return undefined;
  }
  return Object.freeze({
    stage: "inbox",
    state: value["state"],
    counts: inbox.counts,
    failures: inbox.failures,
  });
}

function orderedStages(stages: ControllerCycleStages): readonly ControllerCycleStage[] {
  return Object.freeze([stages.webhookHealth, stages.inbox, stages.reconcile, stages.projects]);
}

function interrupted(
  stageCounts: ControllerCycleStageCounts,
  stageOutcomes: readonly ControllerCycleStageOutcomeReport[],
): ControllerCycleResult {
  return Object.freeze({
    state: "interrupted",
    stageCounts,
    stageOutcomes: Object.freeze(stageOutcomes),
  });
}

function failed(
  reasonCode: ControllerCycleFailureCode,
  stageCounts: ControllerCycleStageCounts,
  stageOutcomes: readonly ControllerCycleStageOutcomeReport[],
): ControllerCycleResult {
  return Object.freeze({
    state: "failed",
    reasonCode,
    stageCounts,
    stageOutcomes: Object.freeze(stageOutcomes),
  });
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
  const stageOutcomes: ControllerCycleStageOutcomeReport[] = [];
  if (!verifyStageOrder(sequence))
    return failed("stage_execution_failed", stageCounts, stageOutcomes);

  for (const stage of sequence) {
    if (isInterrupted(signal)) return interrupted(stageCounts, stageOutcomes);
    let stageOutcome: unknown;
    try {
      stageOutcome = await stage.run(Object.freeze({ signal }));
    } catch {
      return failed("stage_execution_failed", stageCounts, stageOutcomes);
    }
    const report = toStageOutcomeReport(stage.id, stageOutcome);
    if (report === undefined) return failed("stage_execution_failed", stageCounts, stageOutcomes);
    stageCounts = incrementStageCount(stageCounts, report.state);
    stageOutcomes.push(report);
    if (report.state === "failed") return failed("stage_failed", stageCounts, stageOutcomes);
    if (isInterrupted(signal)) return interrupted(stageCounts, stageOutcomes);
  }

  return Object.freeze({
    state: stageCounts.degraded === 0 ? "completed" : "degraded",
    stageCounts,
    stageOutcomes: Object.freeze(stageOutcomes),
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
    "stageOutcomes" in result ? result.stageOutcomes : [],
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
  const emptyOutcomes: readonly ControllerCycleStageOutcomeReport[] = [];
  if (isInterrupted(options.signal)) return interrupted(emptyCounts, emptyOutcomes);

  let acquired: Awaited<ReturnType<ControllerCycleLockAcquirer>>;
  try {
    acquired = await options.acquireLock(options.agentTeamHome, options.holderId);
  } catch {
    return failed("lock_acquire_failed", emptyCounts, emptyOutcomes);
  }
  if (!acquired.ok) {
    return acquired.error.code === "conflict"
      ? Object.freeze({ state: "already_running" })
      : failed("lock_acquire_failed", emptyCounts, emptyOutcomes);
  }

  let result: ControllerCycleResult;
  try {
    result = await new ControllerCycleCoordinator(options.stages).run(options.signal);
  } catch {
    result = failed("stage_execution_failed", emptyCounts, emptyOutcomes);
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
          stageOutcomes: result.stageOutcomes,
        }),
      });
    case "degraded":
      return Object.freeze({
        state: "blocked",
        message: JSON.stringify({
          operation: "controller_cycle",
          state: "degraded",
          stageCounts: result.stageCounts,
          stageOutcomes: result.stageOutcomes,
        }),
      });
    case "interrupted":
      return Object.freeze({
        state: "interrupted",
        message: JSON.stringify({
          operation: "controller_cycle",
          state: "interrupted",
          stageCounts: result.stageCounts,
          stageOutcomes: result.stageOutcomes,
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
          stageOutcomes: result.stageOutcomes,
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
