import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CliCommandOutcome } from "../program.js";

export const systemdUnitNames = Object.freeze({
  service: "agent-team-reconcile.service",
  timer: "agent-team-reconcile.timer",
});

export const systemdOwnershipMarkers = Object.freeze({
  service: "# agent-team-managed: agent-team-reconcile.service v1",
  timer: "# agent-team-managed: agent-team-reconcile.timer v1",
});

export type SystemdCommandInput =
  | Readonly<{ action: "install"; dryRun: boolean }>
  | Readonly<{ action: "uninstall"; dryRun: boolean }>
  | Readonly<{ action: "status" }>;

export interface RuntimeCommand {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
}

export interface CommandRunRequest {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
}

export interface CommandRunResult {
  readonly exitCode: number | null;
}

export interface CommandRunner {
  readonly run: (request: CommandRunRequest) => Promise<CommandRunResult>;
}

export interface RenderedSystemdUnits {
  readonly unitDirectory: string;
  readonly servicePath: string;
  readonly timerPath: string;
  readonly service: string;
  readonly timer: string;
  readonly runtimeCommand: readonly string[];
}

export interface SystemdManagerOptions {
  readonly runtimeCommand: RuntimeCommand;
  readonly commandRunner?: CommandRunner;
  readonly templateDirectory?: string;
}

type UnitOwnership = "missing" | "owned" | "foreign";

interface UnitInspection {
  readonly ownership: UnitOwnership;
  readonly content?: string;
}

type InstallationState =
  "not_installed" | "installed" | "managed_drifted" | "partial_installation" | "foreign_units";

const defaultTemplateDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../systemd",
);

const defaultCommandRunner: CommandRunner = Object.freeze({
  run: async (request: CommandRunRequest) =>
    new Promise<CommandRunResult>((resolveResult) => {
      const child = spawn(request.executable, request.arguments, {
        env: request.environment,
        stdio: "ignore",
      });
      let settled = false;
      const settle = (result: CommandRunResult): void => {
        if (settled) return;
        settled = true;
        resolveResult(result);
      };
      child.once("error", () => {
        settle({ exitCode: null });
      });
      child.once("close", (exitCode) => {
        settle({ exitCode });
      });
    }),
});

function isErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function outcome(
  state: CliCommandOutcome["state"],
  payload: Readonly<Record<string, unknown>>,
): CliCommandOutcome {
  return { state, message: JSON.stringify(payload) };
}

function quoteSystemdArgument(value: string): string {
  if (value.length === 0 || /[\u0000\r\n]/u.test(value)) {
    throw new Error("Systemd command contains an unsafe argument.");
  }
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", "$$")
    .replaceAll("%", "%%")}"`;
}

function renderExecStart(runtimeCommand: RuntimeCommand): string {
  const arguments_ = runtimeCommand.arguments;
  const argumentCount = arguments_.length;
  if (
    argumentCount < 2 ||
    arguments_[argumentCount - 2] !== "reconcile" ||
    arguments_[argumentCount - 1] !== "--all"
  ) {
    throw new Error("Systemd unit must execute reconcile --all.");
  }
  return [runtimeCommand.executable, ...arguments_].map(quoteSystemdArgument).join(" ");
}

function renderAgentTeamHome(runtimeCommand: RuntimeCommand): string {
  const agentTeamHome = runtimeCommand.environment["AGENT_TEAM_HOME"];
  if (agentTeamHome === undefined) return "";
  return `Environment=${quoteSystemdArgument(`AGENT_TEAM_HOME=${agentTeamHome}`)}\n`;
}

function renderTemplate(template: string, replacements: Readonly<Record<string, string>>): string {
  let rendered = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    if (!rendered.includes(placeholder)) {
      throw new Error(`Systemd template is missing ${placeholder}.`);
    }
    rendered = rendered.replaceAll(placeholder, value);
  }
  if (/\{\{[A-Z_]+\}\}/u.test(rendered)) {
    throw new Error("Systemd template contains an unresolved placeholder.");
  }
  return rendered;
}

function hasStrictOwnershipMarker(content: string, marker: string): boolean {
  return content.startsWith(`${marker}\n`);
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  if (handle === undefined) return;
  try {
    await handle.close();
  } catch {
    // The caller's primary failure is more useful than a cleanup failure.
  }
}

async function unlinkQuietly(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // A missing temporary file does not affect the authoritative unit file.
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function inspectUnit(path: string, marker: string): Promise<UnitInspection> {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) return { ownership: "foreign" };
    const content = await readFile(path, "utf8");
    return hasStrictOwnershipMarker(content, marker)
      ? { ownership: "owned", content }
      : { ownership: "foreign" };
  } catch (error) {
    if (isErrorWithCode(error, "ENOENT")) return { ownership: "missing" };
    throw error;
  }
}

async function writeNewUnit(path: string, content: string): Promise<"written" | "exists"> {
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${randomUUID().replaceAll("-", "")}.tmp`,
  );
  let handle: FileHandle | undefined;
  try {
    await mkdir(directory, { recursive: true, mode: 0o755 });
    handle = await open(temporaryPath, "wx", 0o644);
    await handle.writeFile(content, "utf8");
    await handle.chmod(0o644);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporaryPath, path);
    } catch (error) {
      if (isErrorWithCode(error, "EEXIST")) return "exists";
      throw error;
    }
    await syncDirectory(directory);
    return "written";
  } finally {
    await closeQuietly(handle);
    await unlinkQuietly(temporaryPath);
  }
}

export function resolveSystemdUserUnitDirectory(environment: NodeJS.ProcessEnv): string {
  const xdgConfigHome = environment["XDG_CONFIG_HOME"];
  const configHome =
    xdgConfigHome === undefined || xdgConfigHome.length === 0
      ? join(environment["HOME"] ?? homedir(), ".config")
      : xdgConfigHome;
  if (!isAbsolute(configHome)) {
    throw new Error("XDG_CONFIG_HOME must be an absolute path.");
  }
  return join(configHome, "systemd", "user");
}

export class SystemdManager {
  readonly #runtimeCommand: RuntimeCommand;
  readonly #commandRunner: CommandRunner;
  readonly #templateDirectory: string;

  constructor(options: SystemdManagerOptions) {
    this.#runtimeCommand = options.runtimeCommand;
    this.#commandRunner = options.commandRunner ?? defaultCommandRunner;
    this.#templateDirectory = options.templateDirectory ?? defaultTemplateDirectory;
  }

  async preview(): Promise<RenderedSystemdUnits> {
    const [serviceTemplate, timerTemplate] = await Promise.all([
      readFile(join(this.#templateDirectory, systemdUnitNames.service), "utf8"),
      readFile(join(this.#templateDirectory, systemdUnitNames.timer), "utf8"),
    ]);
    const unitDirectory = resolveSystemdUserUnitDirectory(this.#runtimeCommand.environment);
    const service = renderTemplate(serviceTemplate, {
      "{{AGENT_TEAM_HOME_ENVIRONMENT}}": renderAgentTeamHome(this.#runtimeCommand),
      "{{EXEC_START}}": renderExecStart(this.#runtimeCommand),
    });
    const timer = renderTemplate(timerTemplate, {});
    return Object.freeze({
      unitDirectory,
      servicePath: join(unitDirectory, systemdUnitNames.service),
      timerPath: join(unitDirectory, systemdUnitNames.timer),
      service,
      timer,
      runtimeCommand: Object.freeze([
        this.#runtimeCommand.executable,
        ...this.#runtimeCommand.arguments,
      ]),
    });
  }

  async handle(input: SystemdCommandInput): Promise<CliCommandOutcome> {
    try {
      switch (input.action) {
        case "install":
          return await this.#install(input.dryRun);
        case "uninstall":
          return await this.#uninstall(input.dryRun);
        case "status":
          return await this.#status();
      }
    } catch {
      return outcome("failed", {
        operation: input.action,
        state: "systemd_configuration_error",
      });
    }
  }

  async #inspect(
    preview: RenderedSystemdUnits,
  ): Promise<Readonly<{ service: UnitInspection; timer: UnitInspection }>> {
    const [service, timer] = await Promise.all([
      inspectUnit(preview.servicePath, systemdOwnershipMarkers.service),
      inspectUnit(preview.timerPath, systemdOwnershipMarkers.timer),
    ]);
    return Object.freeze({ service, timer });
  }

  #installationState(
    inspection: Readonly<{ service: UnitInspection; timer: UnitInspection }>,
    preview: RenderedSystemdUnits,
  ): InstallationState {
    const ownership = [inspection.service.ownership, inspection.timer.ownership];
    if (ownership.every((value) => value === "missing")) return "not_installed";
    if (ownership.includes("foreign")) return "foreign_units";
    if (ownership.includes("missing")) return "partial_installation";
    if (
      inspection.service.content !== preview.service ||
      inspection.timer.content !== preview.timer
    ) {
      return "managed_drifted";
    }
    return "installed";
  }

  async #run(request: CommandRunRequest): Promise<CommandRunResult> {
    return this.#commandRunner.run(request);
  }

  async #runPreflight(): Promise<CommandRunResult> {
    return this.#run({
      executable: this.#runtimeCommand.executable,
      arguments: this.#runtimeCommand.arguments,
      environment: this.#runtimeCommand.environment,
    });
  }

  async #verify(preview: RenderedSystemdUnits): Promise<CommandRunResult> {
    const validationRoot = await mkdtemp(join(tmpdir(), "agent-team-systemd-verify-"));
    const servicePath = join(validationRoot, systemdUnitNames.service);
    const timerPath = join(validationRoot, systemdUnitNames.timer);
    try {
      await Promise.all([
        writeFile(servicePath, preview.service, { encoding: "utf8", mode: 0o644 }),
        writeFile(timerPath, preview.timer, { encoding: "utf8", mode: 0o644 }),
      ]);
      return await this.#run({
        executable: "systemd-analyze",
        arguments: ["verify", servicePath, timerPath],
        environment: this.#runtimeCommand.environment,
      });
    } finally {
      await rm(validationRoot, { recursive: true, force: true });
    }
  }

  async #reloadUserManager(): Promise<CommandRunResult> {
    return this.#run({
      executable: "systemctl",
      arguments: ["--user", "daemon-reload"],
      environment: this.#runtimeCommand.environment,
    });
  }

  async #enableTimer(): Promise<CommandRunResult> {
    return this.#run({
      executable: "systemctl",
      arguments: ["--user", "enable", "--now", systemdUnitNames.timer],
      environment: this.#runtimeCommand.environment,
    });
  }

  async #disableTimer(): Promise<void> {
    await this.#run({
      executable: "systemctl",
      arguments: ["--user", "disable", "--now", systemdUnitNames.timer],
      environment: this.#runtimeCommand.environment,
    });
  }

  async #removeCreatedUnits(
    createdPaths: readonly string[],
    preview: RenderedSystemdUnits,
  ): Promise<void> {
    const expected = new Map([
      [preview.servicePath, preview.service],
      [preview.timerPath, preview.timer],
    ]);
    for (const path of createdPaths) {
      const marker =
        path === preview.servicePath
          ? systemdOwnershipMarkers.service
          : systemdOwnershipMarkers.timer;
      const inspection = await inspectUnit(path, marker);
      if (inspection.ownership === "owned" && inspection.content === expected.get(path)) {
        await unlinkQuietly(path);
      }
    }
    if (createdPaths.length > 0) {
      await this.#reloadUserManager();
    }
  }

  async #rollbackInstall(
    createdPaths: readonly string[],
    preview: RenderedSystemdUnits,
  ): Promise<void> {
    if (createdPaths.includes(preview.timerPath)) {
      await this.#disableTimer();
    }
    await this.#removeCreatedUnits(createdPaths, preview);
  }

  async #install(dryRun: boolean): Promise<CliCommandOutcome> {
    const preview = await this.preview();
    if (dryRun) {
      return outcome("success", {
        operation: "install",
        dryRun: true,
        unitDirectory: preview.unitDirectory,
        runtimeCommand: preview.runtimeCommand,
        service: preview.service,
        timer: preview.timer,
        nextSteps: ["preflight", "systemd-analyze verify", "safe_write", "daemon-reload", "enable"],
      });
    }

    const preflight = await this.#runPreflight();
    if (preflight.exitCode !== 0) {
      return outcome("blocked", {
        operation: "install",
        state: "runtime_unavailable",
        preflightExitCode: preflight.exitCode,
      });
    }

    const inspection = await this.#inspect(preview);
    const installationState = this.#installationState(inspection, preview);
    if (installationState === "foreign_units" || installationState === "partial_installation") {
      return outcome("blocked", {
        operation: "install",
        state: installationState,
        unitDirectory: preview.unitDirectory,
      });
    }
    if (installationState === "managed_drifted") {
      return outcome("blocked", {
        operation: "install",
        state: "managed_drifted",
        hint: "Run --dry-run, inspect the managed units, then resolve the drift manually.",
      });
    }

    const verification = await this.#verify(preview);
    if (verification.exitCode !== 0) {
      return outcome("blocked", {
        operation: "install",
        state: "unit_verification_failed",
        verificationExitCode: verification.exitCode,
      });
    }

    const createdPaths: string[] = [];
    try {
      if (installationState === "not_installed") {
        const serviceWrite = await writeNewUnit(preview.servicePath, preview.service);
        if (serviceWrite === "exists") {
          return outcome("blocked", {
            operation: "install",
            state: "unit_write_conflict",
            unit: systemdUnitNames.service,
          });
        }
        createdPaths.push(preview.servicePath);

        const timerWrite = await writeNewUnit(preview.timerPath, preview.timer);
        if (timerWrite === "exists") {
          await this.#rollbackInstall(createdPaths, preview);
          return outcome("blocked", {
            operation: "install",
            state: "unit_write_conflict",
            unit: systemdUnitNames.timer,
          });
        }
        createdPaths.push(preview.timerPath);
      }

      const reload = await this.#reloadUserManager();
      if (reload.exitCode !== 0) {
        await this.#rollbackInstall(createdPaths, preview);
        return outcome("failed", {
          operation: "install",
          state: "daemon_reload_failed",
          systemctlExitCode: reload.exitCode,
        });
      }
      const enable = await this.#enableTimer();
      if (enable.exitCode !== 0) {
        await this.#rollbackInstall(createdPaths, preview);
        return outcome("failed", {
          operation: "install",
          state: "timer_enable_failed",
          systemctlExitCode: enable.exitCode,
        });
      }
      return outcome("success", {
        operation: "install",
        state: installationState === "not_installed" ? "installed" : "already_installed",
        unitDirectory: preview.unitDirectory,
        timer: systemdUnitNames.timer,
      });
    } catch {
      await this.#rollbackInstall(createdPaths, preview);
      return outcome("failed", { operation: "install", state: "safe_write_failed" });
    }
  }

  async #uninstall(dryRun: boolean): Promise<CliCommandOutcome> {
    const preview = await this.preview();
    const inspection = await this.#inspect(preview);
    const installationState = this.#installationState(inspection, preview);
    if (dryRun) {
      return outcome("success", {
        operation: "uninstall",
        dryRun: true,
        state: installationState,
        unitDirectory: preview.unitDirectory,
      });
    }
    if (installationState === "not_installed") {
      return outcome("success", { operation: "uninstall", state: "not_installed" });
    }
    if (inspection.service.ownership !== "owned" || inspection.timer.ownership !== "owned") {
      return outcome("blocked", {
        operation: "uninstall",
        state: "mixed_or_foreign_ownership",
      });
    }

    const disable = await this.#run({
      executable: "systemctl",
      arguments: ["--user", "disable", "--now", systemdUnitNames.timer],
      environment: this.#runtimeCommand.environment,
    });
    if (disable.exitCode !== 0) {
      return outcome("failed", {
        operation: "uninstall",
        state: "timer_disable_failed",
        systemctlExitCode: disable.exitCode,
      });
    }
    try {
      await unlink(preview.servicePath);
      await unlink(preview.timerPath);
      const reload = await this.#reloadUserManager();
      if (reload.exitCode !== 0) {
        return outcome("failed", {
          operation: "uninstall",
          state: "daemon_reload_failed",
          systemctlExitCode: reload.exitCode,
        });
      }
      return outcome("success", { operation: "uninstall", state: "uninstalled" });
    } catch {
      return outcome("failed", { operation: "uninstall", state: "unit_remove_failed" });
    }
  }

  async #status(): Promise<CliCommandOutcome> {
    const preview = await this.preview();
    const inspection = await this.#inspect(preview);
    const installationState = this.#installationState(inspection, preview);
    const preflight = await this.#runPreflight();
    if (preflight.exitCode !== 0) {
      return outcome("success", {
        operation: "status",
        installation: installationState,
        runtime: "runtime_unavailable",
        preflightExitCode: preflight.exitCode,
      });
    }
    if (installationState !== "installed") {
      return outcome("success", {
        operation: "status",
        installation: installationState,
        runtime: "available",
        timer: "not_checked",
      });
    }
    const timerStatus = await this.#run({
      executable: "systemctl",
      arguments: ["--user", "is-enabled", systemdUnitNames.timer],
      environment: this.#runtimeCommand.environment,
    });
    return outcome("success", {
      operation: "status",
      installation: installationState,
      runtime: "available",
      timer:
        timerStatus.exitCode === 0
          ? "enabled"
          : timerStatus.exitCode === null
            ? "systemd_unavailable"
            : "disabled",
    });
  }
}

export function createSystemdHandler(
  runtimeEntrypoint: string,
  environment: NodeJS.ProcessEnv = process.env,
): (input: SystemdCommandInput) => Promise<CliCommandOutcome> {
  const manager = new SystemdManager({
    runtimeCommand: Object.freeze({
      executable: process.execPath,
      arguments: Object.freeze([runtimeEntrypoint, "reconcile", "--all"]),
      environment,
    }),
  });
  return (input) => manager.handle(input);
}
