import {
  createProductionRegistrationSetupComposition,
  type CreateProductionRegistrationSetupCompositionOptions,
  type ProductionRegistrationSetupComposition,
} from "../../../adapters/registration/setup-composition.js";
import type {
  GitHubRegistrationTarget,
  RegistrationReadOnlyScanUseCase,
} from "../../../application/registration/index.js";
import type { UiFeatureRegistration } from "../../registry/index.js";

import {
  createRegistrationWizardUiFeatureRegistration,
  type RegistrationGitHubUseCaseFactory,
  type RegistrationLinearUseCaseFactory,
} from "./registration.js";

export interface CreateProductionRegistrationWizardUiCompositionOptions {
  /** Explicit production dependency; this composition never selects the O002 fixture. */
  readonly readOnlyScan: RegistrationReadOnlyScanUseCase;
  /** Explicit production dependency; this composition never selects the O003 fixture. */
  readonly linearUseCaseFactory: RegistrationLinearUseCaseFactory;
  /** Explicit production dependency; this composition never selects the O004 fixture. */
  readonly githubUseCaseFactory: RegistrationGitHubUseCaseFactory;
  readonly githubTarget: GitHubRegistrationTarget;
  readonly setup: CreateProductionRegistrationSetupCompositionOptions;
}

export interface ProductionRegistrationWizardUiComposition {
  readonly feature: UiFeatureRegistration;
  readonly setupWiring: ProductionRegistrationSetupComposition["wiring"];
}

/**
 * Production host composition for the single Registration Wizard slot.
 * Every pre-O005 dependency is explicit, and the W3A controller is injected into
 * that same feature. Missing Setup dependencies remain visibly fail closed.
 */
export function createProductionRegistrationWizardUiComposition(
  options: CreateProductionRegistrationWizardUiCompositionOptions,
): ProductionRegistrationWizardUiComposition {
  const setup = createProductionRegistrationSetupComposition(options.setup);
  return Object.freeze({
    feature: createRegistrationWizardUiFeatureRegistration(
      options.readOnlyScan,
      options.linearUseCaseFactory,
      options.githubUseCaseFactory,
      options.githubTarget,
      setup.controller,
    ),
    setupWiring: setup.wiring,
  });
}
