import type { DomainError, Result } from "../../domain/foundation/index.js";

export type PortResult<Value> = Result<Value, DomainError>;
export type AsyncPortResult<Value> = Promise<PortResult<Value>>;

export interface ReadOptions {
  readonly signal?: AbortSignal;
}

export interface MutationOptions extends ReadOptions {
  readonly idempotencyKey: string;
}

export interface PlatformIdentity {
  readonly provider: string;
  readonly accountFingerprint: string;
}
