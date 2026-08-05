import { Command, CommanderError, Option } from "commander";

import type { SystemdCommandInput } from "./systemd/index.js";

export interface PackageMetadata {
  readonly description: string;
  readonly version: string;
}

export const cliExitCodes = Object.freeze({
  success: 0,
  failure: 1,
  usage: 2,
  blocked: 3,
  interrupted: 130,
} as const);

export type CliCommandOutcome = Readonly<
  | { state: "success"; message?: string }
  | { state: "failed"; message: string }
  | { state: "blocked"; message: string }
  | { state: "interrupted"; message: string }
>;

export interface CliHandlers {
  readonly run: (input: Readonly<{ projectId?: string }>) => Promise<CliCommandOutcome>;
  readonly ingest: (
    input: Readonly<{ provider: "github" | "linear"; headersFile: string }>,
  ) => Promise<CliCommandOutcome>;
  readonly reconcile: (input: Readonly<{ all: true }>) => Promise<CliCommandOutcome>;
  readonly project: (input: Readonly<{ projectId?: string }>) => Promise<CliCommandOutcome>;
  readonly ui: () => Promise<CliCommandOutcome>;
  readonly systemd: (input: SystemdCommandInput) => Promise<CliCommandOutcome>;
}

export interface CliIo {
  readonly writeOut: (message: string) => void;
  readonly writeErr: (message: string) => void;
}

interface CliExecutionState {
  exitCode: number;
}

function blocked(command: string): Promise<CliCommandOutcome> {
  return Promise.resolve({
    state: "blocked",
    message: `${command} 尚未接上 Runtime composition；請完成對應後續階段。`,
  });
}

export const defaultCliHandlers: CliHandlers = Object.freeze({
  run: () => blocked("run"),
  ingest: () => blocked("ingest"),
  reconcile: () => blocked("reconcile"),
  project: () => blocked("project"),
  ui: () => blocked("ui"),
  systemd: () => blocked("systemd"),
});

const defaultIo: CliIo = Object.freeze({
  writeOut: (message: string) => process.stdout.write(message),
  writeErr: (message: string) => process.stderr.write(message),
});

function outcomeExitCode(outcome: CliCommandOutcome): number {
  switch (outcome.state) {
    case "success":
      return cliExitCodes.success;
    case "failed":
      return cliExitCodes.failure;
    case "blocked":
      return cliExitCodes.blocked;
    case "interrupted":
      return cliExitCodes.interrupted;
  }
}

function renderOutcome(outcome: CliCommandOutcome, io: CliIo): void {
  if (outcome.message === undefined) return;
  const line = outcome.message.endsWith("\n") ? outcome.message : `${outcome.message}\n`;
  if (outcome.state === "success") io.writeOut(line);
  else io.writeErr(line);
}

function action(
  state: CliExecutionState,
  io: CliIo,
  handler: () => Promise<CliCommandOutcome>,
): () => Promise<void> {
  return async () => {
    const outcome = await handler();
    state.exitCode = outcomeExitCode(outcome);
    renderOutcome(outcome, io);
  };
}

export function createProgram(
  metadata: PackageMetadata,
  handlers: CliHandlers = defaultCliHandlers,
  io: CliIo = defaultIo,
  state: CliExecutionState = { exitCode: cliExitCodes.success },
): Command {
  const program = new Command()
    .name("agent-team")
    .description(metadata.description)
    .version(metadata.version)
    .showHelpAfterError()
    .configureOutput({ writeOut: io.writeOut, writeErr: io.writeErr });

  program
    .command("run")
    .description("執行一次派工與 Controller pipeline")
    .argument("[project-id]", "只處理指定專案")
    .action((projectId: string | undefined) =>
      action(state, io, () => handlers.run(projectId === undefined ? {} : { projectId }))(),
    );

  program
    .command("ingest")
    .description("接收已由外部 HTTPS Runtime 轉交的 Webhook")
    .addArgument(
      new Command().createArgument("<provider>", "Webhook provider").choices(["github", "linear"]),
    )
    .requiredOption("--headers-file <path>", "含原始 HTTP Headers 的 JSON 檔案")
    .action((provider: "github" | "linear", options: { readonly headersFile: string }) =>
      action(state, io, () => handlers.ingest({ provider, headersFile: options.headersFile }))(),
    );

  program
    .command("reconcile")
    .description("對帳本機狀態、事件與權威服務")
    .addOption(new Option("--all", "對帳所有已註冊專案").makeOptionMandatory())
    .action(() => action(state, io, () => handlers.reconcile({ all: true }))());

  program
    .command("project")
    .description("讀取指定專案或列出專案摘要")
    .argument("[project-id]", "專案識別碼")
    .action((projectId: string | undefined) =>
      action(state, io, () => handlers.project(projectId === undefined ? {} : { projectId }))(),
    );

  program
    .command("ui")
    .description("啟動按需 localhost 管理介面")
    .action(action(state, io, handlers.ui));

  const systemd = program.command("systemd").description("管理 Agent Team 的 systemd user timer");
  const dryRunOptions = (command: Command): Command =>
    command
      .option("--dry-run", "只輸出預覽，不寫入檔案或呼叫 systemd")
      .option("--preview", "--dry-run 的別名");

  dryRunOptions(
    systemd
      .command("install")
      .description("驗證並安全安裝五分鐘 reconcile timer")
      .action((options: Readonly<{ dryRun?: boolean; preview?: boolean }>) =>
        action(state, io, () =>
          handlers.systemd({
            action: "install",
            dryRun: options.dryRun === true || options.preview === true,
          }),
        )(),
      ),
  );

  dryRunOptions(
    systemd
      .command("uninstall")
      .description("只移除兩個可確認為 Agent Team 所有的 units")
      .action((options: Readonly<{ dryRun?: boolean; preview?: boolean }>) =>
        action(state, io, () =>
          handlers.systemd({
            action: "uninstall",
            dryRun: options.dryRun === true || options.preview === true,
          }),
        )(),
      ),
  );

  systemd
    .command("status")
    .description("顯示 unit ownership、timer 與 Runtime preflight 狀態")
    .action(() => action(state, io, () => handlers.systemd({ action: "status" }))());

  return program;
}

export async function runCli(
  metadata: PackageMetadata,
  argv: readonly string[],
  handlers: CliHandlers = defaultCliHandlers,
  io: CliIo = defaultIo,
): Promise<number> {
  const state: CliExecutionState = { exitCode: cliExitCodes.success };
  const program = createProgram(metadata, handlers, io, state);
  const overrideExits = (command: Command): void => {
    command.exitOverride();
    command.commands.forEach(overrideExits);
  };
  overrideExits(program);
  if (argv.length === 0) {
    program.outputHelp();
    return cliExitCodes.success;
  }
  try {
    await program.parseAsync([...argv], { from: "user" });
    return state.exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? cliExitCodes.success : cliExitCodes.usage;
    }
    io.writeErr("CLI command failed unexpectedly.\n");
    return cliExitCodes.failure;
  }
}
