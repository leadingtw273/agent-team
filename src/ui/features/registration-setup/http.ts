import {
  registrationSetupFinalApprovalPhrase,
  registrationSetupPreviewConfirmationPhrase,
  type RegistrationSetupControllerContext,
  type RegistrationSetupControllerUseCase,
} from "../../../application/registration/index.js";
import type { UiRequest, UiResponse, UiTrustedRequestContext } from "../../server/index.js";

const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:@+-]{0,220}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;

function response(request: UiRequest, statusCode: number, body: unknown): UiResponse {
  const headers = Object.freeze({
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  return request.method === "HEAD"
    ? Object.freeze({ statusCode, headers })
    : Object.freeze({ statusCode, headers, body: JSON.stringify(body) });
}

function exactKeys(body: UiRequest["body"], keys: readonly string[]): boolean {
  return body !== undefined && Object.keys(body).sort().join("\0") === [...keys].sort().join("\0");
}

function context(
  trustedContext: UiTrustedRequestContext,
): RegistrationSetupControllerContext | undefined {
  const authorityDigest = trustedContext.session?.authorityDigest;
  return authorityDigest === undefined ? undefined : Object.freeze({ authorityDigest });
}

export async function handleRegistrationSetupRequest(
  controller: RegistrationSetupControllerUseCase,
  request: UiRequest,
  trustedContext: UiTrustedRequestContext,
): Promise<UiResponse> {
  const trusted = context(trustedContext);
  if (request.auth.kind !== "session" || trusted === undefined) {
    return response(request, 403, { state: "error", code: "localhost_session_required" });
  }
  if (request.method === "GET" || request.method === "HEAD") {
    return response(request, 200, await controller.read(trusted));
  }
  if (request.method !== "PUT") {
    return response(request, 405, { state: "error", code: "method_not_allowed" });
  }
  const body = request.body;
  const action = body?.["action"];
  const setupSessionId = body?.["setupSessionId"];
  const operationId = body?.["operationId"];
  if (
    typeof action !== "string" ||
    typeof setupSessionId !== "string" ||
    typeof operationId !== "string" ||
    !identifierPattern.test(setupSessionId) ||
    !identifierPattern.test(operationId)
  ) {
    return response(request, 422, { state: "error", code: "invalid_setup_action" });
  }
  let result;
  if (
    action === "confirm_preview" &&
    exactKeys(body, ["action", "setupSessionId", "previewDigest", "confirmation", "operationId"]) &&
    typeof body?.["previewDigest"] === "string" &&
    digestPattern.test(body["previewDigest"]) &&
    body["confirmation"] === registrationSetupPreviewConfirmationPhrase
  ) {
    result = await controller.confirmPreview(
      {
        setupSessionId,
        previewDigest: body["previewDigest"],
        confirmation: registrationSetupPreviewConfirmationPhrase,
        idempotencyKey: `ui:${operationId}:confirm-preview`,
      },
      trusted,
    );
  } else if (
    action === "start" &&
    exactKeys(body, ["action", "setupSessionId", "previewDigest", "tokenId", "operationId"]) &&
    typeof body?.["previewDigest"] === "string" &&
    digestPattern.test(body["previewDigest"]) &&
    typeof body["tokenId"] === "string" &&
    identifierPattern.test(body["tokenId"])
  ) {
    result = await controller.start(
      {
        setupSessionId,
        previewDigest: body["previewDigest"],
        tokenId: body["tokenId"],
        idempotencyKeyPrefix: `ui:${operationId}:start`,
      },
      trusted,
    );
  } else if (action === "refresh" && exactKeys(body, ["action", "setupSessionId", "operationId"])) {
    result = await controller.refresh(
      { setupSessionId, idempotencyKeyPrefix: `ui:${operationId}:refresh` },
      trusted,
    );
  } else if (
    action === "issue_approval_intent" &&
    exactKeys(body, [
      "action",
      "setupSessionId",
      "expectedSetupRevision",
      "confirmation",
      "operationId",
    ]) &&
    typeof body?.["expectedSetupRevision"] === "number" &&
    Number.isSafeInteger(body["expectedSetupRevision"]) &&
    body["expectedSetupRevision"] > 0 &&
    body["confirmation"] === registrationSetupFinalApprovalPhrase
  ) {
    result = await controller.issueLocalUiApprovalIntent(
      {
        setupSessionId,
        expectedSetupRevision: body["expectedSetupRevision"],
        confirmation: registrationSetupFinalApprovalPhrase,
        idempotencyKey: `ui:${operationId}:approval-intent`,
        idempotencyKeyPrefix: `ui:${operationId}:approval-refresh`,
      },
      trusted,
    );
  } else {
    return response(request, 422, { state: "error", code: "invalid_setup_action" });
  }
  const failure = result.state === "failed" || result.state === "blocked";
  return response(
    request,
    failure ? 409 : result.state === "configuration_incomplete" ? 503 : 202,
    result,
  );
}
