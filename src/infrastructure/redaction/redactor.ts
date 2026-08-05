export const redactedValue = "[REDACTED]";
export const truncatedValue = "[TRUNCATED]";

export interface RedactedJsonObject {
  readonly [key: string]: RedactedJsonValue;
}

export type RedactedJsonValue =
  null | boolean | number | string | readonly RedactedJsonValue[] | RedactedJsonObject;

export interface RedactorOptions {
  readonly secrets?: readonly string[];
  readonly sensitiveKeys?: readonly string[];
  readonly maxDepth?: number;
  readonly maxCollectionEntries?: number;
}

const defaultSensitiveKeys = [
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "apikey",
  "xapikey",
  "token",
  "accesstoken",
  "refreshtoken",
  "password",
  "passwd",
  "secret",
  "clientsecret",
  "privatekey",
  "signature",
  "webhooksecret",
] as const;

const sensitiveKeySuffixes = [
  "authorization",
  "cookie",
  "apikey",
  "token",
  "password",
  "passwd",
  "secret",
  "privatekey",
  "signature",
] as const;

const tokenPatternSources = [
  String.raw`\bsk-ant-[a-zA-Z0-9_-]{12,}\b`,
  String.raw`\bsk-[a-zA-Z0-9_-]{12,}\b`,
  String.raw`\blin_api_[a-zA-Z0-9_-]{12,}\b`,
  String.raw`\bgh[pousr]_[a-zA-Z0-9_]{20,}\b`,
  String.raw`\bgithub_pat_[a-zA-Z0-9_]{20,}\b`,
  String.raw`\bAIza[a-zA-Z0-9_-]{30,}\b`,
  String.raw`\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b`,
] as const;
const tokenPatterns = tokenPatternSources.map((source) => new RegExp(source, "gu"));

/** Pure, allocation-bounded recognition for provider credentials and JWT-shaped values. */
export function containsSensitiveValue(input: string): boolean {
  return tokenPatternSources.some((source) => new RegExp(source, "u").test(input));
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function replaceLiteral(input: string, literal: string): string {
  return literal.length === 0 ? input : input.split(literal).join(redactedValue);
}

function decodeQueryKey(key: string): string {
  try {
    return decodeURIComponent(key.replace(/\+/gu, " "));
  } catch {
    return key;
  }
}

function secretVariants(secret: string): readonly string[] {
  const variants = new Set([secret, encodeURIComponent(secret)]);
  if (secret.length >= 4) variants.add(Buffer.from(secret, "utf8").toString("base64"));
  return [...variants].sort((left, right) => right.length - left.length);
}

export class Redactor {
  readonly #secretVariants: readonly string[];
  readonly #sensitiveKeys: ReadonlySet<string>;
  readonly #maxDepth: number;
  readonly #maxCollectionEntries: number;

  constructor(options: RedactorOptions = {}) {
    this.#secretVariants = (options.secrets ?? [])
      .filter((secret) => secret.length > 0)
      .flatMap(secretVariants)
      .sort((left, right) => right.length - left.length);
    this.#sensitiveKeys = new Set(
      [...defaultSensitiveKeys, ...(options.sensitiveKeys ?? [])].map(normalizeKey),
    );
    this.#maxDepth = Math.max(1, Math.trunc(options.maxDepth ?? 32));
    this.#maxCollectionEntries = Math.max(1, Math.trunc(options.maxCollectionEntries ?? 10_000));
  }

  isSensitiveKey(key: string): boolean {
    const normalized = normalizeKey(key);
    return (
      this.#sensitiveKeys.has(normalized) ||
      sensitiveKeySuffixes.some((suffix) => normalized.endsWith(suffix))
    );
  }

  redactText(input: string): string {
    let output = input;
    for (const variant of this.#secretVariants) output = replaceLiteral(output, variant);

    output = output.replace(
      /(authorization\s*[:=]\s*(?:(?:bearer|basic)\s+)?)[^\s,;]+/giu,
      `$1${redactedValue}`,
    );
    output = output.replace(/((?:set-cookie|cookie)\s*[:=]\s*)[^\r\n]*/giu, `$1${redactedValue}`);
    output = output.replace(
      /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/giu,
      `$1${redactedValue}@`,
    );
    output = output.replace(
      /([?&])([^=&#\s]+)=([^&#\s]*)/gu,
      (match, separator: string, key: string) =>
        this.isSensitiveKey(decodeQueryKey(key)) ? `${separator}${key}=${redactedValue}` : match,
    );
    output = output.replace(
      /(^|[\s,{;])(["']?)([a-z][a-z0-9_-]*)(\2\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\r\n]+)/gimu,
      (match, boundary: string, quote: string, key: string, separator: string) =>
        this.isSensitiveKey(key) ? `${boundary}${quote}${key}${separator}${redactedValue}` : match,
    );
    if (containsSensitiveValue(output)) {
      for (const pattern of tokenPatterns) output = output.replace(pattern, redactedValue);
    }
    return output;
  }

  redactUnknown(input: unknown): RedactedJsonValue {
    return this.#redactUnknown(input, 0, new WeakSet<object>());
  }

  #redactUnknown(input: unknown, depth: number, ancestors: WeakSet<object>): RedactedJsonValue {
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string") return this.redactText(input);
    if (typeof input === "number") return Number.isFinite(input) ? input : redactedValue;
    if (typeof input !== "object" || depth >= this.#maxDepth) return redactedValue;
    if (ancestors.has(input)) return redactedValue;

    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        const values = input
          .slice(0, this.#maxCollectionEntries)
          .map((value) => this.#redactUnknown(value, depth + 1, ancestors));
        if (input.length > this.#maxCollectionEntries) values.push(truncatedValue);
        return Object.freeze(values);
      }

      const prototype = Object.getPrototypeOf(input) as unknown;
      if (prototype !== Object.prototype && prototype !== null) return redactedValue;
      const descriptors = Object.getOwnPropertyDescriptors(input);
      const output: Record<string, RedactedJsonValue> = Object.create(null) as Record<
        string,
        RedactedJsonValue
      >;
      const entries = Object.entries(descriptors).slice(0, this.#maxCollectionEntries);
      for (const [key, descriptor] of entries) {
        output[key] =
          this.isSensitiveKey(key) || !("value" in descriptor)
            ? redactedValue
            : this.#redactUnknown(descriptor.value, depth + 1, ancestors);
      }
      if (Object.keys(descriptors).length > this.#maxCollectionEntries) {
        output[truncatedValue] = truncatedValue;
      }
      return Object.freeze(output);
    } catch {
      return redactedValue;
    } finally {
      ancestors.delete(input);
    }
  }
}
