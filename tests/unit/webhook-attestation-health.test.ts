import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RegistrationWebhookProbePort } from "../../src/application/ports/index.js";
import {
  createFixedClock,
  domainError,
  err,
  parseInstant,
  type Clock,
} from "../../src/domain/foundation/index.js";
import { projectIdSchema } from "../../src/domain/project/index.js";
import {
  WebhookAttestationHealthReader,
  createWebhookAttestationRefreshStage,
  webhookAttestationRefreshWindowMs,
  type RegisteredWebhookProjectListing,
  type RegisteredWebhookProjectReader,
  type WebhookAttestationConfigReader,
  type WebhookAttestationSecretReader,
} from "../../src/cli/health/webhook-attestation.js";
import {
  FileWebhookAttestationStore,
  webhookAttestationLookupForConfig,
  webhookAttestationTtlMs,
} from "../../src/cli/health/webhook-attestation-store.js";
import type {
  RegistrationProbeHostConfig,
  ReadSecretFileResult,
} from "../../src/cli/registration/index.js";

const roots: string[] = [];
const projectA = "project_018f47d2-77a4-7cc1-8ef2-0123456789ab";
const projectB = "project_018f47d2-77a4-7cc1-8ef2-0123456789ac";
const startMs = Date.parse("2026-08-12T10:00:00.000Z");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function instant(ms: number) {
  const parsed = parseInstant(new Date(ms).toISOString());
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function clock(ms: number): Clock {
  return createFixedClock(instant(ms));
}

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "agent-team-h02-health-"));
  roots.push(value);
  return value;
}

function hostConfig(
  github = "https://github-runtime.example.test/",
  linear = "https://linear-runtime.example.test/",
): RegistrationProbeHostConfig {
  return Object.freeze({
    linearWorkflowStateId: "state-h02",
    gitRemote: "origin",
    webhookBaseUrls: Object.freeze({ github, linear }),
  });
}

function lookup(projectId: string, config: RegistrationProbeHostConfig) {
  const value = webhookAttestationLookupForConfig({
    projectId: projectIdSchema.parse(projectId),
    webhookBaseUrls: config.webhookBaseUrls,
  });
  if (value === undefined) throw new Error("h02_lookup_missing");
  return value;
}

function configReader(
  configs: ReadonlyMap<string, RegistrationProbeHostConfig>,
): WebhookAttestationConfigReader & { readonly load: ReturnType<typeof vi.fn> } {
  const load = vi.fn((projectId: string) => {
    const config = configs.get(projectId);
    return Promise.resolve(
      config === undefined
        ? Object.freeze({ ok: false as const, reason: "missing_or_invalid" as const })
        : Object.freeze({ ok: true as const, value: config }),
    );
  });
  return Object.freeze({ load });
}

function projects(ids: readonly string[]): RegisteredWebhookProjectReader {
  return Object.freeze({
    listRegisteredProjectIds: () =>
      Promise.resolve(
        Object.freeze({ state: "available" as const, projectIds: Object.freeze([...ids]) }),
      ),
  });
}

function unavailableProjects(): RegisteredWebhookProjectReader {
  return Object.freeze({
    listRegisteredProjectIds: () =>
      Promise.resolve(
        Object.freeze({ state: "unavailable" as const }) satisfies RegisteredWebhookProjectListing,
      ),
  });
}

function secureSecrets(): WebhookAttestationSecretReader & {
  readonly calls: () => number;
} {
  let calls = 0;
  return Object.freeze({
    read: () => {
      calls += 1;
      return Promise.resolve(
        Object.freeze({
          ok: true as const,
          value: Uint8Array.from([1, 2, 3, 4]),
        }) satisfies ReadSecretFileResult,
      );
    },
    calls: () => calls,
  });
}

function unavailableSecrets(): WebhookAttestationSecretReader & {
  readonly calls: () => number;
} {
  let calls = 0;
  return Object.freeze({
    read: () => {
      calls += 1;
      return Promise.resolve(
        Object.freeze({
          ok: false as const,
          reason: "missing_or_insecure" as const,
        }) satisfies ReadSecretFileResult,
      );
    },
    calls: () => calls,
  });
}

function verifiedProbe(): RegistrationWebhookProbePort & {
  readonly requests: () => readonly Parameters<
    RegistrationWebhookProbePort["runSyntheticProbe"]
  >[0][];
} {
  let sequence = 0;
  const requests: Parameters<RegistrationWebhookProbePort["runSyntheticProbe"]>[0][] = [];
  return Object.freeze({
    runSyntheticProbe: (
      request: Parameters<RegistrationWebhookProbePort["runSyntheticProbe"]>[0],
    ) => {
      requests.push(request);
      return Promise.resolve(
        Object.freeze({
          state: "verified" as const,
          provider: request.provider,
          deliveryId: `h02-unit-delivery-${String(++sequence)}`,
          latencyMs: 1,
          inboxSha256: "a".repeat(64),
        }),
      );
    },
    requests: () => Object.freeze([...requests]),
  });
}

function failedLinearProbe(): RegistrationWebhookProbePort & {
  readonly requests: () => readonly Parameters<
    RegistrationWebhookProbePort["runSyntheticProbe"]
  >[0][];
} {
  const requests: Parameters<RegistrationWebhookProbePort["runSyntheticProbe"]>[0][] = [];
  return Object.freeze({
    runSyntheticProbe: (
      request: Parameters<RegistrationWebhookProbePort["runSyntheticProbe"]>[0],
    ) => {
      requests.push(request);
      return Promise.resolve(
        request.provider === "github"
          ? Object.freeze({
              state: "verified" as const,
              provider: "github" as const,
              deliveryId: "h02-unit-github",
              latencyMs: 1,
              inboxSha256: "b".repeat(64),
            })
          : Object.freeze({ state: "failed" as const, reason: "transport_failed" as const }),
      );
    },
    requests: () => Object.freeze([...requests]),
  });
}

function stage(
  agentTeamHome: string,
  now: number,
  store: FileWebhookAttestationStore,
  reader: WebhookAttestationConfigReader,
  probe: RegistrationWebhookProbePort,
  secrets: WebhookAttestationSecretReader = secureSecrets(),
  listed: RegisteredWebhookProjectReader = projects([projectA]),
) {
  return createWebhookAttestationRefreshStage({
    projects: listed,
    config: reader,
    secrets,
    probe,
    store,
    clock: clock(now),
    agentTeamHome,
  });
}

describe("H02 webhook attestation refresh", () => {
  it("keeps fresh evidence, uses the exact five-minute boundary, then refreshes one millisecond later", async () => {
    const agentTeamHome = await root();
    const configs = new Map([[projectA, hostConfig()]]);
    const writer = new FileWebhookAttestationStore(agentTeamHome, { clock: clock(startMs) });
    const initialLookup = lookup(projectA, hostConfig());
    expect(await writer.writeVerified(initialLookup)).toMatchObject({ ok: true });

    const atBoundary = startMs + webhookAttestationTtlMs - webhookAttestationRefreshWindowMs;
    const boundaryStore = new FileWebhookAttestationStore(agentTeamHome, {
      clock: clock(atBoundary),
    });
    const boundaryProbe = verifiedProbe();
    const boundary = await stage(
      agentTeamHome,
      atBoundary,
      boundaryStore,
      configReader(configs),
      boundaryProbe,
    ).run({ signal: new AbortController().signal });

    expect(boundary).toEqual({ state: "completed" });
    expect(boundaryProbe.requests()).toEqual([]);
    expect(await boundaryStore.read(initialLookup)).toMatchObject({
      ok: true,
      value: { state: "verified", attestation: { verifiedAt: instant(startMs) } },
    });

    const oneMillisecondLater = atBoundary + 1;
    const refreshedStore = new FileWebhookAttestationStore(agentTeamHome, {
      clock: clock(oneMillisecondLater),
    });
    const refreshedProbe = verifiedProbe();
    const refreshed = await stage(
      agentTeamHome,
      oneMillisecondLater,
      refreshedStore,
      configReader(configs),
      refreshedProbe,
    ).run({ signal: new AbortController().signal });

    expect(refreshed).toEqual({ state: "completed" });
    expect(refreshedProbe.requests().map((request) => request.provider)).toEqual([
      "github",
      "linear",
    ]);
    expect(await refreshedStore.read(initialLookup)).toMatchObject({
      ok: true,
      value: {
        state: "verified",
        attestation: {
          verifiedAt: instant(oneMillisecondLater),
          expiresAt: instant(oneMillisecondLater + webhookAttestationTtlMs),
        },
      },
    });
  });

  it("refreshes an expired record and an attestation whose canonical URL digest has drifted", async () => {
    const agentTeamHome = await root();
    const oldConfig = hostConfig(
      "https://old-github.example.test/",
      "https://old-linear.example.test/",
    );
    const newConfig = hostConfig(
      "https://new-github.example.test/",
      "https://new-linear.example.test/",
    );
    const writer = new FileWebhookAttestationStore(agentTeamHome, { clock: clock(startMs) });
    expect(await writer.writeVerified(lookup(projectA, oldConfig))).toMatchObject({ ok: true });

    const expiredAt = startMs + webhookAttestationTtlMs;
    const expiredStore = new FileWebhookAttestationStore(agentTeamHome, {
      clock: clock(expiredAt),
    });
    const expiredProbe = verifiedProbe();
    expect(
      await stage(
        agentTeamHome,
        expiredAt,
        expiredStore,
        configReader(new Map([[projectA, oldConfig]])),
        expiredProbe,
      ).run({ signal: new AbortController().signal }),
    ).toEqual({ state: "completed" });
    expect(expiredProbe.requests()).toHaveLength(2);

    const driftStore = new FileWebhookAttestationStore(agentTeamHome, {
      clock: clock(expiredAt + 1),
    });
    const driftProbe = verifiedProbe();
    expect(
      await stage(
        agentTeamHome,
        expiredAt + 1,
        driftStore,
        configReader(new Map([[projectA, newConfig]])),
        driftProbe,
      ).run({ signal: new AbortController().signal }),
    ).toEqual({ state: "completed" });
    expect(driftProbe.requests()).toHaveLength(2);
    expect(await driftStore.read(lookup(projectA, newConfig))).toMatchObject({
      ok: true,
      value: { state: "verified" },
    });
  });

  it("never publishes an attestation after a single-provider failure, unavailable secret, unsafe URL, or untrusted probe result", async () => {
    const agentTeamHome = await root();
    const normalConfig = hostConfig();
    const normalLookup = lookup(projectA, normalConfig);
    const store = new FileWebhookAttestationStore(agentTeamHome, { clock: clock(startMs) });

    const singleProvider = failedLinearProbe();
    expect(
      await stage(
        agentTeamHome,
        startMs,
        store,
        configReader(new Map([[projectA, normalConfig]])),
        singleProvider,
      ).run({ signal: new AbortController().signal }),
    ).toEqual({ state: "degraded" });
    expect(singleProvider.requests()).toHaveLength(2);
    expect(await store.read(normalLookup)).toEqual({ ok: true, value: { state: "absent" } });

    const missingSecret = unavailableSecrets();
    const noProbe = verifiedProbe();
    expect(
      await stage(
        agentTeamHome,
        startMs,
        store,
        configReader(new Map([[projectA, normalConfig]])),
        noProbe,
        missingSecret,
      ).run({ signal: new AbortController().signal }),
    ).toEqual({ state: "degraded" });
    expect(missingSecret.calls()).toBe(2);
    expect(noProbe.requests()).toEqual([]);

    const unsafeProbe = verifiedProbe();
    expect(
      await stage(
        agentTeamHome,
        startMs,
        store,
        configReader(
          new Map([
            [projectA, hostConfig("https://127.0.0.1:8747/", "https://runtime.example.test/")],
          ]),
        ),
        unsafeProbe,
      ).run({ signal: new AbortController().signal }),
    ).toEqual({ state: "degraded" });
    expect(unsafeProbe.requests()).toEqual([]);

    const malformed = vi.fn(() =>
      Promise.resolve(
        Object.assign(
          {
            state: "verified" as const,
            provider: "github" as const,
            deliveryId: "h02-malformed",
            latencyMs: 1,
            inboxSha256: "c".repeat(64),
          },
          { [Symbol("unknown")]: true },
        ),
      ),
    );
    const malformedProbe: RegistrationWebhookProbePort = { runSyntheticProbe: malformed };
    expect(
      await stage(
        agentTeamHome,
        startMs,
        store,
        configReader(new Map([[projectA, normalConfig]])),
        malformedProbe,
      ).run({ signal: new AbortController().signal }),
    ).toEqual({ state: "degraded" });
    expect(malformed).toHaveBeenCalledTimes(1);
    expect(await store.read(normalLookup)).toEqual({ ok: true, value: { state: "absent" } });
  });

  it("rejects every non-global literal IP before secrets, transport, or an attestation write while retaining global IPv4 and IPv6", async () => {
    const agentTeamHome = await root();
    const store = new FileWebhookAttestationStore(agentTeamHome, { clock: clock(startMs) });
    const globalConfig = hostConfig("https://8.8.8.8/", "https://[2001:4860:4860::8888]/");
    const globalLookup = lookup(projectA, globalConfig);
    const unsafeLiteralUrls = [
      "https://127.0.0.1/",
      "https://2130706433/",
      "https://10.0.0.1/",
      "https://100.64.0.1/",
      "https://169.254.1.1/",
      "https://172.16.0.1/",
      "https://0.0.0.0/",
      "https://192.0.0.1/",
      "https://192.88.99.1/",
      "https://192.168.1.1/",
      "https://198.18.0.1/",
      "https://224.0.0.1/",
      "https://240.0.0.1/",
      "https://192.0.2.1/",
      "https://[::127.0.0.1]/",
      "https://[::ffff:127.0.0.1]/",
      "https://[::ffff:192.168.1.1]/",
      "https://[::ffff:0:127.0.0.1]/",
      "https://[64:ff9b::7f00:1]/",
      "https://[64:ff9b:1::7f00:1]/",
      "https://[100::1]/",
      "https://[100:0:0:1::1]/",
      "https://[::1]/",
      "https://[fd00::1]/",
      "https://[fe80::1]/",
      "https://[::]/",
      "https://[ff02::1]/",
      "https://[2001:db8::1]/",
      "https://[2001:2::1]/",
      "https://[2001:10::1]/",
      "https://[2002:7f00:1::1]/",
      "https://[3fff::1]/",
      "https://[5f00::1]/",
    ] as const;

    for (const unsafeUrl of unsafeLiteralUrls) {
      const secrets = secureSecrets();
      const probe = verifiedProbe();
      const unsafeConfig = hostConfig(unsafeUrl, globalConfig.webhookBaseUrls.linear);
      const unsafeLookup = lookup(projectA, unsafeConfig);
      const result = await stage(
        agentTeamHome,
        startMs,
        store,
        configReader(new Map([[projectA, unsafeConfig]])),
        probe,
        secrets,
      ).run({ signal: new AbortController().signal });

      expect(result, unsafeUrl).toEqual({ state: "degraded" });
      expect(secrets.calls(), unsafeUrl).toBe(0);
      expect(probe.requests(), unsafeUrl).toEqual([]);
      expect(await store.read(unsafeLookup), unsafeUrl).toEqual({
        ok: true,
        value: { state: "absent" },
      });
    }

    const globalSecrets = secureSecrets();
    const globalProbe = verifiedProbe();
    const globalResult = await stage(
      agentTeamHome,
      startMs,
      store,
      configReader(new Map([[projectA, globalConfig]])),
      globalProbe,
      globalSecrets,
    ).run({ signal: new AbortController().signal });

    expect(globalResult).toEqual({ state: "completed" });
    expect(globalSecrets.calls()).toBe(2);
    expect(globalProbe.requests().map((request) => request.baseUrl)).toEqual([
      globalConfig.webhookBaseUrls.github,
      globalConfig.webhookBaseUrls.linear,
    ]);
    expect(await store.read(globalLookup)).toMatchObject({
      ok: true,
      value: { state: "verified" },
    });
  });

  it("sorts registered projects by ID before probing and lets a degraded health stage continue the fixed cycle", async () => {
    const agentTeamHome = await root();
    const first = hostConfig("https://a-github.example.test/", "https://a-linear.example.test/");
    const second = hostConfig("https://b-github.example.test/", "https://b-linear.example.test/");
    const store = new FileWebhookAttestationStore(agentTeamHome, { clock: clock(startMs) });
    const probe = verifiedProbe();
    const result = await stage(
      agentTeamHome,
      startMs,
      store,
      configReader(
        new Map([
          [projectA, first],
          [projectB, second],
        ]),
      ),
      probe,
      secureSecrets(),
      projects([projectB, projectA]),
    ).run({ signal: new AbortController().signal });

    expect(result).toEqual({ state: "completed" });
    expect(probe.requests().map((request) => request.baseUrl)).toEqual([
      first.webhookBaseUrls.github,
      first.webhookBaseUrls.linear,
      second.webhookBaseUrls.github,
      second.webhookBaseUrls.linear,
    ]);
  });
});

describe("H02 authoritative, read-only webhook health reader", () => {
  it("requires every registered project globally while a detail reads only its own fresh attestation", async () => {
    const agentTeamHome = await root();
    const configA = hostConfig("https://a-github.example.test/", "https://a-linear.example.test/");
    const configB = hostConfig("https://b-github.example.test/", "https://b-linear.example.test/");
    const store = new FileWebhookAttestationStore(agentTeamHome, { clock: clock(startMs) });
    expect(await store.writeVerified(lookup(projectA, configA))).toMatchObject({ ok: true });
    expect(await store.writeVerified(lookup(projectB, configB))).toMatchObject({ ok: true });
    const configs = new Map([
      [projectA, configA],
      [projectB, configB],
    ]);
    const reads = vi.fn(store.read.bind(store));
    const reader = new WebhookAttestationHealthReader({
      projects: projects([projectB, projectA]),
      config: configReader(configs),
      store: { read: reads },
      clock: clock(startMs + 1),
    });
    const recordPath = join(
      agentTeamHome,
      "state",
      "health",
      "webhook-attestations",
      `attestation-${createHash("sha256")
        .update(JSON.stringify({ schemaVersion: 1, projectId: projectA }), "utf8")
        .digest("hex")}.json`,
    );
    const before = await readFile(recordPath, "utf8");

    expect(await reader.readGlobalWebhookWakeupState()).toBe("verified");
    expect(await reader.readProjectWebhookWakeupState(projectA)).toBe("verified");

    configs.set(
      projectB,
      hostConfig("https://drift-github.example.test/", "https://drift-linear.example.test/"),
    );
    expect(await reader.readGlobalWebhookWakeupState()).toBe("unhealthy");
    expect(await reader.readProjectWebhookWakeupState(projectA)).toBe("verified");
    expect(await readFile(recordPath, "utf8")).toBe(before);
    expect(reads).toHaveBeenCalled();
  });

  it("fails closed on near-expiry, future-clock, unavailable inventory, and durable read uncertainty without initiating a probe or write", async () => {
    const agentTeamHome = await root();
    const config = hostConfig();
    const writer = new FileWebhookAttestationStore(agentTeamHome, { clock: clock(startMs) });
    expect(await writer.writeVerified(lookup(projectA, config))).toMatchObject({ ok: true });

    const nearExpiry = new WebhookAttestationHealthReader({
      projects: projects([projectA]),
      config: configReader(new Map([[projectA, config]])),
      store: new FileWebhookAttestationStore(agentTeamHome, {
        clock: clock(startMs + webhookAttestationTtlMs - webhookAttestationRefreshWindowMs + 1),
      }),
      clock: clock(startMs + webhookAttestationTtlMs - webhookAttestationRefreshWindowMs + 1),
    });
    expect(await nearExpiry.readProjectWebhookWakeupState(projectA)).toBe("unhealthy");

    const rollback = new WebhookAttestationHealthReader({
      projects: projects([projectA]),
      config: configReader(new Map([[projectA, config]])),
      store: new FileWebhookAttestationStore(agentTeamHome, { clock: clock(startMs - 1) }),
      clock: clock(startMs - 1),
    });
    expect(await rollback.readProjectWebhookWakeupState(projectA)).toBe("unknown");

    const unknownStore = new WebhookAttestationHealthReader({
      projects: projects([projectA]),
      config: configReader(new Map([[projectA, config]])),
      store: { read: () => Promise.resolve(err(domainError("external_failure"))) },
      clock: clock(startMs + 1),
    });
    expect(await unknownStore.readProjectWebhookWakeupState(projectA)).toBe("unknown");

    const inventoryUnknown = new WebhookAttestationHealthReader({
      projects: unavailableProjects(),
      config: configReader(new Map([[projectA, config]])),
      store: new FileWebhookAttestationStore(agentTeamHome, { clock: clock(startMs + 1) }),
      clock: clock(startMs + 1),
    });
    expect(await inventoryUnknown.readGlobalWebhookWakeupState()).toBe("unknown");
  });
});
