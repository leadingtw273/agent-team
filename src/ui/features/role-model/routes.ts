import type { UiSecurityRouteContract } from "../../security/index.js";

import { roleModelApiPath } from "./api.js";
import { roleModelPagePath } from "./feature.js";

const readMethods = Object.freeze(["GET"] as const);
const roleModelApiMethods = Object.freeze(["GET", "PUT"] as const);

/** Exact allow-list required to run the completed shell page behind U002 security. */
export const roleModelUiSecurityRoutes: readonly UiSecurityRouteContract[] = Object.freeze([
  ...["/", "/projects", "/events", roleModelPagePath].map((path) =>
    Object.freeze({
      path,
      allowedQueryParameters: Object.freeze([]),
      allowedMethods: readMethods,
      response: "standard" as const,
    }),
  ),
  ...[
    "/assets/icons.svg",
    "/assets/tabler-1.4.0.min.css",
    "/assets/ui-shell.css",
    "/assets/role-model.css",
    "/assets/role-model.js",
  ].map((path) =>
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
