import { describe, expect, it } from "vitest";

import type { ProcessPort, ProcessSpawnRequest } from "../../src/application/ports/index.js";
import { observeCodexRouteCandidates } from "../../src/cli/dispatch/codex-observation.js";
import {
  createFixedClock,
  domainError,
  err,
  ok,
  parseInstant,
} from "../../src/domain/foundation/index.js";

const parsedNow = parseInstant("2026-08-14T12:00:00.000Z");
if (!parsedNow.ok) throw new Error(parsedNow.error.code);
const now = parsedNow.value;
const clock = createFixedClock(now);
const config = {
  executable: "codex",
  models: ["gpt-5.6-sol", "gpt-5.6-terra"],
  account: "default",
};

function fakeProcess(
  outcome:
    | Readonly<{ kind: "spawn_failed" }>
    | Readonly<{
        kind: "exit";
        exitCode: number | null;
        signal: null | "SIGKILL";
        outputTruncated?: boolean;
      }>,
): ProcessPort & { readonly requests: ProcessSpawnRequest[] } {
  const requests: ProcessSpawnRequest[] = [];
  return {
    requests,
    spawn(request) {
      requests.push(request);
      if (outcome.kind === "spawn_failed") return Promise.resolve(err(domainError("unavailable")));
      return Promise.resolve(
        ok({
          pid: 1,
          output: (async function* () {
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
                outputTruncated: outcome.outputTruncated === true,
              }),
            ),
        }),
      );
    },
  };
}

describe("observeCodexRouteCandidates", () => {
  it("marks every configured Codex model ready after one bounded zero-exit version probe", async () => {
    const process = fakeProcess({ kind: "exit", exitCode: 0, signal: null });
    await expect(
      observeCodexRouteCandidates({ process, config, workingDirectory: "/tmp", clock }),
    ).resolves.toEqual([
      { provider: "codex", model: "gpt-5.6-sol", state: "ready" },
      { provider: "codex", model: "gpt-5.6-terra", state: "ready" },
    ]);
    expect(process.requests).toEqual([
      expect.objectContaining({
        executable: "codex",
        arguments: ["--version"],
        workingDirectory: "/tmp",
        maxOutputBytes: 4096,
      }),
    ]);
  });

  it.each([
    ["spawn failure", fakeProcess({ kind: "spawn_failed" })],
    ["non-zero exit", fakeProcess({ kind: "exit", exitCode: 1, signal: null })],
    ["signal", fakeProcess({ kind: "exit", exitCode: null, signal: "SIGKILL" })],
    [
      "truncated output",
      fakeProcess({ kind: "exit", exitCode: 0, signal: null, outputTruncated: true }),
    ],
  ])("fails every candidate closed on %s", async (_name, process) => {
    const observations = await observeCodexRouteCandidates({
      process,
      config,
      workingDirectory: "/tmp",
      clock,
    });
    expect(observations.every(({ state }) => state === "provider_unavailable")).toBe(true);
  });
});
