/**
 * C015b unit tests: `loadHostDispatchProviderConfig` (src/cli/dispatch/provider-config-store.ts)
 * -- the fail-closed envelope around `dispatchProviderConfigSchema`. Mirrors the coverage style
 * already established for the sibling routing-config loader's schema (dispatch-composition.test.ts's
 * `routing_config_unavailable` cases): missing file, malformed JSON, extra/strict-violating keys,
 * and the happy path.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  defaultDispatchProviderConfigPath,
  loadHostDispatchProviderConfig,
} from "../../src/cli/dispatch/provider-config-store.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-provider-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

const validConfig = {
  schemaVersion: 1,
  codex: { executable: "codex", models: ["gpt-5.6-terra"], account: "default" },
  claude: { executable: "claude", models: ["opus", "sonnet"], account: "default" },
};

describe("loadHostDispatchProviderConfig", () => {
  it("fails closed with missing_or_invalid when the file does not exist", async () => {
    const agentTeamHome = await temporaryHome();
    const result = await loadHostDispatchProviderConfig(
      defaultDispatchProviderConfigPath(agentTeamHome),
    );
    expect(result).toEqual({ ok: false, reason: "missing_or_invalid" });
  });

  it("fails closed on a relative path rather than resolving against cwd", async () => {
    const result = await loadHostDispatchProviderConfig("config/dispatch/providers.json");
    expect(result).toEqual({ ok: false, reason: "missing_or_invalid" });
  });

  it("fails closed on malformed JSON", async () => {
    const agentTeamHome = await temporaryHome();
    const filePath = defaultDispatchProviderConfigPath(agentTeamHome);
    await mkdir(join(agentTeamHome, "config", "dispatch"), { recursive: true });
    await writeFile(filePath, "{ not valid json", "utf8");
    const result = await loadHostDispatchProviderConfig(filePath);
    expect(result).toEqual({ ok: false, reason: "missing_or_invalid" });
  });

  it("fails closed on an empty file", async () => {
    const agentTeamHome = await temporaryHome();
    const filePath = defaultDispatchProviderConfigPath(agentTeamHome);
    await mkdir(join(agentTeamHome, "config", "dispatch"), { recursive: true });
    await writeFile(filePath, "", "utf8");
    const result = await loadHostDispatchProviderConfig(filePath);
    expect(result).toEqual({ ok: false, reason: "missing_or_invalid" });
  });

  it("fails closed on a schema-strict violation (unknown top-level key)", async () => {
    const agentTeamHome = await temporaryHome();
    const filePath = defaultDispatchProviderConfigPath(agentTeamHome);
    await mkdir(join(agentTeamHome, "config", "dispatch"), { recursive: true });
    await writeFile(filePath, JSON.stringify({ ...validConfig, extra: "nope" }), "utf8");
    const result = await loadHostDispatchProviderConfig(filePath);
    expect(result).toEqual({ ok: false, reason: "missing_or_invalid" });
  });

  it("fails closed when claude.models is empty", async () => {
    const agentTeamHome = await temporaryHome();
    const filePath = defaultDispatchProviderConfigPath(agentTeamHome);
    await mkdir(join(agentTeamHome, "config", "dispatch"), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({ ...validConfig, claude: { ...validConfig.claude, models: [] } }),
      "utf8",
    );
    const result = await loadHostDispatchProviderConfig(filePath);
    expect(result).toEqual({ ok: false, reason: "missing_or_invalid" });
  });

  it("fails closed when required Codex config is absent", async () => {
    const agentTeamHome = await temporaryHome();
    const filePath = defaultDispatchProviderConfigPath(agentTeamHome);
    await mkdir(join(agentTeamHome, "config", "dispatch"), { recursive: true });
    const { codex: _codex, ...withoutCodex } = validConfig;
    void _codex;
    await writeFile(filePath, JSON.stringify(withoutCodex), "utf8");
    await expect(loadHostDispatchProviderConfig(filePath)).resolves.toEqual({
      ok: false,
      reason: "missing_or_invalid",
    });
  });

  it("loads a schema-valid config", async () => {
    const agentTeamHome = await temporaryHome();
    const filePath = defaultDispatchProviderConfigPath(agentTeamHome);
    await mkdir(join(agentTeamHome, "config", "dispatch"), { recursive: true });
    await writeFile(filePath, JSON.stringify(validConfig), "utf8");
    const result = await loadHostDispatchProviderConfig(filePath);
    expect(result).toEqual({ ok: true, value: validConfig });
  });
});
