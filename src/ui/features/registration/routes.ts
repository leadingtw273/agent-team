import type { UiSecurityRouteContract } from "../../security/index.js";
import { uiShellCoreRouteContracts } from "../../shell/index.js";

import { linearProvisionApiPath } from "./linear-http.js";
import {
  registrationWizardCssPath,
  registrationWizardPagePath,
  registrationWizardScriptPath,
} from "./metadata.js";

const readOnlyMethods = Object.freeze(["GET"] as const);

/** O003 adds one typed, bounded mutation route under O002's existing Registry feature. */
export const registrationWizardFeatureSecurityRoutes: readonly UiSecurityRouteContract[] =
  Object.freeze([
    ...[registrationWizardCssPath, registrationWizardScriptPath].map((path) =>
      Object.freeze({
        path,
        allowedQueryParameters: Object.freeze([]),
        allowedMethods: readOnlyMethods,
        response: "standard" as const,
      }),
    ),
    Object.freeze({
      path: linearProvisionApiPath,
      allowedQueryParameters: Object.freeze([]),
      allowedMethods: Object.freeze(["GET", "PUT"] as const),
      response: "standard" as const,
      mutationBody: "bounded-json" as const,
    }),
  ]);

/** Compatibility route union for callers that still build feature policy separately. */
export const registrationWizardUiSecurityRoutes: readonly UiSecurityRouteContract[] = Object.freeze(
  [
    ...uiShellCoreRouteContracts,
    Object.freeze({
      path: registrationWizardPagePath,
      allowedQueryParameters: Object.freeze([]),
      allowedMethods: readOnlyMethods,
      response: "standard" as const,
    }),
    ...registrationWizardFeatureSecurityRoutes,
  ],
);
