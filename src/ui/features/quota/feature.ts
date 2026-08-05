import type { UiFeatureRegistration } from "../../registry/index.js";
import { createQuotaUiFeatureRegistration } from "./registration.js";
import type { QuotaDashboardUseCase, QuotaUiActionReadModel } from "./use-case.js";
import { renderQuotaDashboard } from "./view.js";

export class QuotaUiFeature {
  readonly #useCase: QuotaDashboardUseCase;

  constructor(useCase: QuotaDashboardUseCase) {
    this.#useCase = useCase;
  }

  async render(): Promise<string> {
    return renderQuotaDashboard(await this.#useCase.read());
  }

  refresh(provider: string): Promise<QuotaUiActionReadModel> {
    return this.#useCase.refresh(provider);
  }

  resume(provider: string): Promise<QuotaUiActionReadModel> {
    return this.#useCase.resume(provider);
  }

  uiFeatureRegistration(): UiFeatureRegistration {
    return createQuotaUiFeatureRegistration(this);
  }
}

export function createQuotaUiFeature(useCase: QuotaDashboardUseCase): QuotaUiFeature {
  return new QuotaUiFeature(useCase);
}
