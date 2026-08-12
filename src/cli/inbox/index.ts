import { join } from "node:path";

import {
  InboxProcessor,
  type InboxProcessingFailureStage,
  type InboxProcessorOutcome,
  type InboxUseCaseRouter,
} from "../../application/inbox/index.js";
import {
  createClock,
  domainErrorDefinitions,
  ok,
  type Clock,
  type DomainErrorCode,
} from "../../domain/foundation/index.js";
import {
  DurableInbox,
  DurableInboxCompletionStore,
  JsonlEventStore,
} from "../../infrastructure/events/index.js";
import type {
  ControllerCycleInboxFailure,
  ControllerCycleInboxFailureStage,
  ControllerCycleInboxSummary,
  ControllerCycleStage,
  ControllerCycleStageOutcome,
} from "../cycle/index.js";

export interface InboxProcessorRunner {
  run(): Promise<InboxProcessorOutcome>;
}

export interface CreateProductionInboxControllerCycleStageOptions {
  readonly agentTeamHome: string;
  readonly clock?: Clock;
}

function isSafeCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
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

function safeReasonCode(value: unknown): DomainErrorCode {
  return typeof value === "string" && Object.hasOwn(domainErrorDefinitions, value)
    ? (value as DomainErrorCode)
    : "external_failure";
}

function sourceFailure(
  reasonCode: DomainErrorCode = "external_failure",
): ControllerCycleStageOutcome {
  return Object.freeze({
    state: "failed" as const,
    inbox: Object.freeze({
      counts: Object.freeze({ discovered: 0, processed: 0, alreadyCompleted: 0, failed: 1 }),
      failures: Object.freeze([Object.freeze({ stage: "source" as const, reasonCode, count: 1 })]),
    }),
  });
}

function compareFailures(
  left: ControllerCycleInboxFailure,
  right: ControllerCycleInboxFailure,
): number {
  if (left.stage !== right.stage) return left.stage < right.stage ? -1 : 1;
  if (left.reasonCode !== right.reasonCode) return left.reasonCode < right.reasonCode ? -1 : 1;
  return 0;
}

function groupFailures(
  failures: readonly Readonly<{
    stage: InboxProcessingFailureStage;
    error: Readonly<{ code: DomainErrorCode }>;
  }>[],
): readonly ControllerCycleInboxFailure[] | undefined {
  const grouped = new Map<string, ControllerCycleInboxFailure>();
  for (const failure of failures) {
    if (!isInboxFailureStage(failure.stage)) return undefined;
    const reasonCode = safeReasonCode(failure.error.code);
    const key = `${failure.stage}\u0000${reasonCode}`;
    const previous = grouped.get(key);
    grouped.set(
      key,
      Object.freeze({
        stage: failure.stage,
        reasonCode,
        count: (previous?.count ?? 0) + 1,
      }),
    );
  }
  return Object.freeze([...grouped.values()].sort(compareFailures));
}

function projectProcessedOutcome(
  outcome: Extract<InboxProcessorOutcome, Readonly<{ state: "completed" | "partial" }>>,
): ControllerCycleStageOutcome {
  if (
    !isSafeCount(outcome.discovered) ||
    !isSafeCount(outcome.processed) ||
    !isSafeCount(outcome.alreadyCompleted)
  ) {
    return sourceFailure();
  }
  const failures = groupFailures(outcome.failures);
  if (failures === undefined) return sourceFailure();
  const failed = failures.reduce((total, failure) => total + failure.count, 0);
  if (
    outcome.discovered !== outcome.processed + outcome.alreadyCompleted + failed ||
    (outcome.state === "completed" && failed !== 0) ||
    (outcome.state === "partial" && failed === 0)
  ) {
    return sourceFailure();
  }

  const inbox: ControllerCycleInboxSummary = Object.freeze({
    counts: Object.freeze({
      discovered: outcome.discovered,
      processed: outcome.processed,
      alreadyCompleted: outcome.alreadyCompleted,
      failed,
    }),
    failures,
  });
  return Object.freeze({
    state: outcome.state === "completed" ? ("completed" as const) : ("degraded" as const),
    inbox,
  });
}

/** Maps only InboxProcessor's typed, durable outcome to C02's fixed public-safe stage contract. */
export function projectInboxProcessorOutcome(
  outcome: InboxProcessorOutcome,
): ControllerCycleStageOutcome {
  if (outcome.state === "failed") return sourceFailure(safeReasonCode(outcome.error.code));
  return projectProcessedOutcome(outcome);
}

/** The v1 production router is deliberately a durable no-op: a webhook is only a wakeup hint. */
export function createIgnoredInboxUseCaseRouter(): InboxUseCaseRouter {
  return Object.freeze({
    apply: () => Promise.resolve(ok(Object.freeze({ outcome: "ignored" as const }))),
  });
}

/**
 * Makes the existing processor usable as C01's concrete Inbox stage. The runner is injected only
 * for direct composition tests; the production factory below always creates the fixed durable
 * Inbox/Event/Completion stores and the fixed ignored router.
 */
export function createInboxControllerCycleStage(
  runner: InboxProcessorRunner,
): ControllerCycleStage {
  return Object.freeze({
    id: "inbox",
    async run() {
      try {
        return projectInboxProcessorOutcome(await runner.run());
      } catch {
        return sourceFailure();
      }
    },
  });
}

export function createProductionInboxControllerCycleStage(
  options: CreateProductionInboxControllerCycleStageOptions,
): ControllerCycleStage {
  const stateDirectory = join(options.agentTeamHome, "state");
  const processor = new InboxProcessor(
    {
      source: new DurableInbox(join(stateDirectory, "inbox")),
      events: new JsonlEventStore(join(stateDirectory, "events", "events.jsonl")),
      useCases: createIgnoredInboxUseCaseRouter(),
      completions: new DurableInboxCompletionStore(join(stateDirectory, "inbox-completions")),
    },
    options.clock ?? createClock(),
  );
  return createInboxControllerCycleStage(processor);
}
