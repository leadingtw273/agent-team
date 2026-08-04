import type { ProviderTextRedactor } from "./context.js";

export interface SanitizedProviderOutput {
  readonly text: string;
  readonly byteLength: number;
  readonly truncated: boolean;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && end < bytes.byteLength) {
    const nextByte = bytes[end];
    if (nextByte === undefined || (nextByte & 0xc0) !== 0x80) break;
    end -= 1;
  }
  return bytes.subarray(0, end).toString("utf8");
}

export function sanitizeProviderOutput(
  output: string,
  redactor: ProviderTextRedactor,
  maxBytes: number,
): SanitizedProviderOutput {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 64 * 1024 * 1024) {
    throw new RangeError("maxBytes must be between 1 byte and 64 MiB");
  }
  const redacted = redactor.redactText(output);
  const text = truncateUtf8(redacted, maxBytes);
  return Object.freeze({
    text,
    byteLength: Buffer.byteLength(text, "utf8"),
    truncated: text !== redacted,
  });
}
