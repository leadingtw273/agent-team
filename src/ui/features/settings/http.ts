import { createSettingsSecretSafeJsonResponse } from "../../security/index.js";
import type { UiRequest, UiResponse } from "../../server/index.js";
import type { SettingsReadModel, SettingsUseCase } from "./use-case.js";

export const settingsApiPath = "/api/settings" as const;

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

/** Handles the settings feature's secret-safe API route after registry policy authorization. */
export async function handleSettingsApiRequest(
  useCase: SettingsUseCase,
  request: UiRequest,
): Promise<UiResponse> {
  if (request.method === "GET" || request.method === "HEAD") {
    return readyJson(await useCase.read());
  }
  if (request.method !== "PUT") return fixedJson(405, "method_not_allowed");
  const saved = await useCase.saveRaw(request.body);
  if (saved.state === "saved") return readyJson(saved.model);
  const status =
    saved.reason === "conflict" ? 409 : saved.reason === "invalid_settings" ? 422 : 500;
  return fixedJson(status, saved.reason);
}
