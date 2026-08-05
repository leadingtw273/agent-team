import type { Instant } from "../../../domain/foundation/index.js";
import type { QuotaSample } from "../../../application/ports/index.js";
import type { QuotaProviderId, QuotaProviderRecord } from "./contracts.js";

export type QuotaBucketId = "weekly" | "five_hour" | "availability";
export type QuotaSampleState = "fresh" | "stale" | "unknown";

export type QuotaReadModelReason =
  | "account_switched"
  | "account_switch_invalidation_failed"
  | "cli_version_unverified"
  | "cli_version_changed"
  | "identity_invalid"
  | "provider_record_missing"
  | "provider_record_ambiguous"
  | "signal_confirmed"
  | "provider_signal_unknown"
  | "sample_expired"
  | "sample_identity_mismatch"
  | "sample_in_future"
  | "sample_invalid"
  | "sample_missing"
  | "sample_marked_stale"
  | "sample_provider_mismatch"
  | "sample_duplicated"
  | "source_unverified"
  | "snapshot_missing";

export interface QuotaBucketReadModel {
  readonly bucket: QuotaBucketId;
  readonly state: QuotaSampleState;
  readonly reason: QuotaReadModelReason;
  readonly source: string;
  readonly observedAt: string;
  readonly remainingPercent?: number;
  readonly usedPercent?: number;
  readonly resetsAt?: string;
  readonly available?: boolean;
}

export type WeeklyConfigurationReadModel =
  | Readonly<{ state: "configured"; usageLimitPercent: number }>
  | Readonly<{ state: "unconfigured"; reason: "weekly_setting_missing_or_invalid" }>
  | Readonly<{ state: "not_applicable" }>;

export type AccountSwitchReadModel =
  | Readonly<{ state: "none" }>
  | Readonly<{
      state: "detected";
      reason: "account_switched";
      previousIdentity: string;
    }>;

export interface QuotaProviderReadModel {
  readonly provider: QuotaProviderId;
  readonly label: string;
  readonly activeIdentity: string;
  readonly weeklyConfiguration: WeeklyConfigurationReadModel;
  readonly accountSwitch: AccountSwitchReadModel;
  readonly buckets: readonly QuotaBucketReadModel[];
}

export interface QuotaDashboardReadModel {
  readonly providers: readonly QuotaProviderReadModel[];
}

export interface QuotaReadModelPolicy {
  readonly now: () => Instant;
  readonly maxSampleAgeMs: number;
  readonly expectedCliVersions: Readonly<Record<string, string>>;
}

const providerLabels: Readonly<Record<QuotaProviderId, string>> = Object.freeze({
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
});

const sourceLabels: Readonly<Record<string, string>> = Object.freeze({
  "claude-rate-limit-event": "Claude 結構化額度事件",
  "codex-app-server": "Codex app-server 結構化事件",
  fixture: "去識別 Fixture",
  "provider-structured-event": "Provider 結構化事件",
});

const expectedBuckets: Readonly<Record<QuotaProviderId, readonly QuotaBucketId[]>> = Object.freeze({
  claude: Object.freeze(["weekly", "five_hour"] as const),
  codex: Object.freeze(["weekly", "five_hour"] as const),
  gemini: Object.freeze(["availability"] as const),
});

function validFingerprint(value: string): boolean {
  return /^[A-Za-z0-9:_-]{6,160}$/u.test(value);
}

function maskedIdentity(value: string): string {
  if (!validFingerprint(value)) return "未確認帳號";
  if (value.length <= 8) return `${value.slice(0, 2)}••${value.slice(-2)}`;
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

function validPercent(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 100;
}

function displayTime(value: string | undefined): string {
  if (value === undefined) return "未取得";
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return "未取得";
  const date = new Date(milliseconds);
  const segments = [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ];
  const time = [
    String(date.getUTCHours()).padStart(2, "0"),
    String(date.getUTCMinutes()).padStart(2, "0"),
  ];
  return `${segments.join("-")} ${time.join(":")} UTC`;
}

function sourceLabel(value: string | undefined): string {
  if (value === undefined) return "尚未取得";
  return trustedSourceLabel(value) ?? "未驗證來源";
}

function trustedSourceLabel(value: string): string | undefined {
  return Object.hasOwn(sourceLabels, value) ? sourceLabels[value] : undefined;
}

function bucketLabel(provider: QuotaProviderId, bucket: QuotaBucketId): string {
  if (bucket === "weekly") return "週額度";
  if (bucket === "five_hour") return "五小時額度";
  return provider === "gemini" ? "Provider 可用性" : "可用性";
}

function defaultBucket(bucket: QuotaBucketId, reason: QuotaReadModelReason): QuotaBucketReadModel {
  return Object.freeze({
    bucket,
    state: "unknown",
    reason,
    source: "尚未取得",
    observedAt: "未取得",
  });
}

function sampleBucket(sample: QuotaSample): QuotaBucketId {
  return sample.kind === "availability" ? "availability" : sample.bucket;
}

function validPolicy(policy: QuotaReadModelPolicy): boolean {
  return (
    Number.isSafeInteger(policy.maxSampleAgeMs) &&
    policy.maxSampleAgeMs > 0 &&
    Object.values(policy.expectedCliVersions).every((value) => typeof value === "string")
  );
}

function staleBucket(
  sample: QuotaSample,
  bucket: QuotaBucketId,
  reason: Extract<
    QuotaReadModelReason,
    "account_switched" | "cli_version_changed" | "sample_expired" | "sample_marked_stale"
  >,
): QuotaBucketReadModel {
  return Object.freeze({
    bucket,
    state: "stale",
    reason,
    source: sourceLabel(sample.source),
    observedAt: displayTime(sample.observedAt),
  });
}

function unknownFromSample(
  sample: QuotaSample | undefined,
  bucket: QuotaBucketId,
  reason: QuotaReadModelReason,
): QuotaBucketReadModel {
  return Object.freeze({
    bucket,
    state: "unknown",
    reason,
    source: sourceLabel(sample?.source),
    observedAt: displayTime(sample?.observedAt),
  });
}

function freshBucket(sample: QuotaSample, bucket: QuotaBucketId): QuotaBucketReadModel {
  if (sample.kind === "availability") {
    if (sample.state !== "confirmed") return unknownFromSample(sample, bucket, "sample_invalid");
    return Object.freeze({
      bucket,
      state: "fresh",
      reason: "signal_confirmed",
      source: sourceLabel(sample.source),
      observedAt: displayTime(sample.observedAt),
      available: sample.available,
    });
  }
  if (sample.state !== "confirmed") return unknownFromSample(sample, bucket, "sample_invalid");
  const remainingPercent = sample.remainingPercent;
  if (!validPercent(remainingPercent)) return unknownFromSample(sample, bucket, "sample_invalid");
  return Object.freeze({
    bucket,
    state: "fresh",
    reason: "signal_confirmed",
    source: sourceLabel(sample.source),
    observedAt: displayTime(sample.observedAt),
    remainingPercent,
    usedPercent: 100 - remainingPercent,
    ...(sample.resetsAt === undefined ? {} : { resetsAt: displayTime(sample.resetsAt) }),
  });
}

function confirmedSample(sample: QuotaSample): boolean {
  return sample.state === "confirmed";
}

function sameIdentity(
  provider: QuotaProviderId,
  accountFingerprint: string,
  candidate: Readonly<{ provider: string; accountFingerprint: string }>,
): boolean {
  return candidate.provider === provider && candidate.accountFingerprint === accountFingerprint;
}

function normalizeBucket(
  provider: QuotaProviderId,
  accountFingerprint: string,
  bucket: QuotaBucketId,
  samples: readonly QuotaSample[],
  policy: QuotaReadModelPolicy,
): QuotaBucketReadModel {
  const matching = samples.filter((sample) => sampleBucket(sample) === bucket);
  if (matching.length === 0) return defaultBucket(bucket, "sample_missing");
  if (matching.length !== 1) return unknownFromSample(matching[0], bucket, "sample_duplicated");
  const sample = matching[0];
  if (sample === undefined) return defaultBucket(bucket, "sample_missing");
  if (!validFingerprint(sample.accountFingerprint)) {
    return unknownFromSample(sample, bucket, "identity_invalid");
  }
  if (!sameIdentity(provider, accountFingerprint, sample)) {
    return unknownFromSample(sample, bucket, "sample_identity_mismatch");
  }
  if (sample.kind === "availability" ? bucket !== "availability" : bucket === "availability") {
    return unknownFromSample(sample, bucket, "sample_invalid");
  }
  if (sample.state === "stale") return staleBucket(sample, bucket, "sample_marked_stale");
  if (!confirmedSample(sample)) {
    return unknownFromSample(sample, bucket, "provider_signal_unknown");
  }
  if (trustedSourceLabel(sample.source) === undefined) {
    return unknownFromSample(sample, bucket, "source_unverified");
  }
  const expectedCliVersion = policy.expectedCliVersions[provider];
  if (expectedCliVersion === undefined) {
    return unknownFromSample(sample, bucket, "cli_version_unverified");
  }
  if (sample.cliVersion !== expectedCliVersion) {
    return staleBucket(sample, bucket, "cli_version_changed");
  }
  const observedAt = Date.parse(sample.observedAt);
  const now = Date.parse(policy.now());
  if (!Number.isFinite(observedAt) || !Number.isFinite(now)) {
    return unknownFromSample(sample, bucket, "sample_invalid");
  }
  const age = now - observedAt;
  if (age < 0) return unknownFromSample(sample, bucket, "sample_in_future");
  if (age > policy.maxSampleAgeMs) return staleBucket(sample, bucket, "sample_expired");
  return freshBucket(sample, bucket);
}

function weeklyConfiguration(
  provider: QuotaProviderId,
  value: number | undefined,
): WeeklyConfigurationReadModel {
  if (provider === "gemini") return Object.freeze({ state: "not_applicable" });
  return validPercent(value)
    ? Object.freeze({ state: "configured", usageLimitPercent: value })
    : Object.freeze({ state: "unconfigured", reason: "weekly_setting_missing_or_invalid" });
}

function unknownProvider(
  provider: QuotaProviderId,
  reason: Extract<QuotaReadModelReason, "provider_record_missing" | "provider_record_ambiguous">,
): QuotaProviderReadModel {
  return Object.freeze({
    provider,
    label: providerLabels[provider],
    activeIdentity: "未確認帳號",
    weeklyConfiguration: weeklyConfiguration(provider, undefined),
    accountSwitch: Object.freeze({ state: "none" }),
    buckets: Object.freeze(
      expectedBuckets[provider].map((bucket) => defaultBucket(bucket, reason)),
    ),
  });
}

function providerReadModel(
  record: QuotaProviderRecord,
  policy: QuotaReadModelPolicy,
): QuotaProviderReadModel {
  const { provider, activeIdentity, snapshot } = record;
  const activeFingerprint = activeIdentity.accountFingerprint;
  if (
    !validPolicy(policy) ||
    !validFingerprint(activeFingerprint) ||
    !sameIdentity(provider, activeFingerprint, activeIdentity)
  ) {
    return Object.freeze({
      provider,
      label: providerLabels[provider],
      activeIdentity: maskedIdentity(activeFingerprint),
      weeklyConfiguration: weeklyConfiguration(provider, record.weeklyUsageLimitPercent),
      accountSwitch: Object.freeze({ state: "none" }),
      buckets: Object.freeze(
        expectedBuckets[provider].map((bucket) => defaultBucket(bucket, "identity_invalid")),
      ),
    });
  }
  if (snapshot === undefined) {
    return Object.freeze({
      provider,
      label: providerLabels[provider],
      activeIdentity: maskedIdentity(activeFingerprint),
      weeklyConfiguration: weeklyConfiguration(provider, record.weeklyUsageLimitPercent),
      accountSwitch: Object.freeze({ state: "none" }),
      buckets: Object.freeze(
        expectedBuckets[provider].map((bucket) => defaultBucket(bucket, "snapshot_missing")),
      ),
    });
  }
  if (!validFingerprint(snapshot.accountFingerprint)) {
    return Object.freeze({
      provider,
      label: providerLabels[provider],
      activeIdentity: maskedIdentity(activeFingerprint),
      weeklyConfiguration: weeklyConfiguration(provider, record.weeklyUsageLimitPercent),
      accountSwitch: Object.freeze({ state: "none" }),
      buckets: Object.freeze(
        expectedBuckets[provider].map((bucket) => defaultBucket(bucket, "identity_invalid")),
      ),
    });
  }
  if (snapshot.provider !== provider) {
    return Object.freeze({
      provider,
      label: providerLabels[provider],
      activeIdentity: maskedIdentity(activeFingerprint),
      weeklyConfiguration: weeklyConfiguration(provider, record.weeklyUsageLimitPercent),
      accountSwitch: Object.freeze({ state: "none" }),
      buckets: Object.freeze(
        expectedBuckets[provider].map((bucket) =>
          defaultBucket(bucket, "sample_provider_mismatch"),
        ),
      ),
    });
  }
  if (snapshot.accountFingerprint !== activeFingerprint) {
    return Object.freeze({
      provider,
      label: providerLabels[provider],
      activeIdentity: maskedIdentity(activeFingerprint),
      weeklyConfiguration: weeklyConfiguration(provider, record.weeklyUsageLimitPercent),
      accountSwitch: Object.freeze({
        state: "detected",
        reason: "account_switched",
        previousIdentity: maskedIdentity(snapshot.accountFingerprint),
      }),
      buckets: Object.freeze(
        expectedBuckets[provider].map((bucket) => {
          const sample = snapshot.samples.find((candidate) => sampleBucket(candidate) === bucket);
          return sample === undefined
            ? unknownFromSample(sample, bucket, "account_switched")
            : staleBucket(sample, bucket, "account_switched");
        }),
      ),
    });
  }
  return Object.freeze({
    provider,
    label: providerLabels[provider],
    activeIdentity: maskedIdentity(activeFingerprint),
    weeklyConfiguration: weeklyConfiguration(provider, record.weeklyUsageLimitPercent),
    accountSwitch: Object.freeze({ state: "none" }),
    buckets: Object.freeze(
      expectedBuckets[provider].map((bucket) =>
        normalizeBucket(provider, activeFingerprint, bucket, snapshot.samples, policy),
      ),
    ),
  });
}

export function buildQuotaDashboardReadModel(
  records: readonly QuotaProviderRecord[],
  policy: QuotaReadModelPolicy,
): QuotaDashboardReadModel {
  const providers = (Object.keys(providerLabels) as QuotaProviderId[]).map((provider) => {
    const recordsForProvider = records.filter((record) => record.provider === provider);
    if (recordsForProvider.length === 0)
      return unknownProvider(provider, "provider_record_missing");
    if (recordsForProvider.length !== 1)
      return unknownProvider(provider, "provider_record_ambiguous");
    const record = recordsForProvider[0];
    if (record === undefined) return unknownProvider(provider, "provider_record_missing");
    return providerReadModel(record, policy);
  });
  return Object.freeze({ providers: Object.freeze(providers) });
}

export function quotaBucketLabel(provider: QuotaProviderId, bucket: QuotaBucketId): string {
  return bucketLabel(provider, bucket);
}
