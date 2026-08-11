/**
 * C015b unit tests: `observeClaudeRouteCandidates` (src/cli/dispatch/claude-observation.ts) --
 * the minimal real routeObservations source. Uses a fake `ProcessPort` (no real process is ever
 * spawned in a test) to prove: (a) a zero-exit-code probe yields `state:"ready"` for every
 * configured model; (b) a spawn failure, a non-zero exit, and a killed-by-signal exit all yield
 * `state:"provider_unavailable"`, never `"ready"`; (c) it never reports `quota_unknown`/
 * `quota_blocked`/`provider_slot_full` -- this function has no quota signal to report at all
 * (see the module's own header for why that is a disclosed scope decision, not a bug).
 */
import { describe, expect, it } from "vitest";

import {
  observeClaudeCliVersion,
  observeClaudeRouteCandidates,
} from "../../src/cli/dispatch/claude-observation.js";
import type {
  ProcessOutputChunk,
  ProcessPort,
  ProcessSpawnRequest,
} from "../../src/application/ports/index.js";
import {
  createFixedClock,
  ok,
  err,
  domainError,
  parseInstant,
} from "../../src/domain/foundation/index.js";

const parsedNow = parseInstant("2026-08-07T12:00:00.000Z");
if (!parsedNow.ok) throw new Error(parsedNow.error.code);
const now = parsedNow.value;
const clock = createFixedClock(now);

const config = { executable: "claude", models: ["opus", "sonnet"], account: "default" };

function fakeProcess(
  outcome:
    | Readonly<{ kind: "spawn_failed" }>
    | Readonly<{ kind: "exit"; exitCode: number | null; signal: null | "SIGKILL" }>,
): ProcessPort & { readonly requests: ProcessSpawnRequest[] } {
  const requests: ProcessSpawnRequest[] = [];
  return {
    requests,
    spawn(request) {
      requests.push(request);
      if (outcome.kind === "spawn_failed") {
        return Promise.resolve(err(domainError("unavailable")));
      }
      return Promise.resolve(
        ok({
          pid: 4242,
          output: (async function* () {
            // The capability probe never reads any output -- this stub deliberately yields
            // nothing.
            await Promise.resolve();
          })(),
          writeStdin: () => Promise.resolve(ok(undefined)),
          closeStdin: () => Promise.resolve(ok(undefined)),
          sendSignal: () => Promise.resolve(ok(undefined)),
          wait: () =>
            Promise.resolve(
              ok({
                exitCode: outcome.exitCode,
                signal: outcome.signal,
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

function versionProcess(
  input: Readonly<{
    readonly output?: readonly Readonly<{ stream: "stdout" | "stderr"; bytes: Uint8Array }>[];
    readonly exitCode?: number | null;
    readonly signal?: null | "SIGKILL";
    readonly outputTruncated?: boolean;
  }>,
): ProcessPort & { readonly requests: ProcessSpawnRequest[] } {
  const requests: ProcessSpawnRequest[] = [];
  return {
    requests,
    spawn(request) {
      requests.push(request);
      const chunks: readonly ProcessOutputChunk[] = (input.output ?? []).map((chunk, index) => ({
        sequence: index,
        stream: chunk.stream,
        bytes: chunk.bytes,
        observedAt: now,
      }));
      return Promise.resolve(
        ok({
          pid: 4242,
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
                exitCode: input.exitCode ?? 0,
                signal: input.signal ?? null,
                startedAt: now,
                exitedAt: now,
                outputTruncated: input.outputTruncated === true,
              }),
            ),
        }),
      );
    },
  };
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe("observeClaudeRouteCandidates", () => {
  it("reports state:ready for every configured model when the probe exits zero", async () => {
    const process = fakeProcess({ kind: "exit", exitCode: 0, signal: null });
    const result = await observeClaudeRouteCandidates({
      process,
      config,
      workingDirectory: "/tmp",
      clock,
    });
    expect(result).toEqual([
      { provider: "claude", model: "opus", state: "ready" },
      { provider: "claude", model: "sonnet", state: "ready" },
    ]);
    expect(process.requests).toHaveLength(1);
    expect(process.requests[0]).toMatchObject({
      executable: "claude",
      arguments: ["--version"],
      workingDirectory: "/tmp",
    });
  });

  it("reports state:provider_unavailable for every model when spawn itself fails", async () => {
    const process = fakeProcess({ kind: "spawn_failed" });
    const result = await observeClaudeRouteCandidates({
      process,
      config,
      workingDirectory: "/tmp",
      clock,
    });
    expect(result).toEqual([
      { provider: "claude", model: "opus", state: "provider_unavailable" },
      { provider: "claude", model: "sonnet", state: "provider_unavailable" },
    ]);
  });

  it("reports state:provider_unavailable on a non-zero exit code", async () => {
    const process = fakeProcess({ kind: "exit", exitCode: 1, signal: null });
    const result = await observeClaudeRouteCandidates({
      process,
      config,
      workingDirectory: "/tmp",
      clock,
    });
    expect(result.every((observation) => observation.state === "provider_unavailable")).toBe(true);
  });

  it("reports state:provider_unavailable when the probe is killed by signal (null exit code)", async () => {
    const process = fakeProcess({ kind: "exit", exitCode: null, signal: "SIGKILL" });
    const result = await observeClaudeRouteCandidates({
      process,
      config,
      workingDirectory: "/tmp",
      clock,
    });
    expect(result.every((observation) => observation.state === "provider_unavailable")).toBe(true);
  });

  it("never reports a quota-related state -- this function has no quota signal to report", async () => {
    const process = fakeProcess({ kind: "exit", exitCode: 0, signal: null });
    const result = await observeClaudeRouteCandidates({
      process,
      config,
      workingDirectory: "/tmp",
      clock,
    });
    const states = new Set(result.map((observation) => observation.state));
    expect(states.has("quota_unknown")).toBe(false);
    expect(states.has("quota_blocked")).toBe(false);
    expect(states.has("provider_slot_full")).toBe(false);
  });
});

describe("observeClaudeCliVersion", () => {
  it("returns exactly one normalized stdout line and never uses provider account metadata", async () => {
    const process = versionProcess({
      output: [{ stream: "stdout", bytes: bytes("claude 2.1.0\r\n") }],
    });

    await expect(
      observeClaudeCliVersion({ process, config, workingDirectory: "/tmp", clock }),
    ).resolves.toBe("claude 2.1.0");
    expect(process.requests).toEqual([
      expect.objectContaining({
        executable: "claude",
        arguments: ["--version"],
        workingDirectory: "/tmp",
        maxOutputBytes: 4096,
      }),
    ]);
  });

  it.each([
    ["empty stdout", {}],
    ["multiple lines", { output: [{ stream: "stdout", bytes: bytes("claude 1\nextra\n") }] }],
    ["stderr", { output: [{ stream: "stderr", bytes: bytes("warning") }] }],
    [
      "signal",
      { output: [{ stream: "stdout", bytes: bytes("claude 1\n") }], signal: "SIGKILL" as const },
    ],
    ["non-zero", { output: [{ stream: "stdout", bytes: bytes("claude 1\n") }], exitCode: 1 }],
    [
      "truncation",
      { output: [{ stream: "stdout", bytes: bytes("claude 1\n") }], outputTruncated: true },
    ],
    ["invalid UTF-8", { output: [{ stream: "stdout", bytes: Uint8Array.of(0xff) }] }],
    ["control byte", { output: [{ stream: "stdout", bytes: bytes("claude\u0000 1\n") }] }],
    ["leading whitespace", { output: [{ stream: "stdout", bytes: bytes(" claude 1\n") }] }],
  ])("fails closed on %s", async (_name, input) => {
    const process = versionProcess(input as Parameters<typeof versionProcess>[0]);
    await expect(
      observeClaudeCliVersion({ process, config, workingDirectory: "/tmp", clock }),
    ).resolves.toBeUndefined();
  });
});
