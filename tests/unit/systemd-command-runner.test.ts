import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildRuntimeEnvironment,
  createBoundedCommandRunner,
  type CommandRunRequest,
} from "../../src/cli/systemd/index.js";

const roots: string[] = [];
const linuxIt = process.platform === "linux" ? it : it.skip;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

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

    const result = await runner.run(
      request(["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);"]),
    );

    expect(result).toMatchObject({ classification: "timeout", signal: "SIGKILL" });
  });

  linuxIt(
    "kills a TERM-ignoring descendant before it can write a post-deadline marker",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "agent-team-runner-group-"));
      roots.push(root);
      const parentPath = join(root, "parent.mjs");
      const descendantPath = join(root, "descendant.mjs");
      const readyPath = join(root, "ready.marker");
      const survivorPath = join(root, "survivor.marker");
      await Promise.all([
        writeFile(
          parentPath,
          [
            'import { spawn } from "node:child_process";',
            'spawn(process.execPath, process.argv.slice(2), { stdio: "ignore" });',
            "setInterval(() => {}, 1_000);",
          ].join("\n"),
          "utf8",
        ),
        writeFile(
          descendantPath,
          [
            'import { writeFileSync } from "node:fs";',
            'process.on("SIGTERM", () => {});',
            'writeFileSync(process.argv[2], "ready");',
            'setTimeout(() => { writeFileSync(process.argv[3], "survived"); process.exit(0); }, 1_600);',
          ].join("\n"),
          "utf8",
        ),
      ]);
      const runner = createBoundedCommandRunner({ deadlineMs: 800, terminateGraceMs: 100 });

      const result = await runner.run(
        request([parentPath, descendantPath, readyPath, survivorPath]),
      );

      expect(result).toMatchObject({ classification: "timeout", signal: "SIGTERM" });
      await expect(readFile(readyPath, "utf8")).resolves.toBe("ready");
      await wait(900);
      await expect(readFile(survivorPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.skipIf(process.platform !== "win32")(
    "fails closed where detached POSIX process-group termination is unavailable",
    async () => {
      const runner = createBoundedCommandRunner();

      const result = await runner.run(request(["-e", "process.exit(0);"]));

      expect(result).toMatchObject({
        classification: "spawn_error",
        spawnErrorCode: "UNSUPPORTED_PROCESS_GROUPS",
      });
    },
  );

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
