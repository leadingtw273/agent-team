import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { RepositorySecretScanner } from "../../src/infrastructure/redaction/repository-secret-scanner.js";

/** Every fake credential literal below is built through `joined()` (plain string concatenation)
 * rather than written as one contiguous literal -- the same convention `tests/unit/redaction.test.ts`
 * already established -- so this test file itself never contains a token-shaped substring a
 * secret scanner (including GitHub's own push-protection) could mistake for a real credential. */
function joined(...parts: readonly string[]): string {
  return parts.join("");
}

const fixtureGhpToken = joined("gh", "p_", "abcdefghijklmnopqrstuvwxyz0123456789AB");
const fixtureGithubPatToken = joined("github", "_pat_", "abcdefghijklmnopqrstuvwxyz0123456789ABCD");
const fixtureSkAntToken = joined("sk", "-ant-", "abcdefghijklmnopqrstuvwxyz012345");
const fixtureAizaToken = joined("AI", "za", "abcdefghijklmnopqrstuvwxyz0123456789");
const fixtureJwtToken = joined("eyJ", "abcdefghijk", ".", "abcdefghijkl", ".", "abcdefghijkl");
const fixtureLinApiToken = joined("lin", "_api_", "abcdefghijklmnopqrstuv");
const fixtureAwsAccessKeyId = joined("AKIA", "JH3IUF7QOWSNBPA1");
const fixtureClientSecretValue = joined("9f8a7b6c5d4e3f2a", "1b0c9d8e");
const fixturePasswordValue = joined("Tr0ub4dor3x", "Kq9zP");
const fixturePrivateKeyValue = joined(
  "MIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEA1234567890abcdef",
  "ghijklmnopqrstuvwxyz",
);
const fixtureApiKeyValue = joined("a9f8e7d6c5b4a3f2", "e1d0c9b8");
const fixtureBasicAuthValue = joined("dXNlcjpzdXBl", "cnNlY3JldA==");
const fixtureBearerOpaqueValue = joined("9f8a7b6c5d4e3f2a", "1b0c9d8e");
const fixtureUrlUserinfoPasswordValue = joined("S3cur3Pass", "w0rd");
const fixtureQueryTokenValue = joined("a9f8e7d6c5b4a3f2", "e1d0c9b8");
const fixtureCookieSessionValue = joined("abc123def", "456ghi789");
const fixturePemPrivateKeyBlock = [
  joined("-----BEGIN ", "RSA PRIVATE KEY", "-----"),
  "MIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEA1234567890abcdef",
  "ghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEF==",
  joined("-----END ", "RSA PRIVATE KEY", "-----"),
].join("\n");
const fixtureOpenSshPrivateKeyBlock = [
  joined("-----BEGIN ", "OPENSSH PRIVATE KEY", "-----"),
  "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gt",
  joined("-----END ", "OPENSSH PRIVATE KEY", "-----"),
].join("\n");

describe("RepositorySecretScanner", () => {
  describe("regression: descriptive prose that merely mentions a sensitive-looking key name", () => {
    // The exact real-world false positive this ticket fixes: an ESLint disable comment
    // containing the English phrase "required signature:" was previously classified as a secret
    // purely because `signature` is one of the Redactor's sensitive key names.
    const harmlessTexts = [
      "// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- required signature: lastIndex<T>(items: readonly T[]): number",
      "export function lastIndex<T>(items: readonly T[]): number { return items.length - 1; }",
      "/** The function signature: (a: number, b: number) => number describes two numeric params. */",
      "// key: this comment explains the meaning of key: value pairs found in JSON documents.",
      "// token: refers to a lexical token produced by the parser, not a credential of any kind.",
      "// password: complexity requirements are enforced by policy and are not stored here.",
      "// secret: the recipe's secret is a pinch of nutmeg, according to the changelog note.",
    ];

    it.each(harmlessTexts)("does not flag: %s", (text) => {
      const scanner = new RepositorySecretScanner();
      expect(scanner.classify(text)).toEqual({ matched: false, reasons: [] });
    });
  });

  describe("high-confidence provider/JWT tokens and private-key blocks", () => {
    it.each([
      ["ghp_-shaped token", fixtureGhpToken, "provider_or_jwt_token"],
      ["github_pat_-shaped token", fixtureGithubPatToken, "provider_or_jwt_token"],
      ["sk-ant--shaped token", fixtureSkAntToken, "provider_or_jwt_token"],
      ["AIza-shaped token", fixtureAizaToken, "provider_or_jwt_token"],
      ["JWT-shaped value", fixtureJwtToken, "provider_or_jwt_token"],
      ["lin_api_-shaped token", fixtureLinApiToken, "provider_or_jwt_token"],
      ["PEM private-key block", fixturePemPrivateKeyBlock, "private_key_block"],
      ["OpenSSH private-key block", fixtureOpenSshPrivateKeyBlock, "private_key_block"],
    ] as const)("flags a %s embedded in surrounding file content", (_label, fixture, reason) => {
      const scanner = new RepositorySecretScanner();
      const text = `context before\n${fixture}\ncontext after\n`;
      const classification = scanner.classify(text);
      expect(classification.matched).toBe(true);
      expect(classification.reasons).toContain(reason);
      expect(scanner.containsSecret(text)).toBe(true);
    });

    it("does not flag ordinary code that merely resembles these shapes", () => {
      const scanner = new RepositorySecretScanner();
      expect(scanner.containsSecret("const skValue = 'sk-short';")).toBe(false);
      expect(scanner.containsSecret("mentions PRIVATE KEY in prose but has no key block")).toBe(
        false,
      );
    });
  });

  describe("known-secret variants (raw / URL-encoded / Base64) -- no capability regression", () => {
    const secret = "registered-file-secret-value/with+symbols";

    it.each([
      ["raw", secret],
      ["URL-encoded", encodeURIComponent(secret)],
      ["Base64", Buffer.from(secret, "utf8").toString("base64")],
    ])("flags the %s variant of a registered knownSecrets entry", (_label, variant) => {
      const scanner = new RepositorySecretScanner({ knownSecrets: [secret] });
      const classification = scanner.classify(`prefix ${variant} suffix`);
      expect(classification.matched).toBe(true);
      expect(classification.reasons).toContain("known_secret_variant");
    });

    it("does not flag unrelated text when no registered secret is present", () => {
      const scanner = new RepositorySecretScanner({ knownSecrets: [secret] });
      expect(scanner.containsSecret("nothing sensitive here at all")).toBe(false);
    });

    it("tolerates an empty knownSecrets list", () => {
      const scanner = new RepositorySecretScanner({ knownSecrets: [] });
      expect(scanner.containsSecret("plain text")).toBe(false);
    });
  });

  describe("multi-signal contextual credentials (AWS / .env-style / connection strings)", () => {
    it("flags an AWS access key id even without a paired secret access key", () => {
      const scanner = new RepositorySecretScanner();
      const classification = scanner.classify(`AWS_ACCESS_KEY_ID=${fixtureAwsAccessKeyId}\n`);
      expect(classification.matched).toBe(true);
      expect(classification.reasons).toContain("contextual_credential");
    });

    it("flags a real-looking AWS access/secret key pair", () => {
      const scanner = new RepositorySecretScanner();
      const text = [
        `AWS_ACCESS_KEY_ID=${fixtureAwsAccessKeyId}`,
        "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYzEuLtG9QaHx",
      ].join("\n");
      expect(scanner.containsSecret(text)).toBe(true);
    });

    it("flags a high-confidence .env-style credential (WEBHOOK_SECRET=)", () => {
      const scanner = new RepositorySecretScanner();
      const text = "WEBHOOK_SECRET=whsec_8f3a9c2b1d4e5f607182930a4b5c6d7e";
      const classification = scanner.classify(text);
      expect(classification.matched).toBe(true);
      expect(classification.reasons).toEqual(["contextual_credential"]);
    });

    it("flags a database connection string with embedded credentials", () => {
      const scanner = new RepositorySecretScanner();
      const text = "DATABASE_URL=postgres://dbuser:S3cur3Passw0rdValue@db.internal:5432/app";
      expect(scanner.containsSecret(text)).toBe(true);
    });

    it("does NOT flag an explicit placeholder value (EXAMPLE_TOKEN=changeme)", () => {
      const scanner = new RepositorySecretScanner();
      expect(scanner.classify("EXAMPLE_TOKEN=changeme")).toEqual({ matched: false, reasons: [] });
    });

    it.each([
      "DB_PASSWORD=changeme",
      "API_KEY=<your-api-key-here>",
      "WEBHOOK_SECRET=xxxxxxxxxxxxxxxx",
      "ACCESS_TOKEN=",
      "postgres://dbuser:changeme@db.internal:5432/app",
    ])("does not flag other placeholder-shaped credentials: %s", (text) => {
      const scanner = new RepositorySecretScanner();
      expect(scanner.containsSecret(text)).toBe(false);
    });

    it("does not flag ordinary uppercase constants unrelated to credentials", () => {
      const scanner = new RepositorySecretScanner();
      expect(scanner.containsSecret("MAX_RETRY_COUNT=5\nLOG_LEVEL=info\n")).toBe(false);
    });
  });

  // C034b: C034's new scanner dropped bucket coverage the old
  // `redactor.redactText(text) !== text` check used to provide incidentally -- lowercase/quoted
  // sensitive key:value pairs, any-scheme URL userinfo, and Authorization/cookie/query-key
  // credentials. Each of these 9 real-credential shapes regressed from "blocked" to "allowed".
  describe("C034b regression: real credentials the pre-scanner Redactor-based check used to catch", () => {
    it.each([
      [
        "lowercase quoted client_secret (YAML/JSON)",
        `client_secret: "${fixtureClientSecretValue}"`,
      ],
      [
        "lowercase quoted password (JS object literal)",
        `const cfg = { password: "${fixturePasswordValue}" };`,
      ],
      [
        "lowercase quoted private_key without a PEM header",
        `private_key: "${fixturePrivateKeyValue}"`,
      ],
      ["lowercase api_key= assignment", `api_key=${fixtureApiKeyValue}`],
      ["Authorization: Basic <base64>", `Authorization: Basic ${fixtureBasicAuthValue}`],
      ["Authorization: Bearer <opaque token>", `Authorization: Bearer ${fixtureBearerOpaqueValue}`],
      [
        "non-database-scheme URL userinfo",
        `https://admin:${fixtureUrlUserinfoPasswordValue}@internal.example.com/api`,
      ],
      ["sensitive URL query parameter", `?token=${fixtureQueryTokenValue}`],
      ["set-cookie session credential", `set-cookie: session=${fixtureCookieSessionValue}`],
    ] as const)("flags %s", (_label, text) => {
      const scanner = new RepositorySecretScanner();
      const classification = scanner.classify(text);
      expect(classification.matched).toBe(true);
      expect(classification.reasons).toContain("contextual_credential");
      expect(scanner.containsSecret(text)).toBe(true);
    });

    // The one false positive this fix is known to reintroduce -- `value=complexity` (10 letters)
    // clears the shared credible-value gate on its own -- is suppressed by the quote-or-`=`
    // discipline: a bare colon-separated value never qualifies. Already covered by the
    // "descriptive prose" `it.each` above (`// password: complexity requirements ...`); asserted
    // again here, explicitly, because C034b's acceptance review singled it out by name.
    it("does not reintroduce the 'password: complexity requirements...' false positive", () => {
      const scanner = new RepositorySecretScanner();
      const text =
        "// password: complexity requirements are enforced by policy and are not stored here.";
      expect(scanner.classify(text)).toEqual({ matched: false, reasons: [] });
    });
  });

  // C034c: the acceptance review for C034b found that its new bucket 4d/4e/4f/4g fixtures were
  // written in shapes convenient for the implementation, not the shapes these credentials actually
  // take in real source -- a bare `?token=...` with nothing around it, a `set-cookie:` line with no
  // attributes, prose that happened to have no bearer/basic prefix collide with a value that
  // happened to be an ordinary word. Every fixture below is deliberately written the way the
  // underlying bug report/regex documents it appearing for real: quoted, parenthesized,
  // attribute-bearing, or as a doc-comment sentence.
  describe("C034c: query-key values wrapped the way real source code wraps a URL", () => {
    it.each([
      ["bare, unwrapped URL", `https://api.example.com/v1?token=${fixtureQueryTokenValue}`],
      [
        "single-quoted JS string literal",
        `const u = 'https://api.example.com/v1?token=${fixtureQueryTokenValue}';`,
      ],
      [
        "double-quoted JS string literal",
        `const u = "https://api.example.com/v1?token=${fixtureQueryTokenValue}";`,
      ],
      [
        "bare call-argument, closed by a paren",
        `fetch(https://x.com/?access_token=${fixtureQueryTokenValue})`,
      ],
      [
        "Markdown link target, closed by a paren",
        `[docs](https://x.com/?token=${fixtureQueryTokenValue})`,
      ],
      [
        "followed by a second, unrelated query parameter",
        `https://api.example.com/v1?token=${fixtureQueryTokenValue}&page=2`,
      ],
    ] as const)("flags %s", (_label, text) => {
      const scanner = new RepositorySecretScanner();
      const classification = scanner.classify(text);
      expect(classification.matched).toBe(true);
      expect(classification.reasons).toContain("contextual_credential");
    });
  });

  describe("C034c: Set-Cookie/cookie lines carrying the attributes a real header has", () => {
    it.each([
      ["trailing HttpOnly attribute", `set-cookie: sid=${fixtureCookieSessionValue}; HttpOnly`],
      ["trailing Path attribute", `set-cookie: sid=${fixtureCookieSessionValue}; Path=/`],
      [
        "multiple trailing attributes, capitalized header",
        `Set-Cookie: session=${fixtureCookieSessionValue}; Secure; HttpOnly`,
      ],
      ["no attributes at all", `set-cookie: sid=${fixtureCookieSessionValue}`],
    ] as const)("flags %s", (_label, text) => {
      const scanner = new RepositorySecretScanner();
      const classification = scanner.classify(text);
      expect(classification.matched).toBe(true);
      expect(classification.reasons).toContain("contextual_credential");
    });
  });

  describe("C034c: Authorization -- doc-comment prose must not collide with real headers", () => {
    it.each([
      "// Authorization: required for all admin routes; see docs/auth.md",
      "* Authorization: optional when the request is internal.",
      "// authorization: disabled in local dev mode",
      "// Authorization: inherited from the parent router",
    ])("does not flag prose: %s", (text) => {
      const scanner = new RepositorySecretScanner();
      expect(scanner.classify(text)).toEqual({ matched: false, reasons: [] });
    });

    it.each([
      ["Basic <base64>", `Authorization: Basic ${fixtureBasicAuthValue}`],
      ["Bearer <opaque token>", `Authorization: Bearer ${fixtureBearerOpaqueValue}`],
      ["unprefixed but quoted", `authorization: "${fixtureBearerOpaqueValue}"`],
    ] as const)("still flags a real header: %s", (_label, text) => {
      const scanner = new RepositorySecretScanner();
      const classification = scanner.classify(text);
      expect(classification.matched).toBe(true);
      expect(classification.reasons).toContain("contextual_credential");
    });
  });

  describe("C034c: bucket 4d must not flag an ordinary quoted English word as a credential", () => {
    it.each([
      'const node = { token: "identifier", start: 0 };',
      'const x = { secret: "santa-list" };',
      'const rules = { password: "required" };',
      'kind: "punctuation", token: "semicolon"',
    ])("does not flag: %s", (text) => {
      const scanner = new RepositorySecretScanner();
      expect(scanner.classify(text)).toEqual({ matched: false, reasons: [] });
    });

    it.each([
      ["client_secret", `client_secret: "${fixtureClientSecretValue}"`],
      ["password", `const cfg = { password: "${fixturePasswordValue}" };`],
      ["private_key", `private_key: "${fixturePrivateKeyValue}"`],
      ["api_key", `api_key=${fixtureApiKeyValue}`],
      ["webhook secret via .env shape", "WEBHOOK_SECRET=whsec_8f3a9c2b1d4e5f607182930a4b5c6d7e"],
    ] as const)("still flags a real credential: %s", (_label, text) => {
      const scanner = new RepositorySecretScanner();
      const classification = scanner.classify(text);
      expect(classification.matched).toBe(true);
      expect(classification.reasons).toContain("contextual_credential");
    });
  });

  describe("C034d: credentials written as all letters, and words that only look like them", () => {
    // Probing the prose-word rejection against credentials as they are actually written found it
    // dropped every all-letter credential; probing it against real files found an i18n label file
    // tripping it. One bound fixes both: prose values that reach here are short, credentials are not.
    it.each([
      ['password: "deadbeefcafebabe"', "lowercase hex"],
      ['password: "supersecretpassphrase"', "passphrase"],
      ['client_secret: "abcdefghijklmnopqrst"', "all-letter secret"],
      ['api_key: "mfrggzdfmztwqzlm"', "lowercase base32"],
      ['secret: "correct-horse-battery-staple"', "hyphenated passphrase"],
    ])("flags an all-letter credential: %s (%s)", (text) => {
      expect(new RepositorySecretScanner().containsSecret(text)).toBe(true);
    });

    it("flags an = assignment regardless of the value's shape, which has no prose ambiguity", () => {
      expect(new RepositorySecretScanner().containsSecret("api_key=deadbeefcafebabe")).toBe(true);
    });

    it.each([
      ['export const en = { password: "Password", token: "Access token" };', "i18n labels"],
      ['{ password: "Passwort" }', "i18n label, other language"],
      ['{ token: "AccessToken" }', "i18n label, camel case"],
    ])("still allows a label whose value is one word: %s (%s)", (text) => {
      expect(new RepositorySecretScanner().containsSecret(text)).toBe(false);
    });
  });

  describe("C034d: a query credential inside whatever the surrounding code wraps the URL in", () => {
    const token = "a9f8e7d6c5b4a3f2e1d0c9b8";
    it.each([
      [`const url = \`https://api.example.com/v1?token=${token}\`;`, "template literal"],
      [`url: https://api.example.com/v1?token=${token},`, "trailing comma"],
      [`https://api.example.com/v1?token=${token};`, "trailing semicolon"],
    ])("flags %s (%s)", (text) => {
      expect(new RepositorySecretScanner().containsSecret(text)).toBe(true);
    });
  });

  // C034e (this fixes a fresh-context acceptance FAIL): a fourth-round scan of this very repo's
  // 701 tracked files found bucket 4d's `=` form treating ordinary property-access reads
  // (`const token = request.confirmation;`) as credentials, purely because the right-hand side is
  // an identifier chain at least 8 characters long that clears the shared plausibility gate.
  describe("C034e / M1: an unquoted, dot-joined identifier chain is a property read, not a credential", () => {
    it.each([
      "const token = request.confirmation;",
      "const confirmationToken = panel.dataset.confirmationToken;",
      "const secret = config.webhookSecret;",
      "let apiKey = process.env.API_KEY;",
      "const accessToken = response.body.accessToken;",
      "const password = credentials.password;",
    ])("does not flag: %s", (text) => {
      expect(new RepositorySecretScanner().classify(text)).toEqual({ matched: false, reasons: [] });
    });

    // Real credentials the acceptance reviewer re-ran against this fix, confirming none regressed.
    // The last entry is the boundary case: the dot alone is not the discriminator (a real
    // credential can legitimately contain one) -- what matters is whether every dot-separated
    // segment is itself a valid identifier (letter/underscore/$ first). A value whose first
    // segment starts with a digit can never be a JS/TS property-access expression, so it must
    // fall through to the ordinary plausibility gate and still be flagged.
    it.each([
      ["bare hex, no dot", "api_key=deadbeefcafebabe"],
      ["bare hex, no dot, longer", "api_key=a9f8e7d6c5b4a3f2e1d0c9b8"],
      ["provider-prefixed secret", "WEBHOOK_SECRET=whsec_8f3a9c2b1d4e5f607182930a4b5c6d7e"],
      ["quoted passphrase", 'const cfg = { password: "Tr0ub4dor3xKq9zP" };'],
      [
        "quoted PEM-shaped base64",
        'private_key: "MIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEA1234567890abcdefghijklmnopqrstuvwxyz"',
      ],
      ["dotted value, not an identifier chain", "api_key=9f8e7d6.c5b4a3f2e1d0c9b8"],
    ] as const)("still flags a real credential: %s", (_label, text) => {
      expect(new RepositorySecretScanner().containsSecret(text)).toBe(true);
    });
  });

  // C034e / M2: a TS union/enum literal (`authorization: "ordinary"`) reached bucket 4e's
  // quoted-value hatch, which -- unlike bucket 4d's colon form -- had no prose rejection at all.
  describe("C034e / M2: a quoted TS union/enum literal under a sensitive key is not a credential", () => {
    it.each([
      'authorization: "ordinary"',
      'authorization: "ordinary" | "project_long_term";',
      'authorization: "project_long_term",',
    ])("does not flag: %s", (text) => {
      expect(new RepositorySecretScanner().classify(text)).toEqual({ matched: false, reasons: [] });
    });

    // The snake_case prose rule is deliberately separator-driven, not just length-driven -- it
    // must not eat an underscore-joined value that is genuinely long and hyphen-free but is a real
    // credential shape (a lowercase env-style secret), only values that look like an identifier.
    it("still flags a real quoted credential that happens to contain no underscore-joined words", () => {
      const text = 'authorization: "9f8a7b6c5d4e3f2a1b0c9d8e"';
      expect(new RepositorySecretScanner().containsSecret(text)).toBe(true);
    });
  });

  // C034e / M4: pins the `=` vs `:` separator distinction bucket 4d's prose rejection relies on.
  // The pre-existing `api_key=deadbeefcafebabe` fixture is 16 characters, so it was already
  // outside the prose-word length bound (< 16) and would pass even if the separator guard were
  // accidentally widened to cover `=` too. An 8-letter `=` value is the only shape that actually
  // exercises the guard: `deadbeef` is a single all-lowercase word under the 16-char bound, so it
  // WOULD be misread as prose if the `:`-only condition on `isProseValue` were ever loosened.
  describe("C034e / M4: the `=` form is never subject to the colon-only prose rejection", () => {
    it("flags an 8-letter = value that a broadened prose rejection would incorrectly drop", () => {
      expect(new RepositorySecretScanner().containsSecret("api_key=deadbeef")).toBe(true);
    });
  });

  // C034e / M5: the decisive regression guard for this round -- the acceptance failure was found
  // by running the scanner against this repository's own source, not against hand-picked fixtures.
  // Re-running that exact scan here means any future change that reintroduces a false positive on
  // real code in this repo fails a unit test, not a fresh-context acceptance review.
  describe("C034e / M5: scanning this repository's own src/** must never flag a secret", () => {
    /** Deliberately empty. If a file genuinely must contain a fixture-shaped credential under
     * `src/**` (none currently do -- all such fixtures live under `tests/`), add its repo-relative
     * path here with a comment naming the exact line and why it cannot be rewritten to avoid the
     * false positive. Do NOT add an entry to make a real miss disappear, and do NOT loosen any
     * bucket above to shrink this list -- that is exactly the regression this test exists to catch. */
    const allowlistedRelativePaths: readonly string[] = [];

    function collectSourceFiles(directory: string): string[] {
      const files: string[] = [];
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const fullPath = join(directory, entry.name);
        if (entry.isDirectory()) {
          files.push(...collectSourceFiles(fullPath));
        } else if (entry.isFile() && /\.(ts|js)$/u.test(entry.name)) {
          files.push(fullPath);
        }
      }
      return files;
    }

    const srcRoot = join(__dirname, "..", "..", "src");
    const sourceFiles = collectSourceFiles(srcRoot);

    it("finds a non-trivial number of source files to scan (sanity check on the walk itself)", () => {
      expect(sourceFiles.length).toBeGreaterThan(50);
    });

    it("flags zero files under src/** (allowlist above must stay empty in the passing state)", () => {
      const scanner = new RepositorySecretScanner();
      const flaggedFiles: string[] = [];
      for (const filePath of sourceFiles) {
        const relativePath = filePath.slice(srcRoot.length + 1);
        if (allowlistedRelativePaths.includes(relativePath)) continue;
        const text = readFileSync(filePath, "utf8");
        if (scanner.containsSecret(text)) flaggedFiles.push(relativePath);
      }
      expect(flaggedFiles).toEqual([]);
    });
  });
});
