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

function handlers(outcome: CliCommandOutcome = { state: "success" }) {
  return {
    run: vi.fn(() => Promise.resolve(outcome)),
    ingest: vi.fn(() => Promise.resolve(outcome)),
    reconcile: vi.fn(() => Promise.resolve(outcome)),
    project: vi.fn(() => Promise.resolve(outcome)),
    ui: vi.fn(() => Promise.resolve(outcome)),
    systemd: vi.fn(() => Promise.resolve(outcome)),
  } satisfies CliHandlers;
}

describe("agent-team CLI contract", () => {
  it("keeps the top-level help snapshot stable", () => {
    expect(createProgram(metadata).helpInformation()).toMatchInlineSnapshot(`
      "Usage: agent-team [options] [command]

      Local-first agent team controller for Linear and GitHub workflows.

      Options:
        -V, --version                output the version number
        -h, --help                   display help for command

      Commands:
        run [project-id]             執行一次派工與 Controller pipeline
        ingest [options] <provider>  接收已由外部 HTTPS Runtime 轉交的 Webhook
        reconcile [options]          對帳本機狀態、事件與權威服務
        project [project-id]         讀取指定專案或列出專案摘要
        ui                           啟動按需 localhost 管理介面
        systemd                      管理 Agent Team 的 systemd user timer
        help [command]               display help for command
      "
    `);
  });

  it("prints help without arguments and reports package version", async () => {
    const sink = output();

    await expect(runCli(metadata, [], handlers(), sink.io)).resolves.toBe(cliExitCodes.success);
    expect(sink.stdout()).toContain("Usage: agent-team [options] [command]");
    expect(createProgram(metadata).version()).toBe(metadata.version);
  });

  it("dispatches every command with bounded parsed input", async () => {
    const commands = handlers({ state: "success", message: "完成" });
    const sink = output();

    await expect(runCli(metadata, ["run", "project-a"], commands, sink.io)).resolves.toBe(0);
    await expect(
      runCli(
        metadata,
        ["ingest", "github", "--headers-file", "/tmp/headers.json"],
        commands,
        sink.io,
      ),
    ).resolves.toBe(0);
    await expect(runCli(metadata, ["reconcile", "--all"], commands, sink.io)).resolves.toBe(0);
    await expect(runCli(metadata, ["project"], commands, sink.io)).resolves.toBe(0);
    await expect(runCli(metadata, ["ui"], commands, sink.io)).resolves.toBe(0);
    await expect(
      runCli(metadata, ["systemd", "install", "--preview"], commands, sink.io),
    ).resolves.toBe(0);
    await expect(
      runCli(metadata, ["systemd", "uninstall", "--dry-run"], commands, sink.io),
    ).resolves.toBe(0);
    await expect(runCli(metadata, ["systemd", "status"], commands, sink.io)).resolves.toBe(0);

    expect(commands.run).toHaveBeenCalledWith({ projectId: "project-a" });
    expect(commands.ingest).toHaveBeenCalledWith({
      provider: "github",
      headersFile: "/tmp/headers.json",
    });
    expect(commands.reconcile).toHaveBeenCalledWith({ all: true });
    expect(commands.project).toHaveBeenCalledWith({});
    expect(commands.ui).toHaveBeenCalledOnce();
    expect(commands.systemd).toHaveBeenNthCalledWith(1, { action: "install", dryRun: true });
    expect(commands.systemd).toHaveBeenNthCalledWith(2, { action: "uninstall", dryRun: true });
    expect(commands.systemd).toHaveBeenNthCalledWith(3, { action: "status" });
    expect(sink.stdout()).toBe("完成\n".repeat(8));
  });

  it.each([
    [{ state: "success" } as const, cliExitCodes.success, "stdout"],
    [{ state: "failed", message: "失敗" } as const, cliExitCodes.failure, "stderr"],
    [{ state: "blocked", message: "阻塞" } as const, cliExitCodes.blocked, "stderr"],
    [{ state: "interrupted", message: "中斷" } as const, cliExitCodes.interrupted, "stderr"],
  ])("maps %s to its stable exit code", async (outcome, expected, stream) => {
    const sink = output();
    const code = await runCli(metadata, ["ui"], handlers(outcome), sink.io);

    expect(code).toBe(expected);
    if ("message" in outcome) {
      expect(stream === "stdout" ? sink.stdout() : sink.stderr()).toBe(`${outcome.message}\n`);
    }
  });

  it.each([
    ["unknown command", ["unknown"]],
    ["missing reconcile scope", ["reconcile"]],
    ["unsupported webhook provider", ["ingest", "gitlab"]],
  ])("returns usage exit 2 for %s without calling a handler", async (_name, argv) => {
    const commands = handlers();
    const sink = output();

    await expect(runCli(metadata, argv, commands, sink.io)).resolves.toBe(cliExitCodes.usage);
    expect(Object.values(commands).every((handler) => handler.mock.calls.length === 0)).toBe(true);
    expect(sink.stderr()).not.toBe("");
  });

  it("fails closed with exit 3 when a command has not been composed yet", async () => {
    const sink = output();

    await expect(runCli(metadata, ["reconcile", "--all"], undefined, sink.io)).resolves.toBe(
      cliExitCodes.blocked,
    );
    expect(sink.stderr()).toContain("尚未接上 Runtime composition");
  });

  it("sanitizes an unexpected handler exception and returns exit 1", async () => {
    const commands = handlers();
    commands.ui.mockRejectedValueOnce(new Error("secret internal detail"));
    const sink = output();

    await expect(runCli(metadata, ["ui"], commands, sink.io)).resolves.toBe(cliExitCodes.failure);
    expect(sink.stderr()).toBe("CLI command failed unexpectedly.\n");
    expect(sink.stderr()).not.toContain("secret internal detail");
  });
});
