import { chmod, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  ProcessOutputChunk,
  ProcessPort,
  ProcessSpawnRequest,
} from "../../src/application/ports/index.js";
import { createClaudeQuotaCollector } from "../../src/adapters/providers/claude/index.js";
import { createFixedClock, ok, parseInstant } from "../../src/domain/foundation/index.js";

const parsedNow = parseInstant("2026-08-13T06:13:30.000Z");
if (!parsedNow.ok) throw new Error(parsedNow.error.code);
const now = parsedNow.value;
const clock = createFixedClock(now);
const probeSeconds = Math.floor(Date.parse(now) / 1_000) - 30;
const resetsFiveHour = probeSeconds + 3_600;
const resetsWeekly = probeSeconds + 86_400;
const directories: string[] = [];

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function scriptedProcess(
  outputs: readonly string[],
): ProcessPort & { requests: ProcessSpawnRequest[] } {
  const requests: ProcessSpawnRequest[] = [];
  let index = 0;
  return {
    requests,
    spawn(request) {
      requests.push(request);
      const output = outputs[index++];
      if (output === undefined) throw new Error("unexpected process request");
      const chunks: readonly ProcessOutputChunk[] = [
        { sequence: 0, stream: "stdout", bytes: bytes(output), observedAt: now },
      ];
      return Promise.resolve(
        ok({
          pid: 42,
          output: (async function* () {
            await Promise.resolve();
            yield* chunks;
          })(),
          writeStdin: () => Promise.resolve(ok(undefined)),
          closeStdin: () => Promise.resolve(ok(undefined)),
          sendSignal: () => Promise.resolve(ok(undefined)),
          wait: () =>
            Promise.resolve(
              ok({
                exitCode: 0,
                signal: null,
                startedAt: now,
                exitedAt: now,
                outputTruncated: false,
              }),
            ),
        }),
      );
    },
  };
}

function auth(orgId = "provider-org-1"): string {
  return JSON.stringify({
    loggedIn: true,
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    email: "private@example.invalid",
    orgId,
    orgName: "private-name",
    subscriptionType: "team",
  });
}

async function snapshot(extra: Readonly<Record<string, unknown>> = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "quota-claude-"));
  directories.push(directory);
  const path = join(directory, "latest.json");
  await writeFile(
    path,
    JSON.stringify({
      schema: 1,
      probe_ts: probeSeconds,
      session_id: "private-session",
      rate_limits: {
        five_hour: { used_percentage: 6, resets_at: resetsFiveHour },
        seven_day: { used_percentage: 20, resets_at: resetsWeekly },
      },
      ...extra,
    }),
    { mode: 0o600 },
  );
  await utimes(path, probeSeconds, probeSeconds);
  return path;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Claude quota collector", () => {
  it("collects both buckets inside one stable auth/version epoch without a model turn", async () => {
    const process = scriptedProcess([
      auth(),
      "2.1.229 (Claude Code)\n",
      "2.1.229 (Claude Code)\n",
      auth(),
    ]);
    const collector = createClaudeQuotaCollector({ process, workingDirectory: "/tmp", clock });

    const result = await collector.collect({
      statusSnapshotPath: await snapshot(),
      expectedCliVersion: "2.1.229",
      maxSampleAgeMs: 300_000,
    });

    expect(result).toMatchObject({
      provider: "claude",
      state: "full",
      cliVersion: "2.1.229",
      provenance: "claude_status_line_v1",
      buckets: {
        weekly: { remainingPercent: 80 },
        fiveHour: { remainingPercent: 94 },
      },
    });
    expect(process.requests.map((request) => request.arguments)).toEqual([
      ["auth", "status", "--json"],
      ["--version"],
      ["--version"],
      ["auth", "status", "--json"],
    ]);
    expect(process.requests.every((request) => request.stdin === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-session");
    expect(JSON.stringify(result)).not.toContain("private@example.invalid");
    expect(JSON.stringify(result)).not.toContain("provider-org-1");
  });

  it("fails closed when the provider-owned identity changes across the epoch", async () => {
    const process = scriptedProcess([auth("before"), "2.1.229\n", "2.1.229\n", auth("after")]);
    const collector = createClaudeQuotaCollector({ process, workingDirectory: "/tmp", clock });

    await expect(
      collector.collect({
        statusSnapshotPath: await snapshot(),
        expectedCliVersion: "2.1.229",
        maxSampleAgeMs: 300_000,
      }),
    ).resolves.toEqual({ provider: "claude", state: "unknown", reason: "runtime_context_changed" });
  });

  it("rejects stale, extra-field, and insecure-mode snapshots", async () => {
    const stalePath = await snapshot();
    const extraPath = await snapshot({ unexpected: true });
    const insecurePath = await snapshot();
    await chmod(insecurePath, 0o644);
    for (const [path, maxSampleAgeMs, reason] of [
      [stalePath, 1, "snapshot_stale"],
      [extraPath, 300_000, "snapshot_unavailable"],
      [insecurePath, 300_000, "snapshot_unavailable"],
    ] as const) {
      const process = scriptedProcess([auth(), "2.1.229\n"]);
      const collector = createClaudeQuotaCollector({ process, workingDirectory: "/tmp", clock });
      await expect(
        collector.collect({
          statusSnapshotPath: path,
          expectedCliVersion: "2.1.229",
          maxSampleAgeMs,
        }),
      ).resolves.toEqual({ provider: "claude", state: "unknown", reason });
    }
  });

  it("rejects a CLI version outside the private config", async () => {
    const collector = createClaudeQuotaCollector({
      process: scriptedProcess([auth(), "2.1.230\n"]),
      workingDirectory: "/tmp",
      clock,
    });
    await expect(
      collector.collect({
        statusSnapshotPath: await snapshot(),
        expectedCliVersion: "2.1.229",
        maxSampleAgeMs: 300_000,
      }),
    ).resolves.toEqual({ provider: "claude", state: "unknown", reason: "version_unavailable" });
  });

  it("rejects duplicate JSON keys before schema validation can overwrite them", async () => {
    const path = await snapshot();
    const original = await readFile(path, "utf8");
    const duplicate = original.replace('{"schema":1,', '{"schema":1,"schema":1,');
    await writeFile(path, duplicate, { mode: 0o600 });
    await utimes(path, probeSeconds, probeSeconds);
    const collector = createClaudeQuotaCollector({
      process: scriptedProcess([auth(), "2.1.229\n"]),
      workingDirectory: "/tmp",
      clock,
    });
    await expect(
      collector.collect({
        statusSnapshotPath: path,
        expectedCliVersion: "2.1.229",
        maxSampleAgeMs: 300_000,
      }),
    ).resolves.toEqual({ provider: "claude", state: "unknown", reason: "snapshot_unavailable" });
  });
});
