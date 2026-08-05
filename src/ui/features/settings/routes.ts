import type { UiSecurityRouteContract } from "../../security/index.js";
import { uiShellCoreRouteContracts } from "../../shell/index.js";

import { settingsApiPath } from "./http.js";
import { settingsPagePath } from "./metadata.js";

const readMethods = Object.freeze(["GET"] as const);

export const settingsFeatureSecurityRoutes: readonly UiSecurityRouteContract[] = Object.freeze([
  ...["/assets/settings.css", "/assets/settings.js"].map((path) =>
    Object.freeze({
      path,
      allowedQueryParameters: Object.freeze([]),
      allowedMethods: readMethods,
      response: "standard" as const,
    }),
  ),
  Object.freeze({
    path: settingsApiPath,
    allowedQueryParameters: Object.freeze([]),
    allowedMethods: Object.freeze(["GET", "PUT"] as const),
    response: "secret-safe" as const,
    mutationBody: "bounded-json" as const,
  }),
]);

/** Compatibility route union for callers that still construct handler and policy separately. */
export const settingsUiSecurityRoutes: readonly UiSecurityRouteContract[] = Object.freeze([
  ...uiShellCoreRouteContracts,
  Object.freeze({
    path: settingsPagePath,
    allowedQueryParameters: Object.freeze([]),
    allowedMethods: readMethods,
    response: "standard" as const,
  }),
  ...settingsFeatureSecurityRoutes,
]);
