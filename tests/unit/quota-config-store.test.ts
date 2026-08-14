import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readQuotaHostConfig } from "../../src/cli/quota/index.js";

const directories: string[] = [];

function value() {
  return {
    schemaVersion: 1,
    claude: {
      enabled: true,
      statusSnapshotPath: "/operator/quota/latest.json",
      expectedCliVersion: "2.1.229",
      weeklyUsageLimitPercent: 80,
      terminalRemainingPercent: 3,
      maxSampleAgeMs: 300_000,
    },
    codex: {
      enabled: true,
      diagnosticEnabled: true,
      expectedCliVersion: "0.147.0",
      weeklyUsageLimitPercent: 80,
      terminalRemainingPercent: 3,
      maxSampleAgeMs: 300_000,
    },
  };
}

async function fixture(input: unknown = value()): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "quota-config-"));
  directories.push(directory);
  const path = join(directory, "quota.json");
  await writeFile(path, JSON.stringify(input), { mode: 0o600 });
  return path;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("quota host config", () => {
  it("reads the strict owner-only v1 schema", async () => {
    await expect(readQuotaHostConfig(await fixture())).resolves.toEqual({
      ok: true,
      value: value(),
    });
  });

  it("rejects unknown fields, non-canonical paths, wrong mode, and symlinks", async () => {
    const extra = await fixture({ ...value(), unexpected: true });
    const noncanonicalValue = value();
    noncanonicalValue.claude.statusSnapshotPath = "/operator/a/../latest.json";
    const noncanonical = await fixture(noncanonicalValue);
    const insecure = await fixture();
    await chmod(insecure, 0o644);
    const target = await fixture();
    const link = join(target, "..", "quota-link.json");
    await symlink(target, link);
    for (const path of [extra, noncanonical, insecure, link]) {
      await expect(readQuotaHostConfig(path)).resolves.toEqual({
        ok: false,
        reason: "config_unavailable",
      });
    }
  });

  it("rejects the retired Claude active refresh field with a migration-specific reason", async () => {
    const legacy = value() as ReturnType<typeof value> & {
      claude: ReturnType<typeof value>["claude"] & {
        activeRefresh: { enabled: boolean; workingDirectory: string };
      };
    };
    legacy.claude.activeRefresh = {
      enabled: true,
      workingDirectory: "/operator/agent-team",
    };
    await expect(readQuotaHostConfig(await fixture(legacy))).resolves.toEqual({
      ok: false,
      reason: "active_refresh_superseded",
    });
  });
});
