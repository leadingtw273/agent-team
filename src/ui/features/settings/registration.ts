import { readFileSync } from "node:fs";

import type { UiFeatureRegistration, UiFeatureRoute } from "../../registry/index.js";
import type { UiRequest, UiResponse } from "../../server/index.js";
import { handleSettingsApiRequest, settingsApiPath } from "./http.js";
import { settingsPageDescription, settingsPagePath, settingsPageTitle } from "./metadata.js";
import { settingsFeatureSecurityRoutes } from "./routes.js";
import type { SettingsUseCase } from "./use-case.js";
import { renderSettingsContent } from "./view.js";

const settingsCss = readFileSync(new URL("../../assets/settings.css", import.meta.url), "utf8");
const settingsScript = readFileSync(new URL("../../assets/settings.js", import.meta.url), "utf8");

function assetResponse(request: UiRequest, content: string, contentType: string): UiResponse {
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

export function createSettingsUiFeatureRegistration(
  useCase: SettingsUseCase,
): UiFeatureRegistration {
  const contracts = new Map(
    settingsFeatureSecurityRoutes.map((contract) => [contract.path, contract]),
  );
  const requiredContract = (path: string) => {
    const contract = contracts.get(path);
    if (contract === undefined) throw new TypeError("Missing Settings UI route contract.");
    return contract;
  };
  const routes: readonly UiFeatureRoute[] = Object.freeze([
    Object.freeze({
      contract: requiredContract("/assets/settings.css"),
      handler: (request: UiRequest) =>
        assetResponse(request, settingsCss, "text/css; charset=utf-8"),
    }),
    Object.freeze({
      contract: requiredContract("/assets/settings.js"),
      handler: (request: UiRequest) =>
        assetResponse(request, settingsScript, "text/javascript; charset=utf-8"),
    }),
    Object.freeze({
      contract: requiredContract(settingsApiPath),
      handler: (request: UiRequest) => handleSettingsApiRequest(useCase, request),
    }),
  ]);
  return Object.freeze({
    id: "settings",
    slot: "settings",
    page: Object.freeze({
      path: settingsPagePath,
      title: settingsPageTitle,
      description: settingsPageDescription,
      styles: Object.freeze(["/assets/settings.css"]),
      scripts: Object.freeze(["/assets/settings.js"]),
      render: async () => renderSettingsContent(await useCase.read()),
    }),
    routes,
  });
}
