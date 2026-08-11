import type { DispatcherCandidate } from "../../application/dispatch/index.js";
import type {
  NewJobQuotaAdmissionPort,
  NewJobQuotaDecision,
} from "../../application/quota/index.js";
import type {
  CandidateObservation,
  ModelCandidate,
  ModelProvider,
  ModelRoutingConfig,
} from "../../application/routing/index.js";

export function createFailClosedNewJobQuotaAdmission(): NewJobQuotaAdmissionPort {
  return Object.freeze({
    resolve: () =>
      Promise.resolve(
        Object.freeze({ state: "quota_unknown" as const, reason: "collector_unavailable" }),
      ),
  });
}

function identity(candidate: ModelCandidate): string {
  return `${candidate.provider}:${candidate.model}`;
}

function safeDecisionState(value: unknown): NewJobQuotaDecision["state"] {
  if (typeof value !== "object" || value === null) return "quota_unknown";
  const record = value as Record<string, unknown>;
  const state = record["state"];
  const reason = record["reason"];
  return (state === "ready" ||
    state === "provider_unavailable" ||
    state === "quota_blocked" ||
    state === "quota_unknown") &&
    typeof reason === "string" &&
    reason.trim().length > 0
    ? state
    : "quota_unknown";
}

function relevantModelCandidates(
  routingConfig: ModelRoutingConfig,
  candidates: readonly DispatcherCandidate[],
): readonly ModelCandidate[] {
  const modelRoles = new Set(
    candidates
      .filter((candidate) => candidate.workKind === "model")
      .map((candidate) => candidate.issue.agentRole)
      .filter((role) => role !== undefined),
  );
  const seen = new Set<string>();
  const relevant: ModelCandidate[] = [];
  for (const route of routingConfig.routes) {
    if (!modelRoles.has(route.role)) continue;
    for (const candidate of route.candidates) {
      const key = identity(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      relevant.push(candidate);
    }
  }
  return Object.freeze(relevant);
}

/**
 * Resolves quota once per Provider for this dispatch invocation, then projects that decision onto
 * every configured model candidate. Rejections are data, not thrown failures, and remain
 * fail-closed as `quota_unknown`.
 */
export async function observeQuotaRouteCandidates(
  input: Readonly<{
    routingConfig: ModelRoutingConfig;
    candidates: readonly DispatcherCandidate[];
    quota: NewJobQuotaAdmissionPort;
  }>,
): Promise<readonly CandidateObservation[]> {
  const decisions = new Map<ModelProvider, ReturnType<NewJobQuotaAdmissionPort["resolve"]>>();
  const resolve = (provider: ModelProvider) => {
    const existing = decisions.get(provider);
    if (existing !== undefined) return existing;
    const pending = Promise.resolve()
      .then(() => input.quota.resolve(provider))
      .then((decision) =>
        Object.freeze({
          state: safeDecisionState(decision),
          reason: "quota_admission_observed",
        }),
      )
      .catch(() =>
        Object.freeze({
          state: "quota_unknown" as const,
          reason: "quota_admission_failed",
        }),
      );
    decisions.set(provider, pending);
    return pending;
  };

  return Object.freeze(
    await Promise.all(
      relevantModelCandidates(input.routingConfig, input.candidates).map(async (candidate) => {
        const decision = await resolve(candidate.provider);
        return Object.freeze({
          ...candidate,
          state: decision.state,
        });
      }),
    ),
  );
}

/** Quota can only downgrade admission. Liveness is consulted solely for quota-ready candidates. */
export function applyProviderLiveness(
  quotaObservations: readonly CandidateObservation[],
  livenessObservations: readonly CandidateObservation[],
): readonly CandidateObservation[] {
  const liveness = new Map(
    livenessObservations.map((observation) => [identity(observation), observation.state]),
  );
  return Object.freeze(
    quotaObservations.map((observation) =>
      observation.state !== "ready"
        ? observation
        : Object.freeze({
            provider: observation.provider,
            model: observation.model,
            state: liveness.get(identity(observation)) ?? ("provider_unavailable" as const),
          }),
    ),
  );
}
