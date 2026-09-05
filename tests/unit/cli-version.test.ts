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
    humanAcceptanceList: vi.fn(() => Promise.resolve(outcome)),
    humanAcceptanceAccept: vi.fn(() => Promise.resolve(outcome)),
    humanAcceptanceRequestAdjustment: vi.fn(() => Promise.resolve(outcome)),
    dispatchResolve: vi.fn(() => Promise.resolve(outcome)),
    dispatchAcknowledgeExternalMerge: vi.fn(() => Promise.resolve(outcome)),
    dispatchResolveLegacyClaim: vi.fn(() => Promise.resolve(outcome)),
    dispatchAutoMergeResume: vi.fn(() => Promise.resolve(outcome)),
    dispatchReviewerResume: vi.fn(() => Promise.resolve(outcome)),
    dispatchReviewerReplay: vi.fn(() => Promise.resolve(outcome)),
    dispatchReviewerReplayPolicy: vi.fn(() => Promise.resolve(outcome)),
    dispatchWorkStatusRecover: vi.fn(() => Promise.resolve(outcome)),
    dispatchCiResume: vi.fn(() => Promise.resolve(outcome)),
    dispatchJobResume: vi.fn(() => Promise.resolve(outcome)),
    ingest: vi.fn(() => Promise.resolve(outcome)),
    reconcile: vi.fn(() => Promise.resolve(outcome)),
    cycle: vi.fn(() => Promise.resolve(outcome)),
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
    quota: {
      canaryConfirm: vi.fn(() => Promise.resolve(outcome)),
      canaryStatus: vi.fn(() => Promise.resolve(outcome)),
      probeStatus: vi.fn(() => Promise.resolve(outcome)),
    },
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
        run [options]                輪詢 Linear 待執行工單、恢復既有 Job，並驅動 implementer pipeline
        acceptance                   列出或處理合併後等待產品負責人驗收的工單
        dispatch                     C015o：手動收斂卡住的 dispatch job
        quota                        受控的 provider quota host 操作
        ingest [options] <provider>  接收已由外部 HTTPS Runtime 轉交的 Webhook
        reconcile [options]          對帳本機狀態、事件與權威服務
        cycle [options]              執行一次全域互斥的 Controller 收斂輪次
        health                       顯示 Reconcile 喚醒來源、降級原因與手動路徑
        project [project-id]         讀取指定專案或列出專案摘要
        ui                           啟動按需 localhost 管理介面
        registration                 Registration Setup 與主動 Probe 的最小 CLI 接線
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

    await expect(
      runCli(metadata, ["run", "--project", "project-a"], commands, sink.io),
    ).resolves.toBe(0);
    await expect(
      runCli(metadata, ["acceptance", "list", "--project", "project-a"], commands, sink.io),
    ).resolves.toBe(0);
    expect(commands.humanAcceptanceList).toHaveBeenCalledWith({ projectId: "project-a" });
    await expect(
      runCli(
        metadata,
        ["acceptance", "accept", "--project", "project-a", "--issue", "linear-1"],
        commands,
        sink.io,
      ),
    ).resolves.toBe(0);
    expect(commands.humanAcceptanceAccept).toHaveBeenCalledWith({
      projectId: "project-a",
      externalIssueId: "linear-1",
    });
    await expect(
      runCli(
        metadata,
        ["acceptance", "request-adjustment", "--project", "project-a", "--issue", "linear-1"],
        commands,
        sink.io,
      ),
    ).resolves.toBe(0);
    expect(commands.humanAcceptanceRequestAdjustment).toHaveBeenCalledWith({
      projectId: "project-a",
      externalIssueId: "linear-1",
    });
    await expect(
      runCli(
        metadata,
        ["ingest", "github", "--headers-file", "/tmp/headers.json"],
        commands,
        sink.io,
      ),
    ).resolves.toBe(0);
    await expect(runCli(metadata, ["reconcile", "--all"], commands, sink.io)).resolves.toBe(0);
    await expect(
      runCli(
        metadata,
        ["reconcile", "--job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab"],
        commands,
        sink.io,
      ),
    ).resolves.toBe(0);
    expect(commands.reconcile).toHaveBeenLastCalledWith({
      jobId: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    });
    await expect(
      runCli(
        metadata,
        ["dispatch", "ci-resume", "--job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab", "--dry-run"],
        commands,
        sink.io,
      ),
    ).resolves.toBe(0);
    expect(commands.dispatchCiResume).toHaveBeenCalledWith({
      jobId: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
      dryRun: true,
    });
    await expect(
      runCli(
        metadata,
        [
          "dispatch",
          "acknowledge-external-merge",
          "--job",
          "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
          "--pr",
          "57",
          "--head",
          "a".repeat(40),
          "--merge-commit",
          "b".repeat(40),
          "--allow-missing-human-acceptance",
          "--dry-run",
        ],
        commands,
        sink.io,
      ),
    ).resolves.toBe(0);
    expect(commands.dispatchAcknowledgeExternalMerge).toHaveBeenCalledWith({
      jobId: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
      prNumber: "57",
      headSha: "a".repeat(40),
      mergeCommitSha: "b".repeat(40),
      allowMissingHumanAcceptance: true,
      dryRun: true,
    });
    await expect(
      runCli(
        metadata,
        [
          "dispatch",
          "job-resume",
          "--job",
          "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
          "--dry-run",
        ],
        commands,
        sink.io,
      ),
    ).resolves.toBe(0);
    expect(commands.dispatchJobResume).toHaveBeenCalledWith({
      jobId: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
      dryRun: true,
    });
    await expect(
      runCli(
        metadata,
        [
          "dispatch",
          "job-resume",
          "--job",
          "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
          "--adopt-pr",
          "116",
          "--expect-head",
          "a".repeat(40),
          "--expect-requirements-digest",
          "b".repeat(64),
          "--dry-run",
        ],
        commands,
        sink.io,
      ),
    ).resolves.toBe(0);
    expect(commands.dispatchJobResume).toHaveBeenLastCalledWith({
      jobId: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
      dryRun: true,
      adoptPr: 116,
      expectHead: "a".repeat(40),
      expectRequirementsDigest: "b".repeat(64),
    });
    await expect(
      runCli(
        metadata,
        [
          "dispatch",
          "reviewer-replay",
          "--job",
          "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
          "--dry-run",
        ],
        commands,
        sink.io,
      ),
    ).resolves.toBe(0);
    expect(commands.dispatchReviewerReplay).toHaveBeenCalledWith({
      jobId: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
      dryRun: true,
    });
    await expect(
      runCli(
        metadata,
        [
          "dispatch",
          "reviewer-replay",
          "--job",
          "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
          "--dry-run",
          "--new-contract-epoch",
          "--expect-contract-version",
          "2",
        ],
        commands,
        sink.io,
      ),
    ).resolves.toBe(0);
    expect(commands.dispatchReviewerReplay).toHaveBeenLastCalledWith({
      jobId: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
      dryRun: true,
      newContractEpoch: true,
      expectContractVersion: 2,
    });
    await expect(
      runCli(
        metadata,
        [
          "dispatch",
          "reviewer-replay",
          "--job",
          "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
          "--dry-run",
          "--final-review-epoch",
          "--expect-checkpoint",
          "checkpoint_018f47d2-77a4-7cc1-8ef2-0123456789ab",
        ],
        commands,
        sink.io,
      ),
    ).resolves.toBe(0);
    expect(commands.dispatchReviewerReplay).toHaveBeenLastCalledWith({
      jobId: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
      dryRun: true,
      finalReviewEpoch: true,
      expectCheckpoint: "checkpoint_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    });
    await expect(
      runCli(
        metadata,
        [
          "dispatch",
          "reviewer-replay",
          "--job",
          "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
          "--dry-run",
          "--fix-rejected-review",
        ],
        commands,
        sink.io,
      ),
    ).resolves.toBe(0);
    expect(commands.dispatchReviewerReplay).toHaveBeenLastCalledWith({
      jobId: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
      dryRun: true,
      fixRejectedReview: true,
    });
    await expect(
      runCli(
        metadata,
        ["dispatch", "reviewer-replay-policy", "--project", "project-a", "--state", "enabled"],
        commands,
        sink.io,
      ),
    ).resolves.toBe(0);
    expect(commands.dispatchReviewerReplayPolicy).toHaveBeenCalledWith({
      projectId: "project-a",
      enabled: true,
    });
    await expect(
      runCli(
        metadata,
        [
          "dispatch",
          "work-status-recover",
          "--job",
          "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
          "--transition",
          "a".repeat(64),
          "--dry-run",
        ],
        commands,
        sink.io,
      ),
    ).resolves.toBe(0);
    expect(commands.dispatchWorkStatusRecover).toHaveBeenCalledWith({
      jobId: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
      transitionInstance: "a".repeat(64),
      dryRun: true,
    });
    await expect(runCli(metadata, ["cycle", "--all"], commands, sink.io)).resolves.toBe(0);
    await expect(runCli(metadata, ["health"], commands, sink.io)).resolves.toBe(0);
    await expect(runCli(metadata, ["project"], commands, sink.io)).resolves.toBe(0);
    await expect(runCli(metadata, ["ui"], commands, sink.io)).resolves.toBe(0);
    await expect(runCli(metadata, ["quota", "canary-confirm"], commands, sink.io)).resolves.toBe(0);
    await expect(runCli(metadata, ["quota", "canary-status"], commands, sink.io)).resolves.toBe(0);
    await expect(
      runCli(metadata, ["quota", "probe-status", "--provider", "all"], commands, sink.io),
    ).resolves.toBe(0);
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
    expect(commands.cycle).toHaveBeenCalledWith({ all: true });
    expect(commands.health).toHaveBeenCalledOnce();
    expect(commands.project).toHaveBeenCalledWith({});
    expect(commands.ui).toHaveBeenCalledOnce();
    expect(commands.quota.canaryConfirm).toHaveBeenCalledOnce();
    expect(commands.quota.canaryStatus).toHaveBeenCalledOnce();
    expect(commands.quota.probeStatus).toHaveBeenCalledWith({ provider: "all" });
    expect(commands.systemd).toHaveBeenNthCalledWith(1, { action: "install", dryRun: true });
    expect(commands.systemd).toHaveBeenNthCalledWith(2, { action: "uninstall", dryRun: true });
    expect(commands.systemd).toHaveBeenNthCalledWith(3, { action: "status" });
    expect(sink.stdout()).toBe("完成\n".repeat(27));
  });

  it("maps a blocked work-status recovery to exit 3", async () => {
    const commands = handlers({ state: "blocked", message: "blocked" });
    const sink = output();
    await expect(
      runCli(
        metadata,
        [
          "dispatch",
          "work-status-recover",
          "--job",
          "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
          "--transition",
          "b".repeat(64),
          "--dry-run",
        ],
        commands,
        sink.io,
      ),
    ).resolves.toBe(cliExitCodes.blocked);
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
    const { registration, quota, ...topLevel } = commands;
    expect(Object.values(topLevel).every((handler) => handler.mock.calls.length === 0)).toBe(true);
    expect(Object.values(registration).every((handler) => handler.mock.calls.length === 0)).toBe(
      true,
    );
    expect(Object.values(quota).every((handler) => handler.mock.calls.length === 0)).toBe(true);
    expect(sink.stderr()).not.toBe("");
  });

  it("keeps quota canary IDs, versions, and confirmations out of argv", async () => {
    const commands = handlers();
    const sink = output();
    const opaqueIssueId = "b9567572-6a20-41e2-b20f-0123456789ab";

    await expect(
      runCli(
        metadata,
        ["quota", "canary-confirm", "--project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab"],
        commands,
        sink.io,
      ),
    ).resolves.toBe(cliExitCodes.usage);
    await expect(
      runCli(metadata, ["quota", "canary-status", opaqueIssueId], commands, sink.io),
    ).resolves.toBe(cliExitCodes.usage);
    expect(commands.quota.canaryConfirm).not.toHaveBeenCalled();
    expect(commands.quota.canaryStatus).not.toHaveBeenCalled();
    expect(sink.stderr()).not.toContain(opaqueIssueId);
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
