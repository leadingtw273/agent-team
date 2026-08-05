import { readFileSync } from "node:fs";

import type { UiRequest, UiRequestHandler, UiResponse } from "../../server/index.js";
import { createUiShellHandler } from "../../shell/index.js";
import type {
  DangerApprovalCategory,
  DangerApprovalDecision,
  DangerApprovalUseCase,
} from "./index.js";
import { renderDangerPage } from "./view.js";

const script = readFileSync(new URL("../../assets/danger.js", import.meta.url), "utf8");
const decisions = new Set<DangerApprovalDecision>([
  "approve_once",
  "reject",
  "allow_project_category",
]);

export const dangerUiRouteContract = Object.freeze({
  path: "/api/danger",
  allowedQueryParameters: Object.freeze([]),
  allowedMethods: Object.freeze(["GET", "PUT"] as const),
  response: "standard" as const,
  mutationBody: "bounded-json" as const,
});

function json(statusCode: number, value: unknown): UiResponse {
  return Object.freeze({
    statusCode,
    headers: Object.freeze({ "content-type": "application/json; charset=utf-8" }),
    body: JSON.stringify(value),
  });
}

function command(
  value: UiRequest["body"],
): Parameters<DangerApprovalUseCase["decide"]>[0] | undefined {
  if (value === undefined || Object.keys(value).length !== 5) return undefined;
  const requestId = value["requestId"];
  const projectId = value["projectId"];
  const category = value["category"];
  const expectedRevision = value["expectedRevision"];
  const decision = value["decision"];
  if (
    typeof requestId !== "string" ||
    typeof projectId !== "string" ||
    typeof category !== "string" ||
    typeof expectedRevision !== "string" ||
    typeof decision !== "string" ||
    !decisions.has(decision as DangerApprovalDecision)
  )
    return undefined;
  return {
    requestId,
    projectId,
    category: category as DangerApprovalCategory,
    expectedRevision,
    decision: decision as DangerApprovalDecision,
  };
}

export function createDangerUiHandler(useCase: DangerApprovalUseCase): UiRequestHandler {
  const shell = createUiShellHandler();
  return async (request: UiRequest): Promise<UiResponse> => {
    if (request.url === "/api/danger") {
      if (request.method === "GET") return json(200, useCase.read());
      if (request.method !== "PUT")
        return json(405, { state: "error", code: "method_not_allowed" });
      const parsed = command(request.body);
      if (parsed === undefined) return json(422, { state: "error", code: "invalid_decision" });
      const result = useCase.decide(parsed);
      return result.state === "saved"
        ? json(200, { state: "saved" })
        : json(result.state === "conflict" ? 409 : 422, { state: "error", code: result.state });
    }
    if (request.url === "/security" && (request.method === "GET" || request.method === "HEAD")) {
      const body = renderDangerPage(useCase.read());
      return request.method === "HEAD"
        ? { statusCode: 200, headers: { "content-type": "text/html; charset=utf-8" } }
        : { statusCode: 200, headers: { "content-type": "text/html; charset=utf-8" }, body };
    }
    if (
      request.url === "/assets/danger.js" &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      return request.method === "HEAD"
        ? { statusCode: 200, headers: { "content-type": "text/javascript; charset=utf-8" } }
        : {
            statusCode: 200,
            headers: { "content-type": "text/javascript; charset=utf-8" },
            body: script,
          };
    }
    return shell(request);
  };
}
