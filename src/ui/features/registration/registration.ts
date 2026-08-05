import { readFileSync } from "node:fs";

import type {
  GitHubRegistrationPolicyUseCase,
  GitHubRegistrationTarget,
  LinearProvisionConfirmationContext,
  LinearProvisionUseCase,
  RegistrationReadOnlyScanUseCase,
} from "../../../application/registration/index.js";
import type { UiFeatureRegistration, UiFeatureRoute } from "../../registry/index.js";
import type { UiRequest, UiResponse, UiTrustedRequestContext } from "../../server/index.js";

import { fixtureRegistrationReadOnlyScanUseCase } from "./fixture.js";
import {
  createFixtureGitHubRegistrationPolicyUseCaseFactory,
  fixtureGitHubRegistrationUiController,
} from "./github-policy-fixture.js";
import {
  createGitHubRegistrationUiContribution,
  createGitHubRegistrationUiController,
  githubRegistrationPolicyApiPath,
  githubRegistrationPolicyScriptPath,
  handleGitHubRegistrationPolicyRequest,
  type GitHubRegistrationUiController,
} from "./github-policy.js";
import { createFixtureLinearProvisionUseCaseFactory } from "./linear-fixture.js";
import { handleLinearProvisionApiRequest, linearProvisionApiPath } from "./linear-http.js";
import {
  registrationWizardCssPath,
  registrationWizardPageDescription,
  registrationWizardPagePath,
  registrationWizardPageTitle,
  registrationWizardScriptPath,
} from "./metadata.js";
import { registrationWizardFeatureSecurityRoutes } from "./routes.js";
import { renderRegistrationWizard } from "./view.js";

const registrationWizardCss = readFileSync(
  new URL("../../assets/registration.css", import.meta.url),
  "utf8",
);
const registrationWizardScript = readFileSync(
  new URL("../../assets/registration.js", import.meta.url),
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
  const headers = Object.freeze({
    "cache-control": "no-store",
    "content-type": contentType,
  });
  return request.method === "HEAD"
    ? Object.freeze({ statusCode: 200, headers })
    : Object.freeze({ statusCode: 200, headers, body: content });
}

/**
 * O002 owns the single Registration page. O003 composes a typed Linear
 * preview/provision section into that page without creating another Shell.
 */
export function createRegistrationWizardUiFeatureRegistration(
  useCase: RegistrationReadOnlyScanUseCase = fixtureRegistrationReadOnlyScanUseCase,
  linearUseCaseFactory: (
    context: LinearProvisionConfirmationContext,
  ) => LinearProvisionUseCase = createFixtureLinearProvisionUseCaseFactory(),
  githubUseCaseFactory: (
    context: LinearProvisionConfirmationContext,
  ) => GitHubRegistrationPolicyUseCase = createFixtureGitHubRegistrationPolicyUseCaseFactory(),
  githubTarget: GitHubRegistrationTarget = Object.freeze({
    repository: "fixture/registered-project",
    defaultBranch: "main",
  }),
): UiFeatureRegistration {
  const sessionUseCase = (
    trustedContext: UiTrustedRequestContext,
  ): LinearProvisionUseCase | undefined => {
    const digest = trustedContext.session?.authorityDigest;
    return digest === undefined ? undefined : linearUseCaseFactory(Object.freeze({ digest }));
  };
  let githubSession:
    Readonly<{ digest: string; controller: GitHubRegistrationUiController }> | undefined;
  const sessionGitHubController = (
    trustedContext: UiTrustedRequestContext,
  ): GitHubRegistrationUiController | undefined => {
    const digest = trustedContext.session?.authorityDigest;
    if (digest === undefined) return undefined;
    if (githubSession?.digest === digest) return githubSession.controller;
    const policy = githubUseCaseFactory(Object.freeze({ digest }));
    const controller = createGitHubRegistrationUiController(policy, githubTarget);
    githubSession = Object.freeze({ digest, controller });
    return controller;
  };
  const githubContribution = createGitHubRegistrationUiContribution(
    fixtureGitHubRegistrationUiController,
  );
  const contracts = new Map(
    registrationWizardFeatureSecurityRoutes.map((contract) => [contract.path, contract]),
  );
  const cssContract = contracts.get(registrationWizardCssPath);
  if (cssContract === undefined)
    throw new TypeError("Missing Registration Wizard stylesheet route.");
  const scriptContract = contracts.get(registrationWizardScriptPath);
  const apiContract = contracts.get(linearProvisionApiPath);
  if (scriptContract === undefined || apiContract === undefined) {
    throw new TypeError("Missing Registration Wizard O003 route.");
  }
  const githubScriptRoute = githubContribution.routes.find(
    (route) => route.contract.path === githubRegistrationPolicyScriptPath,
  );
  const githubApiContract = githubContribution.routes.find(
    (route) => route.contract.path === githubRegistrationPolicyApiPath,
  )?.contract;
  if (githubScriptRoute === undefined || githubApiContract === undefined) {
    throw new TypeError("Missing Registration Wizard O004 route.");
  }
  const routes: readonly UiFeatureRoute[] = Object.freeze([
    Object.freeze({
      contract: cssContract,
      handler: (request: UiRequest) =>
        assetResponse(request, registrationWizardCss, "text/css; charset=utf-8"),
    }),
    Object.freeze({
      contract: scriptContract,
      handler: (request: UiRequest) =>
        assetResponse(request, registrationWizardScript, "text/javascript; charset=utf-8"),
    }),
    githubScriptRoute,
    Object.freeze({
      contract: apiContract,
      handler: (request: UiRequest, trustedContext: UiTrustedRequestContext) => {
        const linearUseCase = sessionUseCase(trustedContext);
        return linearUseCase === undefined
          ? Object.freeze({ statusCode: 403, body: "Forbidden\n" })
          : handleLinearProvisionApiRequest(linearUseCase, request);
      },
    }),
    Object.freeze({
      contract: githubApiContract,
      handler: (request: UiRequest, trustedContext: UiTrustedRequestContext) => {
        const controller = sessionGitHubController(trustedContext);
        return controller === undefined
          ? Object.freeze({ statusCode: 403, body: "Forbidden\n" })
          : handleGitHubRegistrationPolicyRequest(controller, request);
      },
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
      scripts: Object.freeze([registrationWizardScriptPath, githubRegistrationPolicyScriptPath]),
      render: async (trustedContext: UiTrustedRequestContext) => {
        const linearUseCase = sessionUseCase(trustedContext);
        const githubController = sessionGitHubController(trustedContext);
        if (linearUseCase === undefined || githubController === undefined) {
          throw new TypeError("Missing trusted UI session.");
        }
        const [scan, preview, githubPreview] = await Promise.all([
          useCase.scan(),
          linearUseCase.preview(),
          githubController.preview(),
        ]);
        return renderRegistrationWizard(scan, preview, githubPreview);
      },
    }),
    routes,
  });
}
