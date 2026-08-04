import { createHash } from "node:crypto";

import { domainError, err, ok, type DomainError, type Result } from "../foundation/index.js";

declare const sha256DigestBrand: unique symbol;

export type Sha256Digest = string & { readonly [sha256DigestBrand]: true };

function serializeValue(value: unknown, ancestors: WeakSet<object>): string | undefined {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : undefined;

  if (Array.isArray(value)) {
    if (ancestors.has(value)) return undefined;
    ancestors.add(value);
    const items = value.map((item) => serializeValue(item, ancestors));
    ancestors.delete(value);
    return items.some((item) => item === undefined) ? undefined : `[${items.join(",")}]`;
  }

  if (typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(record) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  if (ancestors.has(record)) return undefined;

  ancestors.add(record);
  const members: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const serialized = serializeValue(record[key], ancestors);
    if (serialized === undefined) {
      ancestors.delete(record);
      return undefined;
    }
    members.push(`${JSON.stringify(key)}:${serialized}`);
  }
  ancestors.delete(record);
  return `{${members.join(",")}}`;
}

export function canonicalSerialize(
  value: unknown,
): Result<string, DomainError<"invariant_violation">> {
  const serialized = serializeValue(value, new WeakSet());
  return serialized === undefined ? err(domainError("invariant_violation")) : ok(serialized);
}

export function sha256Digest(
  value: unknown,
): Result<Sha256Digest, DomainError<"invariant_violation">> {
  const serialized = canonicalSerialize(value);
  if (!serialized.ok) return serialized;
  return ok(createHash("sha256").update(serialized.value, "utf8").digest("hex") as Sha256Digest);
}
