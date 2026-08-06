import { readFileSync } from "node:fs";

import type { RegistrationSetupControllerUseCase } from "../../../application/registration/index.js";
import type { UiFeatureRoute } from "../../registry/index.js";
import type { UiRequest, UiResponse, UiTrustedRequestContext } from "../../server/index.js";
import { handleRegistrationSetupRequest } from "./http.js";
import {
  registrationSetupApiPath,
  registrationSetupContributionSecurityRoutes,
  registrationSetupCssPath,
  registrationSetupScriptPath,
} from "./routes.js";
import { renderRegistrationSetupPanel } from "./view.js";

const setupScript = readFileSync(
  new URL("../../assets/registration-setup.js", import.meta.url),
  "utf8",
);
const setupCss = readFileSync(
  new URL("../../assets/registration-setup.css", import.meta.url),
  "utf8",
);

function assetResponse(request: UiRequest, content: string, contentType: string): UiResponse {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return Object.freeze({
      statusCode: 405,
      headers: Object.freeze({
        allow: "GET, HEAD",
        "content-type": "text/plain; charset=utf-8",
      }),
      body: "Method Not Allowed\n",
    });
  }
  const headers = Object.freeze({ "cache-control": "no-store", "content-type": contentType });
  return request.method === "HEAD"
    ? Object.freeze({ statusCode: 200, headers })
    : Object.freeze({ statusCode: 200, headers, body: content });
}

export interface RegistrationSetupUiContribution {
  readonly styles: readonly [typeof registrationSetupCssPath];
  readonly scripts: readonly [typeof registrationSetupScriptPath];
  readonly routes: readonly UiFeatureRoute[];
  readonly render: (context: UiTrustedRequestContext) => Promise<string>;
}

export function createRegistrationSetupUiContribution(
  controller: RegistrationSetupControllerUseCase,
): RegistrationSetupUiContribution {
  const contracts = new Map(
    registrationSetupContributionSecurityRoutes.map((item) => [item.path, item]),
  );
  const css = contracts.get(registrationSetupCssPath);
  const script = contracts.get(registrationSetupScriptPath);
  const api = contracts.get(registrationSetupApiPath);
  if (css === undefined || script === undefined || api === undefined) {
    throw new TypeError("Missing Registration Setup contribution route.");
  }
  return Object.freeze({
    styles: Object.freeze([registrationSetupCssPath] as const),
    scripts: Object.freeze([registrationSetupScriptPath] as const),
    routes: Object.freeze([
      Object.freeze({
        contract: css,
        handler: (request: UiRequest) =>
          assetResponse(request, setupCss, "text/css; charset=utf-8"),
      }),
      Object.freeze({
        contract: script,
        handler: (request: UiRequest) =>
          assetResponse(request, setupScript, "text/javascript; charset=utf-8"),
      }),
      Object.freeze({
        contract: api,
        handler: (request: UiRequest, context: UiTrustedRequestContext) =>
          handleRegistrationSetupRequest(controller, request, context),
      }),
    ]),
    render: async (context: UiTrustedRequestContext) => {
      const authorityDigest = context.session?.authorityDigest;
      return renderRegistrationSetupPanel(
        authorityDigest === undefined
          ? Object.freeze({
              state: "configuration_incomplete" as const,
              evidence: Object.freeze([
                Object.freeze({
                  code: "production_dependencies_unwired" as const,
                  message: "缺少可信本機 UI session。",
                }),
              ]),
              nextStep: "重新開啟本機 UI session。",
            })
          : await controller.read({ authorityDigest }),
      );
    },
  });
}
