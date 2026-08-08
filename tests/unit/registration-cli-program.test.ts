/**
 * O009: unit-level command-parsing contract for the new `agent-team registration <setup|probe>`
 * subcommand group. Exercises only Commander wiring (program.ts) against a fully faked
 * `registration` handler bundle -- no composition, no adapters, no filesystem/network I/O.
 */
import { describe, expect, it, vi } from "vitest";

import {
  cliExitCodes,
  createProgram,
  runCli,
  type CliCommandOutcome,
  type CliHandlers,
} from "../../src/cli/program.js";

const metadata = {
  description: "Local-first agent team controller for Linear and GitHub workflows.",
  version: "0.1.0",
} as const;

function output() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      writeOut(message: string) {
        stdout += message;
      },
      writeErr(message: string) {
        stderr += message;
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function baseHandlers(outcome: CliCommandOutcome = { state: "success" }): CliHandlers {
  return {
    run: vi.fn(() => Promise.resolve(outcome)),
    dispatchResolve: vi.fn(() => Promise.resolve(outcome)),
    dispatchResolveLegacyClaim: vi.fn(() => Promise.resolve(outcome)),
    dispatchAutoMergeResume: vi.fn(() => Promise.resolve(outcome)),
    ingest: vi.fn(() => Promise.resolve(outcome)),
    reconcile: vi.fn(() => Promise.resolve(outcome)),
    health: vi.fn(() => Promise.resolve(outcome)),
    project: vi.fn(() => Promise.resolve(outcome)),
    ui: vi.fn(() => Promise.resolve(outcome)),
    systemd: vi.fn(() => Promise.resolve(outcome)),
    registration: {
      setupStart: vi.fn(() => Promise.resolve(outcome)),
      setupStatus: vi.fn(() => Promise.resolve(outcome)),
      setupResume: vi.fn(() => Promise.resolve(outcome)),
      setupRefresh: vi.fn(() => Promise.resolve(outcome)),
      setupApprove: vi.fn(() => Promise.resolve(outcome)),
      probeRun: vi.fn(() => Promise.resolve(outcome)),
      probeStatus: vi.fn(() => Promise.resolve(outcome)),
    },
  };
}

describe("O009 registration CLI command parsing", () => {
  it("dispatches every registration subcommand with its parsed --project (and --draft) input", async () => {
    const commands = baseHandlers({ state: "success", message: "ok" });
    const sink = output();

    await expect(
      runCli(
        metadata,
        ["registration", "setup", "start", "--project", "proj-1", "--draft", "/tmp/d.json"],
        commands,
        sink.io,
      ),
    ).resolves.toBe(cliExitCodes.success);
    await expect(
      runCli(
        metadata,
        ["registration", "setup", "status", "--project", "proj-1"],
        commands,
        sink.io,
      ),
    ).resolves.toBe(cliExitCodes.success);
    await expect(
      runCli(
        metadata,
        ["registration", "setup", "resume", "--project", "proj-1"],
        commands,
        sink.io,
      ),
    ).resolves.toBe(cliExitCodes.success);
    await expect(
      runCli(
        metadata,
        ["registration", "setup", "refresh", "--project", "proj-1"],
        commands,
        sink.io,
      ),
    ).resolves.toBe(cliExitCodes.success);
    await expect(
      runCli(
        metadata,
        ["registration", "setup", "approve", "--project", "proj-1"],
        commands,
        sink.io,
      ),
    ).resolves.toBe(cliExitCodes.success);
    await expect(
      runCli(metadata, ["registration", "probe", "run", "--project", "proj-1"], commands, sink.io),
    ).resolves.toBe(cliExitCodes.success);
    await expect(
      runCli(
        metadata,
        ["registration", "probe", "status", "--project", "proj-1"],
        commands,
        sink.io,
      ),
    ).resolves.toBe(cliExitCodes.success);

    expect(commands.registration.setupStart).toHaveBeenCalledWith({
      projectId: "proj-1",
      draftPath: "/tmp/d.json",
    });
    expect(commands.registration.setupStatus).toHaveBeenCalledWith({ projectId: "proj-1" });
    expect(commands.registration.setupResume).toHaveBeenCalledWith({ projectId: "proj-1" });
    expect(commands.registration.setupRefresh).toHaveBeenCalledWith({ projectId: "proj-1" });
    expect(commands.registration.setupApprove).toHaveBeenCalledWith({
      projectId: "proj-1",
      draftPath: undefined,
    });
    expect(commands.registration.probeRun).toHaveBeenCalledWith({ projectId: "proj-1" });
    expect(commands.registration.probeStatus).toHaveBeenCalledWith({ projectId: "proj-1" });
  });

  it("requires --project for every registration subcommand and never calls a handler without it", async () => {
    const commands = baseHandlers();
    const sink = output();

    for (const argv of [
      ["registration", "setup", "start"],
      ["registration", "setup", "status"],
      ["registration", "setup", "resume"],
      ["registration", "setup", "refresh"],
      ["registration", "setup", "approve"],
      ["registration", "probe", "run"],
      ["registration", "probe", "status"],
    ]) {
      await expect(runCli(metadata, argv, commands, sink.io)).resolves.toBe(cliExitCodes.usage);
    }

    expect(commands.registration.setupStart).not.toHaveBeenCalled();
    expect(commands.registration.setupStatus).not.toHaveBeenCalled();
    expect(commands.registration.setupResume).not.toHaveBeenCalled();
    expect(commands.registration.setupRefresh).not.toHaveBeenCalled();
    expect(commands.registration.setupApprove).not.toHaveBeenCalled();
    expect(commands.registration.probeRun).not.toHaveBeenCalled();
    expect(commands.registration.probeStatus).not.toHaveBeenCalled();
  });

  it("maps a `rejected` outcome to the stable usage exit code 2, on stderr", async () => {
    const commands = baseHandlers();
    const registration = {
      ...commands.registration,
      setupStart: vi.fn(() =>
        Promise.resolve<CliCommandOutcome>({ state: "rejected", message: "確認字串不符" }),
      ),
    };
    const sink = output();

    const code = await runCli(
      metadata,
      ["registration", "setup", "start", "--project", "proj-1"],
      { ...commands, registration },
      sink.io,
    );

    expect(code).toBe(cliExitCodes.usage);
    expect(sink.stderr()).toBe("確認字串不符\n");
    expect(sink.stdout()).toBe("");
  });

  it("keeps the registration help subtree stable", () => {
    const help = createProgram(metadata).helpInformation();
    expect(help).toContain("registration");
  });
});
