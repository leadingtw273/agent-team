import type { PlatformIdentity, QuotaSnapshot } from "../../../application/ports/index.js";

export const quotaProviderIds = Object.freeze(["codex", "claude", "gemini"] as const);

export type QuotaProviderId = (typeof quotaProviderIds)[number];

export interface QuotaProviderRecord {
  readonly provider: QuotaProviderId;
  readonly activeIdentity: PlatformIdentity;
  /** User-configured weekly usage ceiling. Gemini deliberately has no such configuration. */
  readonly weeklyUsageLimitPercent?: number;
  readonly snapshot?: QuotaSnapshot;
}

export interface QuotaMutationResult {
  readonly state: "accepted" | "rejected";
  readonly reason: string;
}

/**
 * A feature-local boundary. Runtime adapters remain behind this closure and are never exposed to
 * the HTTP handler or rendered into the page.
 */
export interface QuotaDashboardPort {
  listProviders(): Promise<readonly QuotaProviderRecord[]>;
  invalidateSnapshot(provider: QuotaProviderId, reason: "account_switched"): Promise<void>;
  refreshSample(provider: QuotaProviderId): Promise<QuotaMutationResult>;
  resumeDispatch(provider: QuotaProviderId): Promise<QuotaMutationResult>;
}

export function isQuotaProviderId(value: string): value is QuotaProviderId {
  return (quotaProviderIds as readonly string[]).includes(value);
}
