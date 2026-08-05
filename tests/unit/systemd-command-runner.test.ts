import { describe, expect, it } from "vitest";

import {
  buildRuntimeEnvironment,
  createBoundedCommandRunner,
  type CommandRunRequest,
} from "../../src/cli/systemd/index.js";

function request(arguments_: readonly string[]): CommandRunRequest {
  return {
    executable: process.execPath,
    arguments: arguments_,
    environment: buildRuntimeEnvironment({
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: process.cwd(),
      XDG_CONFIG_HOME: process.cwd(),
    }),
  };
}

describe("bounded system command runner", () => {
  it("rejects caller-supplied limits that would defeat the hard resource bounds", () => {
    expect(() => createBoundedCommandRunner({ deadlineMs: 60_001 })).toThrow(
      "Invalid command runner limits.",
    );
    expect(() => createBoundedCommandRunner({ maxOutputBytes: 1_048_577 })).toThrow(
      "Invalid command runner limits.",
    );
    expect(() => createBoundedCommandRunner({ terminateGraceMs: 5_001 })).toThrow(
      "Invalid command runner limits.",
    );
  });

  it("captures UTF-8-safe bounded stdout and stderr without exposing unbounded child output", async () => {
    const runner = createBoundedCommandRunner({ maxOutputBytes: 16, deadlineMs: 1_000 });

    const result = await runner.run(
      request([
        "-e",
        "process.stdout.write('界'.repeat(64)); process.stderr.write('語'.repeat(64));",
      ]),
    );

    expect(result).toMatchObject({
      classification: "exited",
      exitCode: 0,
      stdoutTruncated: true,
      stderrTruncated: true,
    });
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(16);
    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(16);
    expect(result.stdout).toBe("界".repeat(5));
    expect(result.stderr).toBe("語".repeat(5));
  });

  it("classifies timeout after TERM then bounded KILL fallback", async () => {
    const runner = createBoundedCommandRunner({
      deadlineMs: 40,
      terminateGraceMs: 20,
      maxOutputBytes: 16,
    });

    const result = await runner.run(request(["-e", "setInterval(() => {}, 1_000);"]));

    expect(result.classification).toBe("timeout");
  });

  it("classifies a child signal separately from an exit code", async () => {
    const runner = createBoundedCommandRunner({ deadlineMs: 1_000 });

    const result = await runner.run(request(["-e", "process.kill(process.pid, 'SIGTERM');"]));

    expect(result).toMatchObject({ classification: "signal", exitCode: null, signal: "SIGTERM" });
  });

  it("classifies spawn failures without pretending they are process exits", async () => {
    const runner = createBoundedCommandRunner({ deadlineMs: 1_000 });

    const result = await runner.run({
      executable: "/definitely-not-an-agent-team-command",
      arguments: [],
      environment: buildRuntimeEnvironment({
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        HOME: process.cwd(),
        XDG_CONFIG_HOME: process.cwd(),
      }),
    });

    expect(result).toMatchObject({ classification: "spawn_error", exitCode: null });
  });
});
