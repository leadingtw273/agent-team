import { domainError, err, ok, type DomainError, type Result } from "../foundation/index.js";
import type { JobAttemptCounters } from "./schema.js";

export const attemptLimits = Object.freeze({
  processRecoveries: 1,
  ciFixRounds: 2,
  reviewerFixRounds: 2,
  reviewRuns: 3,
} as const satisfies Record<keyof JobAttemptCounters, number>);

export type AttemptKind = keyof JobAttemptCounters;

export function emptyAttemptCounters(): JobAttemptCounters {
  return Object.freeze({
    processRecoveries: 0,
    ciFixRounds: 0,
    reviewerFixRounds: 0,
    reviewRuns: 0,
  });
}

export function consumeAttempt(
  counters: JobAttemptCounters,
  kind: AttemptKind,
): Result<JobAttemptCounters, DomainError<"conflict">> {
  if (counters[kind] >= attemptLimits[kind]) return err(domainError("conflict"));

  return ok(Object.freeze({ ...counters, [kind]: counters[kind] + 1 }));
}

export function canConsumeAttempt(counters: JobAttemptCounters, kind: AttemptKind): boolean {
  return counters[kind] < attemptLimits[kind];
}
