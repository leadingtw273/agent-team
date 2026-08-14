import type {
  PlatformIdentity,
  QuotaPort,
  QuotaSample,
  QuotaSnapshot,
  ReadOptions,
  UsageQuotaSample,
} from "../ports/index.js";
import type { Instant } from "../../domain/foundation/index.js";
import type { CandidateRouteState } from "../routing/index.js";

export interface QuotaPolicy {
  readonly weeklyUsageLimitPercent: number;
  readonly terminalRemainingPercent: number;
  readonly maxSampleAgeMs: number;
  readonly expectedCliVersions: Readonly<Record<string, string>>;
}

export type NewJobQuotaDecision = Readonly<{
  state: Extract<
    CandidateRouteState,
    "ready" | "provider_unavailable" | "quota_blocked" | "quota_unknown"
  >;
  reason: string;
}>;

export type RunningQuotaDecision = Readonly<{
  action: "continue" | "checkpoint";
  reason: string;
}>;

function validPolicy(policy: QuotaPolicy): boolean {
  return (
    Number.isFinite(policy.weeklyUsageLimitPercent) &&
    policy.weeklyUsageLimitPercent > 0 &&
    policy.weeklyUsageLimitPercent <= 100 &&
    Number.isFinite(policy.terminalRemainingPercent) &&
    policy.terminalRemainingPercent >= 0 &&
    policy.terminalRemainingPercent <= 100 &&
    Number.isSafeInteger(policy.maxSampleAgeMs) &&
    policy.maxSampleAgeMs > 0 &&
    Object.values(policy.expectedCliVersions).every(
      (version) => typeof version === "string" && version.trim().length > 0,
    )
  );
}

function validIdentity(identity: PlatformIdentity): boolean {
  return (
    typeof identity.provider === "string" &&
    identity.provider.trim().length > 0 &&
    typeof identity.accountFingerprint === "string" &&
    identity.accountFingerprint.trim().length > 0
  );
}

function identityMatches(sample: QuotaSample, identity: PlatformIdentity): boolean {
  return (
    validIdentity(sample) &&
    validIdentity(identity) &&
    sample.provider === identity.provider &&
    sample.accountFingerprint === identity.accountFingerprint
  );
}

function sampleFresh(sample: QuotaSample, now: Instant, policy: QuotaPolicy): boolean {
  const age = Date.parse(now) - Date.parse(sample.observedAt);
  return (
    typeof sample.cliVersion === "string" &&
    sample.cliVersion.trim().length > 0 &&
    typeof sample.source === "string" &&
    sample.source.trim().length > 0 &&
    policy.expectedCliVersions[sample.provider] === sample.cliVersion &&
    Number.isFinite(age) &&
    age >= 0 &&
    age <= policy.maxSampleAgeMs
  );
}

function usageSample(
  snapshot: QuotaSnapshot,
  identity: PlatformIdentity,
  bucket: UsageQuotaSample["bucket"],
  now: Instant,
  policy: QuotaPolicy,
): UsageQuotaSample | undefined {
  const matches = snapshot.samples.filter(
    (sample): sample is UsageQuotaSample => sample.kind === "usage" && sample.bucket === bucket,
  );
  if (matches.length !== 1) return undefined;
  const sample = matches[0];
  return sample !== undefined &&
    identityMatches(sample, identity) &&
    sampleFresh(sample, now, policy)
    ? sample
    : undefined;
}

function validRemainingPercent(
  sample: UsageQuotaSample,
): sample is Extract<UsageQuotaSample, { state: "confirmed" }> {
  return (
    sample.state === "confirmed" &&
    Number.isFinite(sample.remainingPercent) &&
    sample.remainingPercent >= 0 &&
    sample.remainingPercent <= 100
  );
}

export function evaluateQuotaForNewJob(
  snapshot: QuotaSnapshot,
  identity: PlatformIdentity,
  now: Instant,
  policy: QuotaPolicy,
): NewJobQuotaDecision {
  if (
    !validPolicy(policy) ||
    !validIdentity(identity) ||
    !validIdentity(snapshot) ||
    snapshot.provider !== identity.provider ||
    snapshot.accountFingerprint !== identity.accountFingerprint
  ) {
    return Object.freeze({ state: "quota_unknown", reason: "identity_or_policy_invalid" });
  }
  if (identity.provider === "gemini") {
    const availability = snapshot.samples.filter((sample) => sample.kind === "availability");
    const sample = availability.length === 1 ? availability[0] : undefined;
    if (
      sample?.state !== "confirmed" ||
      typeof sample.available !== "boolean" ||
      !identityMatches(sample, identity) ||
      !sampleFresh(sample, now, policy)
    ) {
      return Object.freeze({ state: "quota_unknown", reason: "availability_unknown_or_stale" });
    }
    return sample.available
      ? Object.freeze({ state: "ready", reason: "availability_confirmed" })
      : Object.freeze({ state: "provider_unavailable", reason: "availability_false" });
  }

  const weekly = usageSample(snapshot, identity, "weekly", now, policy);
  const fiveHour = usageSample(snapshot, identity, "five_hour", now, policy);
  if (identity.provider === "codex") {
    if (weekly === undefined || !validRemainingPercent(weekly)) {
      return Object.freeze({ state: "quota_unknown", reason: "usage_unknown_or_stale" });
    }
    const weeklyRemainingWall = 100 - policy.weeklyUsageLimitPercent;
    if (weekly.remainingPercent <= weeklyRemainingWall) {
      return Object.freeze({ state: "quota_blocked", reason: "weekly_wall_reached" });
    }
    if (fiveHour !== undefined) {
      if (!validRemainingPercent(fiveHour)) {
        return Object.freeze({ state: "quota_unknown", reason: "usage_unknown_or_stale" });
      }
      if (fiveHour.remainingPercent <= 0) {
        return Object.freeze({ state: "quota_blocked", reason: "five_hour_limit_reached" });
      }
    }
    return Object.freeze({ state: "ready", reason: "weekly_quota_confirmed" });
  }
  if (
    weekly === undefined ||
    fiveHour === undefined ||
    !validRemainingPercent(weekly) ||
    !validRemainingPercent(fiveHour)
  ) {
    return Object.freeze({ state: "quota_unknown", reason: "usage_unknown_or_stale" });
  }
  const weeklyRemainingWall = 100 - policy.weeklyUsageLimitPercent;
  if (weekly.remainingPercent <= weeklyRemainingWall) {
    return Object.freeze({ state: "quota_blocked", reason: "weekly_wall_reached" });
  }
  if (fiveHour.remainingPercent <= 0) {
    return Object.freeze({ state: "quota_blocked", reason: "five_hour_limit_reached" });
  }
  return Object.freeze({ state: "ready", reason: "quota_confirmed" });
}

export function evaluateRunningQuota(
  snapshot: QuotaSnapshot,
  identity: PlatformIdentity,
  now: Instant,
  policy: QuotaPolicy,
): RunningQuotaDecision {
  if (
    !validPolicy(policy) ||
    !validIdentity(identity) ||
    !validIdentity(snapshot) ||
    snapshot.provider !== identity.provider ||
    snapshot.accountFingerprint !== identity.accountFingerprint
  ) {
    return Object.freeze({ action: "checkpoint", reason: "quota_policy_invalid" });
  }
  if (identity.provider === "gemini") {
    const availability = evaluateQuotaForNewJob(snapshot, identity, now, policy);
    return availability.state === "ready"
      ? Object.freeze({ action: "continue", reason: "availability_confirmed" })
      : Object.freeze({ action: "checkpoint", reason: "availability_unavailable_or_unknown" });
  }
  const weekly = usageSample(snapshot, identity, "weekly", now, policy);
  const fiveHour = usageSample(snapshot, identity, "five_hour", now, policy);
  if (identity.provider === "codex") {
    if (weekly === undefined || !validRemainingPercent(weekly)) {
      return Object.freeze({ action: "checkpoint", reason: "quota_signal_unknown_or_stale" });
    }
    if (weekly.remainingPercent <= policy.terminalRemainingPercent) {
      return Object.freeze({ action: "checkpoint", reason: "terminal_weekly_boundary" });
    }
    if (fiveHour !== undefined) {
      if (!validRemainingPercent(fiveHour)) {
        return Object.freeze({ action: "checkpoint", reason: "quota_signal_unknown_or_stale" });
      }
      if (fiveHour.remainingPercent <= 0) {
        return Object.freeze({ action: "checkpoint", reason: "five_hour_limit_reached" });
      }
    }
    return Object.freeze({ action: "continue", reason: "quota_safe" });
  }
  if (
    weekly === undefined ||
    fiveHour === undefined ||
    !validRemainingPercent(weekly) ||
    !validRemainingPercent(fiveHour)
  ) {
    return Object.freeze({ action: "checkpoint", reason: "quota_signal_unknown_or_stale" });
  }
  if (weekly.remainingPercent <= policy.terminalRemainingPercent) {
    return Object.freeze({ action: "checkpoint", reason: "terminal_weekly_boundary" });
  }
  if (fiveHour.remainingPercent <= 0) {
    return Object.freeze({ action: "checkpoint", reason: "five_hour_limit_reached" });
  }
  return Object.freeze({ action: "continue", reason: "quota_safe" });
}

export async function resolveQuotaForNewJob(
  port: QuotaPort,
  identity: PlatformIdentity,
  now: Instant,
  policy: QuotaPolicy,
  options: ReadOptions = {},
): Promise<Readonly<{ decision: NewJobQuotaDecision; refreshed: boolean }>> {
  const cached = await port.readCached(identity, options);
  if (cached.ok) {
    const decision = evaluateQuotaForNewJob(cached.value, identity, now, policy);
    if (decision.state !== "quota_unknown") return Object.freeze({ decision, refreshed: false });
  }
  const refreshed = await port.refresh(identity.provider, options);
  const decision = refreshed.ok
    ? evaluateQuotaForNewJob(refreshed.value, identity, now, policy)
    : Object.freeze({ state: "quota_unknown" as const, reason: "refresh_failed" });
  return Object.freeze({ decision, refreshed: true });
}

export function invalidateQuotaSnapshot(snapshot: QuotaSnapshot, reason: string): QuotaSnapshot {
  return Object.freeze({
    provider: snapshot.provider,
    accountFingerprint: snapshot.accountFingerprint,
    samples: Object.freeze(
      snapshot.samples.map((sample): QuotaSample =>
        sample.kind === "usage"
          ? Object.freeze({
              provider: sample.provider,
              accountFingerprint: sample.accountFingerprint,
              cliVersion: sample.cliVersion,
              source: sample.source,
              observedAt: sample.observedAt,
              kind: "usage",
              bucket: sample.bucket,
              state: "stale",
              reason,
            })
          : Object.freeze({
              provider: sample.provider,
              accountFingerprint: sample.accountFingerprint,
              cliVersion: sample.cliVersion,
              source: sample.source,
              observedAt: sample.observedAt,
              kind: "availability",
              state: "stale",
              reason,
            }),
      ),
    ),
  });
}
