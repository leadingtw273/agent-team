import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createProviderRevisionIdentity,
  WebhookReconcileCoordinator,
  type WebhookReadBackChange,
  type WebhookReadBackPort,
  type WebhookReadBackRequest,
  type WebhookReconcileCursor,
  type WebhookReconcileCursorStorePort,
  type WebhookReconcileEventPort,
  type WebhookReconcileProvider,
} from "../../src/application/reconcile/index.js";
import type { MutationOptions } from "../../src/application/ports/index.js";
import {
  domainError,
  err,
  ok,
  parseInstant,
  type Identifier,
  type Instant,
} from "../../src/domain/foundation/index.js";
import { projectSchema } from "../../src/domain/project/index.js";
import {
  DurableWebhookReconcileCursorStore,
  JsonlEventStore,
  readEventLog,
} from "../../src/infrastructure/events/index.js";

const roots: string[] = [];
const project = projectSchema.parse({
  schemaVersion: 1,
  id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  displayName: "Webhook reconcile fixture",
  localRepositoryPath: "/tmp/webhook-reconcile-project",
  defaultBranch: "main",
  workManagement: { provider: "linear", containerId: "workspace", projectId: "team" },
  sourceControl: { provider: "github", repository: "owner/repository" },
});

function instant(value: string) {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

async function temporaryRoot() {
  const value = await mkdtemp(join(tmpdir(), "agent-team-webhook-reconcile-"));
  roots.push(value);
  return value;
}

function change(
  revisionLabel: string,
  occurredAt: string,
  eventType = "state_changed",
): WebhookReadBackChange {
  const provider = revisionLabel.startsWith("linear") ? "linear" : "github";
  const identity = createProviderRevisionIdentity({
    provider,
    resourceType: provider === "github" ? "pull_request" : "issue",
    resourceId: revisionLabel,
    updatedAt: instant(occurredAt),
    authoritativeContent: { revisionLabel, eventType },
  });
  if (!identity.ok) throw new Error(identity.error.code);
  return {
    providerEventId: identity.value.providerEventId,
    eventType,
    occurredAt: instant(occurredAt),
    streamKey: `stream-${revisionLabel}`,
    payload: { providerEventId: identity.value.providerEventId, authoritative: true },
  };
}

class AuthoritativeReadBack implements WebhookReadBackPort {
  readonly requests: WebhookReadBackRequest[] = [];
  readonly failures = new Set<"github" | "linear">();

  constructor(
    readonly changes: Readonly<{
      github: readonly WebhookReadBackChange[];
      linear: readonly WebhookReadBackChange[];
    }>,
  ) {}

  readChanges(request: WebhookReadBackRequest) {
    this.requests.push(request);
    if (this.failures.has(request.provider)) {
      return Promise.resolve(err(domainError("unavailable")));
    }
    return Promise.resolve(
      ok(
        this.changes[request.provider].filter(
          (candidate) =>
            candidate.occurredAt >= request.fromInclusive &&
            candidate.occurredAt <= request.throughInclusive,
        ),
      ),
    );
  }
}

class StoredUnconfirmedCursorStore implements WebhookReconcileCursorStorePort {
  readonly values = new Map<WebhookReconcileProvider, WebhookReconcileCursor>();
  readonly advances: Readonly<{
    cursor: WebhookReconcileCursor;
    expectedHighWatermark: Instant | undefined;
    options: MutationOptions;
  }>[] = [];

  get(_projectId: Identifier<"project">, provider: WebhookReconcileProvider) {
    return Promise.resolve(ok(this.values.get(provider)));
  }

  advance(
    cursor: WebhookReconcileCursor,
    expectedHighWatermark: Instant | undefined,
    options: MutationOptions,
  ) {
    this.advances.push(Object.freeze({ cursor, expectedHighWatermark, options }));
    this.values.set(cursor.provider, cursor);
    return Promise.resolve(
      ok(
        Object.freeze({
          classification:
            cursor.provider === "github" ? ("stored_unconfirmed" as const) : ("advanced" as const),
          durability: cursor.provider === "github" ? ("unknown" as const) : ("confirmed" as const),
          lockRelease: "confirmed" as const,
        }),
      ),
    );
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("Webhook read-back reconcile with durable time cursors", () => {
  it("rebuilds a deleted event from the overlap window without duplicating later replay", async () => {
    const root = await temporaryRoot();
    const eventsPath = join(root, "events.jsonl");
    const cursorDirectory = join(root, "cursors");
    const cursors = new DurableWebhookReconcileCursorStore(cursorDirectory);
    const readBack = new AuthoritativeReadBack({
      github: [change("github-pr-42-revision-7", "2026-08-05T12:09:30.000Z", "pull_request")],
      linear: [],
    });
    let now = instant("2026-08-05T12:10:00.000Z");
    const coordinator = new WebhookReconcileCoordinator(
      { readBack, events: new JsonlEventStore(eventsPath), cursors },
      { now: () => now },
    );

    const first = await coordinator.reconcile({
      project,
      idempotencyKeyPrefix: "reconcile:webhook:tick-1",
    });
    await writeFile(eventsPath, "", "utf8");
    now = instant("2026-08-05T12:10:30.000Z");
    const repaired = await coordinator.reconcile({
      project,
      idempotencyKeyPrefix: "reconcile:webhook:tick-2",
    });
    const replay = await coordinator.reconcile({
      project,
      idempotencyKeyPrefix: "reconcile:webhook:tick-3",
    });
    const log = await readEventLog(eventsPath);

    expect(first.state).toBe("completed");
    if (first.state === "failed") throw new Error(first.error.code);
    expect(first.providers).toContainEqual(
      expect.objectContaining({ provider: "github", observed: 1, duplicates: 0 }),
    );
    expect(repaired.state).toBe("completed");
    if (repaired.state === "failed") throw new Error(repaired.error.code);
    expect(repaired.providers).toContainEqual(
      expect.objectContaining({ provider: "github", observed: 1, duplicates: 0 }),
    );
    expect(replay.state).toBe("completed");
    if (replay.state === "failed") throw new Error(replay.error.code);
    expect(replay.providers).toContainEqual(
      expect.objectContaining({ provider: "github", observed: 1, duplicates: 1 }),
    );
    if (!log.ok) throw new Error(log.error.code);
    expect(log.value.events).toHaveLength(1);
    expect(log.value.events[0]).toMatchObject({
      eventType: "github.pull_request",
      source: { kind: "external", provider: "github" },
      payload: { authoritative: true },
    });
    const recoveredSource = log.value.events[0]?.source;
    expect(recoveredSource?.kind).toBe("external");
    if (recoveredSource?.kind !== "external") throw new Error("expected_external_source");
    expect(recoveredSource.deliveryId).toMatch(/^readback:provider-revision:v1:github:/u);
    expect(readBack.requests[2]).toMatchObject({
      provider: "github",
      fromInclusive: "2026-08-05T12:09:00.000Z",
      throughInclusive: "2026-08-05T12:10:30.000Z",
    });
    const cursorFiles = (await readdir(cursorDirectory)).filter((name) => name.endsWith(".json"));
    expect(cursorFiles).toHaveLength(2);
    await Promise.all(
      cursorFiles.map(async (name) => {
        expect((await stat(join(cursorDirectory, name))).mode & 0o777).toBe(0o600);
      }),
    );
  });

  it("does not advance a failed provider cursor while a healthy sibling converges", async () => {
    const root = await temporaryRoot();
    const cursors = new DurableWebhookReconcileCursorStore(join(root, "cursors"));
    const readBack = new AuthoritativeReadBack({
      github: [change("github-pr-1", "2026-08-05T12:09:30.000Z")],
      linear: [change("linear-issue-1-r2", "2026-08-05T12:09:40.000Z", "Issue")],
    });
    readBack.failures.add("github");
    const eventsPath = join(root, "events.jsonl");
    const coordinator = new WebhookReconcileCoordinator(
      { readBack, events: new JsonlEventStore(eventsPath), cursors },
      { now: () => instant("2026-08-05T12:10:00.000Z") },
    );

    const outcome = await coordinator.reconcile({
      project,
      idempotencyKeyPrefix: "reconcile:webhook:provider-failure",
    });
    const githubCursor = await cursors.get(project.id, "github");
    const linearCursor = await cursors.get(project.id, "linear");
    const log = await readEventLog(eventsPath);

    expect(outcome).toMatchObject({
      state: "degraded",
      providers: [
        { state: "failed", provider: "github", stage: "read_back" },
        { state: "synchronized", provider: "linear", observed: 1 },
      ],
    });
    expect(githubCursor).toEqual({ ok: true, value: undefined });
    expect(linearCursor).toMatchObject({
      ok: true,
      value: { highWatermark: "2026-08-05T12:10:00.000Z" },
    });
    if (!log.ok) throw new Error(log.error.code);
    expect(log.value.events.map((event) => event.eventType)).toEqual(["linear.issue"]);
  });

  it("leaves the cursor unchanged when an Event append is not durably confirmed", async () => {
    const root = await temporaryRoot();
    const cursors = new DurableWebhookReconcileCursorStore(join(root, "cursors"));
    const readBack = new AuthoritativeReadBack({
      github: [change("github-pr-uncertain", "2026-08-05T12:09:30.000Z")],
      linear: [],
    });
    const durableEvents = new JsonlEventStore(join(root, "events.jsonl"));
    const events: WebhookReconcileEventPort = {
      append(event) {
        if (event.source.kind === "external" && event.source.provider === "github") {
          return Promise.resolve(
            ok({ persistence: "persisted_unknown" as const, lockRelease: "confirmed" as const }),
          );
        }
        return durableEvents.append(event);
      },
    };
    const coordinator = new WebhookReconcileCoordinator(
      { readBack, events, cursors },
      { now: () => instant("2026-08-05T12:10:00.000Z") },
    );

    const outcome = await coordinator.reconcile({
      project,
      idempotencyKeyPrefix: "reconcile:webhook:uncertain-append",
    });
    const githubCursor = await cursors.get(project.id, "github");
    const linearCursor = await cursors.get(project.id, "linear");

    expect(outcome.state).toBe("degraded");
    if (outcome.state === "failed") throw new Error(outcome.error.code);
    expect(outcome.providers).toContainEqual(
      expect.objectContaining({
        state: "failed",
        provider: "github",
        stage: "event_append",
      }),
    );
    expect(githubCursor).toEqual({ ok: true, value: undefined });
    expect(linearCursor).toMatchObject({ ok: true, value: { provider: "linear" } });
  });

  it("fails closed when a cursor may be stored but its durability is unknown", async () => {
    const root = await temporaryRoot();
    const cursors = new StoredUnconfirmedCursorStore();
    const readBack = new AuthoritativeReadBack({
      github: [change("github-pr-cursor-uncertain", "2026-08-05T12:09:30.000Z")],
      linear: [],
    });
    const eventsPath = join(root, "events.jsonl");
    const coordinator = new WebhookReconcileCoordinator(
      { readBack, events: new JsonlEventStore(eventsPath), cursors },
      { now: () => instant("2026-08-05T12:10:00.000Z") },
    );

    const outcome = await coordinator.reconcile({
      project,
      idempotencyKeyPrefix: "reconcile:webhook:uncertain-cursor",
    });
    const githubCursor = await cursors.get(project.id, "github");
    const linearCursor = await cursors.get(project.id, "linear");
    const log = await readEventLog(eventsPath);

    expect(outcome).toMatchObject({
      state: "degraded",
      providers: [
        { state: "failed", provider: "github", stage: "cursor_write" },
        { state: "synchronized", provider: "linear", observed: 0 },
      ],
    });
    expect(githubCursor).toMatchObject({
      ok: true,
      value: { highWatermark: "2026-08-05T12:10:00.000Z", provider: "github" },
    });
    expect(linearCursor).toMatchObject({
      ok: true,
      value: { highWatermark: "2026-08-05T12:10:00.000Z", provider: "linear" },
    });
    expect(cursors.advances).toHaveLength(2);
    const githubAdvance = cursors.advances[0];
    const linearAdvance = cursors.advances[1];
    if (githubAdvance === undefined || linearAdvance === undefined) {
      throw new Error("expected_cursor_advances");
    }
    expect(githubAdvance.cursor.provider).toBe("github");
    expect(githubAdvance.expectedHighWatermark).toBeUndefined();
    expect(githubAdvance.options.idempotencyKey).toBe(
      "reconcile:webhook:uncertain-cursor:cursor:github",
    );
    expect(linearAdvance.cursor.provider).toBe("linear");
    expect(linearAdvance.expectedHighWatermark).toBeUndefined();
    expect(linearAdvance.options.idempotencyKey).toBe(
      "reconcile:webhook:uncertain-cursor:cursor:linear",
    );
    if (!log.ok) throw new Error(log.error.code);
    expect(log.value.events).toHaveLength(1);
    expect(log.value.events[0]).toMatchObject({ source: { provider: "github" } });
  });

  it("uses compare-and-swap to reject a stale or regressing cursor writer", async () => {
    const root = await temporaryRoot();
    const cursorDirectory = join(root, "cursors");
    const cursors = new DurableWebhookReconcileCursorStore(cursorDirectory);
    const firstHigh = instant("2026-08-05T12:00:00.000Z");
    const secondHigh = instant("2026-08-05T12:01:00.000Z");
    const base = {
      schemaVersion: 1 as const,
      projectId: project.id,
      provider: "github" as const,
      updatedAt: firstHigh,
    };

    const first = await cursors.advance({ ...base, highWatermark: firstHigh }, undefined, {
      idempotencyKey: "cursor:first",
    });
    const stale = await cursors.advance(
      { ...base, highWatermark: secondHigh, updatedAt: secondHigh },
      undefined,
      { idempotencyKey: "cursor:stale" },
    );
    const advanced = await cursors.advance(
      { ...base, highWatermark: secondHigh, updatedAt: secondHigh },
      firstHigh,
      { idempotencyKey: "cursor:second" },
    );
    const regressed = await cursors.advance(
      { ...base, highWatermark: firstHigh, updatedAt: secondHigh },
      secondHigh,
      { idempotencyKey: "cursor:regress" },
    );

    expect(first).toMatchObject({ ok: true, value: { classification: "advanced" } });
    expect(stale).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(advanced).toMatchObject({ ok: true, value: { classification: "advanced" } });
    expect(regressed).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});
