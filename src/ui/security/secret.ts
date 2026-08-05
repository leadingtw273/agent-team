import type { UiResponse } from "../server/index.js";
import { containsSensitiveValue } from "../../infrastructure/redaction/index.js";

const trustedSecretSafeResponses = new WeakSet<object>();

export type SecretSafeJsonResponse = UiResponse;

export interface SecretSafeMetadata {
  readonly configured: boolean;
  readonly fingerprint?: string;
  readonly lastTestedAt?: string;
}

const fingerprintPattern = /^sha256:[a-f0-9]{8,64}$/u;

function safeFingerprint(value: unknown): string | undefined {
  return typeof value === "string" && fingerprintPattern.test(value) ? value : undefined;
}

function safeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 32) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? value
    : undefined;
}

export function projectSecretSafeMetadata(source: unknown): SecretSafeMetadata {
  const record: Readonly<Record<string, unknown>> =
    typeof source === "object" && source !== null
      ? (source as Readonly<Record<string, unknown>>)
      : Object.freeze<Record<string, unknown>>({});
  const configured = record["configured"] === true;
  const fingerprint = safeFingerprint(record["fingerprint"]);
  const lastTestedAt = safeTimestamp(record["lastTestedAt"]);
  return Object.freeze({
    configured,
    ...(fingerprint === undefined ? {} : { fingerprint }),
    ...(lastTestedAt === undefined ? {} : { lastTestedAt }),
  });
}

export function createSecretSafeJsonResponse(source: unknown): SecretSafeJsonResponse {
  const response = Object.freeze({
    statusCode: 200,
    headers: Object.freeze({ "content-type": "application/json; charset=utf-8" }),
    body: JSON.stringify(projectSecretSafeMetadata(source)),
  });
  trustedSecretSafeResponses.add(response);
  return response;
}

const settingsErrorStatus = Object.freeze({
  conflict: 409,
  invalid_settings: 422,
  method_not_allowed: 405,
  settings_unavailable: 500,
  store_failure: 500,
  write_unconfirmed: 500,
});

function exactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function validSettingsProjection(statusCode: number, value: unknown): boolean {
  if (exactKeys(value, ["state", "code"]) && value["state"] === "error") {
    const code = value["code"];
    return (
      typeof code === "string" &&
      Object.hasOwn(settingsErrorStatus, code) &&
      settingsErrorStatus[code as keyof typeof settingsErrorStatus] === statusCode
    );
  }
  if (
    statusCode !== 200 ||
    !exactKeys(value, [
      "state",
      "source",
      "revision",
      "webhookRuntimeBaseUrl",
      "concurrency",
      "rawYaml",
    ]) ||
    value["state"] !== "ready" ||
    (value["source"] !== "defaults" && value["source"] !== "persisted") ||
    (value["revision"] !== null &&
      (typeof value["revision"] !== "string" || !/^[a-f0-9]{64}$/u.test(value["revision"]))) ||
    (value["webhookRuntimeBaseUrl"] !== null &&
      typeof value["webhookRuntimeBaseUrl"] !== "string") ||
    typeof value["rawYaml"] !== "string" ||
    !exactKeys(value["concurrency"], [
      "globalModelJobs",
      "perProviderModelJobs",
      "perProjectModelJobs",
      "perRepositoryIntegrationJobs",
    ])
  ) {
    return false;
  }
  const concurrency = value["concurrency"];
  if (!exactKeys(concurrency["perProviderModelJobs"], ["codex", "claude", "gemini"])) {
    return false;
  }
  return [
    concurrency["globalModelJobs"],
    concurrency["perProjectModelJobs"],
    concurrency["perRepositoryIntegrationJobs"],
    concurrency["perProviderModelJobs"]["codex"],
    concurrency["perProviderModelJobs"]["claude"],
    concurrency["perProviderModelJobs"]["gemini"],
  ].every((limit) => Number.isSafeInteger(limit) && Number(limit) >= 0);
}

export function createSettingsSecretSafeJsonResponse(
  statusCode: number,
  projected: unknown,
): SecretSafeJsonResponse {
  if (!validSettingsProjection(statusCode, projected)) {
    throw new TypeError("Invalid settings response projection.");
  }
  const body = JSON.stringify(projected);
  if (Buffer.byteLength(body, "utf8") > 32_768 || containsSensitiveValue(body)) {
    throw new TypeError("Unsafe secret-safe JSON response.");
  }
  const response = Object.freeze({
    statusCode,
    headers: Object.freeze({ "content-type": "application/json; charset=utf-8" }),
    body,
  });
  trustedSecretSafeResponses.add(response);
  return response;
}

export function isSecretSafeJsonResponse(response: UiResponse): boolean {
  return trustedSecretSafeResponses.has(response);
}
