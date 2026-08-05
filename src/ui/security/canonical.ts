import type { UiResponse } from "../server/index.js";

const maximumCanonicalBytes = 1024 * 1024;
const maximumCredentialCount = 8;
const maximumCredentialBytes = 1024;
const maximumPercentDecodeDepth = 2;
const percentEscapePattern = /%[0-9A-Fa-f]{2}/uy;

function boundedText(value: string | Uint8Array): string | undefined {
  if (typeof value === "string") {
    return Buffer.byteLength(value, "utf8") <= maximumCanonicalBytes ? value : undefined;
  }
  if (value.byteLength > maximumCanonicalBytes) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return undefined;
  }
}

function validCredentials(credentials: readonly string[]): boolean {
  return (
    credentials.length <= maximumCredentialCount &&
    credentials.every(
      (credential) =>
        credential.length > 0 && Buffer.byteLength(credential, "utf8") <= maximumCredentialBytes,
    )
  );
}

function hasOnlyCompletePercentEscapes(value: string): boolean {
  for (let index = value.indexOf("%"); index !== -1; index = value.indexOf("%", index + 3)) {
    percentEscapePattern.lastIndex = index;
    if (percentEscapePattern.exec(value) === null) return false;
  }
  return true;
}

/**
 * Scans a bounded canonical representation without exposing the matching value.
 * Malformed, oversized, or still-decodable input after two percent-decoding
 * passes is unsafe by construction.
 */
export function canonicalValueIsUnsafe(
  value: string | Uint8Array,
  credentials: readonly string[],
): boolean {
  if (!validCredentials(credentials)) return true;
  let representation = boundedText(value);
  if (representation === undefined) return true;

  for (let depth = 0; depth <= maximumPercentDecodeDepth; depth += 1) {
    for (const credential of credentials) {
      if (representation.includes(credential)) return true;
    }
    if (!representation.includes("%")) return false;
    if (!hasOnlyCompletePercentEscapes(representation)) return true;
    if (depth === maximumPercentDecodeDepth) return true;
    try {
      const decoded = decodeURIComponent(representation);
      representation = boundedText(decoded);
      if (representation === undefined) return true;
    } catch {
      return true;
    }
  }
  return true;
}

export function canonicalResponseIsUnsafe(
  response: UiResponse,
  credentials: readonly string[],
): boolean {
  if (canonicalValueIsUnsafe(String(response.statusCode), credentials)) return true;
  if (response.headers !== undefined) {
    for (const [name, headerValue] of Object.entries(response.headers)) {
      if (canonicalValueIsUnsafe(name, credentials)) return true;
      const values = typeof headerValue === "string" ? [headerValue] : headerValue;
      for (const value of values) {
        if (canonicalValueIsUnsafe(value, credentials)) return true;
      }
    }
  }
  return response.body === undefined ? false : canonicalValueIsUnsafe(response.body, credentials);
}
