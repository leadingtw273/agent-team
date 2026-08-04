import type { AvailabilityQuotaSample, UsageQuotaSample } from "../ports/quota.js";
import { instantFromDate, type Instant } from "../../domain/foundation/index.js";

export interface QuotaParserContext {
  readonly provider: string;
  readonly accountFingerprint: string;
  readonly cliVersion: string;
  readonly source: string;
  readonly observedAt: Instant;
}

function asRecord(input: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Readonly<Record<string, unknown>>)
    : undefined;
}

function epochInstant(seconds: unknown): Instant | undefined {
  if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds <= 0)
    return undefined;
  const parsed = instantFromDate(new Date(seconds * 1_000));
  return parsed.ok ? parsed.value : undefined;
}

function unknownUsage(
  context: QuotaParserContext,
  bucket: UsageQuotaSample["bucket"],
  reason: string,
): UsageQuotaSample {
  return Object.freeze({
    ...context,
    kind: "usage",
    bucket,
    state: "unknown",
    reason,
  });
}

function confirmedUsage(
  context: QuotaParserContext,
  bucket: UsageQuotaSample["bucket"],
  usedPercent: unknown,
  resetsAt: unknown,
): UsageQuotaSample | undefined {
  if (
    typeof usedPercent !== "number" ||
    !Number.isFinite(usedPercent) ||
    usedPercent < 0 ||
    usedPercent > 100
  ) {
    return undefined;
  }
  const reset = epochInstant(resetsAt);
  if (reset === undefined) return undefined;
  return Object.freeze({
    ...context,
    kind: "usage",
    bucket,
    state: "confirmed",
    remainingPercent: 100 - usedPercent,
    resetsAt: reset,
  });
}

export function parseCodexRateLimits(
  input: unknown,
  context: QuotaParserContext,
  limitId?: string,
): readonly UsageQuotaSample[] {
  const root = asRecord(input);
  const current = asRecord(root?.["rateLimits"]);
  const byId = asRecord(root?.["rateLimitsByLimitId"]);
  const selected =
    limitId === undefined
      ? current
      : (asRecord(byId?.[limitId]) ?? (current?.["limitId"] === limitId ? current : undefined));
  if (selected === undefined) {
    return Object.freeze([
      unknownUsage(context, "weekly", "codex_limit_missing"),
      unknownUsage(context, "five_hour", "codex_limit_missing"),
    ]);
  }

  const parsed = new Map<UsageQuotaSample["bucket"], UsageQuotaSample>();
  for (const windowName of ["primary", "secondary"] as const) {
    const window = asRecord(selected[windowName]);
    const duration = window?.["windowDurationMins"];
    const bucket = duration === 10_080 ? "weekly" : duration === 300 ? "five_hour" : undefined;
    if (bucket === undefined) continue;
    const sample = confirmedUsage(context, bucket, window?.["usedPercent"], window?.["resetsAt"]);
    if (sample !== undefined) parsed.set(bucket, sample);
  }
  return Object.freeze(
    (["weekly", "five_hour"] as const).map(
      (bucket) =>
        parsed.get(bucket) ?? unknownUsage(context, bucket, "codex_bucket_missing_or_invalid"),
    ),
  );
}

export function parseClaudeRateLimitEvents(
  events: readonly unknown[],
  context: QuotaParserContext,
): readonly UsageQuotaSample[] {
  const parsed = new Map<UsageQuotaSample["bucket"], UsageQuotaSample>();
  for (const input of events) {
    const event = asRecord(input);
    if (event?.["type"] !== "rate_limit_event") continue;
    const info = asRecord(event["rate_limit_info"] ?? event["rateLimitInfo"]);
    const type = info?.["rate_limit_type"] ?? info?.["rateLimitType"];
    const bucket = type === "seven_day" ? "weekly" : type === "five_hour" ? "five_hour" : undefined;
    const utilization = info?.["utilization"];
    const status = info?.["status"];
    if (info === undefined || bucket === undefined || typeof utilization !== "number") continue;
    const sample = confirmedUsage(
      context,
      bucket,
      status === "rejected" || status === "exceeded" ? 100 : utilization * 100,
      info["resets_at"] ?? info["resetsAt"],
    );
    if (sample !== undefined) parsed.set(bucket, sample);
  }
  return Object.freeze(
    (["weekly", "five_hour"] as const).map(
      (bucket) =>
        parsed.get(bucket) ?? unknownUsage(context, bucket, "claude_bucket_missing_or_invalid"),
    ),
  );
}

export function geminiAvailabilitySample(
  available: boolean,
  context: QuotaParserContext,
): AvailabilityQuotaSample {
  return Object.freeze({ ...context, kind: "availability", state: "confirmed", available });
}
