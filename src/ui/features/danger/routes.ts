import type { UiSecurityRouteContract } from "../../security/index.js";
import { dangerApiPath } from "./http.js";

export const dangerPagePath = "/security" as const;
export const dangerCssPath = "/assets/danger.css" as const;
export const dangerScriptPath = "/assets/danger.js" as const;

const readMethods = Object.freeze(["GET"] as const);

export const dangerUiRouteContract: UiSecurityRouteContract = Object.freeze({
  path: dangerApiPath,
  allowedQueryParameters: Object.freeze([]),
  allowedMethods: Object.freeze(["GET", "PUT"] as const),
  response: "standard" as const,
  mutationBody: "bounded-json" as const,
});

export const dangerFeatureSecurityRoutes: readonly UiSecurityRouteContract[] = Object.freeze([
  ...[dangerCssPath, dangerScriptPath].map((path) =>
    Object.freeze({
      path,
      allowedQueryParameters: Object.freeze([]),
      allowedMethods: readMethods,
      response: "standard" as const,
    }),
  ),
  dangerUiRouteContract,
]);
