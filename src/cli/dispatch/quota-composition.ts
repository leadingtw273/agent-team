import {
  createCodexQuotaCollector,
  type CodexQuotaCollector,
  type CodexQuotaDiagnosticResult,
} from "../../adapters/providers/codex/index.js";
import type { PlatformIdentity, QuotaPort, QuotaSnapshot } from "../../application/ports/index.js";
import {
  PolicyBackedNewJobQuotaAdmission,
  type NewJobQuotaAdmissionPort,
  type QuotaRuntimeContextPort,
} from "../../application/quota/index.js";
import {
  createClock,
  domainError,
  err,
  ok,
  type Clock,
  type Instant,
} from "../../domain/foundation/index.js";
import {
  defaultQuotaHostConfigPath,
  readQuotaHostConfig,
  type QuotaHostConfig,
} from "../quota/index.js";
import { createFailClosedNewJobQuotaAdmission } from "./quota-admission.js";

type CodexPartialResult = Extract<CodexQuotaDiagnosticResult, { state: "partial" }>;
type CodexUsableResult = CodexPartialResult & {
  readonly buckets: CodexPartialResult["buckets"] & {
    readonly weekly: NonNullable<CodexPartialResult["buckets"]["weekly"]>;
  };
};

function usable(result: CodexQuotaDiagnosticResult): result is CodexUsableResult {
  return result.state === "partial" && result.buckets.weekly !== undefined;
}

function snapshot(result: CodexUsableResult): QuotaSnapshot {
  const identity = Object.freeze({
    provider: "codex",
    accountFingerprint: result.accountFingerprint,
  });
  const sample = (
    bucket: "weekly" | "five_hour",
    value: Readonly<{ remainingPercent: number; resetsAt: Instant }>,
  ) =>
    Object.freeze({
      ...identity,
      cliVersion: result.cliVersion,
      source: result.provenance,
      observedAt: result.observedAt,
      kind: "usage" as const,
      bucket,
      state: "confirmed" as const,
      remainingPercent: value.remainingPercent,
      resetsAt: value.resetsAt,
    });
  return Object.freeze({
    ...identity,
    samples: Object.freeze([
      sample("weekly", result.buckets.weekly),
      ...(result.buckets.fiveHour === undefined
        ? []
        : [sample("five_hour", result.buckets.fiveHour)]),
    ]),
  });
}

/** One process-local authoritative App Server epoch, shared by context and quota reads. */
class CodexQuotaEpochBridge implements QuotaRuntimeContextPort, QuotaPort {
  readonly #collector: CodexQuotaCollector;
  readonly #config: QuotaHostConfig["codex"];
  #inFlight: Promise<CodexUsableResult | undefined> | undefined;
  #latest: CodexUsableResult | undefined;

  constructor(collector: CodexQuotaCollector, config: QuotaHostConfig["codex"]) {
    this.#collector = collector;
    this.#config = config;
  }

  async #collect(): Promise<CodexUsableResult | undefined> {
    if (this.#inFlight !== undefined) return this.#inFlight;
    const epoch = this.#collector
      .collect({ expectedCliVersion: this.#config.expectedCliVersion })
      .then((result) => {
        const accepted = usable(result) ? result : undefined;
        this.#latest = accepted;
        return accepted;
      })
      .catch(() => {
        this.#latest = undefined;
        return undefined;
      })
      .finally(() => {
        this.#inFlight = undefined;
      });
    this.#inFlight = epoch;
    return epoch;
  }

  async observe(provider: string) {
    if (provider !== "codex") return err(domainError("unavailable"));
    const result = await this.#collect();
    return result === undefined
      ? err(domainError("unavailable"))
      : ok(
          Object.freeze({
            identity: Object.freeze({
              provider: "codex",
              accountFingerprint: result.accountFingerprint,
            }),
            cliVersion: result.cliVersion,
          }),
        );
  }

  readCached(identity: PlatformIdentity) {
    const result = this.#latest;
    return Promise.resolve(
      result !== undefined &&
        identity.provider === "codex" &&
        identity.accountFingerprint === result.accountFingerprint
        ? ok(snapshot(result))
        : err(domainError("not_found")),
    );
  }

  async refresh(provider: string) {
    if (provider !== "codex") return err(domainError("unavailable"));
    this.#latest = undefined;
    const result = await this.#collect();
    return result === undefined ? err(domainError("unavailable")) : ok(snapshot(result));
  }
}

export interface CreateProductionQuotaAdmissionOptions {
  readonly agentTeamHome: string;
  readonly codexExecutable?: string;
  readonly clock?: Clock;
  readonly collector?: CodexQuotaCollector;
}

export async function createProductionQuotaAdmission(
  options: CreateProductionQuotaAdmissionOptions,
): Promise<NewJobQuotaAdmissionPort> {
  const config = await readQuotaHostConfig(defaultQuotaHostConfigPath(options.agentTeamHome));
  if (!config.ok || !config.value.codex.enabled) return createFailClosedNewJobQuotaAdmission();
  const clock = options.clock ?? createClock();
  const collector =
    options.collector ??
    createCodexQuotaCollector({
      ...(options.codexExecutable === undefined ? {} : { executable: options.codexExecutable }),
      clock,
    });
  const bridge = new CodexQuotaEpochBridge(collector, config.value.codex);
  return new PolicyBackedNewJobQuotaAdmission(
    bridge,
    bridge,
    Object.freeze({
      weeklyUsageLimitPercent: config.value.codex.weeklyUsageLimitPercent,
      terminalRemainingPercent: config.value.codex.terminalRemainingPercent,
      maxSampleAgeMs: config.value.codex.maxSampleAgeMs,
      expectedCliVersions: Object.freeze({ codex: config.value.codex.expectedCliVersion }),
    }),
    clock,
  );
}
