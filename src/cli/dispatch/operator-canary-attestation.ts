/**
 * CLI and composition support for Q01's one-time operator canary.  It intentionally does not
 * construct quota samples or interact with quota policy: this is an exact issue-scoped gate that
 * only becomes relevant after ordinary quota admission has remained unavailable.
 */
import { join } from "node:path";

import { z } from "zod";

import { LocalGitAdapter } from "../../adapters/git/index.js";
import { ChildProcessRunner } from "../../adapters/process/index.js";
import { FileRegistrationSetupActivationRegistry } from "../../adapters/registration/index.js";
import type { DispatcherCandidate } from "../../application/dispatch/index.js";
import type { ProcessPort } from "../../application/ports/index.js";
import { ProjectRegistry, TrustedProjectConfigLoader } from "../../application/projects/index.js";
import type { CandidateObservation, ModelRoutingConfig } from "../../application/routing/index.js";
import { createClock, type Clock, type DomainError } from "../../domain/foundation/index.js";
import { projectIdSchema } from "../../domain/project/index.js";
import {
  FileOperatorCanaryAttestationStore,
  operatorCanaryScopeDigest,
  operatorCanaryVersionDigest,
  type OperatorCanaryAttestation,
  type OperatorCanaryInspection,
  type OperatorCanaryScope,
} from "../../adapters/dispatch/operator-canary-attestation-store.js";
import type { CliCommandOutcome } from "../program.js";
import {
  defaultRegistrationDraftPath,
  loadHostRegistrationSetupDraft,
} from "../registration/draft-store.js";
import { observeClaudeCliVersion } from "./claude-observation.js";
import {
  defaultDispatchProviderConfigPath,
  loadHostDispatchProviderConfig,
  type DispatchProviderConfig,
} from "./provider-config-store.js";

export const operatorCanaryConfirmationPhrase = "CONFIRM CLAUDE CANARY FOR 15 MINUTES" as const;
export const operatorCanaryMaximumStdinBytes = 4096;

const opaqueLinearIssueIdSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value),
    "linear external issue id must be exact opaque text",
  );
const scopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: projectIdSchema,
    linearExternalIssueId: opaqueLinearIssueIdSchema,
  })
  .strict();
const confirmInputSchema = scopeSchema
  .extend({ confirmation: z.literal(operatorCanaryConfirmationPhrase) })
  .strict();

type InputChunk = Uint8Array | string;

export type OperatorCanaryStorePort = Pick<
  FileOperatorCanaryAttestationStore,
  "inspect" | "consume"
>;

export interface OperatorCanaryPrerequisites {
  readonly projectId: string;
  readonly localRepositoryPath: string;
  readonly config: DispatchProviderConfig["claude"];
  readonly process: ProcessPort;
  readonly store: FileOperatorCanaryAttestationStore;
}

export interface CreateOperatorCanaryCliHandlersOptions {
  readonly agentTeamHome: string;
  readonly stdin?: AsyncIterable<InputChunk>;
  readonly clock?: Clock;
  readonly process?: ProcessPort;
  readonly store?: FileOperatorCanaryAttestationStore;
  readonly loadPrerequisites?: (
    input: OperatorCanaryScope,
  ) => Promise<OperatorCanaryPrerequisites | undefined>;
}

export interface OperatorCanaryCliHandlers {
  readonly canaryConfirm: () => Promise<CliCommandOutcome>;
  readonly canaryStatus: () => Promise<CliCommandOutcome>;
}

export type OperatorCanaryGateResult =
  | Readonly<{ state: "unavailable" }>
  | Readonly<{
      state: "consumed";
      candidate: DispatcherCandidate;
      routeObservations: readonly CandidateObservation[];
    }>;

function message(
  state: Extract<CliCommandOutcome["state"], "success" | "failed" | "blocked" | "rejected">,
  payload: Readonly<Record<string, unknown>>,
): CliCommandOutcome {
  return Object.freeze({ state, message: JSON.stringify(payload) });
}

async function readBoundedJson(
  stdin: AsyncIterable<InputChunk>,
): Promise<Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false }>> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of stdin) {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Uint8Array.from(chunk);
      total += bytes.byteLength;
      if (total > operatorCanaryMaximumStdinBytes) return Object.freeze({ ok: false });
      chunks.push(bytes);
    }
    if (total === 0) return Object.freeze({ ok: false });
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))),
    );
    const parsed: unknown = JSON.parse(decoded);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.freeze({ ok: true, value: parsed })
      : Object.freeze({ ok: false });
  } catch {
    return Object.freeze({ ok: false });
  }
}

async function loadRegisteredPrerequisites(
  agentTeamHome: string,
  scope: OperatorCanaryScope,
  process: ProcessPort,
  store: FileOperatorCanaryAttestationStore,
): Promise<OperatorCanaryPrerequisites | undefined> {
  const draft = await loadHostRegistrationSetupDraft(
    defaultRegistrationDraftPath(agentTeamHome, scope.projectId),
    scope.projectId,
  );
  if (!draft.ok) return undefined;
  const providerConfig = await loadHostDispatchProviderConfig(
    defaultDispatchProviderConfigPath(agentTeamHome),
  );
  if (!providerConfig.ok) return undefined;
  const registry = await new ProjectRegistry(
    new TrustedProjectConfigLoader(
      new LocalGitAdapter(),
      new FileRegistrationSetupActivationRegistry(join(agentTeamHome, "state")),
    ),
  ).load([draft.value.project]);
  const ready = registry.ready.find((entry) => entry.project.id === scope.projectId);
  return ready === undefined
    ? undefined
    : Object.freeze({
        projectId: ready.project.id,
        localRepositoryPath: ready.project.localRepositoryPath,
        config: providerConfig.value.claude,
        process,
        store,
      });
}

function storeFailure(
  operation: "operator_canary_confirm" | "operator_canary_status",
  error: DomainError,
): CliCommandOutcome {
  return error.code === "conflict" || error.code === "not_found"
    ? message("blocked", { operation, state: "blocked", reason: "attestation_unavailable" })
    : message("failed", { operation, state: "failed", reason: "attestation_store_failed" });
}

function remainingSeconds(
  attestation: OperatorCanaryAttestation,
  clock: Clock,
): number | undefined {
  const seconds = Math.ceil((Date.parse(attestation.expiresAt) - Date.parse(clock.now())) / 1000);
  return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 900 ? seconds : undefined;
}

function statusPayload(
  operation: "operator_canary_confirm" | "operator_canary_status",
  attestation: OperatorCanaryAttestation,
  clock: Clock,
): Readonly<Record<string, unknown>> | undefined {
  const scopeDigest = operatorCanaryScopeDigest(attestation);
  const versionDigest = operatorCanaryVersionDigest(attestation.claudeCliVersion);
  const remaining = remainingSeconds(attestation, clock);
  if (scopeDigest === undefined || versionDigest === undefined || remaining === undefined)
    return undefined;
  return Object.freeze({
    operation,
    state: "issued",
    source: "operator_canary",
    provider: "claude",
    ttlSeconds: 900,
    scopeDigest,
    versionDigest,
    expiresAt: attestation.expiresAt,
    ...(operation === "operator_canary_status" ? { remainingSeconds: remaining } : {}),
  });
}

function activeInspection(
  inspection: OperatorCanaryInspection,
): OperatorCanaryAttestation | undefined {
  return inspection.state === "issued" ? inspection.attestation : undefined;
}

/** Builds the two no-inline-argument canary CLI handlers.  Input parsing always completes before
 * project/config/file/process work begins, so rejected input has no observable side effect. */
export function createOperatorCanaryCliHandlers(
  options: CreateOperatorCanaryCliHandlersOptions,
): OperatorCanaryCliHandlers {
  const stdin = options.stdin ?? process.stdin;
  const clock = options.clock ?? createClock();
  const processPort = options.process ?? new ChildProcessRunner();
  const store =
    options.store ?? new FileOperatorCanaryAttestationStore(options.agentTeamHome, { clock });
  const load =
    options.loadPrerequisites ??
    ((scope: OperatorCanaryScope) =>
      loadRegisteredPrerequisites(options.agentTeamHome, scope, processPort, store));

  const prerequisites = async (
    scope: OperatorCanaryScope,
    operation: "operator_canary_confirm" | "operator_canary_status",
  ): Promise<OperatorCanaryPrerequisites | CliCommandOutcome> => {
    const loaded = await load(scope);
    return (
      loaded ??
      message("blocked", { operation, state: "blocked", reason: "prerequisite_unavailable" })
    );
  };

  return Object.freeze({
    async canaryConfirm() {
      const raw = await readBoundedJson(stdin);
      const input = raw.ok ? confirmInputSchema.safeParse(raw.value) : undefined;
      if (input?.success !== true) {
        return message("rejected", {
          operation: "operator_canary_confirm",
          state: "rejected",
          reason: "invalid_confirmation_input",
        });
      }
      const required = await prerequisites(input.data, "operator_canary_confirm");
      if ("state" in required) return required;
      if (required.projectId !== input.data.projectId) {
        return message("blocked", {
          operation: "operator_canary_confirm",
          state: "blocked",
          reason: "prerequisite_unavailable",
        });
      }
      const version = await observeClaudeCliVersion({
        process: required.process,
        config: required.config,
        workingDirectory: required.localRepositoryPath,
        clock,
      });
      if (version === undefined) {
        return message("blocked", {
          operation: "operator_canary_confirm",
          state: "blocked",
          reason: "claude_version_unavailable",
        });
      }
      const issued = await required.store.issue({
        projectId: input.data.projectId,
        linearExternalIssueId: input.data.linearExternalIssueId,
        claudeCliVersion: version,
      });
      if (!issued.ok) return storeFailure("operator_canary_confirm", issued.error);
      const readBack = await required.store.inspect(input.data);
      if (
        !readBack.ok ||
        readBack.value.state !== "issued" ||
        readBack.value.attestation.attestationId !== issued.value.attestationId
      ) {
        return readBack.ok
          ? message("failed", {
              operation: "operator_canary_confirm",
              state: "failed",
              reason: "attestation_readback_failed",
            })
          : storeFailure("operator_canary_confirm", readBack.error);
      }
      const payload = statusPayload("operator_canary_confirm", readBack.value.attestation, clock);
      return payload === undefined
        ? message("failed", {
            operation: "operator_canary_confirm",
            state: "failed",
            reason: "attestation_readback_failed",
          })
        : message("success", payload);
    },

    async canaryStatus() {
      const raw = await readBoundedJson(stdin);
      const input = raw.ok ? scopeSchema.safeParse(raw.value) : undefined;
      if (input?.success !== true) {
        return message("rejected", {
          operation: "operator_canary_status",
          state: "rejected",
          reason: "invalid_status_input",
        });
      }
      const required = await prerequisites(input.data, "operator_canary_status");
      if ("state" in required) return required;
      if (required.projectId !== input.data.projectId) {
        return message("blocked", {
          operation: "operator_canary_status",
          state: "blocked",
          reason: "prerequisite_unavailable",
        });
      }
      const version = await observeClaudeCliVersion({
        process: required.process,
        config: required.config,
        workingDirectory: required.localRepositoryPath,
        clock,
      });
      if (version === undefined) {
        return message("blocked", {
          operation: "operator_canary_status",
          state: "blocked",
          reason: "claude_version_unavailable",
        });
      }
      const inspected = await required.store.inspect(input.data);
      if (!inspected.ok) return storeFailure("operator_canary_status", inspected.error);
      const attestation = activeInspection(inspected.value);
      if (attestation?.claudeCliVersion !== version) {
        return message("blocked", {
          operation: "operator_canary_status",
          state: "blocked",
          reason: "attestation_unavailable",
        });
      }
      const payload = statusPayload("operator_canary_status", attestation, clock);
      return payload === undefined
        ? message("blocked", {
            operation: "operator_canary_status",
            state: "blocked",
            reason: "attestation_unavailable",
          })
        : message("success", payload);
    },
  });
}

function claudeRouteFor(
  routingConfig: ModelRoutingConfig,
  candidate: DispatcherCandidate,
  config: DispatchProviderConfig["claude"],
) {
  const role = candidate.issue.agentRole;
  if (candidate.workKind !== "model" || role === undefined) return undefined;
  const route = routingConfig.routes.find((entry) => entry.role === role);
  if (
    route?.candidates.some(
      (model) => model.provider === "claude" && config.models.includes(model.model),
    ) !== true
  ) {
    return undefined;
  }
  return route;
}

/**
 * Inspects only the discovered candidates, then consumes an exact active record before the caller
 * may claim admission.  It emits observations only for the exact candidate's route; every
 * non-Claude (and unconfigured Claude) candidate remains quota-unknown.
 */
export async function consumeExactOperatorCanaryCandidate(
  input: Readonly<{
    readonly store: OperatorCanaryStorePort;
    readonly projectId: string;
    readonly candidates: readonly DispatcherCandidate[];
    readonly routingConfig: ModelRoutingConfig;
    readonly claude: Readonly<{
      config: DispatchProviderConfig["claude"];
      process: ProcessPort;
      workingDirectory: string;
    }>;
    readonly clock?: Clock;
  }>,
): Promise<OperatorCanaryGateResult> {
  const matches: Readonly<{
    candidate: DispatcherCandidate;
    attestation: OperatorCanaryAttestation;
    route: NonNullable<ReturnType<typeof claudeRouteFor>>;
  }>[] = [];
  for (const candidate of input.candidates) {
    if (candidate.issue.projectId !== input.projectId) {
      return Object.freeze({ state: "unavailable" as const });
    }
    const route = claudeRouteFor(input.routingConfig, candidate, input.claude.config);
    if (route === undefined) continue;
    const inspected = await input.store.inspect({
      projectId: input.projectId,
      linearExternalIssueId: candidate.issue.externalId,
    });
    if (!inspected.ok) return Object.freeze({ state: "unavailable" as const });
    const attestation = activeInspection(inspected.value);
    if (attestation !== undefined) matches.push(Object.freeze({ candidate, attestation, route }));
  }
  if (matches.length !== 1) return Object.freeze({ state: "unavailable" as const });
  const match = matches[0];
  if (match === undefined) return Object.freeze({ state: "unavailable" as const });
  const version = await observeClaudeCliVersion({
    process: input.claude.process,
    config: input.claude.config,
    workingDirectory: input.claude.workingDirectory,
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
  if (version === undefined || version !== match.attestation.claudeCliVersion) {
    return Object.freeze({ state: "unavailable" as const });
  }
  const consumed = await input.store.consume({
    projectId: input.projectId,
    linearExternalIssueId: match.candidate.issue.externalId,
    claudeCliVersion: version,
    attestationId: match.attestation.attestationId,
    expectedRevision: match.attestation.revision,
  });
  if (!consumed.ok) return Object.freeze({ state: "unavailable" as const });
  const routeObservations = Object.freeze(
    match.route.candidates.map((candidate) =>
      Object.freeze({
        provider: candidate.provider,
        model: candidate.model,
        state:
          candidate.provider === "claude" && input.claude.config.models.includes(candidate.model)
            ? ("ready" as const)
            : ("quota_unknown" as const),
      }),
    ),
  );
  return Object.freeze({
    state: "consumed" as const,
    candidate: match.candidate,
    routeObservations,
  });
}

/** A narrow helper used by composition to keep the normal route unmodified whenever a normal
 * model candidate is already eligible for admission. */
export function hasNormalModelAdmissionCandidate(
  candidates: readonly DispatcherCandidate[],
  routingConfig: ModelRoutingConfig,
  observations: readonly CandidateObservation[],
): boolean {
  const observationByIdentity = new Map(
    observations.map((observation) => [
      `${observation.provider}:${observation.model}`,
      observation.state,
    ]),
  );
  return candidates.some((candidate) => {
    if (candidate.workKind !== "model" || candidate.issue.agentRole === undefined) return false;
    const route = routingConfig.routes.find((entry) => entry.role === candidate.issue.agentRole);
    return (
      route?.candidates.some(
        (model) => observationByIdentity.get(`${model.provider}:${model.model}`) === "ready",
      ) === true
    );
  });
}
