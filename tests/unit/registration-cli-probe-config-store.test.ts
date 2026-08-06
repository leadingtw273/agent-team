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

  // ---------------------------------------------------------------------------------------
  // O009f: optional poll override (see probe-composition.ts's own production poll defaults).
  // ---------------------------------------------------------------------------------------
  describe("O009f poll override", () => {
    it("loads and round-trips a well-formed partial poll override", async () => {
      const directory = await root();
      const filePath = join(directory, "probe.json");
      await writeFile(
        filePath,
        validConfigJson({
          poll: {
            ciPoll: { maxAttempts: 20, intervalMs: 10_000 },
            statusPoll: { maxAttempts: 5, intervalMs: 2_000 },
          },
        }),
        "utf8",
      );

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
          poll: {
            ciPoll: { maxAttempts: 20, intervalMs: 10_000 },
            statusPoll: { maxAttempts: 5, intervalMs: 2_000 },
          },
        },
      });
    });

    it("omits poll from the loaded value entirely when the file has none", async () => {
      const directory = await root();
      const filePath = join(directory, "probe.json");
      await writeFile(filePath, validConfigJson(), "utf8");

      const result = await loadHostRegistrationProbeConfig(filePath);

      expect(result.ok && "poll" in result.value).toBe(false);
    });

    it.each([
      ["maxAttempts below 1", { maxAttempts: 0, intervalMs: 1_000 }],
      ["maxAttempts above 200", { maxAttempts: 201, intervalMs: 1_000 }],
      ["maxAttempts not an integer", { maxAttempts: 1.5, intervalMs: 1_000 }],
      ["intervalMs negative", { maxAttempts: 3, intervalMs: -1 }],
      ["intervalMs above 60000", { maxAttempts: 3, intervalMs: 60_001 }],
      ["intervalMs not an integer", { maxAttempts: 3, intervalMs: 1_000.5 }],
    ])("rejects an out-of-range ciPoll override (%s)", async (_label, ciPoll) => {
      const directory = await root();
      const filePath = join(directory, "probe.json");
      await writeFile(filePath, validConfigJson({ poll: { ciPoll } }), "utf8");

      const result = await loadHostRegistrationProbeConfig(filePath);

      expect(result).toEqual({ ok: false, reason: "missing_or_invalid" });
    });

    it("rejects an unknown field inside a poll override entry (strict)", async () => {
      const directory = await root();
      const filePath = join(directory, "probe.json");
      await writeFile(
        filePath,
        validConfigJson({
          poll: { providerEventPoll: { maxAttempts: 3, intervalMs: 1_000, extra: "nope" } },
        }),
        "utf8",
      );

      const result = await loadHostRegistrationProbeConfig(filePath);

      expect(result).toEqual({ ok: false, reason: "missing_or_invalid" });
    });

    it("rejects an unknown top-level key inside poll itself (strict)", async () => {
      const directory = await root();
      const filePath = join(directory, "probe.json");
      await writeFile(
        filePath,
        validConfigJson({ poll: { unknownPoll: { maxAttempts: 3, intervalMs: 1_000 } } }),
        "utf8",
      );

      const result = await loadHostRegistrationProbeConfig(filePath);

      expect(result).toEqual({ ok: false, reason: "missing_or_invalid" });
    });

    it("accepts the boundary values (maxAttempts 1 and 200, intervalMs 0 and 60000)", async () => {
      const directory = await root();
      const filePath = join(directory, "probe.json");
      await writeFile(
        filePath,
        validConfigJson({
          poll: {
            ciPoll: { maxAttempts: 1, intervalMs: 0 },
            statusPoll: { maxAttempts: 200, intervalMs: 60_000 },
          },
        }),
        "utf8",
      );

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
          poll: {
            ciPoll: { maxAttempts: 1, intervalMs: 0 },
            statusPoll: { maxAttempts: 200, intervalMs: 60_000 },
          },
        },
      });
    });
  });
});
