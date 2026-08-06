/**
 * O009 decision #5: probe's webhook base URLs (secrets are handled separately by
 * readSecretFile) come from a host-local config file. There is no existing filename pinned down
 * by the packet for this (only the two secret files are pinned exactly) -- this module defines
 * `${AGENT_TEAM_HOME}/config/registration/<projectId>.probe.json` as that host file, validated
 * strictly, extra fields rejected, matching the same pattern the draft-store loader already uses.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  defaultRegistrationProbeConfigPath,
  loadHostRegistrationProbeConfig,
} from "../../src/cli/registration/probe-config-store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "agent-team-o009-probe-config-"));
  roots.push(value);
  return value;
}

function validConfigJson(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    linearWorkflowStateId: "state-backlog-1",
    gitRemote: "origin",
    webhookBaseUrls: {
      github: "https://runtime.example.test",
      linear: "https://runtime.example.test",
    },
    ...overrides,
  });
}

describe("defaultRegistrationProbeConfigPath", () => {
  it("resolves under ${AGENT_TEAM_HOME}/config/registration/<projectId>.probe.json", () => {
    expect(defaultRegistrationProbeConfigPath("/home/user/.agent-team", "proj-1")).toBe(
      "/home/user/.agent-team/config/registration/proj-1.probe.json",
    );
  });
});

describe("loadHostRegistrationProbeConfig", () => {
  it("loads and validates a well-formed probe config file", async () => {
    const directory = await root();
    const filePath = join(directory, "probe.json");
    await writeFile(filePath, validConfigJson(), "utf8");

    const result = await loadHostRegistrationProbeConfig(filePath);

    expect(result).toEqual({
      ok: true,
      value: {
        linearWorkflowStateId: "state-backlog-1",
        gitRemote: "origin",
        webhookBaseUrls: {
          github: "https://runtime.example.test",
          linear: "https://runtime.example.test",
        },
      },
    });
  });

  it("rejects a missing probe config file", async () => {
    const directory = await root();
    const result = await loadHostRegistrationProbeConfig(join(directory, "missing.json"));
    expect(result).toEqual({ ok: false, reason: "missing_or_invalid" });
  });

  it("rejects an extra top-level field", async () => {
    const directory = await root();
    const filePath = join(directory, "probe.json");
    await writeFile(filePath, validConfigJson({ unexpectedField: "leaked" }), "utf8");

    const result = await loadHostRegistrationProbeConfig(filePath);

    expect(result).toEqual({ ok: false, reason: "missing_or_invalid" });
  });

  it("rejects malformed JSON", async () => {
    const directory = await root();
    const filePath = join(directory, "probe.json");
    await writeFile(filePath, "not json", "utf8");

    const result = await loadHostRegistrationProbeConfig(filePath);

    expect(result).toEqual({ ok: false, reason: "missing_or_invalid" });
  });
});
