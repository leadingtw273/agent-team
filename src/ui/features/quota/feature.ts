import type { UiSecurityRouteContract } from "../../security/index.js";
import type { UiRequest, UiResponse } from "../../server/index.js";
import { quotaClientScript } from "./client.js";
import { isQuotaProviderId } from "./contracts.js";
import type { QuotaDashboardUseCase } from "./use-case.js";
import { renderQuotaDashboard } from "./view.js";

const refreshPath = "/api/quota/refresh";
const resumePath = "/api/quota/resume";
const clientPath = "/assets/quota.js";
const readMethods = Object.freeze(["GET"] as const);
const mutationMethods = Object.freeze(["POST"] as const);

export const quotaUiSecurityRoutes: readonly UiSecurityRouteContract[] = Object.freeze([
  ...[
    "/",
    "/projects",
    "/events",
    "/assets/icons.svg",
    "/assets/tabler-1.4.0.min.css",
    "/assets/ui-shell.css",
  ].map((path) =>
    Object.freeze({
      path,
      allowedQueryParameters: Object.freeze([]),
      allowedMethods: readMethods,
      response: "standard" as const,
    }),
  ),
  Object.freeze({
    path: "/quota",
    allowedQueryParameters: Object.freeze([]),
    allowedMethods: readMethods,
    response: "standard",
  }),
  Object.freeze({
    path: clientPath,
    allowedQueryParameters: Object.freeze([]),
    allowedMethods: readMethods,
    response: "standard",
  }),
  Object.freeze({
    path: refreshPath,
    allowedQueryParameters: Object.freeze([]),
    allowedMethods: mutationMethods,
    response: "standard",
    mutationBody: "bounded-json",
  }),
  Object.freeze({
    path: resumePath,
    allowedQueryParameters: Object.freeze([]),
    allowedMethods: mutationMethods,
    response: "standard",
    mutationBody: "bounded-json",
  }),
]);

export interface QuotaUiFeature {
  readonly render: () => Promise<string>;
  readonly handle: (request: UiRequest) => Promise<UiResponse | undefined>;
}

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

function providerFromRequest(request: UiRequest): string | undefined {
  if (request.body === undefined) return undefined;
  const keys = Object.keys(request.body);
  if (keys.length !== 1 || keys[0] !== "provider") return undefined;
  const provider = request.body["provider"];
  return typeof provider === "string" && isQuotaProviderId(provider) ? provider : undefined;
}

export function createQuotaUiFeature(useCase: QuotaDashboardUseCase): QuotaUiFeature {
  const render = async (): Promise<string> => renderQuotaDashboard(await useCase.read());
  const handle = async (request: UiRequest): Promise<UiResponse | undefined> => {
    if (request.url === clientPath) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return fixedResponse(405, "Method Not Allowed\n", "GET, HEAD");
      }
      const headers = Object.freeze({
        "cache-control": "no-store",
        "content-type": "text/javascript; charset=utf-8",
      });
      return request.method === "HEAD"
        ? Object.freeze({ statusCode: 200, headers })
        : Object.freeze({ statusCode: 200, headers, body: quotaClientScript });
    }
    if (request.url !== refreshPath && request.url !== resumePath) return undefined;
    if (request.method !== "POST") return fixedResponse(405, "Method Not Allowed\n", "POST");
    if (request.auth.kind !== "session") return fixedResponse(401, "Unauthorized\n");
    const provider = providerFromRequest(request);
    if (provider === undefined) return fixedResponse(400, "Bad Request\n");
    const result =
      request.url === refreshPath
        ? await useCase.refresh(provider)
        : await useCase.resume(provider);
    const body = JSON.stringify(result);
    return Object.freeze({
      statusCode: result.state === "accepted" ? 200 : 409,
      headers: Object.freeze({
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      }),
      body,
    });
  };
  return Object.freeze({ render, handle });
}
