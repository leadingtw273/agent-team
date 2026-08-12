import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RegistrationProbeWebhookAdapter } from "../../src/adapters/registration/index.js";
import { InboxProcessor, type InboxUseCaseRouter } from "../../src/application/inbox/index.js";
import {
  createNoopControllerCycleStages,
  runControllerCycleStages,
} from "../../src/cli/cycle/index.js";
import {
  createWebhookAttestationRefreshStage,
  type RegisteredWebhookProjectReader,
} from "../../src/cli/health/webhook-attestation.js";
import {
  FileWebhookAttestationStore,
  webhookAttestationLookupForConfig,
} from "../../src/cli/health/webhook-attestation-store.js";
import type { WebhookRuntimeRequest, WebhookRuntimeTransport } from "../../src/cli/probe/index.js";
import {
  defaultRegistrationProbeConfigPath,
  loadHostRegistrationProbeConfig,
  readSecretFile,
} from "../../src/cli/registration/index.js";
import {
  createFixedClock,
  domainError,
  err,
  ok,
  parseInstant,
} from "../../src/domain/foundation/index.js";
import { projectIdSchema } from "../../src/domain/project/index.js";
import {
  DurableInbox,
  DurableInboxCompletionStore,
  JsonlEventStore,
  readEventLog,
} from "../../src/infrastructure/events/index.js";

const roots: string[] = [];
const nowText = "2026-08-12T10:00:00.000Z";
const projectId = "project_018f47d2-77a4-7cc1-8ef2-0123456789ab";
const baseUrl = "https://runtime.example.test/";
const githubSecretText = "h02-github-secret-never-persisted";
const linearSecretText = "h02-linear-secret-never-persisted";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function instant(value = nowText) {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "agent-team-h02-cycle-"));
  roots.push(value);
  return value;
}

async function writeProbeConfig(
  agentTeamHome: string,
  githubBaseUrl = baseUrl,
  linearBaseUrl = baseUrl,
): Promise<void> {
  const directory = join(agentTeamHome, "config", "registration");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    defaultRegistrationProbeConfigPath(agentTeamHome, projectId),
    JSON.stringify({
      schemaVersion: 1,
      linearWorkflowStateId: "state-h02",
      gitRemote: "origin",
      webhookBaseUrls: { github: githubBaseUrl, linear: linearBaseUrl },
    }),
    { encoding: "utf8", mode: 0o600 },
  );
}

async function writeSecrets(agentTeamHome: string): Promise<void> {
  const directory = join(agentTeamHome, "secrets");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const github = join(directory, "github-webhook-secret");
  const linear = join(directory, "linear-webhook-secret");
  await Promise.all([
    writeFile(github, githubSecretText, { encoding: "utf8", mode: 0o600 }),
    writeFile(linear, linearSecretText, { encoding: "utf8", mode: 0o600 }),
  ]);
  await Promise.all([chmod(github, 0o600), chmod(linear, 0o600)]);
}

function registeredProject(): RegisteredWebhookProjectReader {
  return Object.freeze({
    listRegisteredProjectIds: () =>
      Promise.resolve(Object.freeze({ state: "available" as const, projectIds: [projectId] })),
  });
}

function transportThatDurablyIngests(inbox: DurableInbox): WebhookRuntimeTransport {
  return Object.freeze({
    post: async (request: WebhookRuntimeRequest) => {
      const githubDelivery = request.headers["x-github-delivery"];
      const linearDelivery = request.headers["linear-delivery"];
      const provider = githubDelivery === undefined ? "linear" : "github";
      const deliveryId = githubDelivery ?? linearDelivery;
      if (deliveryId === undefined) return err(domainError("invariant_violation"));
      const sha256 = createHash("sha256").update(request.body).digest("hex");
      const stored = await inbox.store({
        provider,
        deliveryId,
        eventType: "agent_team_probe",
        streamKey: deliveryId,
        sourceTimestampMs: Date.parse(nowText),
        receivedAt: instant(),
        mediaType: "application/json",
        rawBody: request.body,
      });
      if (!stored.ok || stored.value.lockRelease !== "confirmed") {
        return err(domainError("external_failure"));
      }
      return ok({
        statusCode: 200,
        elapsedMs: 4,
        body: new TextEncoder().encode(
          JSON.stringify({
            accepted: true,
            statusCode: 200,
            provider,
            deliveryId,
            eventType: "agent_team_probe",
            inboxSha256: sha256,
          }),
        ),
      });
    },
  });
}

function timeoutTransport(): WebhookRuntimeTransport {
  return Object.freeze({
    post: () => Promise.resolve(ok({ statusCode: 200, elapsedMs: 2_001, body: new Uint8Array() })),
  });
}

async function setup(transport: WebhookRuntimeTransport) {
  const agentTeamHome = await root();
  await Promise.all([writeProbeConfig(agentTeamHome), writeSecrets(agentTeamHome)]);
  const clock = createFixedClock(instant());
  const inbox = new DurableInbox(join(agentTeamHome, "state", "inbox"));
  const store = new FileWebhookAttestationStore(agentTeamHome, { clock });
  const adapter = new RegistrationProbeWebhookAdapter({
    transport,
    inbox,
    clock,
    createDeliveryId: (() => {
      let sequence = 0;
      return () => `h02-delivery-${String(++sequence)}`;
    })(),
  });
  const stage = createWebhookAttestationRefreshStage({
    projects: registeredProject(),
    config: Object.freeze({
      load: (id: string) =>
        loadHostRegistrationProbeConfig(defaultRegistrationProbeConfigPath(agentTeamHome, id)),
    }),
    secrets: Object.freeze({ read: readSecretFile }),
    probe: adapter,
    store,
    clock,
    agentTeamHome,
  });
  const lookup = webhookAttestationLookupForConfig({
    projectId: projectIdSchema.parse(projectId),
    webhookBaseUrls: { github: baseUrl, linear: baseUrl },
  });
  if (lookup === undefined) throw new Error("h02_lookup_missing");
  return { agentTeamHome, inbox, lookup, stage, store };
}

describe("H02 signed webhook-health refresh", () => {
  it("runs both signed probes before the Inbox stage, writes only URL-free dual evidence, then safely ignores and completes both probe deliveries", async () => {
    const fixtureRoot = await root();
    await Promise.all([writeProbeConfig(fixtureRoot), writeSecrets(fixtureRoot)]);
    const clock = createFixedClock(instant());
    const inbox = new DurableInbox(join(fixtureRoot, "state", "inbox"));
    const store = new FileWebhookAttestationStore(fixtureRoot, { clock });
    const adapter = new RegistrationProbeWebhookAdapter({
      transport: transportThatDurablyIngests(inbox),
      inbox,
      clock,
      createDeliveryId: (() => {
        let sequence = 0;
        return () => `h02-delivery-${String(++sequence)}`;
      })(),
    });
    const stage = createWebhookAttestationRefreshStage({
      projects: registeredProject(),
      config: Object.freeze({
        load: (id: string) =>
          loadHostRegistrationProbeConfig(defaultRegistrationProbeConfigPath(fixtureRoot, id)),
      }),
      secrets: Object.freeze({ read: readSecretFile }),
      probe: adapter,
      store,
      clock,
      agentTeamHome: fixtureRoot,
    });
    const lookup = webhookAttestationLookupForConfig({
      projectId: projectIdSchema.parse(projectId),
      webhookBaseUrls: { github: baseUrl, linear: baseUrl },
    });
    if (lookup === undefined) throw new Error("h02_lookup_missing");

    const ignoredApply = vi.fn(() => Promise.resolve(ok({ outcome: "ignored" as const })));
    const ignored: InboxUseCaseRouter = { apply: ignoredApply };
    const processor = new InboxProcessor(
      {
        source: inbox,
        events: new JsonlEventStore(join(fixtureRoot, "state", "events", "events.jsonl")),
        useCases: ignored,
        completions: new DurableInboxCompletionStore(join(fixtureRoot, "state", "completed")),
      },
      clock,
    );
    let processed: Awaited<ReturnType<InboxProcessor["run"]>> | undefined;
    const stages = createNoopControllerCycleStages();
    const order: string[] = [];
    const result = await runControllerCycleStages(
      Object.freeze({
        ...stages,
        webhookHealth: Object.freeze({
          id: "webhook_health" as const,
          run: async (context: Readonly<{ signal: AbortSignal }>) => {
            order.push("webhook_health");
            return stage.run(context);
          },
        }),
        inbox: Object.freeze({
          id: "inbox" as const,
          run: async () => {
            order.push("inbox");
            expect(await store.read(lookup)).toMatchObject({
              ok: true,
              value: { state: "verified" },
            });
            processed = await processor.run();
            return Object.freeze({
              state:
                processed.state === "completed" ? ("completed" as const) : ("degraded" as const),
            });
          },
        }),
      }),
      new AbortController().signal,
    );

    expect(result).toEqual({
      state: "completed",
      stageCounts: { completed: 4, degraded: 0, failed: 0 },
      stageOutcomes: [
        { stage: "webhook_health", state: "completed" },
        { stage: "inbox", state: "completed" },
        { stage: "reconcile", state: "completed" },
        { stage: "projects", state: "completed" },
      ],
    });
    expect(order).toEqual(["webhook_health", "inbox"]);
    expect(await store.read(lookup)).toMatchObject({ ok: true, value: { state: "verified" } });

    const listed = await inbox.list();
    if (!listed.ok) throw new Error(listed.error.code);
    expect(listed.value.map((record) => [record.provider, record.eventType])).toEqual([
      ["github", "agent_team_probe"],
      ["linear", "agent_team_probe"],
    ]);

    const events = await readEventLog(join(fixtureRoot, "state", "events", "events.jsonl"));

    expect(processed).toEqual({
      state: "completed",
      discovered: 2,
      processed: 2,
      alreadyCompleted: 0,
      failures: [],
    });
    expect(ignoredApply).toHaveBeenCalledTimes(2);
    if (!events.ok) throw new Error(events.error.code);
    expect(events.value.events.map((event) => event.eventType)).toEqual([
      "github.agent_team_probe",
      "linear.agent_team_probe",
    ]);
    expect(await readdir(join(fixtureRoot, "state"))).not.toEqual(
      expect.arrayContaining(["jobs.json", "leases.json", "model"]),
    );

    const evidenceDirectory = join(fixtureRoot, "state", "health", "webhook-attestations");
    const evidenceFiles = (await readdir(evidenceDirectory)).filter((name) =>
      name.endsWith(".json"),
    );
    expect(evidenceFiles).toHaveLength(1);
    const evidence = await readFile(join(evidenceDirectory, evidenceFiles[0] ?? ""), "utf8");
    for (const forbidden of [baseUrl, githubSecretText, linearSecretText, "h02-delivery-"]) {
      expect(evidence).not.toContain(forbidden);
    }
    const parsedEvidence: unknown = JSON.parse(evidence);
    expect(parsedEvidence).toEqual({
      schemaVersion: 1,
      projectId,
      configDigest: lookup.configDigest,
      github: "verified",
      linear: "verified",
      verifiedAt: nowText,
      expiresAt: "2026-08-12T10:15:00.000Z",
    });
  });

  it("fails closed on the adapter's existing two-second response boundary and does not publish partial evidence", async () => {
    const fixture = await setup(timeoutTransport());
    const stages = createNoopControllerCycleStages();
    let inboxRan = false;

    const result = await runControllerCycleStages(
      Object.freeze({
        ...stages,
        webhookHealth: fixture.stage,
        inbox: Object.freeze({
          id: "inbox" as const,
          run: () => {
            inboxRan = true;
            return Promise.resolve(Object.freeze({ state: "completed" as const }));
          },
        }),
      }),
      new AbortController().signal,
    );

    expect(result).toEqual({
      state: "degraded",
      stageCounts: { completed: 3, degraded: 1, failed: 0 },
      stageOutcomes: [
        { stage: "webhook_health", state: "degraded" },
        { stage: "inbox", state: "completed" },
        { stage: "reconcile", state: "completed" },
        { stage: "projects", state: "completed" },
      ],
    });
    expect(inboxRan).toBe(true);
    expect(await fixture.store.read(fixture.lookup)).toEqual({
      ok: true,
      value: { state: "absent" },
    });
    expect(await fixture.inbox.list()).toEqual({ ok: true, value: [] });
  });

  it("rejects an IPv4-mapped IPv6 loopback before the real adapter can call its transport or write evidence", async () => {
    const fixtureRoot = await root();
    const unsafeBaseUrl = "https://[::ffff:127.0.0.1]/";
    await Promise.all([writeProbeConfig(fixtureRoot, unsafeBaseUrl), writeSecrets(fixtureRoot)]);
    const clock = createFixedClock(instant());
    const inbox = new DurableInbox(join(fixtureRoot, "state", "inbox"));
    const store = new FileWebhookAttestationStore(fixtureRoot, { clock });
    const post = vi.fn(() => Promise.resolve(err(domainError("external_failure"))));
    const adapter = new RegistrationProbeWebhookAdapter({
      transport: Object.freeze({ post }),
      inbox,
      clock,
      createDeliveryId: () => "h02-mapped-loopback-delivery",
    });
    const stage = createWebhookAttestationRefreshStage({
      projects: registeredProject(),
      config: Object.freeze({
        load: (id: string) =>
          loadHostRegistrationProbeConfig(defaultRegistrationProbeConfigPath(fixtureRoot, id)),
      }),
      secrets: Object.freeze({ read: readSecretFile }),
      probe: adapter,
      store,
      clock,
      agentTeamHome: fixtureRoot,
    });
    const unsafeLookup = webhookAttestationLookupForConfig({
      projectId: projectIdSchema.parse(projectId),
      webhookBaseUrls: { github: unsafeBaseUrl, linear: baseUrl },
    });
    if (unsafeLookup === undefined) throw new Error("h02_mapped_loopback_lookup_missing");

    expect(await stage.run({ signal: new AbortController().signal })).toEqual({
      state: "degraded",
    });
    expect(post).not.toHaveBeenCalled();
    expect(await store.read(unsafeLookup)).toEqual({ ok: true, value: { state: "absent" } });
    expect(await inbox.list()).toEqual({ ok: true, value: [] });
  });
});
