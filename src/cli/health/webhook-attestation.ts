import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { join } from "node:path";

import { LocalGitAdapter } from "../../adapters/git/index.js";
import {
  FileRegistrationSetupActivationRegistry,
  RegistrationProbeWebhookAdapter,
} from "../../adapters/registration/index.js";
import { ProjectRegistry, TrustedProjectConfigLoader } from "../../application/projects/index.js";
import type { RegistrationWebhookProbePort } from "../../application/ports/index.js";
import type { RegistrationWebhookWakeupState } from "../../application/registration/index.js";
import { createClock, type Clock } from "../../domain/foundation/index.js";
import { projectIdSchema } from "../../domain/project/index.js";
import { DurableInbox } from "../../infrastructure/events/index.js";
import type { ControllerCycleStage, ControllerCycleStageContext } from "../cycle/index.js";
import type { WebhookRuntimeTransport } from "../probe/index.js";
import {
  defaultRegistrationProbeConfigPath,
  loadHostRegistrationProbeConfig,
  readSecretFile,
  type LoadHostRegistrationProbeConfigResult,
  type ReadSecretFileResult,
} from "../registration/index.js";
import { listHostRegistrationSetupDrafts } from "../registration/draft-store.js";

import {
  FileWebhookAttestationStore,
  webhookAttestationLookupForConfig,
  webhookAttestationTtlMs,
  type WebhookAttestationInspection,
  type WebhookAttestationLookup,
} from "./webhook-attestation-store.js";

/** A refresh occurs strictly below this remaining lifetime; exactly five minutes remains valid. */
export const webhookAttestationRefreshWindowMs = 5 * 60_000;
const maximumWebhookProbeLatencyMs = 2_000;

/**
 * Stable operator-facing scope for the `verified` webhook source. It deliberately does not
 * claim a provider-side subscription read-back: that remains a separate Registration/live canary
 * gate.
 */
export const webhookAttestationVerificationScope =
  "transport_runtime_ingest_inbox_only_not_provider_subscription";

const maximumRegisteredProjects = 10_000;
const ipv4CompatibleIpv6Prefix = Object.freeze(Array<number>(12).fill(0));
const ipv4TranslatedIpv6Prefix = Object.freeze([
  ...Array<number>(8).fill(0),
  0xff,
  0xff,
  0x00,
  0x00,
]);
const nat64WellKnownIpv6Prefix = Object.freeze([
  0x00,
  0x64,
  0xff,
  0x9b,
  ...Array<number>(8).fill(0),
]);
const nat64LocalUseIpv6Prefix = Object.freeze([0x00, 0x64, 0xff, 0x9b, 0x00, 0x01]);

export type RegisteredWebhookProjectListing =
  | Readonly<{ state: "available"; projectIds: readonly string[] }>
  | Readonly<{ state: "unavailable" }>;

/** Local, read-only source of projects whose trusted configuration and activation both verify. */
export interface RegisteredWebhookProjectReader {
  readonly listRegisteredProjectIds: () => Promise<RegisteredWebhookProjectListing>;
}

/** The global health endpoint needs this reader; project detail needs the project-scoped method. */
export interface GlobalWebhookWakeupStateReader {
  readonly readGlobalWebhookWakeupState: () => Promise<RegistrationWebhookWakeupState>;
}

export interface ProjectWebhookWakeupStateReader {
  readonly readProjectWebhookWakeupState: (
    projectId: string,
  ) => Promise<RegistrationWebhookWakeupState>;
}

export interface WebhookAttestationConfigReader {
  readonly load: (projectId: string) => Promise<LoadHostRegistrationProbeConfigResult>;
}

export interface WebhookAttestationSecretReader {
  readonly read: (filePath: string) => Promise<ReadSecretFileResult>;
}

export interface WebhookAttestationHealthReaderOptions {
  readonly projects: RegisteredWebhookProjectReader;
  readonly config: WebhookAttestationConfigReader;
  readonly store: Pick<FileWebhookAttestationStore, "read">;
  readonly clock?: Clock;
}

export interface CreateWebhookAttestationRefreshStageOptions {
  readonly projects: RegisteredWebhookProjectReader;
  readonly config: WebhookAttestationConfigReader;
  readonly secrets: WebhookAttestationSecretReader;
  readonly probe: RegistrationWebhookProbePort;
  readonly store: Pick<FileWebhookAttestationStore, "read" | "writeVerified">;
  readonly clock: Clock;
  readonly agentTeamHome: string;
}

export interface CreateWebhookAttestationRuntimeOptions {
  readonly agentTeamHome: string;
  readonly clock?: Clock;
  readonly transport?: WebhookRuntimeTransport;
  readonly createDeliveryId?: () => string;
}

export interface WebhookAttestationRuntime {
  readonly reader: WebhookAttestationHealthReader;
  readonly stage: ControllerCycleStage;
}

function unavailableRegisteredProjects(): RegisteredWebhookProjectListing {
  return Object.freeze({ state: "unavailable" });
}

function validProjectIds(value: unknown): readonly string[] | undefined {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    !Number.isSafeInteger(value.length) ||
    value.length > maximumRegisteredProjects
  ) {
    return undefined;
  }
  const ownNames = Object.getOwnPropertyNames(value);
  if (
    ownNames.length !== value.length + 1 ||
    !ownNames.includes("length") ||
    ownNames.some((name) => name !== "length" && !/^(?:0|[1-9]\d*)$/u.test(name))
  ) {
    return undefined;
  }

  const ids: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return undefined;
    }
    const parsed = projectIdSchema.safeParse(descriptor.value);
    if (!parsed.success) return undefined;
    ids.push(parsed.data);
  }
  const sorted = [...ids].sort((left, right) => left.localeCompare(right));
  return new Set(sorted).size === sorted.length ? Object.freeze(sorted) : undefined;
}

/**
 * Uses the same trusted registration definition as the existing Project read model. Any rejected
 * draft prevents a global green result, because a partial inventory cannot establish that *all*
 * registered projects have current evidence.
 */
export class HostRegisteredWebhookProjectReader implements RegisteredWebhookProjectReader {
  constructor(
    readonly options: Readonly<{
      discoverDrafts: () => ReturnType<typeof listHostRegistrationSetupDrafts>;
      registry: Pick<ProjectRegistry, "load">;
    }>,
  ) {}

  async listRegisteredProjectIds(): Promise<RegisteredWebhookProjectListing> {
    try {
      const discovery = await this.options.discoverDrafts();
      if (discovery.state !== "available" || discovery.rejectedDraftCount !== 0) {
        return unavailableRegisteredProjects();
      }
      const snapshot = await this.options.registry.load(
        discovery.drafts.map((draft) => draft.project),
      );
      if (snapshot.rejected.length !== 0) return unavailableRegisteredProjects();
      const projectIds = validProjectIds(snapshot.ready.map((entry) => entry.project.id));
      return projectIds === undefined
        ? unavailableRegisteredProjects()
        : Object.freeze({ state: "available" as const, projectIds });
    } catch {
      return unavailableRegisteredProjects();
    }
  }
}

function parseIpv4Address(value: string): readonly number[] | undefined {
  const octets = value.split(".");
  if (octets.length !== 4 || !octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/u.test(octet))) {
    return undefined;
  }
  const parsed = octets.map(Number);
  return parsed.some((octet) => !Number.isSafeInteger(octet) || octet > 255)
    ? undefined
    : Object.freeze(parsed);
}

function parseIpv6Groups(value: string): readonly number[] | undefined {
  if (value === "") return Object.freeze([]);
  const sections = value.split(":");
  const groups: number[] = [];
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    if (section === undefined) return undefined;
    if (section.includes(".")) {
      if (index !== sections.length - 1) return undefined;
      const ipv4 = parseIpv4Address(section);
      if (ipv4 === undefined) return undefined;
      const [first, second, third, fourth] = ipv4;
      if (
        first === undefined ||
        second === undefined ||
        third === undefined ||
        fourth === undefined
      ) {
        return undefined;
      }
      groups.push((first << 8) | second, (third << 8) | fourth);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/iu.test(section)) return undefined;
    groups.push(Number.parseInt(section, 16));
  }
  return Object.freeze(groups);
}

/** Parses an already `node:net.isIP(...)=6` literal into bytes without DNS resolution. */
function parseIpv6Address(value: string): Uint8Array | undefined {
  const halves = value.split("::");
  if (halves.length > 2) return undefined;
  const left = parseIpv6Groups(halves[0] ?? "");
  const right = halves.length === 2 ? parseIpv6Groups(halves[1] ?? "") : Object.freeze([]);
  if (left === undefined || right === undefined) return undefined;

  const missingGroups = 8 - left.length - right.length;
  if ((halves.length === 1 && missingGroups !== 0) || (halves.length === 2 && missingGroups < 1)) {
    return undefined;
  }
  const groups = [...left, ...Array<number>(missingGroups).fill(0), ...right];
  if (groups.length !== 8) return undefined;

  const bytes = new Uint8Array(16);
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (group === undefined || !Number.isSafeInteger(group) || group < 0 || group > 0xffff) {
      return undefined;
    }
    bytes[index * 2] = group >>> 8;
    bytes[index * 2 + 1] = group & 0xff;
  }
  return bytes;
}

function hasIpPrefix(bytes: Uint8Array, prefix: readonly number[], bits: number): boolean {
  if (!Number.isSafeInteger(bits) || bits < 0 || bits > bytes.length * 8) return false;
  const fullBytes = Math.floor(bits / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  const partialBits = bits % 8;
  if (partialBits === 0) return true;
  const actual = bytes[fullBytes];
  const expected = prefix[fullBytes];
  if (actual === undefined || expected === undefined) return false;
  const mask = (0xff << (8 - partialBits)) & 0xff;
  return (actual & mask) === (expected & mask);
}

/** A conservative no-DNS policy: only ordinary globally routable IPv4 unicast is probeable. */
function isGlobalIpv4(address: readonly number[]): boolean {
  const [first, second, third] = address;
  if (first === undefined || second === undefined || third === undefined) return false;
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && second === 0) return false;
  if (first === 192 && second === 31 && third === 196) return false;
  if (first === 192 && second === 88 && third === 99) return false;
  if (first === 192 && second === 168) return false;
  if (first === 192 && second === 175 && third === 48) return false;
  if (first === 198 && (second === 18 || second === 19)) return false;
  if (first === 198 && second === 51 && third === 100) return false;
  if (first === 203 && second === 0 && third === 113) return false;
  return true;
}

/**
 * Only globally routable IPv6 unicast is accepted. All standard IPv4 embedding/translation
 * prefixes are intentionally rejected as special literal targets, regardless of their payload.
 */
function isGlobalIpv6(address: Uint8Array): boolean {
  const ipv4Compatible = hasIpPrefix(address, ipv4CompatibleIpv6Prefix, 96);
  const ipv4Translated = hasIpPrefix(address, ipv4TranslatedIpv6Prefix, 96);
  const nat64WellKnown = hasIpPrefix(address, nat64WellKnownIpv6Prefix, 96);
  const nat64LocalUse = hasIpPrefix(address, nat64LocalUseIpv6Prefix, 48);
  if (ipv4Compatible || ipv4Translated || nat64WellKnown || nat64LocalUse) {
    return false;
  }

  // Global unicast is 2000::/3. This excludes loopback, ULA, link-local, multicast,
  // unspecified, reserved, and unallocated classes before checking special allocations inside it.
  if (!hasIpPrefix(address, [0x20], 3)) return false;
  return !(
    hasIpPrefix(address, [0x20, 0x01, 0x00], 23) || // IETF protocol assignments / Teredo / ORCHID
    hasIpPrefix(address, [0x20, 0x01, 0x0d, 0xb8], 32) || // documentation
    hasIpPrefix(address, [0x20, 0x02], 16) || // 6to4 translation
    hasIpPrefix(address, [0x26, 0x20, 0x00, 0x4f, 0x80, 0x00], 48) || // AS112
    hasIpPrefix(address, [0x3f, 0xfe], 16) || // deprecated 6bone
    hasIpPrefix(address, [0x3f, 0xff, 0x00], 20) || // documentation
    hasIpPrefix(address, [0x5f, 0x00], 16) // SRv6 local-use SID allocation
  );
}

function isGlobalLiteralIp(hostname: string): boolean | undefined {
  const family = isIP(hostname);
  if (family === 0) return undefined;
  if (family === 4) {
    const address = parseIpv4Address(hostname);
    return address !== undefined && isGlobalIpv4(address);
  }
  if (family === 6) {
    const address = parseIpv6Address(hostname);
    return address !== undefined && isGlobalIpv6(address);
  }
  return false;
}

function validPublicHttpsBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      (url.pathname !== "/" && url.pathname !== "")
    ) {
      return false;
    }
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
    if (hostname === "" || hostname === "localhost" || hostname.endsWith(".localhost")) {
      return false;
    }
    const literalIp = isGlobalLiteralIp(hostname);
    return literalIp ?? true;
  } catch {
    return false;
  }
}

function lookupForConfig(
  projectId: string,
  loaded: LoadHostRegistrationProbeConfigResult,
): WebhookAttestationLookup | undefined {
  const parsedProjectId = projectIdSchema.safeParse(projectId);
  if (!loaded.ok || !parsedProjectId.success) return undefined;
  const config = Object.freeze({
    projectId: parsedProjectId.data,
    webhookBaseUrls: loaded.value.webhookBaseUrls,
  });
  if (
    !validPublicHttpsBaseUrl(config.webhookBaseUrls.github) ||
    !validPublicHttpsBaseUrl(config.webhookBaseUrls.linear)
  ) {
    return undefined;
  }
  return webhookAttestationLookupForConfig(config);
}

function inspectionState(
  inspection: WebhookAttestationInspection,
  nowMs: number,
): RegistrationWebhookWakeupState {
  if (inspection.state !== "verified") return "unhealthy";
  const verifiedAt = Date.parse(inspection.attestation.verifiedAt);
  const expiresAt = Date.parse(inspection.attestation.expiresAt);
  if (
    !Number.isFinite(verifiedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt - verifiedAt !== webhookAttestationTtlMs ||
    verifiedAt > nowMs
  ) {
    return "unknown";
  }
  if (nowMs >= expiresAt) return "unhealthy";
  return expiresAt - nowMs < webhookAttestationRefreshWindowMs ? "unhealthy" : "verified";
}

/**
 * A durable-evidence reader only. It never asks the Runtime to probe and never creates a
 * directory, lock, or record; all uncertainty remains `unknown`/`unhealthy`.
 */
export class WebhookAttestationHealthReader
  implements GlobalWebhookWakeupStateReader, ProjectWebhookWakeupStateReader
{
  readonly #clock: Clock;

  constructor(readonly options: WebhookAttestationHealthReaderOptions) {
    this.#clock = options.clock ?? createClock();
  }

  async readProjectWebhookWakeupState(projectId: string): Promise<RegistrationWebhookWakeupState> {
    try {
      const lookup = lookupForConfig(projectId, await this.options.config.load(projectId));
      if (lookup === undefined) return "unconfigured";
      const inspection = await this.options.store.read(lookup);
      const nowMs = currentTimeMs(this.#clock);
      return inspection.ok && nowMs !== undefined
        ? inspectionState(inspection.value, nowMs)
        : "unknown";
    } catch {
      return "unknown";
    }
  }

  async readGlobalWebhookWakeupState(): Promise<RegistrationWebhookWakeupState> {
    try {
      const listed = await this.options.projects.listRegisteredProjectIds();
      const projectIds =
        listed.state === "available" ? validProjectIds(listed.projectIds) : undefined;
      if (projectIds === undefined) return "unknown";
      if (projectIds.length === 0) return "unconfigured";

      let aggregate: RegistrationWebhookWakeupState = "verified";
      for (const projectId of projectIds) {
        const state = await this.readProjectWebhookWakeupState(projectId);
        if (state === "unknown") return "unknown";
        if (state === "unhealthy") aggregate = "unhealthy";
        else if (state === "unconfigured" && aggregate === "verified") aggregate = "unconfigured";
      }
      return aggregate;
    } catch {
      return "unknown";
    }
  }
}

function currentTimeMs(clock: Clock): number | undefined {
  try {
    const value = Date.parse(clock.now());
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function refreshRequired(
  inspection: WebhookAttestationInspection,
  nowMs: number,
): boolean | undefined {
  if (inspection.state !== "verified") return true;
  const verifiedAt = Date.parse(inspection.attestation.verifiedAt);
  const expiresAt = Date.parse(inspection.attestation.expiresAt);
  if (
    !Number.isFinite(verifiedAt) ||
    !Number.isFinite(expiresAt) ||
    verifiedAt > nowMs ||
    nowMs >= expiresAt ||
    expiresAt - verifiedAt !== webhookAttestationTtlMs
  ) {
    return undefined;
  }
  return expiresAt - nowMs < webhookAttestationRefreshWindowMs;
}

type RefreshProjectOutcome = "verified" | "degraded" | "interrupted";

function cycleInterrupted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function isExactDataObject(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    return false;
  }
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== expectedKeys.length || !expectedKeys.every((key) => names.includes(key))) {
    return false;
  }
  return expectedKeys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
  });
}

function verifiedProbeOutcome(value: unknown, provider: "github" | "linear"): boolean {
  if (
    !isExactDataObject(value, ["state", "provider", "deliveryId", "latencyMs", "inboxSha256"]) ||
    value["state"] !== "verified" ||
    value["provider"] !== provider ||
    typeof value["deliveryId"] !== "string" ||
    value["deliveryId"].length === 0 ||
    value["deliveryId"].length > 512 ||
    typeof value["latencyMs"] !== "number" ||
    !Number.isFinite(value["latencyMs"]) ||
    value["latencyMs"] < 0 ||
    value["latencyMs"] > maximumWebhookProbeLatencyMs ||
    typeof value["inboxSha256"] !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value["inboxSha256"])
  ) {
    return false;
  }
  return true;
}

class WebhookAttestationRefreshStage implements ControllerCycleStage {
  readonly id = "webhook_health" as const;

  constructor(readonly options: CreateWebhookAttestationRefreshStageOptions) {}

  async run(context: ControllerCycleStageContext) {
    try {
      const listed = await this.options.projects.listRegisteredProjectIds();
      const projectIds =
        listed.state === "available" ? validProjectIds(listed.projectIds) : undefined;
      if (projectIds === undefined) return Object.freeze({ state: "degraded" as const });

      let degraded = false;
      for (const projectId of projectIds) {
        if (cycleInterrupted(context.signal)) return Object.freeze({ state: "completed" as const });
        const refreshed = await this.#refreshProject(projectId, context.signal);
        if (refreshed === "interrupted") return Object.freeze({ state: "completed" as const });
        if (refreshed === "degraded") degraded = true;
      }
      return Object.freeze({ state: degraded ? ("degraded" as const) : ("completed" as const) });
    } catch {
      return Object.freeze({ state: "degraded" as const });
    }
  }

  async #refreshProject(projectId: string, signal: AbortSignal): Promise<RefreshProjectOutcome> {
    const config = await this.options.config.load(projectId);
    if (!config.ok) return "degraded";
    const lookup = lookupForConfig(projectId, config);
    if (lookup === undefined) return "degraded";

    const nowMs = currentTimeMs(this.options.clock);
    if (nowMs === undefined) return "degraded";
    const inspected = await this.options.store.read(lookup);
    if (!inspected.ok) return "degraded";
    const shouldRefresh = refreshRequired(inspected.value, nowMs);
    if (shouldRefresh === undefined) return "degraded";
    if (!shouldRefresh) return "verified";
    if (cycleInterrupted(signal)) return "interrupted";

    const [githubSecret, linearSecret] = await Promise.all([
      this.options.secrets.read(
        join(this.options.agentTeamHome, "secrets", "github-webhook-secret"),
      ),
      this.options.secrets.read(
        join(this.options.agentTeamHome, "secrets", "linear-webhook-secret"),
      ),
    ]);
    if (!githubSecret.ok || !linearSecret.ok) return "degraded";

    const probes = [
      Object.freeze({
        provider: "github" as const,
        baseUrl: config.value.webhookBaseUrls.github,
        secret: githubSecret.value,
      }),
      Object.freeze({
        provider: "linear" as const,
        baseUrl: config.value.webhookBaseUrls.linear,
        secret: linearSecret.value,
      }),
    ];
    for (const request of probes) {
      if (cycleInterrupted(signal)) return "interrupted";
      let outcome: Awaited<ReturnType<RegistrationWebhookProbePort["runSyntheticProbe"]>>;
      try {
        outcome = await this.options.probe.runSyntheticProbe(request);
      } catch {
        return "degraded";
      }
      if (!verifiedProbeOutcome(outcome, request.provider)) return "degraded";
    }
    if (cycleInterrupted(signal)) return "interrupted";
    try {
      const written = await this.options.store.writeVerified(lookup);
      return written.ok ? "verified" : "degraded";
    } catch {
      return "degraded";
    }
  }
}

export function createWebhookAttestationRefreshStage(
  options: CreateWebhookAttestationRefreshStageOptions,
): ControllerCycleStage {
  return new WebhookAttestationRefreshStage(options);
}

/**
 * Production-only composition. The cycle stage receives the existing signed probe adapter and
 * exactly the Inbox that the local ingest handler uses; the returned reader remains read-only.
 */
export function createWebhookAttestationRuntime(
  options: CreateWebhookAttestationRuntimeOptions,
): WebhookAttestationRuntime {
  const clock = options.clock ?? createClock();
  const stateRoot = join(options.agentTeamHome, "state");
  const activation = new FileRegistrationSetupActivationRegistry(stateRoot);
  const projects = new HostRegisteredWebhookProjectReader({
    discoverDrafts: () => listHostRegistrationSetupDrafts(options.agentTeamHome),
    registry: new ProjectRegistry(
      new TrustedProjectConfigLoader(new LocalGitAdapter(), activation),
    ),
  });
  const config: WebhookAttestationConfigReader = Object.freeze({
    load: (projectId: string) =>
      loadHostRegistrationProbeConfig(
        defaultRegistrationProbeConfigPath(options.agentTeamHome, projectId),
      ),
  });
  const secrets: WebhookAttestationSecretReader = Object.freeze({ read: readSecretFile });
  const store = new FileWebhookAttestationStore(options.agentTeamHome, { clock });
  const probe = new RegistrationProbeWebhookAdapter({
    ...(options.transport === undefined ? {} : { transport: options.transport }),
    inbox: new DurableInbox(join(stateRoot, "inbox")),
    clock,
    createDeliveryId: options.createDeliveryId ?? (() => randomUUID()),
  });
  return Object.freeze({
    reader: new WebhookAttestationHealthReader({ projects, config, store, clock }),
    stage: createWebhookAttestationRefreshStage({
      projects,
      config,
      secrets,
      probe,
      store,
      clock,
      agentTeamHome: options.agentTeamHome,
    }),
  });
}
