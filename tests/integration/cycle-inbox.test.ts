import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  InboxProcessor,
  type InboxCompletionReceipt,
  type InboxCompletionStorePort,
  type InboxEventAppendReceipt,
  type InboxEventStorePort,
} from "../../src/application/inbox/index.js";
import {
  createControllerCycleHandler,
  createNoopControllerCycleStages,
  type ControllerCycleSignalScope,
  type ControllerCycleStageOutcome,
  type ControllerCycleStages,
} from "../../src/cli/cycle/index.js";
import {
  createInboxControllerCycleStage,
  createIgnoredInboxUseCaseRouter,
  createProductionInboxControllerCycleStage,
} from "../../src/cli/inbox/index.js";
import type { EventEnvelopeV1 } from "../../src/domain/events/index.js";
import { domainError, err, ok, parseInstant } from "../../src/domain/foundation/index.js";
import {
  DurableInbox,
  DurableInboxCompletionStore,
  JsonlEventStore,
  readEventLog,
  type InboxMessage,
} from "../../src/infrastructure/events/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-team-cycle-inbox-"));
  roots.push(root);
  return join(root, ".agent-team");
}

function instant(value: string) {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function message(
  provider: "github" | "linear",
  deliveryId: string,
  receivedAt: string,
  eventType: string,
  rawBody: Uint8Array,
): InboxMessage {
  return {
    provider,
    deliveryId,
    eventType,
    streamKey: `${provider}-subject`,
    sourceTimestampMs: Date.parse(receivedAt) - 1_000,
    receivedAt: instant(receivedAt),
    mediaType: "application/json",
    rawBody,
  };
}

function signalScope(): ControllerCycleSignalScope {
  return Object.freeze({ signal: new AbortController().signal, dispose: () => undefined });
}

function withInbox(inbox: ControllerCycleStages["inbox"]): ControllerCycleStages {
  return Object.freeze({ ...createNoopControllerCycleStages(), inbox });
}

function fixedCycleHandler(agentTeamHome: string, inbox: ControllerCycleStages["inbox"]) {
  return createControllerCycleHandler({
    agentTeamHome,
    stages: withInbox(inbox),
    createSignalScope: signalScope,
  });
}

function faultCompletionReceipt(
  store: DurableInboxCompletionStore,
  fault: (receipt: InboxCompletionReceipt) => InboxCompletionReceipt,
): InboxCompletionStorePort {
  return Object.freeze({
    get: (...args: Parameters<InboxCompletionStorePort["get"]>) => store.get(...args),
    async mark(...args: Parameters<InboxCompletionStorePort["mark"]>) {
      const [completion, options] = args;
      const marked = await store.mark(completion, options);
      return marked.ok ? ok(fault(marked.value)) : marked;
    },
  });
}

function faultAppendReceipt(
  store: JsonlEventStore,
  fault: (receipt: InboxEventAppendReceipt) => InboxEventAppendReceipt,
): InboxEventStorePort {
  return Object.freeze({
    async append(...args: Parameters<InboxEventStorePort["append"]>) {
      const [event] = args;
      const appended = await store.append(event);
      return appended.ok ? ok(fault(appended.value)) : appended;
    },
  });
}

function payload(message: string | undefined): Readonly<Record<string, unknown>> {
  expect(message).toBeDefined();
  return JSON.parse(message ?? "") as Readonly<Record<string, unknown>>;
}

function cyclePayload(
  state: "completed" | "degraded" | "failed",
  stageCounts: Readonly<{ completed: number; degraded: number; failed: number }>,
  inbox: Readonly<{
    state: "completed" | "degraded" | "failed";
    counts: Readonly<{
      discovered: number;
      processed: number;
      alreadyCompleted: number;
      failed: number;
    }>;
    failures: readonly Readonly<{ stage: string; reasonCode: string; count: number }>[];
  }>,
  options: Readonly<{ reasonCode?: "stage_failed"; continueAfterInbox?: boolean }> = {},
) {
  return {
    operation: "controller_cycle",
    state,
    ...(options.reasonCode === undefined ? {} : { reasonCode: options.reasonCode }),
    stageCounts,
    stageOutcomes: [
      { stage: "webhook_health", state: "completed" },
      { stage: "inbox", ...inbox },
      ...(options.continueAfterInbox === false
        ? []
        : [
            { stage: "reconcile", state: "completed" },
            { stage: "projects", state: "completed" },
          ]),
    ],
  };
}

async function completionJsonCount(directory: string): Promise<number> {
  const entries = await readdir(directory);
  return entries.filter((entry) => entry.endsWith(".json")).length;
}

describe("C02 production Inbox Controller stage", () => {
  it("uses a fixed ignored router without inspecting an event or invoking a business composition", async () => {
    let inspected = 0;
    const poisonedEvent = new Proxy(Object.create(null), {
      get() {
        inspected += 1;
        throw new Error("the ignored router must not inspect provider data");
      },
    }) as EventEnvelopeV1;
    const outcome = await createIgnoredInboxUseCaseRouter().apply(poisonedEvent, {
      idempotencyKey: "inbox:ignored-router-proof",
    });

    expect(outcome).toEqual({ ok: true, value: { outcome: "ignored" } });
    expect(inspected).toBe(0);
  });

  it("drains two providers as ignored and replays without duplicate event or completion", async () => {
    const agentTeamHome = await temporaryHome();
    const inbox = new DurableInbox(join(agentTeamHome, "state", "inbox"));
    const githubDeliveryId = "github-delivery-not-public";
    const linearDeliveryId = "linear-delivery-not-public";
    const githubBody = Buffer.from('{"private":"github-body"}', "utf8");
    const linearBody = Buffer.from('{"type":"Issue","data":{"id":"linear-1"}}', "utf8");
    await inbox.store(
      message("github", githubDeliveryId, "2026-08-12T01:00:00.000Z", "unknown_event", githubBody),
    );
    await inbox.store(
      message("linear", linearDeliveryId, "2026-08-12T01:00:01.000Z", "Issue", linearBody),
    );

    const handler = fixedCycleHandler(
      agentTeamHome,
      createProductionInboxControllerCycleStage({
        agentTeamHome,
        clock: { now: () => instant("2026-08-12T01:01:00.000Z") },
      }),
    );
    const first = await handler({ all: true });
    const replay = await handler({ all: true });
    const eventsPath = join(agentTeamHome, "state", "events", "events.jsonl");
    const completions = new DurableInboxCompletionStore(
      join(agentTeamHome, "state", "inbox-completions"),
    );
    const events = await readEventLog(eventsPath);

    expect(first.state).toBe("success");
    expect(payload(first.message)).toEqual(
      cyclePayload(
        "completed",
        { completed: 4, degraded: 0, failed: 0 },
        {
          state: "completed",
          counts: { discovered: 2, processed: 2, alreadyCompleted: 0, failed: 0 },
          failures: [],
        },
      ),
    );
    expect(replay.state).toBe("success");
    expect(payload(replay.message)).toEqual(
      cyclePayload(
        "completed",
        { completed: 4, degraded: 0, failed: 0 },
        {
          state: "completed",
          counts: { discovered: 2, processed: 0, alreadyCompleted: 2, failed: 0 },
          failures: [],
        },
      ),
    );
    if (!events.ok) throw new Error(events.error.code);
    expect(events.value.events.map((event) => event.eventType)).toEqual([
      "github.unknown_event",
      "linear.issue",
    ]);
    expect(await completionJsonCount(join(agentTeamHome, "state", "inbox-completions"))).toBe(2);
    const githubCompletion = await completions.get("github", githubDeliveryId);
    const linearCompletion = await completions.get("linear", linearDeliveryId);
    expect(githubCompletion).toMatchObject({ ok: true, value: { outcome: "ignored" } });
    expect(linearCompletion).toMatchObject({ ok: true, value: { outcome: "ignored" } });
    expect(first.message).not.toContain(githubDeliveryId);
    expect(first.message).not.toContain(linearDeliveryId);
    expect(first.message).not.toContain("github-body");
  });

  it("isolates an invalid sibling, keeps it uncompleted, and still runs safe downstream no-ops", async () => {
    const agentTeamHome = await temporaryHome();
    const inbox = new DurableInbox(join(agentTeamHome, "state", "inbox"));
    const invalidDeliveryId = "invalid-delivery-not-public";
    await inbox.store(
      message(
        "linear",
        invalidDeliveryId,
        "2026-08-12T02:00:00.000Z",
        "Issue",
        Buffer.from("not-json", "utf8"),
      ),
    );
    await inbox.store(
      message(
        "github",
        "safe-delivery",
        "2026-08-12T02:00:01.000Z",
        "unknown_event",
        Buffer.from("{}", "utf8"),
      ),
    );

    const outcome = await fixedCycleHandler(
      agentTeamHome,
      createProductionInboxControllerCycleStage({
        agentTeamHome,
        clock: { now: () => instant("2026-08-12T02:01:00.000Z") },
      }),
    )({ all: true });
    const events = await readEventLog(join(agentTeamHome, "state", "events", "events.jsonl"));
    const completions = new DurableInboxCompletionStore(
      join(agentTeamHome, "state", "inbox-completions"),
    );

    expect(outcome.state).toBe("blocked");
    expect(payload(outcome.message)).toEqual(
      cyclePayload(
        "degraded",
        { completed: 3, degraded: 1, failed: 0 },
        {
          state: "degraded",
          counts: { discovered: 2, processed: 1, alreadyCompleted: 0, failed: 1 },
          failures: [{ stage: "projection", reasonCode: "invariant_violation", count: 1 }],
        },
      ),
    );
    if (!events.ok) throw new Error(events.error.code);
    expect(events.value.events).toHaveLength(1);
    expect(await completions.get("linear", invalidDeliveryId)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await completionJsonCount(join(agentTeamHome, "state", "inbox-completions"))).toBe(1);
    expect(outcome.message).not.toContain(invalidDeliveryId);
    expect(outcome.message).not.toContain("not-json");
  });

  it("replays a completion crash with one Event and one eventual ignored Completion", async () => {
    const agentTeamHome = await temporaryHome();
    const inbox = new DurableInbox(join(agentTeamHome, "state", "inbox"));
    const deliveryId = "completion-crash-not-public";
    await inbox.store(
      message(
        "github",
        deliveryId,
        "2026-08-12T02:30:00.000Z",
        "unknown_event",
        Buffer.from("{}", "utf8"),
      ),
    );
    const durableCompletions = new DurableInboxCompletionStore(
      join(agentTeamHome, "state", "inbox-completions"),
    );
    let failFirstCompletion = true;
    const completions: InboxCompletionStorePort = {
      get: (provider, candidateDeliveryId) => durableCompletions.get(provider, candidateDeliveryId),
      mark(completion, options) {
        if (failFirstCompletion) {
          failFirstCompletion = false;
          return Promise.resolve(err(domainError("external_failure")));
        }
        return durableCompletions.mark(completion, options);
      },
    };
    const processor = new InboxProcessor(
      {
        source: inbox,
        events: new JsonlEventStore(join(agentTeamHome, "state", "events", "events.jsonl")),
        useCases: createIgnoredInboxUseCaseRouter(),
        completions,
      },
      { now: () => instant("2026-08-12T02:31:00.000Z") },
    );
    const handler = fixedCycleHandler(agentTeamHome, createInboxControllerCycleStage(processor));
    const interrupted = await handler({ all: true });
    const replay = await handler({ all: true });
    const settled = await handler({ all: true });
    const events = await readEventLog(join(agentTeamHome, "state", "events", "events.jsonl"));

    expect(interrupted.state).toBe("blocked");
    expect(payload(interrupted.message)).toEqual(
      cyclePayload(
        "degraded",
        { completed: 3, degraded: 1, failed: 0 },
        {
          state: "degraded",
          counts: { discovered: 1, processed: 0, alreadyCompleted: 0, failed: 1 },
          failures: [{ stage: "completion_write", reasonCode: "external_failure", count: 1 }],
        },
      ),
    );
    expect(replay.state).toBe("success");
    expect(payload(replay.message)).toEqual(
      cyclePayload(
        "completed",
        { completed: 4, degraded: 0, failed: 0 },
        {
          state: "completed",
          counts: { discovered: 1, processed: 1, alreadyCompleted: 0, failed: 0 },
          failures: [],
        },
      ),
    );
    expect(settled.state).toBe("success");
    expect(payload(settled.message)).toEqual(
      cyclePayload(
        "completed",
        { completed: 4, degraded: 0, failed: 0 },
        {
          state: "completed",
          counts: { discovered: 1, processed: 0, alreadyCompleted: 1, failed: 0 },
          failures: [],
        },
      ),
    );
    if (!events.ok) throw new Error(events.error.code);
    expect(events.value.events).toHaveLength(1);
    expect(await completionJsonCount(join(agentTeamHome, "state", "inbox-completions"))).toBe(1);
    expect(interrupted.message).not.toContain(deliveryId);
  });

  it("groups Inbox failures by stable stage and reason without exposing provider or delivery data", async () => {
    const agentTeamHome = await temporaryHome();
    const unsafeDelivery = "https://provider.example/delivery?secret=private";
    const runner = {
      run: () =>
        Promise.resolve(
          Object.freeze({
            state: "partial" as const,
            discovered: 3,
            processed: 0,
            alreadyCompleted: 0,
            failures: Object.freeze([
              Object.freeze({
                provider: "github" as const,
                deliveryId: unsafeDelivery,
                stage: "projection" as const,
                error: domainError("invariant_violation"),
              }),
              Object.freeze({
                provider: "linear" as const,
                deliveryId: "second-private-delivery",
                stage: "event_append" as const,
                error: domainError("external_failure"),
              }),
              Object.freeze({
                provider: "github" as const,
                deliveryId: "third-private-delivery",
                stage: "projection" as const,
                error: domainError("invariant_violation"),
              }),
            ]),
          }),
        ),
    };
    const outcome = await fixedCycleHandler(
      agentTeamHome,
      createInboxControllerCycleStage(runner),
    )({ all: true });

    expect(outcome.state).toBe("blocked");
    expect(payload(outcome.message)).toEqual(
      cyclePayload(
        "degraded",
        { completed: 3, degraded: 1, failed: 0 },
        {
          state: "degraded",
          counts: { discovered: 3, processed: 0, alreadyCompleted: 0, failed: 3 },
          failures: [
            { stage: "event_append", reasonCode: "external_failure", count: 1 },
            { stage: "projection", reasonCode: "invariant_violation", count: 2 },
          ],
        },
      ),
    );
    expect(outcome.message).not.toContain(unsafeDelivery);
    expect(outcome.message).not.toContain("second-private-delivery");
    expect(outcome.message).not.toContain("third-private-delivery");
  });

  it.each([
    [
      "classification stored_unconfirmed",
      (receipt: InboxCompletionReceipt): InboxCompletionReceipt =>
        Object.freeze({ ...receipt, classification: "stored_unconfirmed" as const }),
    ],
    [
      "durability unknown",
      (receipt: InboxCompletionReceipt): InboxCompletionReceipt =>
        Object.freeze({ ...receipt, durability: "unknown" as const }),
    ],
    [
      "lock release unknown",
      (receipt: InboxCompletionReceipt): InboxCompletionReceipt =>
        Object.freeze({ ...receipt, lockRelease: "unknown" as const }),
    ],
  ] as const)(
    "fails closed when exactly one real completion receipt field is %s",
    async (_name, fault) => {
      const agentTeamHome = await temporaryHome();
      const deliveryId = "completion-receipt-not-public";
      const inbox = new DurableInbox(join(agentTeamHome, "state", "inbox"));
      await inbox.store(
        message(
          "linear",
          deliveryId,
          "2026-08-12T03:02:00.000Z",
          "Issue",
          Buffer.from('{"type":"Issue","data":{}}', "utf8"),
        ),
      );
      const durableCompletions = new DurableInboxCompletionStore(
        join(agentTeamHome, "state", "inbox-completions"),
      );
      const processor = new InboxProcessor(
        {
          source: inbox,
          events: new JsonlEventStore(join(agentTeamHome, "state", "events", "events.jsonl")),
          useCases: createIgnoredInboxUseCaseRouter(),
          completions: faultCompletionReceipt(durableCompletions, fault),
        },
        { now: () => instant("2026-08-12T03:03:00.000Z") },
      );
      const outcome = await fixedCycleHandler(
        agentTeamHome,
        createInboxControllerCycleStage(processor),
      )({ all: true });

      expect(outcome.state).toBe("blocked");
      expect(payload(outcome.message)).toEqual(
        cyclePayload(
          "degraded",
          { completed: 3, degraded: 1, failed: 0 },
          {
            state: "degraded",
            counts: { discovered: 1, processed: 0, alreadyCompleted: 0, failed: 1 },
            failures: [{ stage: "completion_write", reasonCode: "external_failure", count: 1 }],
          },
        ),
      );
      expect(await durableCompletions.get("linear", deliveryId)).toMatchObject({
        ok: true,
        value: { outcome: "ignored" },
      });
      expect(outcome.message).not.toContain(deliveryId);
    },
  );

  it.each([
    [
      "persistence persisted_unknown",
      (receipt: InboxEventAppendReceipt): InboxEventAppendReceipt =>
        Object.freeze({ ...receipt, persistence: "persisted_unknown" as const }),
    ],
    [
      "lock release unknown",
      (receipt: InboxEventAppendReceipt): InboxEventAppendReceipt =>
        Object.freeze({ ...receipt, lockRelease: "unknown" as const }),
    ],
  ] as const)(
    "fails closed when exactly one real append receipt field is %s",
    async (_name, fault) => {
      const agentTeamHome = await temporaryHome();
      const deliveryId = "append-receipt-not-public";
      const inbox = new DurableInbox(join(agentTeamHome, "state", "inbox"));
      await inbox.store(
        message(
          "github",
          deliveryId,
          "2026-08-12T03:00:00.000Z",
          "unknown_event",
          Buffer.from("{}", "utf8"),
        ),
      );
      const durableCompletions = new DurableInboxCompletionStore(
        join(agentTeamHome, "state", "inbox-completions"),
      );
      const processor = new InboxProcessor(
        {
          source: inbox,
          events: faultAppendReceipt(
            new JsonlEventStore(join(agentTeamHome, "state", "events", "events.jsonl")),
            fault,
          ),
          useCases: createIgnoredInboxUseCaseRouter(),
          completions: durableCompletions,
        },
        { now: () => instant("2026-08-12T03:01:00.000Z") },
      );
      const outcome = await fixedCycleHandler(
        agentTeamHome,
        createInboxControllerCycleStage(processor),
      )({ all: true });

      expect(outcome.state).toBe("blocked");
      expect(payload(outcome.message)).toEqual(
        cyclePayload(
          "degraded",
          { completed: 3, degraded: 1, failed: 0 },
          {
            state: "degraded",
            counts: { discovered: 1, processed: 0, alreadyCompleted: 0, failed: 1 },
            failures: [{ stage: "event_append", reasonCode: "external_failure", count: 1 }],
          },
        ),
      );
      expect(await durableCompletions.get("github", deliveryId)).toEqual({
        ok: true,
        value: undefined,
      });
      expect(outcome.message).not.toContain(deliveryId);
    },
  );

  const malformedInboxOutcomes = [
    {
      name: "a negative count",
      outcome: {
        state: "completed",
        inbox: {
          counts: { discovered: 0, processed: -1, alreadyCompleted: 0, failed: 0 },
          failures: [],
        },
      },
    },
    {
      name: "an unsafe integer count",
      outcome: {
        state: "completed",
        inbox: {
          counts: {
            discovered: Number.MAX_SAFE_INTEGER + 1,
            processed: 0,
            alreadyCompleted: 0,
            failed: 0,
          },
          failures: [],
        },
      },
    },
    {
      name: "non-conserving counts",
      outcome: {
        state: "completed",
        inbox: {
          counts: { discovered: 1, processed: 0, alreadyCompleted: 0, failed: 0 },
          failures: [],
        },
      },
    },
    {
      name: "a completed summary with failures",
      outcome: {
        state: "completed",
        inbox: {
          counts: { discovered: 1, processed: 0, alreadyCompleted: 0, failed: 1 },
          failures: [{ stage: "event_append", reasonCode: "external_failure", count: 1 }],
        },
      },
    },
    {
      name: "a degraded summary without failures",
      outcome: {
        state: "degraded",
        inbox: {
          counts: { discovered: 1, processed: 1, alreadyCompleted: 0, failed: 0 },
          failures: [],
        },
      },
    },
    {
      name: "failure groups whose total does not equal failed",
      outcome: {
        state: "degraded",
        inbox: {
          counts: { discovered: 2, processed: 0, alreadyCompleted: 0, failed: 2 },
          failures: [{ stage: "event_append", reasonCode: "external_failure", count: 1 }],
        },
      },
    },
    {
      name: "a zero-count failure group",
      outcome: {
        state: "degraded",
        inbox: {
          counts: { discovered: 1, processed: 0, alreadyCompleted: 0, failed: 1 },
          failures: [{ stage: "event_append", reasonCode: "external_failure", count: 0 }],
        },
      },
    },
    {
      name: "duplicate failure groups",
      outcome: {
        state: "degraded",
        inbox: {
          counts: { discovered: 2, processed: 0, alreadyCompleted: 0, failed: 2 },
          failures: [
            { stage: "event_append", reasonCode: "external_failure", count: 1 },
            { stage: "event_append", reasonCode: "external_failure", count: 1 },
          ],
        },
      },
    },
    {
      name: "out-of-order failure groups",
      outcome: {
        state: "degraded",
        inbox: {
          counts: { discovered: 2, processed: 0, alreadyCompleted: 0, failed: 2 },
          failures: [
            { stage: "use_case", reasonCode: "external_failure", count: 1 },
            { stage: "event_append", reasonCode: "external_failure", count: 1 },
          ],
        },
      },
    },
    {
      name: "a source failure reported as degraded",
      outcome: {
        state: "degraded",
        inbox: {
          counts: { discovered: 0, processed: 0, alreadyCompleted: 0, failed: 1 },
          failures: [{ stage: "source", reasonCode: "unavailable", count: 1 }],
        },
      },
    },
    {
      name: "a failed non-source Inbox summary",
      outcome: {
        state: "failed",
        inbox: {
          counts: { discovered: 1, processed: 0, alreadyCompleted: 0, failed: 1 },
          failures: [{ stage: "event_append", reasonCode: "external_failure", count: 1 }],
        },
      },
    },
  ] as const;

  for (const malformed of malformedInboxOutcomes) {
    it(`fails closed for ${malformed.name} without rendering the malformed Inbox summary`, async () => {
      const agentTeamHome = await temporaryHome();
      const outcome = await fixedCycleHandler(
        agentTeamHome,
        Object.freeze({
          id: "inbox" as const,
          run: () => Promise.resolve(malformed.outcome as unknown as ControllerCycleStageOutcome),
        }),
      )({ all: true });

      expect(outcome.state).toBe("failed");
      expect(payload(outcome.message)).toEqual({
        operation: "controller_cycle",
        state: "failed",
        reasonCode: "stage_execution_failed",
        stageCounts: { completed: 1, degraded: 0, failed: 0 },
        stageOutcomes: [{ stage: "webhook_health", state: "completed" }],
      });
      expect(outcome.message).not.toContain("discovered");
      expect(outcome.message).not.toContain("event_append");
    });
  }

  it("fails source closed with its fixed Inbox summary and does not start downstream stages", async () => {
    const agentTeamHome = await temporaryHome();
    const sourceFailure = new InboxProcessor(
      {
        source: { list: () => Promise.resolve(err(domainError("unavailable"))) },
        events: { append: () => Promise.resolve(err(domainError("external_failure"))) },
        useCases: createIgnoredInboxUseCaseRouter(),
        completions: {
          get: () => Promise.resolve(err(domainError("external_failure"))),
          mark: () => Promise.resolve(err(domainError("external_failure"))),
        },
      },
      { now: () => instant("2026-08-12T04:00:00.000Z") },
    );
    const outcome = await fixedCycleHandler(
      agentTeamHome,
      createInboxControllerCycleStage(sourceFailure),
    )({ all: true });

    expect(outcome.state).toBe("failed");
    expect(payload(outcome.message)).toEqual(
      cyclePayload(
        "failed",
        { completed: 1, degraded: 0, failed: 1 },
        {
          state: "failed",
          counts: { discovered: 0, processed: 0, alreadyCompleted: 0, failed: 1 },
          failures: [{ stage: "source", reasonCode: "unavailable", count: 1 }],
        },
        { reasonCode: "stage_failed", continueAfterInbox: false },
      ),
    );
  });
});
