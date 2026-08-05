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
      return await buildQuotaDashboardReadModel(
        providers,
        this.policy,
        this.port.invalidateSnapshot.bind(this.port),
      );
    } catch {
      return await buildQuotaDashboardReadModel(
        [],
        this.policy,
        this.port.invalidateSnapshot.bind(this.port),
      );
    }
  }

  async refresh(provider: string): Promise<QuotaUiActionReadModel> {
    return this.runAction("refresh_sample", provider, (verifiedProvider) =>
      this.port.refreshSample(verifiedProvider),
    );
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
}
