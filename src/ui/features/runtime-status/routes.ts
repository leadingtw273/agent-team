import type { UiSecurityRouteContract } from "../../security/index.js";
import { uiShellCoreRouteContracts } from "../../shell/index.js";

import { runtimeStatusCssPath, runtimeStatusPagePath } from "./metadata.js";

const readOnlyMethods = Object.freeze(["GET"] as const);

/** Runtime Status owns only a GET/HEAD CSS asset; its page is composed by the shared Registry. */
export const runtimeStatusFeatureSecurityRoutes: readonly UiSecurityRouteContract[] = Object.freeze(
  [
    Object.freeze({
      path: runtimeStatusCssPath,
      allowedQueryParameters: Object.freeze([]),
      allowedMethods: readOnlyMethods,
      response: "standard" as const,
    }),
  ],
);

/** Compatibility route union for callers that still construct handler and policy separately. */
export const runtimeStatusUiSecurityRoutes: readonly UiSecurityRouteContract[] = Object.freeze([
  ...uiShellCoreRouteContracts,
  Object.freeze({
    path: runtimeStatusPagePath,
    allowedQueryParameters: Object.freeze([]),
    allowedMethods: readOnlyMethods,
    response: "standard" as const,
  }),
  ...runtimeStatusFeatureSecurityRoutes,
]);
