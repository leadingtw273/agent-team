import type { AsyncPortResult, PlatformIdentity, QuotaPort, ReadOptions } from "../ports/index.js";
import type { ModelProvider } from "../routing/index.js";
import { createClock, type Clock } from "../../domain/foundation/index.js";
import { resolveQuotaForNewJob, type NewJobQuotaDecision, type QuotaPolicy } from "./policy.js";

export interface NewJobQuotaAdmissionPort {
  resolve(provider: ModelProvider, options?: ReadOptions): Promise<NewJobQuotaDecision>;
}

export interface QuotaRuntimeContext {
  readonly identity: PlatformIdentity;
  readonly cliVersion: string;
}

/** Provider-owned, redacted runtime identity and CLI version. Operator labels are not identities. */
export interface QuotaRuntimeContextPort {
  observe(provider: ModelProvider, options?: ReadOptions): AsyncPortResult<QuotaRuntimeContext>;
}

function unknown(reason: string): NewJobQuotaDecision {
  return Object.freeze({ state: "quota_unknown", reason });
}

/**
 * Policy-backed bridge for a future production collector and for controlled tests. A failed or
 * inconsistent runtime identity never reaches the cache, and no operator-configured account label
 * can be substituted for the Provider-owned fingerprint.
 */
export class PolicyBackedNewJobQuotaAdmission implements NewJobQuotaAdmissionPort {
  readonly #contexts: QuotaRuntimeContextPort;
  readonly #quota: QuotaPort;
  readonly #policy: QuotaPolicy;
  readonly #clock: Clock;

  constructor(
    contexts: QuotaRuntimeContextPort,
    quota: QuotaPort,
    policy: QuotaPolicy,
    clock: Clock = createClock(),
  ) {
    this.#contexts = contexts;
    this.#quota = quota;
    this.#policy = policy;
    this.#clock = clock;
  }

  async resolve(provider: ModelProvider, options: ReadOptions = {}): Promise<NewJobQuotaDecision> {
    const observed = await this.#contexts.observe(provider, options);
    if (!observed.ok) return unknown("runtime_context_unavailable");

    const expectedVersion = this.#policy.expectedCliVersions[provider];
    const { identity, cliVersion } = observed.value;
    if (
      identity.provider !== provider ||
      identity.provider.trim().length === 0 ||
      identity.accountFingerprint.trim().length === 0 ||
      cliVersion.trim().length === 0 ||
      expectedVersion === undefined ||
      expectedVersion.trim().length === 0 ||
      cliVersion !== expectedVersion
    ) {
      return unknown("runtime_context_invalid");
    }

    return (
      await resolveQuotaForNewJob(this.#quota, identity, this.#clock.now(), this.#policy, options)
    ).decision;
  }
}
