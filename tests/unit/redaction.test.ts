import { describe, expect, it } from "vitest";

import {
  redactCommand,
  Redactor,
  redactedValue,
  truncatedValue,
} from "../../src/infrastructure/redaction/index.js";

function joined(...parts: readonly string[]): string {
  return parts.join("");
}

describe("text redaction", () => {
  it("redacts registered secrets and common encoded variants", () => {
    const secret = "value with/slash+symbols";
    const redactor = new Redactor({ secrets: [secret] });
    const input = [
      secret,
      encodeURIComponent(secret),
      Buffer.from(secret, "utf8").toString("base64"),
    ].join(" | ");

    const output = redactor.redactText(input);
    expect(output).not.toContain(secret);
    expect(output).not.toContain(encodeURIComponent(secret));
    expect(output).not.toContain(Buffer.from(secret, "utf8").toString("base64"));
    expect(output.match(/\[REDACTED\]/gu)).toHaveLength(3);
  });

  it("redacts provider token shapes without storing live-looking test credentials", () => {
    const tokens = [
      joined("sk", "-", "abcdefghijklmnopqrstuv"),
      joined("sk", "-ant-", "abcdefghijklmnopqrstuv"),
      joined("lin", "_api_", "abcdefghijklmnopqrstuv"),
      joined("gh", "p_", "abcdefghijklmnopqrstuvwxyz"),
      joined("github", "_pat_", "abcdefghijklmnopqrstuvwxyz"),
      joined("AI", "za", "abcdefghijklmnopqrstuvwxyz123456789"),
      joined("eyJ", "abcdefghijk", ".", "abcdefghijkl", ".", "abcdefghijkl"),
    ];

    const output = new Redactor().redactText(tokens.join("\n"));
    for (const token of tokens) expect(output).not.toContain(token);
    expect(output.split("\n")).toEqual(tokens.map(() => redactedValue));
  });

  it("redacts authorization, cookies, URL userinfo, and sensitive query parameters", () => {
    const input = [
      "Authorization: Bearer bearer-value",
      "X-Api-Key=header-value",
      "X-Auth-Token: custom-header-value",
      "X-Session-Secret: custom-session-value",
      "Cookie: session=cookie-value; theme=dark",
      "clone https://user-name:password-value@example.test/repo",
      "GET https://example.test/hook?token=query-value&safe=visible&signature=signed-value",
      "GET https://example.test/oauth?client_secret=client-value&webhook_secret=hook-value",
      "GET https://example.test/key?private_key=private-value&api-key=api-value",
      "GET https://example.test/encoded?client%5Fsecret=encoded-value",
    ].join("\n");

    const output = new Redactor().redactText(input);
    for (const secret of [
      "bearer-value",
      "header-value",
      "custom-header-value",
      "custom-session-value",
      "cookie-value",
      "user-name",
      "password-value",
      "query-value",
      "signed-value",
      "client-value",
      "hook-value",
      "private-value",
      "api-value",
      "encoded-value",
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain("safe=visible");
    expect(output).toContain(`https://${redactedValue}@example.test/repo`);
  });

  it("does not redact ordinary short lookalikes or non-sensitive URLs", () => {
    const input =
      "sk-short https://example.test/path?mode=safe X-Session-Secretive: visible ordinary-value";
    expect(new Redactor().redactText(input)).toBe(input);
  });
});

describe("structured redaction", () => {
  it("redacts sensitive keys and nested secret text without mutating the input", () => {
    const secret = "registered-secret-value";
    const input = {
      authorization: "Bearer hidden",
      provider: {
        LINEAR_API_KEY: "hidden-key",
        output: `prefix ${secret} suffix`,
        nested: [{ refreshToken: "hidden-refresh" }, "visible"],
      },
    };

    const output = new Redactor({ secrets: [secret] }).redactUnknown(input);
    expect(output).toEqual({
      authorization: redactedValue,
      provider: {
        LINEAR_API_KEY: redactedValue,
        output: `prefix ${redactedValue} suffix`,
        nested: [{ refreshToken: redactedValue }, "visible"],
      },
    });
    expect(input.provider.output).toContain(secret);
  });

  it("fails closed for cycles, accessors, non-plain objects, and hostile proxies", () => {
    const cyclic: Record<string, unknown> = { visible: true };
    cyclic["self"] = cyclic;
    let getterCalled = false;
    Object.defineProperty(cyclic, "dangerous", {
      enumerable: true,
      get() {
        getterCalled = true;
        return "secret";
      },
    });
    cyclic["date"] = new Date("2026-08-04T00:00:00.000Z");

    const output = new Redactor().redactUnknown(cyclic) as Record<string, unknown>;
    expect(getterCalled).toBe(false);
    expect(output["self"]).toBe(redactedValue);
    expect(output["dangerous"]).toBe(redactedValue);
    expect(output["date"]).toBe(redactedValue);

    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("hostile external object");
        },
      },
    );
    expect(new Redactor().redactUnknown(hostile)).toBe(redactedValue);
  });

  it("enforces depth and collection limits on branches that are actually visited", () => {
    const depthOutput = new Redactor({ maxDepth: 2 }).redactUnknown({
      child: { grandchild: { value: "too-deep" } },
    }) as Record<string, unknown>;
    expect(depthOutput).toEqual({ child: { grandchild: redactedValue } });

    const collectionOutput = new Redactor({ maxCollectionEntries: 2 }).redactUnknown({
      first: 1,
      second: 2,
      third: 3,
    }) as Record<string, unknown>;
    expect(collectionOutput).toEqual({
      first: 1,
      second: 2,
      [truncatedValue]: truncatedValue,
    });
  });
});

describe("command and process output redaction", () => {
  it("redacts split flags, equals flags, environment values, URLs, stdout, and stderr", () => {
    const exact = "exact-command-secret";
    const redactor = new Redactor({ secrets: [exact] });
    const command = redactCommand(
      {
        executable: "/usr/bin/tool",
        arguments: [
          "--token",
          "flag-value",
          "--api_key=equals-value",
          "GITHUB_TOKEN=assignment-value",
          "--access-token=access-value",
          "--cookie",
          "session=cookie-command-value",
          "--webhookSecret",
          "camel-command-value",
          "--webhook_secret",
          "snake-command-value",
          "--webhook-secret",
          "kebab-command-value",
          "--APIKey",
          "acronym-command-value",
          "--custom-auth-token",
          "custom-token-value",
          "--internal-api-key",
          "internal-key-value",
          "--webhookSecrets",
          "non-sensitive-value",
          "--mode=safe",
          `https://example.test?secret=${exact}`,
        ],
        environment: {
          LINEAR_API_KEY: "environment-value",
          SAFE_MODE: "enabled",
          CALLBACK_URL: `https://user:${exact}@example.test/callback`,
        },
        workingDirectory: `/tmp/${exact}/project`,
      },
      redactor,
    );

    expect(command.arguments).toEqual([
      "--token",
      redactedValue,
      `--api_key=${redactedValue}`,
      `GITHUB_TOKEN=${redactedValue}`,
      `--access-token=${redactedValue}`,
      "--cookie",
      redactedValue,
      "--webhookSecret",
      redactedValue,
      "--webhook_secret",
      redactedValue,
      "--webhook-secret",
      redactedValue,
      "--APIKey",
      redactedValue,
      "--custom-auth-token",
      redactedValue,
      "--internal-api-key",
      redactedValue,
      "--webhookSecrets",
      "non-sensitive-value",
      "--mode=safe",
      `https://example.test?secret=${redactedValue}`,
    ]);
    expect(command.environment).toEqual({
      LINEAR_API_KEY: redactedValue,
      SAFE_MODE: "enabled",
      CALLBACK_URL: `https://${redactedValue}@example.test/callback`,
    });
    expect(command.workingDirectory).toBe(`/tmp/${redactedValue}/project`);

    const stdout = redactor.redactText(
      `result=${exact}\nAuthorization: Basic basic-value\ntoken=stdout-value`,
    );
    const stderr = redactor.redactText(
      `failed url=https://user:${exact}@example.test password: stderr-value`,
    );
    expect(stdout).not.toContain(exact);
    expect(stdout).not.toContain("basic-value");
    expect(stdout).not.toContain("stdout-value");
    expect(stderr).not.toContain(exact);
    expect(stderr).not.toContain("stderr-value");
  });
});
