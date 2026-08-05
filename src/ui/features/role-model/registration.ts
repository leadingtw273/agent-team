import { readFileSync } from "node:fs";

import type { UiFeatureRegistration, UiFeatureRoute } from "../../registry/index.js";
import type { UiRequest, UiResponse } from "../../server/index.js";
import { handleRoleModelTypedApiRequest, roleModelApiPath } from "./api.js";
import type { RoleModelFeature } from "./feature.js";
import { roleModelPageDescription, roleModelPagePath, roleModelPageTitle } from "./metadata.js";
import { roleModelFeatureSecurityRoutes } from "./routes.js";

const roleModelCss = readFileSync(new URL("../../assets/role-model.css", import.meta.url), "utf8");
const roleModelScript = readFileSync(
  new URL("../../assets/role-model.js", import.meta.url),
  "utf8",
);

function response(request: UiRequest, content: string, contentType: string): UiResponse {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return Object.freeze({
      statusCode: 405,
      headers: Object.freeze({ allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" }),
      body: "Method Not Allowed\n",
    });
  }
  const headers = Object.freeze({ "cache-control": "no-store", "content-type": contentType });
  return request.method === "HEAD"
    ? Object.freeze({ statusCode: 200, headers })
    : Object.freeze({ statusCode: 200, headers, body: content });
}

function jsonResponse(request: UiRequest, statusCode: number, value: unknown): UiResponse {
  const headers: Record<string, string> = {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  };
  if (statusCode === 405) headers["allow"] = "GET, PUT";
  return request.method === "HEAD"
    ? Object.freeze({ statusCode, headers: Object.freeze(headers) })
    : Object.freeze({
        statusCode,
        headers: Object.freeze(headers),
        body: JSON.stringify(value),
      });
}

export function createRoleModelUiFeatureRegistration(
  feature: RoleModelFeature,
): UiFeatureRegistration {
  const contracts = new Map(
    roleModelFeatureSecurityRoutes.map((contract) => [contract.path, contract]),
  );
  const requiredContract = (path: string) => {
    const contract = contracts.get(path);
    if (contract === undefined) throw new TypeError("Missing Role Model UI route contract.");
    return contract;
  };
  const routes: readonly UiFeatureRoute[] = Object.freeze([
    Object.freeze({
      contract: requiredContract("/assets/role-model.css"),
      handler: (request: UiRequest) => response(request, roleModelCss, "text/css; charset=utf-8"),
    }),
    Object.freeze({
      contract: requiredContract("/assets/role-model.js"),
      handler: (request: UiRequest) =>
        response(request, roleModelScript, "text/javascript; charset=utf-8"),
    }),
    Object.freeze({
      contract: requiredContract(roleModelApiPath),
      handler: async (request: UiRequest) => {
        const result = await handleRoleModelTypedApiRequest(feature, {
          method: request.method,
          ...(request.body === undefined ? {} : { input: request.body }),
        });
        return jsonResponse(request, result.statusCode, result.body);
      },
    }),
  ]);
  return Object.freeze({
    id: "role-model",
    slot: "role-models",
    page: Object.freeze({
      path: roleModelPagePath,
      title: roleModelPageTitle,
      description: roleModelPageDescription,
      styles: Object.freeze(["/assets/role-model.css"]),
      scripts: Object.freeze(["/assets/role-model.js"]),
      render: () => feature.render(),
    }),
    routes,
  });
}
