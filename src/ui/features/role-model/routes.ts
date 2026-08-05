import type { UiSecurityRouteContract } from "../../security/index.js";
import { uiShellCoreRouteContracts } from "../../shell/index.js";

import { roleModelApiPath } from "./api.js";
import { roleModelPagePath } from "./metadata.js";

const readMethods = Object.freeze(["GET"] as const);
const roleModelApiMethods = Object.freeze(["GET", "PUT"] as const);

export const roleModelFeatureSecurityRoutes: readonly UiSecurityRouteContract[] = Object.freeze([
  ...["/assets/role-model.css", "/assets/role-model.js"].map((path) =>
    Object.freeze({
      path,
      allowedQueryParameters: Object.freeze([]),
      allowedMethods: readMethods,
      response: "standard" as const,
    }),
  ),
  Object.freeze({
    path: roleModelApiPath,
    allowedQueryParameters: Object.freeze([]),
    allowedMethods: roleModelApiMethods,
    response: "standard" as const,
    mutationBody: "bounded-json" as const,
  }),
]);

/** Compatibility route union for callers that still construct handler and policy separately. */
export const roleModelUiSecurityRoutes: readonly UiSecurityRouteContract[] = Object.freeze([
  ...uiShellCoreRouteContracts,
  Object.freeze({
    path: roleModelPagePath,
    allowedQueryParameters: Object.freeze([]),
    allowedMethods: readMethods,
    response: "standard" as const,
  }),
  ...roleModelFeatureSecurityRoutes,
]);
