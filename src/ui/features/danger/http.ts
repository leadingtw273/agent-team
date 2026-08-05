import type { UiRequest, UiResponse } from "../../server/index.js";
import type {
  DangerApprovalCategory,
  DangerApprovalDecision,
  DangerApprovalUseCase,
} from "./index.js";

export const dangerApiPath = "/api/danger" as const;

const decisions = new Set<DangerApprovalDecision>([
  "approve_once",
  "reject",
  "allow_project_category",
]);

function jsonResponse(request: UiRequest, statusCode: number, value: unknown): UiResponse {
  const headers: Record<string, string> = {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  };
  if (statusCode === 405) headers["allow"] = "GET, HEAD, PUT";
  return request.method === "HEAD"
    ? Object.freeze({ statusCode, headers: Object.freeze(headers) })
    : Object.freeze({
        statusCode,
        headers: Object.freeze(headers),
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
  ) {
    return undefined;
  }
  return {
    requestId,
    projectId,
    category: category as DangerApprovalCategory,
    expectedRevision,
    decision: decision as DangerApprovalDecision,
  };
}

export function handleDangerApiRequest(
  useCase: DangerApprovalUseCase,
  request: UiRequest,
): UiResponse {
  if (request.method === "GET" || request.method === "HEAD") {
    return jsonResponse(request, 200, useCase.read());
  }
  if (request.method !== "PUT") {
    return jsonResponse(request, 405, { state: "error", code: "method_not_allowed" });
  }
  const parsed = command(request.body);
  if (parsed === undefined) {
    return jsonResponse(request, 422, { state: "error", code: "invalid_decision" });
  }
  const result = useCase.decide(parsed);
  return result.state === "saved"
    ? jsonResponse(request, 200, { state: "saved" })
    : jsonResponse(request, result.state === "conflict" ? 409 : 422, {
        state: "error",
        code: result.state,
      });
}
