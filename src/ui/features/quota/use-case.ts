import type { QuotaDashboardPort, QuotaMutationResult, QuotaProviderId } from "./contracts.js";
import { isQuotaProviderId } from "./contracts.js";
import {
  buildQuotaDashboardReadModel,
  type QuotaDashboardReadModel,
  type QuotaReadModelPolicy,
} from "./read-model.js";

export type QuotaUiAction = "refresh_sample" | "resume_dispatch";

export type QuotaUiActionReadModel = Readonly<{
  action: QuotaUiAction;
  provider: QuotaProviderId | "unknown";
  state: "accepted" | "rejected";
  reason: "action_failed" | "manual_review_recorded" | "provider_invalid" | "refresh_started";
}>;

const trustedActionReasons = new Set<QuotaUiActionReadModel["reason"]>([
  "action_failed",
  "manual_review_recorded",
  "provider_invalid",
  "refresh_started",
]);

function actionResult(
  action: QuotaUiAction,
  provider: QuotaProviderId | "unknown",
  source: QuotaMutationResult,
): QuotaUiActionReadModel {
  const reason = trustedActionReasons.has(source.reason as QuotaUiActionReadModel["reason"])
    ? (source.reason as QuotaUiActionReadModel["reason"])
    : "action_failed";
  return Object.freeze({ action, provider, state: source.state, reason });
}

export class QuotaDashboardUseCase {
  constructor(
    private readonly port: QuotaDashboardPort,
    private readonly policy: QuotaReadModelPolicy,
  ) {}

  async read(): Promise<QuotaDashboardReadModel> {
    try {
      const providers = await this.port.listProviders();
      return buildQuotaDashboardReadModel(providers, this.policy);
    } catch {
      return buildQuotaDashboardReadModel([], this.policy);
    }
  }

  async refresh(provider: string): Promise<QuotaUiActionReadModel> {
    return this.runAction("refresh_sample", provider, async (verifiedProvider) => {
      await this.invalidateSwitchedSnapshot(verifiedProvider);
      return this.port.refreshSample(verifiedProvider);
    });
  }

  async resume(provider: string): Promise<QuotaUiActionReadModel> {
    return this.runAction("resume_dispatch", provider, (verifiedProvider) =>
      this.port.resumeDispatch(verifiedProvider),
    );
  }

  private async runAction(
    action: QuotaUiAction,
    provider: string,
    mutation: (provider: QuotaProviderId) => Promise<QuotaMutationResult>,
  ): Promise<QuotaUiActionReadModel> {
    if (!isQuotaProviderId(provider)) {
      return Object.freeze({
        action,
        provider: "unknown",
        state: "rejected",
        reason: "provider_invalid",
      });
    }
    try {
      return actionResult(action, provider, await mutation(provider));
    } catch {
      return Object.freeze({ action, provider, state: "rejected", reason: "action_failed" });
    }
  }

  private async invalidateSwitchedSnapshot(provider: QuotaProviderId): Promise<void> {
    const matches = (await this.port.listProviders()).filter(
      (record) => record.provider === provider,
    );
    if (matches.length !== 1) return;
    const record = matches[0];
    if (
      record?.snapshot?.provider === provider &&
      record.activeIdentity.provider === provider &&
      record.snapshot.accountFingerprint !== record.activeIdentity.accountFingerprint
    ) {
      await this.port.invalidateSnapshot(provider, "account_switched");
    }
  }
}
