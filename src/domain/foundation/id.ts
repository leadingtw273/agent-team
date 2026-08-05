import { createHash, randomUUID } from "node:crypto";

import { domainError, type DomainError } from "./error.js";
import { err, ok, type Result } from "./result.js";

declare const identifierBrand: unique symbol;

export type Identifier<Scope extends string> = string & {
  readonly [identifierBrand]: Scope;
};

const scopePattern = /^[a-z][a-z0-9-]{0,31}$/u;
export const identifierUuidBodyPattern =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

const uuidPattern = new RegExp(`^${identifierUuidBodyPattern}$`, "u");

export function scopedIdentifierPattern(scope: string): RegExp {
  return new RegExp(`^${scope}_${identifierUuidBodyPattern}$`, "u");
}

export function parseIdentifier<Scope extends string>(
  scope: Scope,
  value: string,
): Result<Identifier<Scope>, DomainError<"invalid_identifier">> {
  const prefix = `${scope}_`;
  const uuid = value.slice(prefix.length);

  if (!scopePattern.test(scope) || !value.startsWith(prefix) || !uuidPattern.test(uuid)) {
    return err(domainError("invalid_identifier"));
  }

  return ok(value as Identifier<Scope>);
}

export function generateIdentifier<Scope extends string>(
  scope: Scope,
  generateUuid: () => string = randomUUID,
): Result<Identifier<Scope>, DomainError<"invalid_identifier">> {
  return parseIdentifier(scope, `${scope}_${generateUuid().toLowerCase()}`);
}

export function generateDeterministicIdentifier<Scope extends string>(
  scope: Scope,
  seed: string | Uint8Array,
): Result<Identifier<Scope>, DomainError<"invalid_identifier">> {
  const bytes = typeof seed === "string" ? Buffer.from(seed, "utf8") : Uint8Array.from(seed);
  if (bytes.byteLength === 0) return err(domainError("invalid_identifier"));
  const digest = createHash("sha256").update(bytes).digest("hex");
  const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  return parseIdentifier(scope, `${scope}_${uuid}`);
}
