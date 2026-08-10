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
});
