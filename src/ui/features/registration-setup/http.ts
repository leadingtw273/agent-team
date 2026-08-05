import type { UiRequest, UiResponse } from "../../server/index.js";
import type {
  RegistrationSetupApprovalUiCommand,
  RegistrationSetupApprovalUiUseCase,
} from "./model.js";

const confirmationPhrase = "APPROVE SETUP MERGE";
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:@+-]{0,220}$/u;

function response(request: UiRequest, statusCode: number, body: unknown): UiResponse {
  const headers = Object.freeze({
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  return request.method === "HEAD"
    ? Object.freeze({ statusCode, headers })
    : Object.freeze({ statusCode, headers, body: JSON.stringify(body) });
}

function approvalCommand(body: UiRequest["body"]): RegistrationSetupApprovalUiCommand | undefined {
  if (body === undefined || Object.keys(body).length !== 3) return undefined;
  const approvalId = body["approvalId"];
  const expectedSetupRevision = body["expectedSetupRevision"];
  if (
    body["confirmation"] !== confirmationPhrase ||
    typeof approvalId !== "string" ||
    typeof expectedSetupRevision !== "number" ||
    !Number.isSafeInteger(expectedSetupRevision) ||
    expectedSetupRevision <= 0
  ) {
    return undefined;
  }
  return identifierPattern.test(approvalId)
    ? Object.freeze({ approvalId, expectedSetupRevision, userConfirmed: true as const })
    : undefined;
}

export async function handleRegistrationSetupApprovalRequest(
  useCase: RegistrationSetupApprovalUiUseCase,
  request: UiRequest,
): Promise<UiResponse> {
  if (request.method === "GET" || request.method === "HEAD") {
    return response(request, 200, await useCase.read());
  }
  if (request.method !== "PUT") {
    return response(request, 405, { state: "error", code: "method_not_allowed" });
  }
  if (request.auth.kind !== "session") {
    return response(request, 403, { state: "error", code: "localhost_session_required" });
  }
  const parsed = approvalCommand(request.body);
  if (parsed === undefined) {
    return response(request, 422, { state: "error", code: "invalid_explicit_approval" });
  }
  const result = await useCase.approve(parsed);
  return result.state === "accepted"
    ? response(request, 202, { state: "accepted" })
    : response(request, result.state === "conflict" ? 409 : 422, {
        state: "error",
        code: result.state,
      });
}
