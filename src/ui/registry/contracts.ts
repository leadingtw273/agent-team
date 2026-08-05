import type { UiRequestHandler } from "../server/index.js";
import type { UiSecurityRouteContract } from "../security/index.js";

export type UiFeatureSlot =
  "running" | "role-models" | "quota" | "security" | "settings" | "registration";

export interface UiFeaturePage {
  readonly path: string;
  readonly title: string;
  readonly description: string;
  readonly styles?: readonly string[];
  readonly scripts?: readonly string[];
  readonly render: () => string | Promise<string>;
}

export interface UiFeatureRoute {
  readonly contract: UiSecurityRouteContract;
  readonly handler: UiRequestHandler;
}

export interface UiFeatureRegistration {
  readonly id: string;
  readonly slot: UiFeatureSlot;
  readonly page: UiFeaturePage;
  readonly routes: readonly UiFeatureRoute[];
}

export interface UiFeatureRegistrationProvider {
  readonly uiFeatureRegistration: () => UiFeatureRegistration;
}

export type UiFeatureSource = UiFeatureRegistration | UiFeatureRegistrationProvider;

export function isUiFeatureRegistrationProvider(
  source: UiFeatureSource,
): source is UiFeatureRegistrationProvider {
  return "uiFeatureRegistration" in source;
}
