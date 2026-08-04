import type { Instant } from "../../domain/foundation/index.js";
import type { AsyncPortResult, PlatformIdentity, ReadOptions } from "./common.js";

interface QuotaSampleBase extends PlatformIdentity {
  readonly cliVersion: string;
  readonly source: string;
  readonly observedAt: Instant;
}

export type UsageQuotaSample =
  | (QuotaSampleBase &
      Readonly<{
        kind: "usage";
        bucket: "weekly" | "five_hour";
        state: "confirmed";
        remainingPercent: number;
        resetsAt?: Instant;
      }>)
  | (QuotaSampleBase &
      Readonly<{
        kind: "usage";
        bucket: "weekly" | "five_hour";
        state: "stale" | "unknown";
        reason: string;
      }>);

export type AvailabilityQuotaSample =
  | (QuotaSampleBase &
      Readonly<{
        kind: "availability";
        state: "confirmed";
        available: boolean;
      }>)
  | (QuotaSampleBase &
      Readonly<{
        kind: "availability";
        state: "stale" | "unknown";
        reason: string;
      }>);

export type QuotaSample = UsageQuotaSample | AvailabilityQuotaSample;

export interface QuotaSnapshot extends PlatformIdentity {
  readonly samples: readonly QuotaSample[];
}

export interface QuotaPort {
  readCached(identity: PlatformIdentity, options?: ReadOptions): AsyncPortResult<QuotaSnapshot>;
  refresh(provider: string, options?: ReadOptions): AsyncPortResult<QuotaSnapshot>;
}
