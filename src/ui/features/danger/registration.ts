import { readFileSync } from "node:fs";

import type { UiFeatureRegistration, UiFeatureRoute } from "../../registry/index.js";
import type { UiRequest, UiResponse } from "../../server/index.js";
import { dangerApiPath, handleDangerApiRequest } from "./http.js";
import type { DangerApprovalUseCase } from "./index.js";
import {
  dangerCssPath,
  dangerFeatureSecurityRoutes,
  dangerPagePath,
  dangerScriptPath,
} from "./routes.js";
import { renderDangerPage } from "./view.js";

const dangerCss = readFileSync(new URL("../../assets/danger.css", import.meta.url), "utf8");
const dangerScript = readFileSync(new URL("../../assets/danger.js", import.meta.url), "utf8");

function assetResponse(request: UiRequest, content: string, contentType: string): UiResponse {
  const headers = Object.freeze({ "cache-control": "no-store", "content-type": contentType });
  return request.method === "HEAD"
    ? Object.freeze({ statusCode: 200, headers })
    : Object.freeze({ statusCode: 200, headers, body: content });
}

export function createDangerUiFeatureRegistration(
  useCase: DangerApprovalUseCase,
): UiFeatureRegistration {
  const contracts = new Map(
    dangerFeatureSecurityRoutes.map((contract) => [contract.path, contract]),
  );
  const requiredContract = (path: string) => {
    const contract = contracts.get(path);
    if (contract === undefined) throw new TypeError("Missing Danger UI route contract.");
    return contract;
  };
  const routes: readonly UiFeatureRoute[] = Object.freeze([
    Object.freeze({
      contract: requiredContract(dangerCssPath),
      handler: (request: UiRequest) => assetResponse(request, dangerCss, "text/css; charset=utf-8"),
    }),
    Object.freeze({
      contract: requiredContract(dangerScriptPath),
      handler: (request: UiRequest) =>
        assetResponse(request, dangerScript, "text/javascript; charset=utf-8"),
    }),
    Object.freeze({
      contract: requiredContract(dangerApiPath),
      handler: (request: UiRequest) => handleDangerApiRequest(useCase, request),
    }),
  ]);

  return Object.freeze({
    id: "danger",
    slot: "security",
    page: Object.freeze({
      path: dangerPagePath,
      title: "安全核可",
      description: "只在本機安全工作階段中檢視並決定等待中的危險操作。",
      styles: Object.freeze([dangerCssPath]),
      scripts: Object.freeze([dangerScriptPath]),
      render: () => renderDangerPage(useCase.read()),
    }),
    routes,
  });
}
