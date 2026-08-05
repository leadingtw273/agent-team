import { readFileSync } from "node:fs";

import type { UiFeatureRegistration, UiFeatureRoute } from "../../registry/index.js";
import type { UiRequest, UiResponse } from "../../server/index.js";
import { isQuotaProviderId } from "./contracts.js";
import type { QuotaUiFeature } from "./feature.js";
import {
  quotaCssPath,
  quotaPageDescription,
  quotaPagePath,
  quotaPageTitle,
  quotaRefreshPath,
  quotaResumePath,
  quotaScriptPath,
} from "./metadata.js";
import { quotaFeatureSecurityRoutes } from "./routes.js";

const quotaCss = readFileSync(new URL("../../assets/quota.css", import.meta.url), "utf8");
const quotaScript = readFileSync(new URL("../../assets/quota.js", import.meta.url), "utf8");

function fixedResponse(statusCode: number, body: string, allow?: string): UiResponse {
  return Object.freeze({
    statusCode,
    headers: Object.freeze({
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      ...(allow === undefined ? {} : { allow }),
    }),
    body,
  });
}

function assetResponse(request: UiRequest, content: string, contentType: string): UiResponse {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return fixedResponse(405, "Method Not Allowed\n", "GET, HEAD");
  }
  const headers = Object.freeze({ "cache-control": "no-store", "content-type": contentType });
  return request.method === "HEAD"
    ? Object.freeze({ statusCode: 200, headers })
    : Object.freeze({ statusCode: 200, headers, body: content });
}

function providerFromRequest(request: UiRequest): string | undefined {
  if (request.body === undefined) return undefined;
  const keys = Object.keys(request.body);
  if (keys.length !== 1 || keys[0] !== "provider") return undefined;
  const provider = request.body["provider"];
  return typeof provider === "string" && isQuotaProviderId(provider) ? provider : undefined;
}

function mutationHandler(
  feature: QuotaUiFeature,
  action: "refresh" | "resume",
): UiFeatureRoute["handler"] {
  return async (request) => {
    if (request.method !== "POST") return fixedResponse(405, "Method Not Allowed\n", "POST");
    if (request.auth.kind !== "session") return fixedResponse(401, "Unauthorized\n");
    const provider = providerFromRequest(request);
    if (provider === undefined) return fixedResponse(400, "Bad Request\n");
    const result =
      action === "refresh" ? await feature.refresh(provider) : await feature.resume(provider);
    return Object.freeze({
      statusCode: result.state === "accepted" ? 200 : 409,
      headers: Object.freeze({
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      }),
      body: JSON.stringify(result),
    });
  };
}

export function createQuotaUiFeatureRegistration(feature: QuotaUiFeature): UiFeatureRegistration {
  const contracts = new Map(
    quotaFeatureSecurityRoutes.map((contract) => [contract.path, contract]),
  );
  const requiredContract = (path: string) => {
    const contract = contracts.get(path);
    if (contract === undefined) throw new TypeError("Missing Quota UI route contract.");
    return contract;
  };
  return Object.freeze({
    id: "quota",
    slot: "quota",
    page: Object.freeze({
      path: quotaPagePath,
      title: quotaPageTitle,
      description: quotaPageDescription,
      styles: Object.freeze([quotaCssPath]),
      scripts: Object.freeze([quotaScriptPath]),
      render: () => feature.render(),
    }),
    routes: Object.freeze([
      Object.freeze({
        contract: requiredContract(quotaCssPath),
        handler: (request: UiRequest) =>
          assetResponse(request, quotaCss, "text/css; charset=utf-8"),
      }),
      Object.freeze({
        contract: requiredContract(quotaScriptPath),
        handler: (request: UiRequest) =>
          assetResponse(request, quotaScript, "text/javascript; charset=utf-8"),
      }),
      Object.freeze({
        contract: requiredContract(quotaRefreshPath),
        handler: mutationHandler(feature, "refresh"),
      }),
      Object.freeze({
        contract: requiredContract(quotaResumePath),
        handler: mutationHandler(feature, "resume"),
      }),
    ]),
  });
}
