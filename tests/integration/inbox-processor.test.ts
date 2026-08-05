import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  InboxProcessor,
  type InboxCompletionStorePort,
  type InboxUseCaseRouter,
} from "../../src/application/inbox/index.js";
import { domainError, err, ok, parseInstant } from "../../src/domain/foundation/index.js";
import {
  DurableInbox,
  DurableInboxCompletionStore,
  JsonlEventStore,
  readEventLog,
  type InboxMessage,
} from "../../src/infrastructure/events/index.js";

const roots: string[] = [];

async function root() {
  const value = await mkdtemp(join(tmpdir(), "agent-team-inbox-processor-"));
  roots.push(value);
  return value;
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
  eventType = provider === "github" ? "pull_request" : "Issue",
): InboxMessage {
  const rawBody = Buffer.from(
    JSON.stringify({ action: "update", data: { id: `${provider}-subject` } }),
    "utf8",
  );
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

function idempotentRouter() {
  const applied = new Set<string>();
  let calls = 0;
  let mutations = 0;
  const router: InboxUseCaseRouter = {
    apply(_event, options) {
      calls += 1;
      if (!applied.has(options.idempotencyKey)) {
        applied.add(options.idempotencyKey);
        mutations += 1;
      }
      return Promise.resolve(ok({ outcome: "applied" as const }));
    },
  };
  return {
    router,
    calls: () => calls,
    mutations: () => mutations,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("short-lived Inbox Processor", () => {
  it("projects sorted deliveries, applies each Use Case once, and skips completed replay", async () => {
    const directory = await root();
    const inbox = new DurableInbox(join(directory, "inbox"));
    await inbox.store(message("linear", "linear-2", "2026-08-05T12:00:02.000Z", "FutureType"));
    await inbox.store(message("github", "github-1", "2026-08-05T12:00:01.000Z"));
    const eventsPath = join(directory, "events", "events.jsonl");
    const completionsDirectory = join(directory, "completed");
    const completions = new DurableInboxCompletionStore(completionsDirectory);
    const useCases = idempotentRouter();
    const processor = new InboxProcessor(
      {
        source: inbox,
        events: new JsonlEventStore(eventsPath),
        useCases: useCases.router,
        completions,
      },
      { now: () => instant("2026-08-05T12:01:00.000Z") },
    );

    const first = await processor.run();
    const replay = await processor.run();
    const log = await readEventLog(eventsPath);

    expect(first).toEqual({
      state: "completed",
      discovered: 2,
      processed: 2,
      alreadyCompleted: 0,
      failures: [],
    });
    expect(replay).toEqual({
      state: "completed",
      discovered: 2,
      processed: 0,
      alreadyCompleted: 2,
      failures: [],
    });
    expect(useCases.calls()).toBe(2);
    expect(useCases.mutations()).toBe(2);
    if (!log.ok) throw new Error(log.error.code);
    expect(log.value.events.map((event) => event.eventType)).toEqual([
      "github.pull_request",
      "linear.futuretype",
    ]);
    expect(log.value.events[1]?.payload).toMatchObject({ providerEventType: "FutureType" });
    const completionFiles = await readdir(completionsDirectory);
    expect(completionFiles.filter((entry) => entry.endsWith(".json"))).toHaveLength(2);
    await Promise.all(
      completionFiles
        .filter((entry) => entry.endsWith(".json"))
        .map(async (entry) => {
          expect((await stat(join(completionsDirectory, entry))).mode & 0o777).toBe(0o600);
        }),
    );
  });

  it("reuses one idempotency key after a crash between mutation and completion write", async () => {
    const directory = await root();
    const inbox = new DurableInbox(join(directory, "inbox"));
    await inbox.store(message("github", "crash-delivery", "2026-08-05T12:00:01.000Z"));
    const eventsPath = join(directory, "events.jsonl");
    const durableCompletions = new DurableInboxCompletionStore(join(directory, "completed"));
    let failFirstCompletion = true;
    const completions: InboxCompletionStorePort = {
      get: (provider, deliveryId) => durableCompletions.get(provider, deliveryId),
      mark(completion, options) {
        if (failFirstCompletion) {
          failFirstCompletion = false;
          return Promise.resolve(err(domainError("external_failure")));
        }
        return durableCompletions.mark(completion, options);
      },
    };
    const useCases = idempotentRouter();
    const processor = new InboxProcessor(
      {
        source: inbox,
        events: new JsonlEventStore(eventsPath),
        useCases: useCases.router,
        completions,
      },
      { now: () => instant("2026-08-05T12:01:00.000Z") },
    );

    const interrupted = await processor.run();
    const resumed = await processor.run();
    const settled = await processor.run();
    const log = await readEventLog(eventsPath);

    expect(interrupted).toMatchObject({
      state: "partial",
      processed: 0,
      failures: [{ stage: "completion_write", error: { code: "external_failure" } }],
    });
    expect(resumed).toMatchObject({ state: "completed", processed: 1, alreadyCompleted: 0 });
    expect(settled).toMatchObject({ state: "completed", processed: 0, alreadyCompleted: 1 });
    expect(useCases.calls()).toBe(2);
    expect(useCases.mutations()).toBe(1);
    if (!log.ok) throw new Error(log.error.code);
    expect(log.value.events).toHaveLength(1);
  });

  it("isolates an invalid delivery and continues processing a safe sibling", async () => {
    const directory = await root();
    const validBody = Buffer.from("{}", "utf8");
    const valid = {
      ...message("github", "safe", "2026-08-05T12:00:01.000Z"),
      rawBody: validBody,
    };
    const invalid = {
      schemaVersion: 2 as const,
      provider: "linear" as const,
      deliveryId: "tampered",
      eventType: "Issue",
      streamKey: "issue-1",
      sourceTimestampMs: Date.parse("2026-08-05T12:00:00.000Z"),
      receivedAt: instant("2026-08-05T12:00:01.000Z"),
      mediaType: "application/json",
      sha256: "0".repeat(64),
      bodyBase64: validBody.toString("base64"),
    };
    const inbox = new DurableInbox(join(directory, "inbox"));
    await inbox.store(valid);
    const listed = await inbox.list();
    if (!listed.ok) throw new Error(listed.error.code);
    const useCases = idempotentRouter();
    const processor = new InboxProcessor(
      {
        source: { list: () => Promise.resolve(ok([invalid, ...listed.value])) },
        events: new JsonlEventStore(join(directory, "events.jsonl")),
        useCases: useCases.router,
        completions: new DurableInboxCompletionStore(join(directory, "completed")),
      },
      { now: () => instant("2026-08-05T12:01:00.000Z") },
    );

    const outcome = await processor.run();

    expect(outcome).toMatchObject({
      state: "partial",
      discovered: 2,
      processed: 1,
      failures: [{ deliveryId: "tampered", stage: "projection" }],
    });
    expect(useCases.mutations()).toBe(1);
  });
});
