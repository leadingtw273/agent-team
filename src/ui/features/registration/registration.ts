import { readFileSync } from "node:fs";

import type { RegistrationReadOnlyScanUseCase } from "../../../application/registration/index.js";
import type { UiFeatureRegistration, UiFeatureRoute } from "../../registry/index.js";
import type { UiRequest, UiResponse } from "../../server/index.js";

import { fixtureRegistrationReadOnlyScanUseCase } from "./fixture.js";
import {
  registrationWizardCssPath,
  registrationWizardPageDescription,
  registrationWizardPagePath,
  registrationWizardPageTitle,
} from "./metadata.js";
import { registrationWizardFeatureSecurityRoutes } from "./routes.js";
import { renderRegistrationWizard } from "./view.js";

const registrationWizardCss = readFileSync(
  new URL("../../assets/registration.css", import.meta.url),
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
 * Content-only O002 registration. The supplied use case may perform seven
 * bounded read-only probes, but this UI contributes no scan endpoint, script,
 * or mutation route of its own.
 */
export function createRegistrationWizardUiFeatureRegistration(
  useCase: RegistrationReadOnlyScanUseCase = fixtureRegistrationReadOnlyScanUseCase,
): UiFeatureRegistration {
  const contracts = new Map(
    registrationWizardFeatureSecurityRoutes.map((contract) => [contract.path, contract]),
  );
  const cssContract = contracts.get(registrationWizardCssPath);
  if (cssContract === undefined)
    throw new TypeError("Missing Registration Wizard stylesheet route.");
  const routes: readonly UiFeatureRoute[] = Object.freeze([
    Object.freeze({
      contract: cssContract,
      handler: (request: UiRequest) => assetResponse(request, registrationWizardCss),
    }),
  ]);
  return Object.freeze({
    id: "registration-wizard",
    slot: "registration",
    page: Object.freeze({
      path: registrationWizardPagePath,
      title: registrationWizardPageTitle,
      description: registrationWizardPageDescription,
      styles: Object.freeze([registrationWizardCssPath]),
      render: async () => renderRegistrationWizard(await useCase.scan()),
    }),
    routes,
  });
}
