import { domainError, type DomainError } from "./error.js";
import { err, ok, type Result } from "./result.js";

declare const instantBrand: unique symbol;

export type Instant = string & { readonly [instantBrand]: true };

export const canonicalInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export interface Clock {
  now(): Instant;
}

export function parseInstant(value: string): Result<Instant, DomainError<"invalid_instant">> {
  const date = new Date(value);

  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== value) {
    return err(domainError("invalid_instant"));
  }

  return ok(value as Instant);
}

export function instantFromDate(date: Date): Result<Instant, DomainError<"invalid_instant">> {
  if (!Number.isFinite(date.valueOf())) return err(domainError("invalid_instant"));
  return ok(date.toISOString() as Instant);
}

export function createClock(readDate: () => Date = () => new Date()): Clock {
  return Object.freeze({
    now(): Instant {
      const instant = instantFromDate(readDate());
      if (!instant.ok) throw new Error(instant.error.code);
      return instant.value;
    },
  });
}

export function createFixedClock(instant: Instant): Clock {
  return Object.freeze({ now: () => instant });
}
