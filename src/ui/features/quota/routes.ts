import type { UiSecurityRouteContract } from "../../security/index.js";
import { uiShellCoreRouteContracts } from "../../shell/index.js";
import {
  quotaCssPath,
  quotaPagePath,
  quotaRefreshPath,
  quotaResumePath,
  quotaScriptPath,
} from "./metadata.js";

const readMethods = Object.freeze(["GET"] as const);
const mutationMethods = Object.freeze(["POST"] as const);

export const quotaFeatureSecurityRoutes: readonly UiSecurityRouteContract[] = Object.freeze([
  ...[quotaCssPath, quotaScriptPath].map((path) =>
    Object.freeze({
      path,
      allowedQueryParameters: Object.freeze([]),
      allowedMethods: readMethods,
      response: "standard" as const,
    }),
  ),
  ...[quotaRefreshPath, quotaResumePath].map((path) =>
    Object.freeze({
      path,
      allowedQueryParameters: Object.freeze([]),
      allowedMethods: mutationMethods,
      response: "standard" as const,
      mutationBody: "bounded-json" as const,
    }),
  ),
]);

/** Compatibility route union for callers that still construct handler and policy separately. */
export const quotaUiSecurityRoutes: readonly UiSecurityRouteContract[] = Object.freeze([
  ...uiShellCoreRouteContracts,
  Object.freeze({
    path: quotaPagePath,
    allowedQueryParameters: Object.freeze([]),
    allowedMethods: readMethods,
    response: "standard" as const,
  }),
  ...quotaFeatureSecurityRoutes,
]);
