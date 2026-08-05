import type { UiSecurityRouteContract } from "../../security/index.js";
import { uiShellCoreRouteContracts } from "../../shell/index.js";

import { registrationWizardCssPath, registrationWizardPagePath } from "./metadata.js";

const readOnlyMethods = Object.freeze(["GET"] as const);

/** O002 owns only a static stylesheet; no scan API or mutation endpoint is exposed. */
export const registrationWizardFeatureSecurityRoutes: readonly UiSecurityRouteContract[] =
  Object.freeze([
    Object.freeze({
      path: registrationWizardCssPath,
      allowedQueryParameters: Object.freeze([]),
      allowedMethods: readOnlyMethods,
      response: "standard" as const,
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
