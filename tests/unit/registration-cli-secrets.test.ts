/**
 * O009 decision #5: probe webhook secrets come from
 * `${AGENT_TEAM_HOME}/secrets/{github,linear}-webhook-secret`, and must be rejected unless the
 * file is exactly 0600 -- mirroring the same secure-read pattern the existing local webhook
 * ingest handler already uses (src/cli/ingest/github.ts's readSecret/readNoFollow), duplicated
 * here rather than importing from that P0 security module so this task never has to touch it.
 */
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  defaultLinearApiKeyPath,
  readLinearApiKey,
  readLinearApiKeyWithFileFallback,
  readSecretFile,
} from "../../src/cli/registration/secrets.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "agent-team-o009-secrets-"));
  roots.push(value);
  return value;
}

describe("readSecretFile", () => {
  it("reads a strictly 0600 secret file and strips a trailing newline", async () => {
    const directory = await root();
    const filePath = join(directory, "github-webhook-secret");
    await writeFile(filePath, "super-secret-value\n", { mode: 0o600 });
    await chmod(filePath, 0o600);

    const result = await readSecretFile(filePath);

    expect(result.ok).toBe(true);
    expect(result.ok && Buffer.from(result.value).toString("utf8")).toBe("super-secret-value");
  });

  it("rejects a secret file that is not exactly 0600", async () => {
    const directory = await root();
    const filePath = join(directory, "github-webhook-secret");
    await writeFile(filePath, "value", { mode: 0o644 });
    await chmod(filePath, 0o644);

    const result = await readSecretFile(filePath);

    expect(result).toEqual({ ok: false, reason: "missing_or_insecure" });
  });

  it("reports a missing secret file the same way as an insecure one (no oracle)", async () => {
    const directory = await root();
    const result = await readSecretFile(join(directory, "does-not-exist"));

    expect(result).toEqual({ ok: false, reason: "missing_or_insecure" });
  });

  it("refuses a symlinked secret path", async () => {
    const directory = await root();
    const real = join(directory, "real-secret");
    await writeFile(real, "value", { mode: 0o600 });
    await chmod(real, 0o600);
    const link = join(directory, "linked-secret");
    await symlink(real, link);

    const result = await readSecretFile(link);

    expect(result).toEqual({ ok: false, reason: "missing_or_insecure" });
  });

  it("rejects a non-absolute path outright", async () => {
    const result = await readSecretFile("relative/secret");
    expect(result).toEqual({ ok: false, reason: "missing_or_insecure" });
  });

  it("rejects an empty secret file", async () => {
    const directory = await root();
    const filePath = join(directory, "empty-secret");
    await writeFile(filePath, "", { mode: 0o600 });
    await chmod(filePath, 0o600);

    const result = await readSecretFile(filePath);

    expect(result).toEqual({ ok: false, reason: "missing_or_insecure" });
  });

  it("rejects a directory passed as the secret path", async () => {
    const directory = await root();
    const sub = join(directory, "a-directory");
    await mkdir(sub);

    const result = await readSecretFile(sub);

    expect(result).toEqual({ ok: false, reason: "missing_or_insecure" });
  });
});

describe("readLinearApiKey", () => {
  it("returns the trimmed value when LINEAR_API_KEY is set", () => {
    expect(readLinearApiKey({ LINEAR_API_KEY: "  linear-key-123  " })).toEqual({
      ok: true,
      value: "linear-key-123",
    });
  });

  it("fails closed when LINEAR_API_KEY is missing", () => {
    expect(readLinearApiKey({})).toEqual({ ok: false, reason: "missing" });
  });

  it("fails closed when LINEAR_API_KEY is blank", () => {
    expect(readLinearApiKey({ LINEAR_API_KEY: "   " })).toEqual({ ok: false, reason: "missing" });
  });
});

describe("readLinearApiKeyWithFileFallback", () => {
  it("prefers the explicit environment and otherwise reads the private host file", async () => {
    const agentTeamHome = await root();
    const filePath = defaultLinearApiKeyPath(agentTeamHome);
    await mkdir(join(agentTeamHome, "secrets"), { recursive: true, mode: 0o700 });
    await writeFile(filePath, "file-key\n", { mode: 0o600 });
    await chmod(filePath, 0o600);

    await expect(
      readLinearApiKeyWithFileFallback(agentTeamHome, { LINEAR_API_KEY: "env-key" }),
    ).resolves.toEqual({ ok: true, value: "env-key" });
    await expect(readLinearApiKeyWithFileFallback(agentTeamHome, {})).resolves.toEqual({
      ok: true,
      value: "file-key",
    });
  });

  it("fails closed for a missing or insecure host file", async () => {
    const agentTeamHome = await root();
    await mkdir(join(agentTeamHome, "secrets"), { recursive: true, mode: 0o700 });
    const filePath = defaultLinearApiKeyPath(agentTeamHome);
    await writeFile(filePath, "must-not-leak", { mode: 0o644 });
    await chmod(filePath, 0o644);

    const result = await readLinearApiKeyWithFileFallback(agentTeamHome, {});

    expect(result).toEqual({ ok: false, reason: "missing" });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  it("fails closed for invalid UTF-8 or a symlinked host file", async () => {
    const agentTeamHome = await root();
    const secretsDirectory = join(agentTeamHome, "secrets");
    await mkdir(secretsDirectory, { recursive: true, mode: 0o700 });
    const filePath = defaultLinearApiKeyPath(agentTeamHome);
    await writeFile(filePath, Buffer.from([0xff, 0xfe]), { mode: 0o600 });
    await chmod(filePath, 0o600);

    await expect(readLinearApiKeyWithFileFallback(agentTeamHome, {})).resolves.toEqual({
      ok: false,
      reason: "missing",
    });

    await rm(filePath);
    const real = join(secretsDirectory, "real-linear-api-key");
    await writeFile(real, "must-not-follow", { mode: 0o600 });
    await chmod(real, 0o600);
    await symlink(real, filePath);

    await expect(readLinearApiKeyWithFileFallback(agentTeamHome, {})).resolves.toEqual({
      ok: false,
      reason: "missing",
    });
  });
});
