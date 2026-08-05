import type { UiSecurityRouteContract } from "../../security/index.js";

export const registrationSetupApprovalPagePath = "/registration/setup-approval" as const;
export const registrationSetupApprovalApiPath = "/api/registration/setup-approval" as const;

export const registrationSetupFeatureSecurityRoutes: readonly UiSecurityRouteContract[] =
  Object.freeze([
    Object.freeze({
      path: registrationSetupApprovalApiPath,
      allowedQueryParameters: Object.freeze([]),
      allowedMethods: Object.freeze(["GET", "PUT"] as const),
      response: "standard" as const,
      mutationBody: "bounded-json" as const,
    }),
  ]);
