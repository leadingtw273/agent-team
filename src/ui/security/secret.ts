import type { UiResponse } from "../server/index.js";

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

export function isSecretSafeJsonResponse(response: UiResponse): boolean {
  return trustedSecretSafeResponses.has(response);
}
