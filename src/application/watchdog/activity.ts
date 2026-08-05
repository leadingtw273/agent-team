import type { Instant } from "../../domain/foundation/index.js";
import type { ProgressEvidenceKind } from "../../domain/jobs/index.js";
import type { EffectiveWatchdogActivity, WatchdogActivity } from "./model.js";
import { watchdogActivitySchema } from "./model.js";

const ignoredKinds = new Set(["heartbeat", "model_output", "command_execution"]);

export function validateWatchdogActivities(
  activities: readonly WatchdogActivity[],
  startedAt: Instant,
  now: Instant,
): boolean {
  const startMs = Date.parse(startedAt);
  const nowMs = Date.parse(now);
  return activities.every((activity) => {
    const parsed = watchdogActivitySchema.safeParse(activity);
    if (!parsed.success) return false;
    const occurredAt = Date.parse(parsed.data.occurredAt);
    return occurredAt >= startMs && occurredAt <= nowMs;
  });
}

export function effectiveWatchdogProgress(
  activities: readonly WatchdogActivity[],
): readonly EffectiveWatchdogActivity[] {
  const seen = new Set<string>();
  const effective: EffectiveWatchdogActivity[] = [];
  for (const activity of activities) {
    if (ignoredKinds.has(activity.kind) || !("fingerprint" in activity)) continue;
    const key = `${activity.kind}:${activity.fingerprint}`;
    if (seen.has(key)) continue;
    seen.add(key);
    effective.push(activity as EffectiveWatchdogActivity);
  }
  return Object.freeze(effective);
}

export function effectiveProgressKinds(
  activities: readonly EffectiveWatchdogActivity[],
): readonly ProgressEvidenceKind[] {
  return Object.freeze([...new Set(activities.map((activity) => activity.kind))]);
}
