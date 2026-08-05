import type { UiSecurityRouteContract } from "../../security/index.js";

export const registrationSetupApiPath = "/api/registration/setup" as const;
export const registrationSetupScriptPath = "/assets/registration-setup.js" as const;
export const registrationSetupCssPath = "/assets/registration-setup.css" as const;

export const registrationSetupContributionSecurityRoutes: readonly UiSecurityRouteContract[] =
  Object.freeze([
    ...[registrationSetupScriptPath, registrationSetupCssPath].map((path) =>
      Object.freeze({
        path,
        allowedQueryParameters: Object.freeze([]),
        allowedMethods: Object.freeze(["GET"] as const),
        response: "standard" as const,
      }),
    ),
    Object.freeze({
      path: registrationSetupApiPath,
      allowedQueryParameters: Object.freeze([]),
      allowedMethods: Object.freeze(["GET", "PUT"] as const),
      response: "standard" as const,
      mutationBody: "bounded-json" as const,
    }),
  ]);
