import { readFileSync } from "node:fs";

import { createSettingsSecretSafeJsonResponse } from "../../security/index.js";
import {
  createUiShellHandler,
  fixtureUiShellReadModel,
  type UiShellReadModel,
} from "../../shell/index.js";
import type { UiRequest, UiRequestHandler, UiResponse } from "../../server/index.js";
import type { SettingsReadModel, SettingsUseCase } from "./use-case.js";
import { renderSettingsPage } from "./view.js";

const settingsScript = readFileSync(new URL("../../assets/settings.js", import.meta.url), "utf8");

function fixedJson(statusCode: number, code: string): UiResponse {
  return createSettingsSecretSafeJsonResponse(statusCode, Object.freeze({ state: "error", code }));
}

function readyJson(model: SettingsReadModel): UiResponse {
  if (model.state !== "ready") return fixedJson(500, "settings_unavailable");
  return createSettingsSecretSafeJsonResponse(
    200,
    Object.freeze({
      state: "ready",
      source: model.source,
      revision: model.revision,
      webhookRuntimeBaseUrl: model.webhookRuntimeBaseUrl,
      concurrency: Object.freeze({
        globalModelJobs: model.concurrency.globalModelJobs,
        perProviderModelJobs: Object.freeze({
          codex: model.concurrency.perProviderModelJobs.codex,
          claude: model.concurrency.perProviderModelJobs.claude,
          gemini: model.concurrency.perProviderModelJobs.gemini,
        }),
        perProjectModelJobs: model.concurrency.perProjectModelJobs,
        perRepositoryIntegrationJobs: model.concurrency.perRepositoryIntegrationJobs,
      }),
      rawYaml: model.rawYaml,
    }),
  );
}

function htmlResponse(method: string, body: string): UiResponse {
  const headers = Object.freeze({ "content-type": "text/html; charset=utf-8" });
  return method === "HEAD"
    ? Object.freeze({ statusCode: 200, headers })
    : { statusCode: 200, headers, body };
}

function scriptResponse(method: string): UiResponse {
  const headers = Object.freeze({ "content-type": "text/javascript; charset=utf-8" });
  return method === "HEAD"
    ? Object.freeze({ statusCode: 200, headers })
    : Object.freeze({ statusCode: 200, headers, body: settingsScript });
}

export function createSettingsUiHandler(
  useCase: SettingsUseCase,
  shellReadModel: UiShellReadModel = fixtureUiShellReadModel,
): UiRequestHandler {
  const shell = createUiShellHandler(shellReadModel);
  return async (request: UiRequest): Promise<UiResponse> => {
    if (request.url === "/api/settings") {
      if (request.method === "GET") return readyJson(await useCase.read());
      if (request.method !== "PUT") return fixedJson(405, "method_not_allowed");
      const saved = await useCase.saveRaw(request.body);
      if (saved.state === "saved") return readyJson(saved.model);
      const status =
        saved.reason === "conflict" ? 409 : saved.reason === "invalid_settings" ? 422 : 500;
      return fixedJson(status, saved.reason);
    }
    if (request.url === "/settings" && (request.method === "GET" || request.method === "HEAD")) {
      return htmlResponse(request.method, renderSettingsPage(await useCase.read()));
    }
    if (
      request.url === "/assets/settings.js" &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      return scriptResponse(request.method);
    }
    return shell(request);
  };
}
