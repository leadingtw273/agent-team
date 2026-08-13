import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createClaudeQuotaRefresher } from "../../src/adapters/providers/claude/index.js";
import type {
  PortResult,
  ProcessExit,
  ProcessPort,
  ProcessSpawnRequest,
} from "../../src/application/ports/index.js";
import {
  createFixedClock,
  ok,
  parseInstant,
  type Instant,
} from "../../src/domain/foundation/index.js";

const parsedNow = parseInstant("2026-08-13T08:30:00.000Z");
if (!parsedNow.ok) throw new Error(parsedNow.error.code);
const now = parsedNow.value;
const roots: string[] = [];

async function writeSnapshot(path: string, observedAt: Instant = now): Promise<void> {
  const seconds = Math.floor(Date.parse(observedAt) / 1_000);
  await writeFile(
    path,
    JSON.stringify({
      schema: 1,
      probe_ts: seconds,
      session_id: "ignored-session",
      rate_limits: {
        five_hour: { used_percentage: 12, resets_at: seconds + 3_600 },
        seven_day: { used_percentage: 18, resets_at: seconds + 86_400 },
      },
    }),
    { mode: 0o600 },
  );
  await utimes(path, seconds, seconds);
}

function processThat(
  onSpawn: (request: ProcessSpawnRequest) => Promise<void>,
  outcome: Readonly<{ exitCode?: number; outputTruncated?: boolean }> = {},
): ProcessPort & { requests: ProcessSpawnRequest[]; stdin: Uint8Array[] } {
  const requests: ProcessSpawnRequest[] = [];
  const stdin: Uint8Array[] = [];
  return {
    requests,
    stdin,
    async spawn(request) {
      requests.push(request);
      await onSpawn(request);
      let complete: ((value: PortResult<ProcessExit>) => void) | undefined;
      const completion = new Promise<PortResult<ProcessExit>>((resolve) => {
        complete = resolve;
      });
      const finish = () => {
        complete?.(
          ok({
            exitCode: outcome.exitCode ?? 0,
            signal: null,
            startedAt: now,
            exitedAt: now,
            outputTruncated: outcome.outputTruncated ?? false,
          }),
        );
      };
      return ok({
        pid: 321,
        output: (async function* () {
          await Promise.resolve();
        })(),
        writeStdin(bytes) {
          stdin.push(bytes);
          finish();
          return Promise.resolve(ok(undefined));
        },
        closeStdin: () => Promise.resolve(ok(undefined)),
        sendSignal: () => {
          finish();
          return Promise.resolve(ok(undefined));
        },
        wait: () => completion,
      });
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Claude active quota refresher", () => {
  it("runs one fixed no-tool PTY turn and exits only after a newer strict snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "quota-refresh-"));
    roots.push(root);
    const path = join(root, "latest.json");
    const process = processThat(() => writeSnapshot(path));
    const refresher = createClaudeQuotaRefresher({
      process,
      claudeExecutable: "claude'; printf unsafe; '",
      workingDirectory: "/controlled/agent-team",
      clock: createFixedClock(now),
      sleep: () => Promise.resolve(),
    });

    await expect(
      refresher.refresh({
        statusSnapshotPath: path,
        expectedCliVersion: "2.1.231",
        maxSampleAgeMs: 300_000,
      }),
    ).resolves.toEqual({ state: "refreshed", reason: "snapshot_refreshed" });

    expect(process.requests).toHaveLength(1);
    expect(process.requests[0]).toMatchObject({
      executable: "/usr/bin/script",
      arguments: ["--quiet", "--return", "--flush", "--command", expect.any(String), "/dev/null"],
      workingDirectory: "/controlled/agent-team",
      keepStdinOpen: true,
    });
    const command = process.requests[0]?.arguments[4] ?? "";
    expect(command).toContain("'--model' 'haiku'");
    expect(command).toContain("'--tools' ''");
    expect(command).toContain("'--permission-mode' 'dontAsk'");
    expect(command).toContain("'claude'\\''; printf unsafe; '\\'''");
    expect(process.stdin).toEqual([Uint8Array.from([0x04, 0x04])]);
  });

  it("fails closed when the PTY exits nonzero after writing the snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "quota-refresh-"));
    roots.push(root);
    const path = join(root, "latest.json");
    const process = processThat(() => writeSnapshot(path), { exitCode: 1 });
    const refresher = createClaudeQuotaRefresher({
      process,
      workingDirectory: "/controlled/agent-team",
      clock: createFixedClock(now),
      sleep: () => Promise.resolve(),
    });
    await expect(
      refresher.refresh({
        statusSnapshotPath: path,
        expectedCliVersion: "2.1.231",
        maxSampleAgeMs: 300_000,
      }),
    ).resolves.toEqual({ state: "failed", reason: "process_failed" });
  });

  it("fails closed when the bounded PTY output is truncated", async () => {
    const root = await mkdtemp(join(tmpdir(), "quota-refresh-"));
    roots.push(root);
    const path = join(root, "latest.json");
    const process = processThat(() => writeSnapshot(path), { outputTruncated: true });
    const refresher = createClaudeQuotaRefresher({
      process,
      workingDirectory: "/controlled/agent-team",
      clock: createFixedClock(now),
      sleep: () => Promise.resolve(),
    });
    await expect(
      refresher.refresh({
        statusSnapshotPath: path,
        expectedCliVersion: "2.1.231",
        maxSampleAgeMs: 300_000,
      }),
    ).resolves.toEqual({ state: "failed", reason: "process_failed" });
  });
});
