import { randomUUID } from "node:crypto";

import { domainError, type DomainError } from "./error.js";
import { err, ok, type Result } from "./result.js";

declare const identifierBrand: unique symbol;

export type Identifier<Scope extends string> = string & {
  readonly [identifierBrand]: Scope;
};

const scopePattern = /^[a-z][a-z0-9-]{0,31}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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
