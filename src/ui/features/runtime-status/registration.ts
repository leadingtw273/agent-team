import { readFileSync } from "node:fs";

import type { UiFeatureRegistration, UiFeatureRoute } from "../../registry/index.js";
import type { UiRequest, UiResponse } from "../../server/index.js";

import { fixtureRuntimeStatusReadModel } from "./fixture.js";
import {
  runtimeStatusCssPath,
  runtimeStatusPageDescription,
  runtimeStatusPagePath,
  runtimeStatusPageTitle,
} from "./metadata.js";
import type { RuntimeStatusReadModel } from "./model.js";
import { runtimeStatusFeatureSecurityRoutes } from "./routes.js";
import { renderRuntimeStatusPage } from "./view.js";

const runtimeStatusCss = readFileSync(
  new URL("../../assets/runtime-status.css", import.meta.url),
  "utf8",
);

function assetResponse(request: UiRequest, content: string): UiResponse {
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
  const headers = Object.freeze({
    "cache-control": "no-store",
    "content-type": "text/css; charset=utf-8",
  });
  return request.method === "HEAD"
    ? Object.freeze({ statusCode: 200, headers })
    : Object.freeze({ statusCode: 200, headers, body: content });
}

/**
 * Registers content only: Registry owns the GET/HEAD page contract and Shell owns the document.
 * Runtime Status contributes no mutations, scripts, or alternate HTML shell.
 */
export function createRuntimeStatusUiFeatureRegistration(
  readModel: RuntimeStatusReadModel = fixtureRuntimeStatusReadModel,
): UiFeatureRegistration {
  const contracts = new Map(
    runtimeStatusFeatureSecurityRoutes.map((contract) => [contract.path, contract]),
  );
  const requiredContract = (path: string) => {
    const contract = contracts.get(path);
    if (contract === undefined) throw new TypeError("Missing Runtime Status UI route contract.");
    return contract;
  };
  const routes: readonly UiFeatureRoute[] = Object.freeze([
    Object.freeze({
      contract: requiredContract(runtimeStatusCssPath),
      handler: (request: UiRequest) => assetResponse(request, runtimeStatusCss),
    }),
  ]);

  return Object.freeze({
    id: "runtime-status",
    slot: "running",
    page: Object.freeze({
      path: runtimeStatusPagePath,
      title: runtimeStatusPageTitle,
      description: runtimeStatusPageDescription,
      styles: Object.freeze([runtimeStatusCssPath]),
      render: () => renderRuntimeStatusPage(readModel),
    }),
    routes,
  });
}
