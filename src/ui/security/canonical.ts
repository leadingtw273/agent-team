import type { UiResponse } from "../server/index.js";

const maximumCanonicalBytes = 1024 * 1024;
const maximumCredentialCount = 8;
const maximumCredentialBytes = 1024;
const maximumPercentDecodeDepth = 2;
const percentEscapePattern = /%[0-9A-Fa-f]{2}/uy;
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

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
 * Strictly canonicalizes caller-controlled input. Malformed, oversized, or
 * still-decodable input after two percent-decoding passes is unsafe by
 * construction, even when it does not contain a known credential.
 */
export function untrustedInputIsUnsafe(
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

function percentByteAt(value: string, index: number): number | undefined {
  if (value[index] !== "%" || index + 2 >= value.length) return undefined;
  const byte = Number.parseInt(value.slice(index + 1, index + 3), 16);
  return Number.isNaN(byte) || !/^[0-9A-Fa-f]{2}$/u.test(value.slice(index + 1, index + 3))
    ? undefined
    : byte;
}

function decodePercentUtf8Unit(
  value: string,
  index: number,
): { readonly text: string; readonly sourceLength: number } | undefined {
  const leadingByte = percentByteAt(value, index);
  if (leadingByte === undefined) return undefined;

  const byteCount =
    leadingByte <= 0x7f
      ? 1
      : leadingByte >= 0xc2 && leadingByte <= 0xdf
        ? 2
        : leadingByte >= 0xe0 && leadingByte <= 0xef
          ? 3
          : leadingByte >= 0xf0 && leadingByte <= 0xf4
            ? 4
            : 0;
  if (byteCount === 0) return undefined;

  const bytes = [leadingByte];
  for (let offset = 1; offset < byteCount; offset += 1) {
    const continuationByte = percentByteAt(value, index + offset * 3);
    if (continuationByte === undefined || continuationByte < 0x80 || continuationByte > 0xbf) {
      return undefined;
    }
    bytes.push(continuationByte);
  }

  try {
    return {
      text: fatalUtf8Decoder.decode(Uint8Array.from(bytes)),
      sourceLength: byteCount * 3,
    };
  } catch {
    return undefined;
  }
}

function decodeValidPercentEscapes(value: string): string {
  const chunks: string[] = [];
  let unchangedStart = 0;
  let index = 0;

  while (index < value.length) {
    if (value[index] !== "%") {
      index += 1;
      continue;
    }

    const decoded = decodePercentUtf8Unit(value, index);
    if (decoded === undefined) {
      index += percentByteAt(value, index) === undefined ? 1 : 3;
      continue;
    }

    chunks.push(value.slice(unchangedStart, index), decoded.text);
    index += decoded.sourceLength;
    unchangedStart = index;
  }

  if (chunks.length === 0) return value;
  chunks.push(value.slice(unchangedStart));
  return chunks.join("");
}

/**
 * Scans trusted output only for known credentials. Valid percent-encoded UTF-8
 * units are decoded independently; an invalid unit remains literal and cannot
 * poison a neighboring credential representation. Work is bounded by the
 * response size, credential cap, and fixed decode depth: O(n * credentials * depth).
 */
function outputValueLeaksCredentials(
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
    const decoded = decodeValidPercentEscapes(representation);
    if (decoded === representation) return false;
    const boundedDecoded = boundedText(decoded);
    if (boundedDecoded === undefined) return true;
    if (depth === maximumPercentDecodeDepth) {
      return credentials.some((credential) => boundedDecoded.includes(credential));
    }
    representation = boundedDecoded;
  }
  return false;
}

export function responseLeaksCredentials(
  response: UiResponse,
  credentials: readonly string[],
): boolean {
  if (outputValueLeaksCredentials(String(response.statusCode), credentials)) return true;
  if (response.headers !== undefined) {
    for (const [name, headerValue] of Object.entries(response.headers)) {
      if (outputValueLeaksCredentials(name, credentials)) return true;
      const values = typeof headerValue === "string" ? [headerValue] : headerValue;
      for (const value of values) {
        if (outputValueLeaksCredentials(value, credentials)) return true;
      }
    }
  }
  return response.body === undefined
    ? false
    : outputValueLeaksCredentials(response.body, credentials);
}
