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

/** Bucket 4b: a URL with embedded `user:password@` userinfo. C034 restricted this to a five-scheme
 * database allowlist (`postgres`, `mysql`, `mongodb`, `redis`, `amqp`), which is why
 * `https://admin:S3cur3Passw0rd@internal.example.com/api` -- a real embedded credential, just not
 * a database URL -- went from "blocked" to "allowed". `redactor.ts`'s own userinfo rule
 * (`redactor.ts:126-129`) never had this restriction; it masks userinfo for *any* URL scheme.
 * Restated here (not shared, `redactor.ts` stays unmodified) with the same generic scheme grammar
 * (`[a-z][a-z0-9+.-]*`), so a legitimate embedded credential is caught regardless of scheme -- the
 * `isCredibleCredentialValue` gate below, not the scheme allowlist, is what keeps placeholders like
 * `postgres://dbuser:changeme@db.internal:5432/app` from being flagged. */
const urlUserinfoCredentialPattern = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]+)@/giu;

function containsUrlUserinfoCredential(text: string): boolean {
  for (const match of text.matchAll(urlUserinfoCredentialPattern)) {
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

/** Bucket 4d support: sensitive key names, restated (not shared) from `redactor.ts`'s
 * `defaultSensitiveKeys`/`sensitiveKeySuffixes` -- same normalize-then-match semantics
 * (lowercase, strip non-alphanumerics, then exact-name-or-suffix), but with one deliberate
 * omission: `signature` is *not* in this list. `signature` is the one sensitive key name the
 * Redactor carries that this scanner's whole reason for existing is to stop treating as
 * sufficient (see the module doc comment's `required signature:` example) -- carrying it into
 * this bucket would silently reintroduce that exact false positive under its colon/quote form. */
const contextualSensitiveKeyNames = new Set(
  [
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
    "webhooksecret",
    "accesskey",
  ].map(normalizeContextKey),
);
const contextualSensitiveKeySuffixes = [
  "authorization",
  "cookie",
  "apikey",
  "token",
  "password",
  "passwd",
  "secret",
  "privatekey",
  "accesskey",
] as const;

function normalizeContextKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function isSensitiveContextKey(key: string): boolean {
  const normalized = normalizeContextKey(key);
  return (
    contextualSensitiveKeyNames.has(normalized) ||
    contextualSensitiveKeySuffixes.some((suffix) => normalized.endsWith(suffix))
  );
}

/** Bucket 4d: lower- or mixed-case, optionally-quoted `key: value` / `key=value` pairs whose key is
 * sensitive (a YAML/JSON config line, not just the uppercase `.env` shape bucket 4a already
 * covers). The discriminator that keeps this from reintroducing the `required signature:` /
 * `password: complexity requirements are enforced by policy` prose false positives: a *colon*
 * separator is only accepted when the value is quoted (`key: "value"`); an unquoted value after a
 * colon is exactly the descriptive-prose shape (`password: complexity requirements ...`) this
 * scanner must not flag. An `=` assignment, by contrast, is inherently a value-carrying form
 * (`api_key=...`), so it is accepted unquoted too. Either way the value still has to clear the
 * shared `isCredibleCredentialValue` gate. */
const contextualKeyValuePattern =
  /(^|[\s,{;])(["']?)([A-Za-z][A-Za-z0-9_-]*)\2\s*([:=])\s*("(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|[^\s,;}\r\n]+)/gmu;

/** A quote alone does not save a value that is itself just an ordinary word (or hyphenated
 * compound), e.g. `{ token: "identifier" }`, `{ secret: "santa-list" }`, or an i18n label file's
 * `{ password: "Password" }` -- these describe *what kind of thing* a field holds, not a
 * credential, yet they clear the shared `isCredibleCredentialValue` gate (>= 8 letters, no
 * placeholder token, legal character set) on their own. So this bucket alone (not the shared gate
 * every other bucket relies on) additionally rejects that shape.
 *
 * Two bounds keep the rejection from swallowing real credentials, both found by probing it against
 * credentials as they are actually written rather than against the rule's own examples:
 *
 * - **Length.** Matching letters alone would drop every all-letter credential: lowercase hex
 *   (`deadbeefcafebabe`), base32 (`mfrggzdfmztwqzlm`), a passphrase (`supersecretpassphrase`), a
 *   hyphenated one (`correct-horse-battery-staple`). Every prose value that reaches here is short
 *   (`required` 8, `semicolon` 9, `identifier` 10, `punctuation` 11, `Password` 8) while those
 *   credentials all run to 16 or beyond, so the rejection stops at 16 characters. A genuine
 *   16-letter English word under a sensitive key is treated as a credential -- the safe direction.
 * - **Separator.** Prose ambiguity comes from the colon form; `api_key=deadbeefcafebabe` has none,
 *   so an `=` assignment is never rejected on these grounds. */
const singleWordPattern = /^[A-Za-z][A-Za-z-]*$/u;
const maximumProseWordLength = 16;

function isSingleProseWordValue(rawValue: string): boolean {
  const value = stripSurroundingQuotes(rawValue);
  return value.length < maximumProseWordLength && singleWordPattern.test(value);
}

function containsSensitiveKeyValueCredential(text: string): boolean {
  for (const match of text.matchAll(contextualKeyValuePattern)) {
    const key = match[3];
    const separator = match[4];
    const rawValue = match[5];
    if (key === undefined || separator === undefined || rawValue === undefined) continue;
    if (!isSensitiveContextKey(key)) continue;
    const isQuotedValue =
      rawValue.length >= 2 && (rawValue.startsWith('"') || rawValue.startsWith("'"));
    if (separator === ":" && !isQuotedValue) continue;
    if (separator === ":" && isSingleProseWordValue(rawValue)) continue;
    if (isCredibleCredentialValue(rawValue)) return true;
  }
  return false;
}

/** Bucket 4e: an `Authorization: Basic <base64>` / `Authorization: Bearer <token>` header. Mirrors
 * `redactor.ts:121-124`'s own extraction (strip an optional `Bearer`/`Basic` prefix, take the
 * remaining non-whitespace run as the credential), then applies the shared credible-value gate --
 * an opaque Bearer token is caught here; a JWT-shaped one is already caught by bucket 2.
 *
 * Because the `Bearer`/`Basic` prefix is optional, an unprefixed, unquoted value is exactly the
 * shape of a doc-comment sentence whose first word happens to clear the credible-value length
 * floor (`// Authorization: required for all admin routes`, `// Authorization: inherited from the
 * parent router`) -- both real headers this scanner must still catch. The fix: a bare `authorization:
 * <value>` line is only treated as a header when the value carries its own credential signal, a
 * `bearer`/`basic` scheme prefix (captured separately below so its presence/absence is observable)
 * or the value itself is quoted -- prose is never quoted here, a real opaque token pasted into
 * config commonly is. */
const authorizationHeaderPattern = /authorization\s*[:=]\s*((?:bearer|basic)\s+)?([^\s,;]+)/giu;

function containsAuthorizationHeaderCredential(text: string): boolean {
  for (const match of text.matchAll(authorizationHeaderPattern)) {
    const schemePrefix = match[1];
    const value = match[2];
    if (value === undefined) continue;
    const isQuotedValue = value.length >= 2 && (value.startsWith('"') || value.startsWith("'"));
    if (schemePrefix === undefined && !isQuotedValue) continue;
    if (isCredibleCredentialValue(value)) return true;
  }
  return false;
}

/** Bucket 4f: a `cookie:` / `set-cookie:` line carrying a credible `name=value` pair. Mirrors
 * `redactor.ts:125`'s own extraction (everything after the header name to end of line); no quote
 * requirement here (unlike bucket 4d) because the credible-value gate already rejects the
 * whitespace-containing prose shape on its own.
 *
 * A real `Set-Cookie` line is essentially never just `name=value` -- it carries `; `-separated
 * attributes (`; HttpOnly`, `; Path=/`, `; Secure`), and taking "everything after the header name"
 * as one value means those attributes ride along and break the credible-value character-class
 * check (`;`, ` `, `/` are not in it), silently letting the real cookie value through. The line is
 * therefore split on `;` first, and every `name=value` segment is checked independently -- an
 * attribute segment either has no `=` (skipped) or a short/non-credential value (`Path=/`,
 * `Max-Age=3600`) that clears its own gate the same as any other bucket. */
const cookieCredentialPattern = /(?:set-cookie|cookie)\s*[:=]\s*([^\r\n]*)/giu;

function containsCookieCredential(text: string): boolean {
  for (const match of text.matchAll(cookieCredentialPattern)) {
    const line = match[1];
    if (line === undefined) continue;
    for (const segment of line.split(";")) {
      const equalsIndex = segment.indexOf("=");
      if (equalsIndex === -1) continue;
      const value = segment.slice(equalsIndex + 1);
      if (isCredibleCredentialValue(value)) return true;
    }
  }
  return false;
}

/** Bucket 4g: a sensitive URL query parameter (`?token=...`, `&api_key=...`). Mirrors
 * `redactor.ts:130-134`'s own extraction and key-decoding, restated locally since that helper is
 * private to the Redactor.
 *
 * A real URL carrying a query string is almost never a bare standalone token in source -- it is
 * quoted (`'https://...?token=...'`), parenthesized (`fetch(https://...)`), or wrapped in a
 * Markdown link (`[x](https://...)`). The value character class below used to run to the next
 * `&`/`#`/whitespace and no further, so it swallowed that trailing quote/paren/bracket into the
 * "value", which then failed the shared credible-value character-class check and let the URL
 * through. Excluding those wrapper characters from the value class itself (rather than the key
 * class, which never carries them) makes the match stop at the credential and not before -- the
 * wrapper closes right where source code actually puts it, immediately after the value. */
function decodeQueryParameterKey(key: string): string {
  try {
    return decodeURIComponent(key.replace(/\+/gu, " "));
  } catch {
    return key;
  }
}
/** The excluded set is everything source and prose wrap a URL in, because whatever follows the
 * credential must not be absorbed into it -- the shared value gate rejects anything outside
 * `[A-Za-z0-9+/=_.:-]`, so one trailing quote is enough to let a real credential through. Backtick
 * matters most of the two added last: a template literal is how TypeScript usually builds a URL. */
const queryKeyCredentialPattern = /[?&]([^=&#\s]+)=([^&#\s'"`()<>[\];,]*)/gu;

function containsQueryKeyCredential(text: string): boolean {
  for (const match of text.matchAll(queryKeyCredentialPattern)) {
    const key = match[1];
    const value = match[2];
    if (key === undefined || value === undefined) continue;
    if (!isSensitiveContextKey(decodeQueryParameterKey(key))) continue;
    if (isCredibleCredentialValue(value)) return true;
  }
  return false;
}

/** Bucket 4: a multi-signal contextual credential. Each sub-check requires *both* a sensitive
 * context (an uppercase `.env`-style key name, a lower/mixed-case quoted-or-`=` key name, an
 * embedded URL userinfo/query parameter, an `Authorization`/`cookie` header, or an AWS
 * access-key-id shape) *and*, where the context alone does not already fix the value's format, a
 * value that is neither an obvious placeholder (`changeme`, `<...>`, `xxx...`, empty, ...) nor
 * implausibly formatted (too short/long, unexpected characters). */
function containsContextualCredential(text: string): boolean {
  return (
    containsAwsCredential(text) ||
    containsSensitiveEnvAssignment(text) ||
    containsUrlUserinfoCredential(text) ||
    containsSensitiveKeyValueCredential(text) ||
    containsAuthorizationHeaderCredential(text) ||
    containsCookieCredential(text) ||
    containsQueryKeyCredential(text)
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
