import {
  linearProvisionDesiredObjects,
  type LinearProvisionAction,
  type LinearProvisionPreview,
  type LinearProvisionUseCase,
} from "../../../application/registration/index.js";
import type { DomainError } from "../../../domain/foundation/index.js";
import type { UiRequest, UiResponse } from "../../server/index.js";

export const linearProvisionApiPath = "/api/registration/linear-provision" as const;

const digestPattern = /^[a-f0-9]{64}$/u;
const fixedNames = new Map(linearProvisionDesiredObjects.map((item) => [item.key, item.name]));

interface SafeLinearProvisionAction {
  readonly key: string;
  readonly name: string;
  readonly kind: LinearProvisionAction["kind"];
  readonly state: LinearProvisionAction["state"];
  readonly instruction?: string;
}

export interface SafeLinearProvisionPreview {
  readonly state: "preview";
  readonly readiness: LinearProvisionPreview["state"];
  readonly expectedRevision: string;
  readonly confirmationToken: string;
  readonly summary: LinearProvisionPreview["summary"];
  readonly actions: readonly SafeLinearProvisionAction[];
}

function safeProjection(preview: LinearProvisionPreview): SafeLinearProvisionPreview {
  const actions = preview.actions.map((action) => {
    const name = fixedNames.get(action.key);
    if (name === undefined || name !== action.name) {
      throw new TypeError("Unsafe Linear provision preview.");
    }
    return Object.freeze({
      key: action.key,
      name,
      kind: action.kind,
      state: action.state,
      ...(action.instruction === undefined ? {} : { instruction: action.instruction }),
    });
  });
  return Object.freeze({
    state: "preview",
    readiness: preview.state,
    expectedRevision: preview.expectedRevision,
    confirmationToken: preview.confirmationToken,
    summary: preview.summary,
    actions: Object.freeze(actions),
  });
}

function jsonResponse(request: UiRequest, statusCode: number, value: unknown): UiResponse {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body, "utf8") > 32_768) {
    throw new TypeError("Linear provision response is too large.");
  }
  const headers: Record<string, string> = {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  };
  if (statusCode === 405) headers["allow"] = "GET, HEAD, PUT";
  return request.method === "HEAD"
    ? Object.freeze({ statusCode, headers: Object.freeze(headers) })
    : Object.freeze({ statusCode, headers: Object.freeze(headers), body });
}

function errorStatus(error: DomainError): number {
  switch (error.code) {
    case "permission_denied":
      return 403;
    case "rate_limited":
      return 429;
    case "conflict":
      return 409;
    case "interrupted":
      return 409;
    case "not_found":
      return 404;
    default:
      return 502;
  }
}

function errorResponse(request: UiRequest, error: DomainError): UiResponse {
  const safeCodes = new Set([
    "permission_denied",
    "rate_limited",
    "conflict",
    "interrupted",
    "not_found",
  ]);
  return jsonResponse(request, errorStatus(error), {
    state: "error",
    code: safeCodes.has(error.code) ? error.code : "linear_unavailable",
  });
}

function provisionCommand(body: UiRequest["body"]) {
  if (body === undefined || Object.keys(body).length !== 4) return undefined;
  const operation = body["operation"];
  const expectedRevision = body["expectedRevision"];
  const confirmationToken = body["confirmationToken"];
  const confirmationText = body["confirmationText"];
  if (
    operation !== "provision" ||
    typeof expectedRevision !== "string" ||
    !digestPattern.test(expectedRevision) ||
    typeof confirmationToken !== "string" ||
    !digestPattern.test(confirmationToken) ||
    confirmationText !== "套用 Linear 設定"
  ) {
    return undefined;
  }
  return Object.freeze({ expectedRevision, confirmationToken, confirmationText });
}

export async function handleLinearProvisionApiRequest(
  useCase: LinearProvisionUseCase,
  request: UiRequest,
): Promise<UiResponse> {
  if (request.method === "GET" || request.method === "HEAD") {
    const preview = await useCase.preview();
    return preview.ok
      ? jsonResponse(request, 200, safeProjection(preview.value))
      : errorResponse(request, preview.error);
  }
  if (request.method !== "PUT") {
    return jsonResponse(request, 405, { state: "error", code: "method_not_allowed" });
  }
  const command = provisionCommand(request.body);
  if (command === undefined) {
    return jsonResponse(request, 422, { state: "error", code: "invalid_operation" });
  }
  const outcome = await useCase.provision(command);
  return outcome.ok
    ? jsonResponse(request, 200, {
        state: "applied",
        result: outcome.value.state,
        createdCount: outcome.value.createdKeys.length,
        preview: safeProjection(outcome.value.preview),
      })
    : errorResponse(request, outcome.error);
}
