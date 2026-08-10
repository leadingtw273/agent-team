/**
 * C034: a repository file's "does this file contain a secret?" classification must not be
 * derived from whether the log/provider-output {@link Redactor} changed the text
 * (`redactor.redactText(text) !== text`). That redactor is deliberately *lenient* -- it treats
 * any key literally named `signature`/`token`/`secret`/... as sensitive regardless of whether the
 * surrounding text is a real credential or plain descriptive prose (a code comment, a JSDoc line,
 * an identifier). A log line and a file-scanning preflight gate have opposite error-cost
 * profiles: over-redacting a log line is cheap, but over-blocking a legitimate commit (this file's
 * caller, `GitPreflight`, turns a `suspected_secret` finding into `allowed: false`, which pauses
 * the whole implementer pipeline) is not. The real-world case that forced this split: a harmless
 * ESLint disable comment containing the English phrase `required signature:` was classified as a
 * secret purely because `signature` is one of the Redactor's sensitive key names.
 *
 * `RepositorySecretScanner` is therefore a separate, precision-first classifier with its own
 * layered contract -- a file is flagged if, and only if, it contains:
 *
 *   a known-secret variant (raw / URL-encoded / Base64, the same variant set the caller's
 *     `knownSecrets` would produce)
 *   OR a high-confidence provider-issued token / JWT shape
 *   OR a complete PEM or OpenSSH private-key block
 *   OR a multi-signal contextual credential (a sensitive key/URL context AND a value that is
 *     neither an obvious placeholder nor implausibly formatted)
 *
 * It intentionally does NOT special-case "this looks like a code comment" (unreliable across
 * languages and easy to route around) and does NOT drop `signature`/`token`/`secret`/... from any
 * list (that would weaken the Redactor's own, unrelated, log-masking duty). It also intentionally
 * does NOT call into `Redactor.redactText`/`containsSensitiveValue` for its final answer. The
 * Redactor keeps its existing, deliberately-lenient behavior for its own callers (log/provider
 * -output masking, where over-redaction is the safe failure mode, not under-redaction); the only
 * thing this change asks of it is to `export` the high-confidence token pattern list below, which
 * both files now share so neither can silently drift away from the other.
 */

import { tokenPatternSources } from "./redactor.js";

const knownSecretMinimumLengthForBase64Variant = 4;

/** Same derivation as redactor.ts's private `secretVariants`, restated here because that helper is
 * private to the Redactor. Unlike the token patterns below, this one is not shared: if it ever does
 * drift, the tests pinning every variant form (raw / URL-encoded / Base64) fail loudly rather than
 * letting a registered secret through unnoticed. */
function knownSecretVariants(secret: string): readonly string[] {
  const variants = new Set([secret, encodeURIComponent(secret)]);
  if (secret.length >= knownSecretMinimumLengthForBase64Variant) {
    variants.add(Buffer.from(secret, "utf8").toString("base64"));
  }
  return [...variants];
}

/** Bucket 1: exact literal match against every variant a registered `knownSecrets` entry could
 * appear as. This is the anti-regression bucket: it must recognize the exact same variant set the
 * Redactor derives from `knownSecrets`, or the scanner would be a capability regression relative
 * to the check it replaces. */
function containsKnownSecretVariant(text: string, knownSecrets: readonly string[]): boolean {
  return knownSecrets.some((secret) =>
    knownSecretVariants(secret).some((variant) => variant.length > 0 && text.includes(variant)),
  );
}

/** Bucket 2: high-confidence provider-issued token and JWT shapes, imported from redactor.ts rather
 * than copied. These were duplicated at first; sharing them is what stops the two from drifting,
 * and drift here is silent -- a provider prefix added for log redaction but missed here would mean
 * this scanner happily lets that credential be committed. A fresh, non-global `RegExp` is built per
 * call so repeated `.test()` calls never race against a shared `lastIndex`. */
function containsProviderOrJwtToken(text: string): boolean {
  return tokenPatternSources.some((source) => new RegExp(source, "u").test(text));
}

/** Bucket 3: a complete PEM or OpenSSH private-key block. OpenSSH's own header
 * (`-----BEGIN OPENSSH PRIVATE KEY-----`) already contains the substring `PRIVATE KEY`, so this
 * single pattern covers both PEM (`RSA/EC/DSA/... PRIVATE KEY`) and OpenSSH without a second
 * regex. Requires both the BEGIN and END markers, i.e. a genuine embedded key block, not a bare
 * mention of the words "private key". */
const privateKeyBlockPattern =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z0-9 ]*PRIVATE KEY-----/u;

function containsPrivateKeyBlock(text: string): boolean {
  return privateKeyBlockPattern.test(text);
}

/** Bucket 4 support: value-quality checks shared by every contextual-credential sub-check below.
 * Deliberately does NOT use entropy -- entropy alone false-positives heavily on hashes, test
 * fixtures, and compressed/encoded data that happen to look "random" but are not secrets. */
const placeholderValueTokens = [
  "changeme",
  "change-me",
  "change_me",
  "example",
  "sample",
  "dummy",
  "fake",
  "placeholder",
  "redacted",
  "insert",
  "replace",
  "your-",
  "your_",
  "here",
  "todo",
  "fixme",
  "tbd",
  "n/a",
  "none",
  "null",
  "undefined",
] as const;

function stripSurroundingQuotes(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  return (first === '"' && last === '"') || (first === "'" && last === "'")
    ? trimmed.slice(1, -1)
    : trimmed;
}

function isPlaceholderCredentialValue(rawValue: string): boolean {
  const value = stripSurroundingQuotes(rawValue);
  if (value.length === 0) return true;
  if (/^[<{].*[>}]$/u.test(value)) return true;
  if (/^(.)\1*$/u.test(value)) return true;
  const lowered = value.toLowerCase();
  return placeholderValueTokens.some((token) => lowered.includes(token));
}

const plausibleCredentialValuePattern = /^[A-Za-z0-9+/=_.:-]+$/u;
const minimumPlausibleCredentialLength = 8;
const maximumPlausibleCredentialLength = 4096;

function isPlausibleCredentialValue(rawValue: string): boolean {
  const value = stripSurroundingQuotes(rawValue);
  return (
    value.length >= minimumPlausibleCredentialLength &&
    value.length <= maximumPlausibleCredentialLength &&
    plausibleCredentialValuePattern.test(value)
  );
}

function isCredibleCredentialValue(rawValue: string): boolean {
  return isPlausibleCredentialValue(rawValue) && !isPlaceholderCredentialValue(rawValue);
}

/** Bucket 4a: `.env`-style `KEY=value` assignments whose key name is sensitive (uppercase
 * `SNAKE_CASE`, matching the real convention env files and CI secret injection use). Anchored to
 * an uppercase key followed by `=` so ordinary lowercase prose (`required signature: ...`,
 * `function signature:`) never matches -- those use a colon, not an equals sign, and are not
 * uppercase identifiers. */
const sensitiveEnvKeyPattern =
  /(PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|WEBHOOK)/u;
const envAssignmentPattern = /^[ \t]*([A-Z][A-Z0-9_]{2,})[ \t]*=[ \t]*(.+?)[ \t]*$/gmu;

function containsSensitiveEnvAssignment(text: string): boolean {
  for (const match of text.matchAll(envAssignmentPattern)) {
    const key = match[1];
    const value = match[2];
    if (
      key !== undefined &&
      value !== undefined &&
      sensitiveEnvKeyPattern.test(key) &&
      isCredibleCredentialValue(value)
    ) {
      return true;
    }
  }
  return false;
}

/** Bucket 4b: a connection-string URL with embedded `user:password@` userinfo
 * (`postgres://`, `mysql://`, `mongodb(+srv)://`, `redis://`, `amqp(s)://`). */
const connectionStringCredentialPattern =
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s:/@]+:([^\s@/]+)@/giu;

function containsConnectionStringCredential(text: string): boolean {
  for (const match of text.matchAll(connectionStringCredentialPattern)) {
    const value = match[1];
    if (value !== undefined && isCredibleCredentialValue(value)) return true;
  }
  return false;
}

/** Bucket 4c: AWS credentials. An AWS access key id (`AKIA`/`ASIA` + 16 uppercase-alnum chars) is
 * a fixed-format, highly distinctive shape and is treated as sufficient context+value on its own
 * (the regex itself already constrains the "value" to the exact AWS format). An
 * `aws_secret_access_key=` assignment is additionally checked against the shared
 * placeholder/plausibility gate, matching the ".env-style credential" contract for every other
 * key=value case in this bucket. */
const awsAccessKeyIdPattern = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u;
const awsSecretAccessKeyAssignmentPattern = /aws_secret_access_key\s*=\s*["']?([^\s"'#]+)["']?/giu;

function containsAwsCredential(text: string): boolean {
  if (awsAccessKeyIdPattern.test(text)) return true;
  for (const match of text.matchAll(awsSecretAccessKeyAssignmentPattern)) {
    const value = match[1];
    if (value !== undefined && isCredibleCredentialValue(value)) return true;
  }
  return false;
}

/** Bucket 4: a multi-signal contextual credential. Each sub-check requires *both* a sensitive
 * context (an uppercase `.env`-style key name, an embedded connection-string userinfo, or an AWS
 * access-key-id shape) *and*, where the context alone does not already fix the value's format, a
 * value that is neither an obvious placeholder (`changeme`, `<...>`, `xxx...`, empty, ...) nor
 * implausibly formatted (too short/long, unexpected characters). */
function containsContextualCredential(text: string): boolean {
  return (
    containsAwsCredential(text) ||
    containsSensitiveEnvAssignment(text) ||
    containsConnectionStringCredential(text)
  );
}

export type RepositorySecretReason =
  "known_secret_variant" | "provider_or_jwt_token" | "private_key_block" | "contextual_credential";

export interface RepositorySecretClassification {
  readonly matched: boolean;
  readonly reasons: readonly RepositorySecretReason[];
}

export interface RepositorySecretScannerOptions {
  readonly knownSecrets?: readonly string[];
}

/** Precise "does this file contain a secret?" classifier for `GitPreflight`. See the module doc
 * comment for the full layered contract and rationale. */
export class RepositorySecretScanner {
  readonly #knownSecrets: readonly string[];

  constructor(options: RepositorySecretScannerOptions = {}) {
    this.#knownSecrets = (options.knownSecrets ?? []).filter((secret) => secret.length > 0);
  }

  /** Classifies `text`, reporting every bucket that matched (useful for tests and diagnostics).
   * `containsSecret` is the boolean projection `GitPreflight` actually consumes. */
  classify(text: string): RepositorySecretClassification {
    const reasons: RepositorySecretReason[] = [];
    if (containsKnownSecretVariant(text, this.#knownSecrets)) reasons.push("known_secret_variant");
    if (containsProviderOrJwtToken(text)) reasons.push("provider_or_jwt_token");
    if (containsPrivateKeyBlock(text)) reasons.push("private_key_block");
    if (containsContextualCredential(text)) reasons.push("contextual_credential");
    return { matched: reasons.length > 0, reasons };
  }

  containsSecret(text: string): boolean {
    return this.classify(text).matched;
  }
}
