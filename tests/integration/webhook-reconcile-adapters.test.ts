import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  GitHubWebhookReadBackAdapter,
  type GhJsonTransport,
} from "../../src/adapters/github/index.js";
import {
  LinearGraphqlTransport,
  LinearWebhookReconcileAdapter,
  type LinearFetch,
} from "../../src/adapters/linear/index.js";
import type { ReadOptions } from "../../src/application/ports/index.js";
import { projectInboxDelivery, type InboxDelivery } from "../../src/application/inbox/index.js";
import {
  WebhookReadBackRouter,
  WebhookReconcileCoordinator,
} from "../../src/application/reconcile/index.js";
import {
  domainError,
  err,
  ok,
  parseInstant,
  type DomainError,
  type Result,
} from "../../src/domain/foundation/index.js";
import { projectSchema, type Project } from "../../src/domain/project/index.js";
import {
  DurableWebhookReconcileCursorStore,
  JsonlEventStore,
  readEventLog,
} from "../../src/infrastructure/events/index.js";

const roots: string[] = [];
const sha = "0123456789abcdef0123456789abcdef01234567";
const nextSha = "fedcba9876543210fedcba9876543210fedcba98";
const project: Project = projectSchema.parse({
  schemaVersion: 1,
  id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  displayName: "Webhook reconcile adapter composition fixture",
  localRepositoryPath: "/tmp/webhook-reconcile-adapters-project",
  defaultBranch: "main",
  workManagement: {
    provider: "linear",
    containerId: "linear-team-fixture",
    projectId: "linear-project-fixture",
  },
  sourceControl: { provider: "github", repository: "owner/repository" },
});

interface LinearRequestBody {
  readonly operationName?: unknown;
  readonly variables?: unknown;
}

class GitHubTransportFixture implements GhJsonTransport {
  readonly requests: Readonly<{
    arguments_: readonly string[];
    signal: AbortSignal | undefined;
  }>[] = [];

  requestJson<Output>(
    arguments_: readonly string[],
    schema: z.ZodType<Output>,
    options?: ReadOptions,
  ): Promise<Result<Output, DomainError>> {
    this.requests.push(
      Object.freeze({ arguments_: Object.freeze([...arguments_]), signal: options?.signal }),
    );
    const parsed = schema.safeParse([
      {
        nodeId: "PR_kwDO_adapter_composition_42",
        number: 42,
        state: "open",
        draft: false,
        createdAt: "2026-08-05T12:00:00Z",
        updatedAt: "2026-08-05T12:09:30Z",
        closedAt: null,
        mergedAt: null,
        baseSha: sha,
        headSha: nextSha,
      },
    ]);
    return Promise.resolve(parsed.success ? ok(parsed.data) : err(domainError("external_failure")));
  }
}

function instant(value: string) {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function linearRequestBody(init: RequestInit): LinearRequestBody {
  if (typeof init.body !== "string") throw new Error("expected_graphql_request_body");
  const parsed: unknown = JSON.parse(init.body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("expected_graphql_request_body");
  }
  return parsed;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-team-webhook-reconcile-adapters-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Webhook reconcile adapter composition", () => {
  it("does not append a read-back representation after complete normal webhook revisions exist", async () => {
    const root = await temporaryRoot();
    const eventsPath = join(root, "events.jsonl");
    const events = new JsonlEventStore(eventsPath);
    const cursors = new DurableWebhookReconcileCursorStore(join(root, "cursors"));
    const githubBody = Buffer.from(
      JSON.stringify({
        action: "synchronize",
        repository: { full_name: "owner/repository" },
        pull_request: {
          node_id: "PR_kwDO_adapter_composition_42",
          number: 42,
          state: "open",
          draft: false,
          merged: false,
          created_at: "2026-08-05T12:00:00Z",
          updated_at: "2026-08-05T12:09:30Z",
          closed_at: null,
          merged_at: null,
          base: { sha },
          head: { sha: nextSha },
        },
      }),
      "utf8",
    );
    const linearBody = Buffer.from(
      JSON.stringify({
        action: "update",
        type: "Issue",
        webhookTimestamp: Date.parse("2026-08-05T12:09:40.000Z"),
        data: {
          id: "linear-issue-42",
          identifier: "AT-42",
          title: "Recover missed webhook event",
          description: "Authoritative Linear revision",
          priority: 2,
          updatedAt: "2026-08-05T12:09:40Z",
          teamId: "linear-team-fixture",
          projectId: "linear-project-fixture",
          stateId: "state-in-progress",
        },
      }),
      "utf8",
    );
    const delivery = (
      provider: InboxDelivery["provider"],
      deliveryId: string,
      eventType: string,
      streamKey: string,
      sourceTimestampMs: number,
      body: Buffer,
    ): InboxDelivery => ({
      schemaVersion: 2,
      provider,
      deliveryId,
      eventType,
      streamKey,
      sourceTimestampMs,
      receivedAt: instant("2026-08-05T12:10:00.000Z"),
      mediaType: "application/json",
      sha256: createHash("sha256").update(body).digest("hex"),
      bodyBase64: body.toString("base64"),
    });
    const githubProjected = projectInboxDelivery(
      delivery(
        "github",
        "github-normal-delivery",
        "pull_request",
        "PR_kwDO_adapter_composition_42",
        Date.parse("2026-08-05T12:09:30.000Z"),
        githubBody,
      ),
    );
    const linearProjected = projectInboxDelivery(
      delivery(
        "linear",
        "linear-normal-delivery",
        "Issue",
        "linear-issue-42",
        Date.parse("2026-08-05T12:09:40.000Z"),
        linearBody,
      ),
    );
    if (!githubProjected.ok || !linearProjected.ok) {
      throw new Error("expected complete provider webhook projections");
    }
    expect((await events.append(githubProjected.value)).ok).toBe(true);
    expect((await events.append(linearProjected.value)).ok).toBe(true);

    const githubTransport = new GitHubTransportFixture();
    const linearFetch: LinearFetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [
                  {
                    id: "linear-issue-42",
                    identifier: "AT-42",
                    title: "Recover missed webhook event",
                    description: "Authoritative Linear revision",
                    priority: 2,
                    updatedAt: "2026-08-05T12:09:40Z",
                    team: { id: "linear-team-fixture" },
                    project: { id: "linear-project-fixture" },
                    state: { id: "state-in-progress" },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    const coordinator = new WebhookReconcileCoordinator(
      {
        readBack: new WebhookReadBackRouter({
          github: new GitHubWebhookReadBackAdapter(githubTransport),
          linear: new LinearWebhookReconcileAdapter(
            new LinearGraphqlTransport({ apiKey: "linear-adapter-key", fetch: linearFetch }),
          ),
        }),
        events,
        cursors,
      },
      { now: () => instant("2026-08-05T12:10:00.000Z") },
    );

    const outcome = await coordinator.reconcile({
      project,
      idempotencyKeyPrefix: "reconcile:webhook:normal-webhooks-present",
    });
    const log = await readEventLog(eventsPath);
    const githubCursor = await cursors.get(project.id, "github");
    const linearCursor = await cursors.get(project.id, "linear");

    expect(outcome).toMatchObject({
      state: "completed",
      providers: [
        {
          state: "synchronized",
          provider: "github",
          observed: 1,
          duplicates: 1,
          appendedEventIds: [],
        },
        {
          state: "synchronized",
          provider: "linear",
          observed: 1,
          duplicates: 1,
          appendedEventIds: [],
        },
      ],
    });
    expect(log.ok && log.value.events).toHaveLength(2);
    expect(
      log.ok &&
        log.value.events.flatMap((event) =>
          event.source.kind === "external" ? [event.source.deliveryId] : [],
        ),
    ).toEqual(["github-normal-delivery", "linear-normal-delivery"]);
    expect(githubCursor).toMatchObject({
      ok: true,
      value: { highWatermark: "2026-08-05T12:10:00.000Z" },
    });
    expect(linearCursor).toMatchObject({
      ok: true,
      value: { highWatermark: "2026-08-05T12:10:00.000Z" },
    });
  });

  it("routes both concrete providers and recovers only a deleted GitHub event through the overlap window", async () => {
    const root = await temporaryRoot();
    const eventsPath = join(root, "events.jsonl");
    const cursors = new DurableWebhookReconcileCursorStore(join(root, "cursors"));
    const githubTransport = new GitHubTransportFixture();
    const linearRequests: LinearRequestBody[] = [];
    const linearFetch: LinearFetch = (_url, init) => {
      linearRequests.push(linearRequestBody(init));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [
                  {
                    id: "linear-issue-42",
                    identifier: "AT-42",
                    title: "Recover missed webhook event",
                    description: "Authoritative Linear revision",
                    priority: 2,
                    updatedAt: "2026-08-05T12:09:40Z",
                    team: { id: "linear-team-fixture" },
                    project: { id: "linear-project-fixture" },
                    state: { id: "state-in-progress" },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    };
    const readBack = new WebhookReadBackRouter({
      github: new GitHubWebhookReadBackAdapter(githubTransport),
      linear: new LinearWebhookReconcileAdapter(
        new LinearGraphqlTransport({
          apiKey: "linear-adapter-composition-key",
          fetch: linearFetch,
        }),
      ),
    });
    let now = instant("2026-08-05T12:10:00.000Z");
    const coordinator = new WebhookReconcileCoordinator(
      { readBack, events: new JsonlEventStore(eventsPath), cursors },
      { now: () => now },
    );

    const first = await coordinator.reconcile({
      project,
      idempotencyKeyPrefix: "reconcile:webhook:adapter-composition:one",
    });
    const firstLog = await readEventLog(eventsPath);
    if (!firstLog.ok) throw new Error(firstLog.error.code);
    const withoutGitHub = firstLog.value.events.filter(
      (event) => event.source.kind !== "external" || event.source.provider !== "github",
    );
    await writeFile(
      eventsPath,
      `${withoutGitHub.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );

    now = instant("2026-08-05T12:10:30.000Z");
    const repaired = await coordinator.reconcile({
      project,
      idempotencyKeyPrefix: "reconcile:webhook:adapter-composition:two",
    });
    const replay = await coordinator.reconcile({
      project,
      idempotencyKeyPrefix: "reconcile:webhook:adapter-composition:three",
    });
    const githubCursor = await cursors.get(project.id, "github");
    const linearCursor = await cursors.get(project.id, "linear");
    const log = await readEventLog(eventsPath);

    expect(first).toMatchObject({
      state: "completed",
      providers: [
        { state: "synchronized", provider: "github", observed: 1, duplicates: 0 },
        { state: "synchronized", provider: "linear", observed: 1, duplicates: 0 },
      ],
    });
    expect(firstLog.value.events).toHaveLength(2);
    expect(withoutGitHub).toHaveLength(1);
    expect(withoutGitHub[0]).toMatchObject({
      source: { kind: "external", provider: "linear" },
    });
    expect(repaired).toMatchObject({
      state: "completed",
      providers: [
        { state: "synchronized", provider: "github", observed: 1, duplicates: 0 },
        { state: "synchronized", provider: "linear", observed: 1, duplicates: 1 },
      ],
    });
    expect(replay).toMatchObject({
      state: "completed",
      providers: [
        { state: "synchronized", provider: "github", observed: 1, duplicates: 1 },
        { state: "synchronized", provider: "linear", observed: 1, duplicates: 1 },
      ],
    });
    expect(githubCursor).toMatchObject({
      ok: true,
      value: { highWatermark: "2026-08-05T12:10:30.000Z" },
    });
    expect(linearCursor).toMatchObject({
      ok: true,
      value: { highWatermark: "2026-08-05T12:10:30.000Z" },
    });
    if (!log.ok) throw new Error(log.error.code);
    expect(log.value.events).toHaveLength(2);
    expect(log.value.events.map((event) => event.source)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "external", provider: "github" }),
        expect.objectContaining({ kind: "external", provider: "linear" }),
      ]),
    );
    expect(githubTransport.requests.map((request) => request.arguments_[1])).toEqual([
      "repos/owner/repository/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1",
      "repos/owner/repository/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1",
      "repos/owner/repository/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1",
    ]);
    expect(
      linearRequests.map(({ operationName, variables }) => ({ operationName, variables })),
    ).toEqual([
      {
        operationName: "AgentTeamReadWebhookReconcileIssues",
        variables: {
          projectId: "linear-project-fixture",
          fromInclusive: "2026-08-05T12:05:00.000Z",
          throughInclusive: "2026-08-05T12:10:00.000Z",
          after: null,
        },
      },
      {
        operationName: "AgentTeamReadWebhookReconcileIssues",
        variables: {
          projectId: "linear-project-fixture",
          fromInclusive: "2026-08-05T12:09:00.000Z",
          throughInclusive: "2026-08-05T12:10:30.000Z",
          after: null,
        },
      },
      {
        operationName: "AgentTeamReadWebhookReconcileIssues",
        variables: {
          projectId: "linear-project-fixture",
          fromInclusive: "2026-08-05T12:09:30.000Z",
          throughInclusive: "2026-08-05T12:10:30.000Z",
          after: null,
        },
      },
    ]);
  });
});
