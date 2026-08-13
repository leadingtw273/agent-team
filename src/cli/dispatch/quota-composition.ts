import {
  createClaudeQuotaCollector,
  type ClaudeQuotaCollector,
  type ClaudeQuotaDiagnosticResult,
} from "../../adapters/providers/claude/index.js";
import type {
  PlatformIdentity,
  ProcessPort,
  QuotaPort,
  QuotaSnapshot,
} from "../../application/ports/index.js";
import {
  PolicyBackedNewJobQuotaAdmission,
  type NewJobQuotaAdmissionPort,
  type QuotaRuntimeContextPort,
} from "../../application/quota/index.js";
import { createClock, domainError, err, ok, type Clock } from "../../domain/foundation/index.js";
import {
  defaultQuotaHostConfigPath,
  readQuotaHostConfig,
  type QuotaHostConfig,
} from "../quota/index.js";
import { createFailClosedNewJobQuotaAdmission } from "./quota-admission.js";

type ClaudeFullResult = Extract<ClaudeQuotaDiagnosticResult, { state: "full" }>;

function snapshot(result: ClaudeFullResult): QuotaSnapshot {
  const identity = Object.freeze({
    provider: "claude",
    accountFingerprint: result.accountFingerprint,
  });
  return Object.freeze({
    ...identity,
    samples: Object.freeze([
      Object.freeze({
        ...identity,
        cliVersion: result.cliVersion,
        source: result.provenance,
        observedAt: result.observedAt,
        kind: "usage" as const,
        bucket: "weekly" as const,
        state: "confirmed" as const,
        remainingPercent: result.buckets.weekly.remainingPercent,
        resetsAt: result.buckets.weekly.resetsAt,
      }),
      Object.freeze({
        ...identity,
        cliVersion: result.cliVersion,
        source: result.provenance,
        observedAt: result.observedAt,
        kind: "usage" as const,
        bucket: "five_hour" as const,
        state: "confirmed" as const,
        remainingPercent: result.buckets.fiveHour.remainingPercent,
        resetsAt: result.buckets.fiveHour.resetsAt,
      }),
    ]),
  });
}

/** One process-local collection bridge shared by runtime-context and quota reads. It retains only
 * a successful, already-observed epoch long enough for PolicyBackedNewJobQuotaAdmission's
 * immediate readCached call; failures clear it. Concurrent callers share one in-flight epoch. */
class ClaudeQuotaEpochBridge implements QuotaRuntimeContextPort, QuotaPort {
  readonly #collector: ClaudeQuotaCollector;
  readonly #config: QuotaHostConfig["claude"];
  #inFlight: Promise<ClaudeFullResult | undefined> | undefined;
  #latest: ClaudeFullResult | undefined;

  constructor(collector: ClaudeQuotaCollector, config: QuotaHostConfig["claude"]) {
    this.#collector = collector;
    this.#config = config;
  }

  async #collect(): Promise<ClaudeFullResult | undefined> {
    if (this.#inFlight !== undefined) return this.#inFlight;
    const epoch = this.#collector
      .collect(this.#config)
      .then((result) => {
        const full = result.state === "full" ? result : undefined;
        this.#latest = full;
        return full;
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
    if (provider !== "claude") return err(domainError("unavailable"));
    const result = await this.#collect();
    return result === undefined
      ? err(domainError("unavailable"))
      : ok(
          Object.freeze({
            identity: Object.freeze({
              provider: "claude",
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
        identity.provider === "claude" &&
        identity.accountFingerprint === result.accountFingerprint
        ? ok(snapshot(result))
        : err(domainError("not_found")),
    );
  }

  async refresh(provider: string) {
    if (provider !== "claude") return err(domainError("unavailable"));
    this.#latest = undefined;
    const result = await this.#collect();
    return result === undefined ? err(domainError("unavailable")) : ok(snapshot(result));
  }
}

export interface CreateProductionQuotaAdmissionOptions {
  readonly agentTeamHome: string;
  readonly claudeProcess: ProcessPort;
  readonly claudeExecutable?: string;
  readonly workingDirectory: string;
  readonly clock?: Clock;
  readonly collector?: ClaudeQuotaCollector;
}

export async function createProductionQuotaAdmission(
  options: CreateProductionQuotaAdmissionOptions,
): Promise<NewJobQuotaAdmissionPort> {
  const config = await readQuotaHostConfig(defaultQuotaHostConfigPath(options.agentTeamHome));
  if (!config.ok || !config.value.claude.enabled) return createFailClosedNewJobQuotaAdmission();
  const clock = options.clock ?? createClock();
  const collector =
    options.collector ??
    createClaudeQuotaCollector({
      process: options.claudeProcess,
      ...(options.claudeExecutable === undefined ? {} : { executable: options.claudeExecutable }),
      workingDirectory: options.workingDirectory,
      clock,
    });
  const bridge = new ClaudeQuotaEpochBridge(collector, config.value.claude);
  return new PolicyBackedNewJobQuotaAdmission(
    bridge,
    bridge,
    Object.freeze({
      weeklyUsageLimitPercent: config.value.claude.weeklyUsageLimitPercent,
      terminalRemainingPercent: config.value.claude.terminalRemainingPercent,
      maxSampleAgeMs: config.value.claude.maxSampleAgeMs,
      expectedCliVersions: Object.freeze({ claude: config.value.claude.expectedCliVersion }),
    }),
    clock,
  );
}
