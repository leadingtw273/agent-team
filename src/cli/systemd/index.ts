import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { CliCommandOutcome } from "../program.js";
import type { RegistrationSystemdWakeupState } from "../../application/registration/index.js";

export interface SystemdUnitNames {
  readonly service: string;
  readonly timer: string;
}

export const systemdUnitNames: Readonly<SystemdUnitNames> = Object.freeze({
  service: "agent-team-reconcile.service",
  timer: "agent-team-reconcile.timer",
});

export const runtimeEnvironmentNames = Object.freeze([
  "PATH",
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "AGENT_TEAM_HOME",
] as const);

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

export type CommandClassification = "exited" | "signal" | "spawn_error" | "timeout";

export interface CommandRunResult {
  readonly classification: CommandClassification;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly signal?: NodeJS.Signals;
  readonly spawnErrorCode?: string;
  readonly terminationErrorCode?: string;
}

export interface CommandRunner {
  readonly run: (request: CommandRunRequest) => Promise<CommandRunResult>;
}

export interface CommandRunnerOptions {
  readonly deadlineMs?: number;
  readonly maxOutputBytes?: number;
  readonly terminateGraceMs?: number;
}

export interface RenderedSystemdUnits {
  readonly unitDirectory: string;
  readonly servicePath: string;
  readonly timerPath: string;
  readonly service: string;
  readonly timer: string;
  readonly runtimeCommand: readonly string[];
  readonly runtimeEnvironment: NodeJS.ProcessEnv;
}

export interface SystemdManagerOptions {
  readonly runtimeCommand: RuntimeCommand;
  /** Explicit composition attestation; absence fails closed for read-only wakeup projection. */
  readonly runtimeAvailable?: boolean;
  readonly commandRunner?: CommandRunner;
  readonly templateDirectory?: string;
  readonly unitNames?: SystemdUnitNames;
}

/** Read-only projection shared by the systemd, health, and project CLI surfaces. */
export interface RegistrationWakeupStateReader {
  readonly readWakeupState: () => Promise<RegistrationSystemdWakeupState>;
}

type UnitObservationKind = "missing" | "canonical" | "untrusted";
type InstallationState = "not_installed" | "installed" | "untrusted_units";

interface DirectoryIdentity {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly nlink: bigint;
  readonly ctimeNs: bigint;
  readonly birthtimeNs: bigint;
  readonly uid: bigint;
  readonly gid: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
}

interface CanonicalUnit {
  readonly path: string;
  readonly expected: Buffer;
  readonly identity: FileIdentity;
}

interface UnitObservation {
  readonly kind: UnitObservationKind;
  readonly unit?: CanonicalUnit;
}

interface UnitPair<T> {
  readonly service: T;
  readonly timer: T;
}

interface QuarantinedUnit {
  readonly unit: CanonicalUnit;
  readonly quarantinePath: string;
  readonly identity?: FileIdentity;
}

interface QuarantineResult {
  readonly entries?: readonly QuarantinedUnit[];
  readonly restored: boolean;
}

interface RemovalResult {
  readonly removed: boolean;
  readonly restored: boolean;
}

interface RollbackResult {
  readonly rolledBack: boolean;
  readonly reason?: "disable_failed" | "remove_failed" | "reload_failed" | "restore_state_failed";
}

interface TimerQueryResult {
  readonly enabledResult: CommandRunResult;
  readonly activeResult: CommandRunResult;
  readonly failedResult: CommandRunResult;
  readonly queryError: boolean;
  readonly enabled: "enabled" | "disabled" | "unknown";
  readonly activity: "active" | "failed" | "inactive" | "unknown";
}

interface BoundedOutput {
  readonly content: Buffer;
  readonly bytes: number;
  readonly truncated: boolean;
}

const defaultTemplateDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../systemd",
);
const defaultRuntimePath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const defaultDeadlineMs = 10_000;
const defaultOutputLimit = 8_192;
const defaultTerminateGraceMs = 500;
const maximumDeadlineMs = 60_000;
const maximumOutputLimit = 1_048_576;
const maximumTerminateGraceMs = 5_000;
const maximumSystemdUnitNameLength = 255;
const supportsDetachedProcessGroups = process.platform !== "win32";
const runtimeEnvironmentExecutable = "/usr/bin/env";
const systemdUnitNamePattern = /^[A-Za-z0-9:_.-]+$/u;
const legacyReconcileServiceTemplate = `# agent-team-managed: agent-team-reconcile.service v1
[Unit]
Description=Agent Team deterministic reconcile

[Service]
Type=oneshot
ExecStart={{EXEC_START}}
`;
const legacyReconcileTimerTemplate = `# agent-team-managed: agent-team-reconcile.timer v1
[Unit]
Description=Run Agent Team reconcile every five minutes

[Timer]
OnBootSec=5min
OnUnitInactiveSec=5min
Unit={{SERVICE_UNIT}}

[Install]
WantedBy=timers.target
`;

type ControllerCommandAction = "cycle" | "reconcile";

function assertSafeSystemdUnitName(
  kind: "service" | "timer",
  value: unknown,
): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`Systemd ${kind} unit name must be a string.`);
  }
  const suffix = kind === "service" ? ".service" : ".timer";
  if (!value.endsWith(suffix)) {
    throw new Error(`Systemd ${kind} unit name must end with ${suffix}.`);
  }
  const basenameBeforeSuffix = value.slice(0, -suffix.length);
  if (
    value.length === 0 ||
    value.length > maximumSystemdUnitNameLength ||
    basenameBeforeSuffix.length === 0 ||
    basename(value) !== value ||
    value.startsWith(".") ||
    value.includes("..") ||
    value.includes("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    /\s/u.test(value) ||
    value.includes("{{") ||
    value.includes("}}") ||
    !systemdUnitNamePattern.test(value)
  ) {
    throw new Error(`Systemd ${kind} unit name is unsafe.`);
  }
}

function resolveSystemdUnitNames(input: unknown): Readonly<SystemdUnitNames> {
  if (input === undefined) return systemdUnitNames;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Systemd unit names must be an object.");
  }
  const names = input as Readonly<Record<string, unknown>>;
  const service = names["service"];
  const timer = names["timer"];
  assertSafeSystemdUnitName("service", service);
  assertSafeSystemdUnitName("timer", timer);
  return Object.freeze({ service, timer });
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function codeFromError(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function spawnErrorResult(
  error: unknown,
  stdout: string,
  stderr: string,
  stdoutTruncated: boolean,
  stderrTruncated: boolean,
): CommandRunResult {
  const spawnErrorCode = codeFromError(error);
  if (spawnErrorCode === undefined) {
    return {
      classification: "spawn_error",
      exitCode: null,
      stdout,
      stderr,
      stdoutTruncated,
      stderrTruncated,
    };
  }
  return {
    classification: "spawn_error",
    exitCode: null,
    stdout,
    stderr,
    stdoutTruncated,
    stderrTruncated,
    spawnErrorCode,
  };
}

function outcome(
  state: CliCommandOutcome["state"],
  payload: Readonly<Record<string, unknown>>,
): CliCommandOutcome {
  return { state, message: JSON.stringify(payload) };
}

function successful(result: CommandRunResult): boolean {
  return (
    result.classification === "exited" &&
    result.exitCode === 0 &&
    result.terminationErrorCode === undefined
  );
}

function commandSummary(result: CommandRunResult): Readonly<Record<string, unknown>> {
  return {
    classification: result.classification,
    exitCode: result.exitCode,
    ...(result.signal === undefined ? {} : { signal: result.signal }),
    ...(result.spawnErrorCode === undefined ? {} : { spawnErrorCode: result.spawnErrorCode }),
    ...(result.terminationErrorCode === undefined
      ? {}
      : { terminationErrorCode: result.terminationErrorCode }),
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
  };
}

function systemdStateOutput(result: CommandRunResult): string | undefined {
  return result.stdoutTruncated ? undefined : result.stdout.trim();
}

function enabledState(result: CommandRunResult): "enabled" | "disabled" | "unknown" {
  const state = systemdStateOutput(result);
  if (
    result.exitCode === 0 &&
    (state === "enabled" ||
      state === "enabled-runtime" ||
      state === "linked" ||
      state === "linked-runtime" ||
      state === "alias")
  ) {
    return "enabled";
  }
  return result.exitCode === 1 && state === "disabled" ? "disabled" : "unknown";
}

function activityState(
  active: CommandRunResult,
  failed: CommandRunResult,
): "active" | "failed" | "inactive" | "unknown" {
  const activeOutput = systemdStateOutput(active);
  const failedOutput = systemdStateOutput(failed);
  if (failed.exitCode === 0 && failedOutput === "failed") return "failed";
  if (active.exitCode === 0 && activeOutput === "active") return "active";
  return active.exitCode === 3 &&
    activeOutput === "inactive" &&
    failed.exitCode === 1 &&
    failedOutput === "inactive"
    ? "inactive"
    : "unknown";
}

function appendBoundedOutput(
  output: BoundedOutput,
  chunk: Buffer,
  maxOutputBytes: number,
): BoundedOutput {
  const remaining = Math.max(0, maxOutputBytes - output.bytes);
  const included = chunk.subarray(0, remaining);
  return {
    content: Buffer.concat([output.content, included]),
    bytes: output.bytes + included.byteLength,
    truncated: output.truncated || chunk.byteLength > remaining,
  };
}

function boundedOutputText(output: BoundedOutput): string {
  let text = output.content.toString("utf8");
  while (Buffer.byteLength(text, "utf8") > output.bytes) {
    text = Array.from(text).slice(0, -1).join("");
  }
  return text;
}

function signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals): string | undefined {
  if (pid === undefined) return "ESRCH";
  try {
    process.kill(-pid, signal);
    return undefined;
  } catch (error) {
    return codeFromError(error) ?? "UNKNOWN";
  }
}

function unsupportedProcessGroupResult(): CommandRunResult {
  return {
    classification: "spawn_error",
    exitCode: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    spawnErrorCode: "UNSUPPORTED_PROCESS_GROUPS",
  };
}

export function createBoundedCommandRunner(options: CommandRunnerOptions = {}): CommandRunner {
  const deadlineMs = options.deadlineMs ?? defaultDeadlineMs;
  const maxOutputBytes = options.maxOutputBytes ?? defaultOutputLimit;
  const terminateGraceMs = options.terminateGraceMs ?? defaultTerminateGraceMs;
  if (
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs <= 0 ||
    deadlineMs > maximumDeadlineMs ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 0 ||
    maxOutputBytes > maximumOutputLimit ||
    !Number.isSafeInteger(terminateGraceMs) ||
    terminateGraceMs < 0 ||
    terminateGraceMs > maximumTerminateGraceMs
  ) {
    throw new Error("Invalid command runner limits.");
  }

  return Object.freeze({
    run: async (request: CommandRunRequest) => {
      if (!supportsDetachedProcessGroups) return unsupportedProcessGroupResult();
      return new Promise<CommandRunResult>((resolveResult) => {
        let child;
        try {
          child = spawn(request.executable, request.arguments, {
            detached: true,
            env: request.environment,
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (error) {
          resolveResult(spawnErrorResult(error, "", "", false, false));
          return;
        }

        let stdout: BoundedOutput = { content: Buffer.alloc(0), bytes: 0, truncated: false };
        let stderr: BoundedOutput = { content: Buffer.alloc(0), bytes: 0, truncated: false };
        let settled = false;
        let timedOut = false;
        let killSent = false;
        let pendingTimeoutResult: CommandRunResult | undefined;
        let terminationErrorCode: string | undefined;
        let terminateTimer: NodeJS.Timeout | undefined;
        const settle = (result: CommandRunResult): void => {
          if (settled) return;
          settled = true;
          clearTimeout(deadlineTimer);
          if (terminateTimer !== undefined) clearTimeout(terminateTimer);
          resolveResult(result);
        };
        const deadlineTimer = setTimeout(() => {
          timedOut = true;
          const termError = signalProcessGroup(child.pid, "SIGTERM");
          if (termError !== undefined && termError !== "ESRCH") terminationErrorCode = termError;
          terminateTimer = setTimeout(() => {
            const killError = signalProcessGroup(child.pid, "SIGKILL");
            if (killError !== undefined && killError !== "ESRCH") {
              terminationErrorCode = killError;
            }
            killSent = true;
            if (pendingTimeoutResult !== undefined) {
              settle({
                ...pendingTimeoutResult,
                ...(terminationErrorCode === undefined ? {} : { terminationErrorCode }),
              });
            }
          }, terminateGraceMs);
        }, deadlineMs);

        child.stdout.on("data", (chunk: Buffer) => {
          stdout = appendBoundedOutput(stdout, chunk, maxOutputBytes);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = appendBoundedOutput(stderr, chunk, maxOutputBytes);
        });
        child.once("error", (error) => {
          settle(
            spawnErrorResult(
              error,
              boundedOutputText(stdout),
              boundedOutputText(stderr),
              stdout.truncated,
              stderr.truncated,
            ),
          );
        });
        child.once("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
          if (!timedOut) {
            const cleanupError = signalProcessGroup(child.pid, "SIGKILL");
            if (cleanupError !== undefined && cleanupError !== "ESRCH") {
              terminationErrorCode = cleanupError;
            }
          }
          const base = {
            exitCode,
            stdout: boundedOutputText(stdout),
            stderr: boundedOutputText(stderr),
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
            ...(signal === null ? {} : { signal }),
            ...(terminationErrorCode === undefined ? {} : { terminationErrorCode }),
          };
          if (timedOut) {
            const timeoutResult: CommandRunResult = { classification: "timeout", ...base };
            if (killSent) settle(timeoutResult);
            else pendingTimeoutResult = timeoutResult;
          } else if (signal !== null) {
            settle({ classification: "signal", ...base });
          } else {
            settle({ classification: "exited", ...base });
          }
        });
      });
    },
  });
}

const defaultCommandRunner = createBoundedCommandRunner();

function assertSafeEnvironmentValue(name: string, value: string): void {
  if (/[\u0000\r\n]/u.test(value)) {
    throw new Error(`${name} contains an unsafe control character.`);
  }
}

export function buildRuntimeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = source["HOME"] ?? homedir();
  const xdgConfigHome = source["XDG_CONFIG_HOME"] ?? join(home, ".config");
  const environment: NodeJS.ProcessEnv = {
    PATH: source["PATH"] ?? defaultRuntimePath,
    HOME: home,
    XDG_CONFIG_HOME: xdgConfigHome,
  };
  for (const name of ["XDG_RUNTIME_DIR", "AGENT_TEAM_HOME"] as const) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  for (const name of runtimeEnvironmentNames) {
    const value = environment[name];
    if (value !== undefined) assertSafeEnvironmentValue(name, value);
  }
  if (!isAbsolute(environment["HOME"] ?? "") || !isAbsolute(environment["XDG_CONFIG_HOME"] ?? "")) {
    throw new Error("HOME and XDG_CONFIG_HOME must be absolute paths.");
  }
  for (const name of ["XDG_RUNTIME_DIR", "AGENT_TEAM_HOME"] as const) {
    const value = environment[name];
    if (value !== undefined && !isAbsolute(value)) {
      throw new Error(`${name} must be an absolute path when set.`);
    }
  }
  return Object.freeze(environment);
}

function quoteSystemdArgument(value: string): string {
  if (value.length === 0 || /[\u0000\r\n]/u.test(value)) {
    throw new Error("Systemd command contains an unsafe argument.");
  }
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replace(/\$/gu, () => "$$")
    .replace(/%/gu, () => "%%");
  return `"${escaped}"`;
}

function assertSafeAbsoluteCommandPath(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !isAbsolute(value) || /[\u0000\r\n]/u.test(value)) {
    throw new Error(`${label} must be an absolute safe path.`);
  }
}

function assertExactControllerCommand(
  runtimeCommand: RuntimeCommand,
  action: ControllerCommandAction,
): void {
  assertSafeAbsoluteCommandPath(runtimeCommand.executable, "Runtime executable");
  const arguments_ = runtimeCommand.arguments;
  const expectedAction = action === "cycle" ? "cycle" : "reconcile";
  if (
    arguments_.length !== 3 ||
    !isAbsolute(arguments_[0] ?? "") ||
    /[\u0000\r\n]/u.test(arguments_[0] ?? "") ||
    arguments_[1] !== expectedAction ||
    arguments_[2] !== "--all"
  ) {
    throw new Error(`Systemd unit must execute exact ${expectedAction} --all.`);
  }
}

function assertExactRuntimeWrapperCommand(
  runtimeCommand: RuntimeCommand,
  action: ControllerCommandAction,
): void {
  if (runtimeCommand.executable !== runtimeEnvironmentExecutable) {
    throw new Error("Systemd unit must use the Runtime environment wrapper.");
  }
  const arguments_ = runtimeCommand.arguments;
  if (arguments_[0] !== "-i") {
    throw new Error("Systemd Runtime wrapper must clear the inherited environment.");
  }
  let index = 1;
  for (const name of ["PATH", "HOME", "XDG_CONFIG_HOME"] as const) {
    const assignment = arguments_[index];
    if (typeof assignment !== "string" || !assignment.startsWith(`${name}=`)) {
      throw new Error(`Systemd Runtime wrapper is missing ${name}.`);
    }
    assertSafeEnvironmentValue(name, assignment.slice(`${name}=`.length));
    index += 1;
  }
  for (const name of ["XDG_RUNTIME_DIR", "AGENT_TEAM_HOME"] as const) {
    const assignment = arguments_[index];
    if (typeof assignment === "string" && assignment.startsWith(`${name}=`)) {
      assertSafeEnvironmentValue(name, assignment.slice(`${name}=`.length));
      index += 1;
    }
  }
  const executable = arguments_[index];
  const entrypoint = arguments_[index + 1];
  assertSafeAbsoluteCommandPath(executable, "Wrapped Runtime executable");
  assertSafeAbsoluteCommandPath(entrypoint, "Compiled CLI entrypoint");
  const expectedAction = action === "cycle" ? "cycle" : "reconcile";
  if (
    arguments_[index + 2] !== expectedAction ||
    arguments_[index + 3] !== "--all" ||
    arguments_.length !== index + 4
  ) {
    throw new Error(`Systemd unit must execute exact ${expectedAction} --all.`);
  }
}

function renderExecStart(runtimeCommand: RuntimeCommand, action: ControllerCommandAction): string {
  assertExactRuntimeWrapperCommand(runtimeCommand, action);
  return [runtimeCommand.executable, ...runtimeCommand.arguments]
    .map(quoteSystemdArgument)
    .join(" ");
}

function createLegacyReconcileRuntimeCommand(runtimeCommand: RuntimeCommand): RuntimeCommand {
  assertExactControllerCommand(runtimeCommand, "cycle");
  const entrypoint = runtimeCommand.arguments[0];
  if (entrypoint === undefined) throw new Error("Compiled CLI entrypoint is unavailable.");
  return Object.freeze({
    executable: runtimeCommand.executable,
    arguments: Object.freeze([entrypoint, "reconcile", "--all"]),
    environment: runtimeCommand.environment,
  });
}

function buildRuntimeWrapperCommand(
  runtimeCommand: RuntimeCommand,
  runtimeEnvironment: NodeJS.ProcessEnv,
  inheritedEnvironment: NodeJS.ProcessEnv,
): RuntimeCommand {
  if (!isAbsolute(runtimeCommand.executable)) {
    throw new Error("Runtime executable must be absolute.");
  }
  const assignments = runtimeEnvironmentNames.flatMap((name) => {
    const value = runtimeEnvironment[name];
    return value === undefined ? [] : [`${name}=${value}`];
  });
  return Object.freeze({
    executable: runtimeEnvironmentExecutable,
    arguments: Object.freeze([
      "-i",
      ...assignments,
      runtimeCommand.executable,
      ...runtimeCommand.arguments,
    ]),
    environment: inheritedEnvironment,
  });
}

function renderTemplate(template: string, replacements: Readonly<Record<string, string>>): string {
  let rendered = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    if (!rendered.includes(placeholder)) {
      throw new Error(`Systemd template is missing ${placeholder}.`);
    }
    rendered = rendered.replaceAll(placeholder, () => value);
  }
  if (/\{\{[A-Z_]+\}\}/u.test(rendered)) {
    throw new Error("Systemd template contains an unresolved placeholder.");
  }
  return rendered;
}

function assertRenderedExactCycleService(service: string, execStart: string): void {
  const execStartLines = service.split("\n").filter((line) => line.startsWith("ExecStart="));
  if (execStartLines.length !== 1 || execStartLines[0] !== `ExecStart=${execStart}`) {
    throw new Error("Systemd service must contain one exact cycle ExecStart.");
  }
}

function fileIdentity(entry: BigIntStats): FileIdentity {
  return {
    dev: entry.dev,
    ino: entry.ino,
    nlink: entry.nlink,
    ctimeNs: entry.ctimeNs,
    birthtimeNs: entry.birthtimeNs,
    uid: entry.uid,
    gid: entry.gid,
    mode: entry.mode,
    size: entry.size,
    mtimeNs: entry.mtimeNs,
  };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.ctimeNs === right.ctimeNs &&
    left.birthtimeNs === right.birthtimeNs &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

function sameFileGenerationAcrossRename(after: FileIdentity, before: FileIdentity): boolean {
  return (
    after.dev === before.dev &&
    after.ino === before.ino &&
    after.nlink === before.nlink &&
    after.ctimeNs >= before.ctimeNs &&
    after.birthtimeNs === before.birthtimeNs &&
    after.uid === before.uid &&
    after.gid === before.gid &&
    after.mode === before.mode &&
    after.size === before.size &&
    after.mtimeNs === before.mtimeNs
  );
}

function isSafeRegularFile(entry: BigIntStats): boolean {
  return entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1n;
}

function directoryIdentity(path: string, entry: BigIntStats): DirectoryIdentity {
  return { path, dev: entry.dev, ino: entry.ino };
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.path === right.path && left.dev === right.dev && left.ino === right.ino;
}

function pathComponents(path: string): readonly string[] {
  const parsed = parse(path);
  const pathFromRoot = relative(parsed.root, path);
  return pathFromRoot.length === 0 ? [] : pathFromRoot.split(sep).filter((part) => part.length > 0);
}

async function lstatOrMissing(path: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (isErrorWithCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function ensureSafeDirectory(
  path: string,
  create: boolean,
): Promise<DirectoryIdentity | undefined> {
  if (!isAbsolute(path)) throw new Error("Systemd unit directory must be absolute.");
  const parsed = parse(path);
  let current = parsed.root;
  for (const component of pathComponents(path)) {
    current = join(current, component);
    let entry = await lstatOrMissing(current);
    if (entry === undefined) {
      if (!create) return undefined;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (!isErrorWithCode(error, "EEXIST")) throw error;
      }
      entry = await lstatOrMissing(current);
    }
    if (entry === undefined || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("Systemd unit directory contains a symlink or non-directory.");
    }
  }
  const finalEntry = await lstat(path, { bigint: true });
  if (!finalEntry.isDirectory() || finalEntry.isSymbolicLink()) {
    throw new Error("Systemd unit directory is unsafe.");
  }
  return directoryIdentity(path, finalEntry);
}

async function assertStableDirectory(identity: DirectoryIdentity): Promise<void> {
  const current = await ensureSafeDirectory(identity.path, false);
  if (current === undefined || !sameDirectoryIdentity(identity, current)) {
    throw new Error("Systemd unit directory changed during operation.");
  }
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  if (handle === undefined) return;
  try {
    await handle.close();
  } catch {
    // The primary filesystem failure remains authoritative.
  }
}

async function unlinkQuietly(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Temporary and quarantine cleanup is best effort only.
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

async function observeUnit(
  path: string,
  expected: Buffer,
  directory: DirectoryIdentity,
): Promise<UnitObservation> {
  await assertStableDirectory(directory);
  const before = await lstatOrMissing(path);
  if (before === undefined) return { kind: "missing" };
  if (!isSafeRegularFile(before) || before.dev !== directory.dev) return { kind: "untrusted" };
  const bytes = await readFile(path);
  const after = await lstatOrMissing(path);
  await assertStableDirectory(directory);
  if (
    after === undefined ||
    !isSafeRegularFile(after) ||
    !sameFileIdentity(fileIdentity(before), fileIdentity(after)) ||
    !bytes.equals(expected)
  ) {
    return { kind: "untrusted" };
  }
  return {
    kind: "canonical",
    unit: { path, expected, identity: fileIdentity(after) },
  };
}

async function writeNewCanonicalUnit(
  path: string,
  expected: Buffer,
  directory: DirectoryIdentity,
): Promise<"exists" | CanonicalUnit> {
  await assertStableDirectory(directory);
  const temporaryPath = join(
    directory.path,
    `.${basename(path)}.agent-team-write-${randomUUID().replaceAll("-", "")}.tmp`,
  );
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o644);
    await handle.writeFile(expected);
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
  } finally {
    await closeQuietly(handle);
    await unlinkQuietly(temporaryPath);
  }
  await syncDirectory(directory.path);
  const observation = await observeUnit(path, expected, directory);
  if (observation.kind !== "canonical" || observation.unit === undefined) {
    throw new Error("Systemd unit changed while being written.");
  }
  return observation.unit;
}

async function restoreCanonicalUnit(
  unit: CanonicalUnit,
  directory: DirectoryIdentity,
): Promise<boolean> {
  const existing = await observeUnit(unit.path, unit.expected, directory);
  if (existing.kind === "canonical") return true;
  if (existing.kind !== "missing") return false;
  const written = await writeNewCanonicalUnit(unit.path, unit.expected, directory);
  return written !== "exists";
}

async function restoreQuarantinedUnit(
  quarantined: QuarantinedUnit,
  directory: DirectoryIdentity,
): Promise<boolean> {
  const source = await observeUnit(
    quarantined.quarantinePath,
    quarantined.unit.expected,
    directory,
  );
  if (
    source.kind !== "canonical" ||
    source.unit === undefined ||
    (quarantined.identity === undefined
      ? !sameFileGenerationAcrossRename(source.unit.identity, quarantined.unit.identity)
      : !sameFileIdentity(source.unit.identity, quarantined.identity))
  ) {
    return false;
  }
  const target = await observeUnit(quarantined.unit.path, quarantined.unit.expected, directory);
  if (target.kind !== "missing") return false;
  try {
    await rename(quarantined.quarantinePath, quarantined.unit.path);
  } catch {
    return false;
  }
  const restored = await observeUnit(quarantined.unit.path, quarantined.unit.expected, directory);
  return (
    restored.kind === "canonical" &&
    restored.unit !== undefined &&
    sameFileGenerationAcrossRename(restored.unit.identity, source.unit.identity)
  );
}

async function restoreTransaction(
  removed: readonly CanonicalUnit[],
  quarantined: readonly QuarantinedUnit[],
  directory: DirectoryIdentity,
): Promise<boolean> {
  let restored = true;
  for (const unit of removed) {
    restored = (await restoreCanonicalUnit(unit, directory)) && restored;
  }
  for (const unit of quarantined) {
    restored = (await restoreQuarantinedUnit(unit, directory)) && restored;
  }
  return restored;
}

async function quarantineUnits(
  units: readonly CanonicalUnit[],
  directory: DirectoryIdentity,
): Promise<QuarantineResult> {
  await assertStableDirectory(directory);
  const quarantined: QuarantinedUnit[] = [];
  try {
    for (const unit of units) {
      const current = await observeUnit(unit.path, unit.expected, directory);
      if (
        current.kind !== "canonical" ||
        current.unit === undefined ||
        !sameFileIdentity(current.unit.identity, unit.identity)
      ) {
        throw new Error("Systemd unit changed before quarantine.");
      }
      const quarantinePath = join(
        directory.path,
        `.${basename(unit.path)}.agent-team-quarantine-${randomUUID().replaceAll("-", "")}`,
      );
      if ((await lstatOrMissing(quarantinePath)) !== undefined) {
        throw new Error("Systemd quarantine path already exists.");
      }
      await rename(unit.path, quarantinePath);
      quarantined.push({ unit, quarantinePath });
    }
    await syncDirectory(directory.path);
    const validated: QuarantinedUnit[] = [];
    for (const entry of quarantined) {
      const moved = await observeUnit(entry.quarantinePath, entry.unit.expected, directory);
      if (
        moved.kind !== "canonical" ||
        moved.unit === undefined ||
        !sameFileGenerationAcrossRename(moved.unit.identity, entry.unit.identity)
      ) {
        throw new Error("Systemd quarantined unit did not retain canonical identity.");
      }
      validated.push({ ...entry, identity: moved.unit.identity });
    }
    return { entries: Object.freeze(validated), restored: false };
  } catch {
    return { restored: await restoreTransaction([], quarantined, directory) };
  }
}

async function removeCanonicalUnits(
  units: readonly CanonicalUnit[],
  directory: DirectoryIdentity,
): Promise<RemovalResult> {
  const quarantine = await quarantineUnits(units, directory);
  if (quarantine.entries === undefined) {
    return { removed: false, restored: quarantine.restored };
  }
  const quarantined = quarantine.entries;
  const removed: CanonicalUnit[] = [];
  try {
    for (const entry of quarantined) {
      const current = await observeUnit(entry.quarantinePath, entry.unit.expected, directory);
      if (
        current.kind !== "canonical" ||
        current.unit === undefined ||
        entry.identity === undefined ||
        !sameFileIdentity(current.unit.identity, entry.identity)
      ) {
        throw new Error("Systemd quarantine changed before removal.");
      }
      await unlink(entry.quarantinePath);
      removed.push(entry.unit);
    }
    await syncDirectory(directory.path);
    return { removed: true, restored: false };
  } catch {
    return {
      removed: false,
      restored: await restoreTransaction(
        removed,
        quarantined.filter((entry) => !removed.some((unit) => unit.path === entry.unit.path)),
        directory,
      ),
    };
  }
}

async function discardQuarantinedUnits(
  quarantined: readonly QuarantinedUnit[],
  directory: DirectoryIdentity,
): Promise<boolean> {
  try {
    for (const entry of quarantined) {
      const current = await observeUnit(entry.quarantinePath, entry.unit.expected, directory);
      if (
        current.kind !== "canonical" ||
        current.unit === undefined ||
        entry.identity === undefined ||
        !sameFileIdentity(current.unit.identity, entry.identity)
      ) {
        return false;
      }
      await unlink(entry.quarantinePath);
    }
    await syncDirectory(directory.path);
    return true;
  } catch {
    return false;
  }
}

export function resolveSystemdUserUnitDirectory(environment: NodeJS.ProcessEnv): string {
  const runtimeEnvironment = buildRuntimeEnvironment(environment);
  const configHome = runtimeEnvironment["XDG_CONFIG_HOME"];
  if (configHome === undefined || !isAbsolute(configHome)) {
    throw new Error("XDG_CONFIG_HOME must be an absolute path.");
  }
  return join(configHome, "systemd", "user");
}

export class SystemdManager {
  readonly #runtimeCommand: RuntimeCommand;
  readonly #legacyRuntimeCommand: RuntimeCommand;
  readonly #runtimeAvailable: boolean;
  readonly #runtimeEnvironment: NodeJS.ProcessEnv;
  readonly #inheritedEnvironment: NodeJS.ProcessEnv;
  readonly #commandRunner: CommandRunner;
  readonly #templateDirectory: string;
  readonly #unitNames: Readonly<SystemdUnitNames>;

  constructor(options: SystemdManagerOptions) {
    this.#unitNames = resolveSystemdUnitNames(options.unitNames);
    assertExactControllerCommand(options.runtimeCommand, "cycle");
    this.#runtimeAvailable = options.runtimeAvailable ?? false;
    this.#inheritedEnvironment = Object.freeze({ ...options.runtimeCommand.environment });
    this.#runtimeEnvironment = buildRuntimeEnvironment(options.runtimeCommand.environment);
    this.#runtimeCommand = buildRuntimeWrapperCommand(
      options.runtimeCommand,
      this.#runtimeEnvironment,
      this.#inheritedEnvironment,
    );
    this.#legacyRuntimeCommand = buildRuntimeWrapperCommand(
      createLegacyReconcileRuntimeCommand(options.runtimeCommand),
      this.#runtimeEnvironment,
      this.#inheritedEnvironment,
    );
    this.#commandRunner = options.commandRunner ?? defaultCommandRunner;
    this.#templateDirectory = options.templateDirectory ?? defaultTemplateDirectory;
  }

  async preview(): Promise<RenderedSystemdUnits> {
    const [serviceTemplate, timerTemplate] = await Promise.all([
      readFile(join(this.#templateDirectory, systemdUnitNames.service), "utf8"),
      readFile(join(this.#templateDirectory, systemdUnitNames.timer), "utf8"),
    ]);
    const unitDirectory = resolveSystemdUserUnitDirectory(this.#runtimeEnvironment);
    const execStart = renderExecStart(this.#runtimeCommand, "cycle");
    const service = renderTemplate(serviceTemplate, { "{{EXEC_START}}": execStart });
    assertRenderedExactCycleService(service, execStart);
    const timer = renderTemplate(timerTemplate, {
      "{{SERVICE_UNIT}}": this.#unitNames.service,
    });
    return Object.freeze({
      unitDirectory,
      servicePath: join(unitDirectory, this.#unitNames.service),
      timerPath: join(unitDirectory, this.#unitNames.timer),
      service,
      timer,
      runtimeCommand: Object.freeze([
        this.#runtimeCommand.executable,
        ...this.#runtimeCommand.arguments,
      ]),
      runtimeEnvironment: this.#runtimeEnvironment,
    });
  }

  #legacyPreview(preview: RenderedSystemdUnits): RenderedSystemdUnits {
    const service = renderTemplate(legacyReconcileServiceTemplate, {
      "{{EXEC_START}}": renderExecStart(this.#legacyRuntimeCommand, "reconcile"),
    });
    const timer = renderTemplate(legacyReconcileTimerTemplate, {
      "{{SERVICE_UNIT}}": this.#unitNames.service,
    });
    return Object.freeze({
      ...preview,
      service,
      timer,
      runtimeCommand: Object.freeze([
        this.#legacyRuntimeCommand.executable,
        ...this.#legacyRuntimeCommand.arguments,
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

  /**
   * Projects the existing authoritative systemd observations into the registration wakeup
   * vocabulary. This intentionally reuses the same canonical ownership and
   * `is-enabled`/`is-active`/`is-failed` reads as `systemd status`; it never parses CLI JSON,
   * spawns a Controller cycle, or creates a second probe path. Runtime capability is an explicit
   * composition attestation so this projection remains read-only.
   */
  async readWakeupState(): Promise<RegistrationSystemdWakeupState> {
    try {
      const preview = await this.preview();
      const directory = await this.#directory(preview, false);
      const observed = await this.#observePair(preview, directory);
      const installationState = this.#installationState(observed);
      if (!this.#runtimeAvailable) return "runtime_unavailable";
      if (installationState === "not_installed") return "not_installed";
      if (installationState === "untrusted_units") return "untrusted";

      const timer = await this.#queryTimer();
      if (timer.queryError || timer.enabled === "unknown" || timer.activity === "unknown") {
        return "unknown";
      }
      if (timer.enabled === "enabled" && timer.activity === "active") return "active";
      if (timer.activity === "failed") return "failed";
      return timer.activity === "inactive" ? "inactive" : "unknown";
    } catch {
      return "unknown";
    }
  }

  async #directory(
    preview: RenderedSystemdUnits,
    create: boolean,
  ): Promise<DirectoryIdentity | undefined> {
    return ensureSafeDirectory(preview.unitDirectory, create);
  }

  async #observePair(
    preview: RenderedSystemdUnits,
    directory: DirectoryIdentity | undefined,
  ): Promise<UnitPair<UnitObservation>> {
    if (directory === undefined) {
      return Object.freeze({
        service: { kind: "missing" as const },
        timer: { kind: "missing" as const },
      });
    }
    const [service, timer] = await Promise.all([
      observeUnit(preview.servicePath, Buffer.from(preview.service, "utf8"), directory),
      observeUnit(preview.timerPath, Buffer.from(preview.timer, "utf8"), directory),
    ]);
    return Object.freeze({ service, timer });
  }

  #installationState(observed: UnitPair<UnitObservation>): InstallationState {
    const values = [observed.service.kind, observed.timer.kind];
    if (values.every((value) => value === "missing")) return "not_installed";
    if (values.every((value) => value === "canonical")) return "installed";
    return "untrusted_units";
  }

  #unitSummary(observed: UnitPair<UnitObservation>): Readonly<Record<string, UnitObservationKind>> {
    return { service: observed.service.kind, timer: observed.timer.kind };
  }

  #canonicalPair(observed: UnitPair<UnitObservation>): UnitPair<CanonicalUnit> | undefined {
    return observed.service.kind === "canonical" &&
      observed.service.unit !== undefined &&
      observed.timer.kind === "canonical" &&
      observed.timer.unit !== undefined
      ? { service: observed.service.unit, timer: observed.timer.unit }
      : undefined;
  }

  async #legacyCanonicalPair(
    preview: RenderedSystemdUnits,
    directory: DirectoryIdentity | undefined,
  ): Promise<
    Readonly<{ preview: RenderedSystemdUnits; pair: UnitPair<CanonicalUnit> }> | undefined
  > {
    if (directory === undefined) return undefined;
    const legacyPreview = this.#legacyPreview(preview);
    const legacyPair = this.#canonicalPair(await this.#observePair(legacyPreview, directory));
    return legacyPair === undefined
      ? undefined
      : Object.freeze({ preview: legacyPreview, pair: legacyPair });
  }

  #sameCanonicalPair(
    observed: UnitPair<UnitObservation>,
    expected: UnitPair<CanonicalUnit>,
  ): boolean {
    const current = this.#canonicalPair(observed);
    return (
      current !== undefined &&
      sameFileIdentity(current.service.identity, expected.service.identity) &&
      sameFileIdentity(current.timer.identity, expected.timer.identity)
    );
  }

  #pathsAbsent(observed: UnitPair<UnitObservation>): boolean {
    return observed.service.kind === "missing" && observed.timer.kind === "missing";
  }

  async #run(request: Omit<CommandRunRequest, "environment">): Promise<CommandRunResult> {
    return this.#commandRunner.run({ ...request, environment: this.#runtimeEnvironment });
  }

  #safePreflight(preview: RenderedSystemdUnits): void {
    const execStart = renderExecStart(this.#runtimeCommand, "cycle");
    assertRenderedExactCycleService(preview.service, execStart);
  }

  async #verify(preview: RenderedSystemdUnits): Promise<CommandRunResult> {
    const validationRoot = await mkdtemp(join(tmpdir(), "agent-team-systemd-verify-"));
    const servicePath = join(validationRoot, this.#unitNames.service);
    const timerPath = join(validationRoot, this.#unitNames.timer);
    try {
      await Promise.all([
        writeFile(servicePath, preview.service, { encoding: "utf8", mode: 0o644 }),
        writeFile(timerPath, preview.timer, { encoding: "utf8", mode: 0o644 }),
      ]);
      return await this.#run({
        executable: "systemd-analyze",
        arguments: ["verify", servicePath, timerPath],
      });
    } finally {
      await rm(validationRoot, { recursive: true, force: true });
    }
  }

  async #systemctl(arguments_: readonly string[]): Promise<CommandRunResult> {
    return this.#run({ executable: "systemctl", arguments: ["--user", ...arguments_] });
  }

  async #reloadUserManager(): Promise<CommandRunResult> {
    return this.#systemctl(["daemon-reload"]);
  }

  async #queryTimer(): Promise<TimerQueryResult> {
    const [enabledResult, activeResult, failedResult] = await Promise.all([
      this.#systemctl(["is-enabled", this.#unitNames.timer]),
      this.#systemctl(["is-active", this.#unitNames.timer]),
      this.#systemctl(["is-failed", this.#unitNames.timer]),
    ]);
    return {
      enabledResult,
      activeResult,
      failedResult,
      queryError: [enabledResult, activeResult, failedResult].some(
        (result) => result.classification !== "exited" || result.terminationErrorCode !== undefined,
      ),
      enabled: enabledState(enabledResult),
      activity: activityState(activeResult, failedResult),
    };
  }

  #timerQuerySummary(query: TimerQueryResult): Readonly<Record<string, unknown>> {
    return {
      enabled: query.enabled,
      activity: query.activity,
      enabledQuery: commandSummary(query.enabledResult),
      activeQuery: commandSummary(query.activeResult),
      failedQuery: commandSummary(query.failedResult),
    };
  }

  async #rollbackInstall(
    created: readonly CanonicalUnit[],
    directory: DirectoryIdentity,
    requiresDisable: boolean,
  ): Promise<RollbackResult> {
    if (requiresDisable) {
      const disable = await this.#systemctl(["disable", "--now", this.#unitNames.timer]);
      if (!successful(disable)) return { rolledBack: false, reason: "disable_failed" };
    }
    if (created.length === 0) return { rolledBack: true };
    const removed = await removeCanonicalUnits(created, directory);
    if (!removed.removed) return { rolledBack: false, reason: "remove_failed" };
    const reload = await this.#reloadUserManager();
    if (successful(reload)) return { rolledBack: true };
    const restored = await restoreTransaction(created, [], directory);
    if (restored) await this.#reloadUserManager();
    return { rolledBack: false, reason: "reload_failed" };
  }

  async #rollbackLegacyUpgrade(
    created: readonly CanonicalUnit[],
    quarantined: readonly QuarantinedUnit[],
    directory: DirectoryIdentity,
    requiresDisable: boolean,
    originalTimer: TimerQueryResult | undefined,
  ): Promise<RollbackResult> {
    if (originalTimer === undefined) return { rolledBack: false, reason: "restore_state_failed" };
    if (requiresDisable) {
      const disable = await this.#systemctl(["disable", "--now", this.#unitNames.timer]);
      if (!successful(disable)) return { rolledBack: false, reason: "disable_failed" };
    }
    if (created.length > 0) {
      const removal = await removeCanonicalUnits(created, directory);
      if (!removal.removed) return { rolledBack: false, reason: "remove_failed" };
    }
    if (!(await restoreTransaction([], quarantined, directory))) {
      return { rolledBack: false, reason: "remove_failed" };
    }
    const reload = await this.#reloadUserManager();
    if (!successful(reload)) return { rolledBack: false, reason: "reload_failed" };
    if (originalTimer.enabled === "enabled" && originalTimer.activity === "active") {
      const enable = await this.#systemctl(["enable", "--now", this.#unitNames.timer]);
      if (!successful(enable)) return { rolledBack: false, reason: "restore_state_failed" };
    }
    const restoredTimer = await this.#queryTimer();
    if (
      restoredTimer.queryError ||
      restoredTimer.enabled !== originalTimer.enabled ||
      restoredTimer.activity !== originalTimer.activity
    ) {
      return { rolledBack: false, reason: "restore_state_failed" };
    }
    return { rolledBack: true };
  }

  async #install(dryRun: boolean): Promise<CliCommandOutcome> {
    const preview = await this.preview();
    await this.#directory(preview, false);
    this.#safePreflight(preview);
    if (dryRun) {
      return outcome("success", {
        operation: "install",
        dryRun: true,
        unitDirectory: preview.unitDirectory,
        runtimeCommand: preview.runtimeCommand,
        runtimeEnvironment: preview.runtimeEnvironment,
        service: preview.service,
        timer: preview.timer,
        nextSteps: ["preflight", "systemd-analyze verify", "safe_write", "daemon-reload", "enable"],
      });
    }

    const directory = await this.#directory(preview, true);
    if (directory === undefined) {
      return outcome("failed", { operation: "install", state: "unit_directory_unavailable" });
    }
    const observed = await this.#observePair(preview, directory);
    const installationState = this.#installationState(observed);
    const legacy =
      installationState === "untrusted_units"
        ? await this.#legacyCanonicalPair(preview, directory)
        : undefined;
    if (installationState === "untrusted_units" && legacy === undefined) {
      return outcome("blocked", {
        operation: "install",
        state: "untrusted_units",
        units: this.#unitSummary(observed),
      });
    }

    const existingPair = this.#canonicalPair(observed);
    const existingTimer =
      installationState === "installed" || legacy !== undefined
        ? await this.#queryTimer()
        : undefined;
    if (installationState === "installed" || legacy !== undefined) {
      if (installationState === "installed" && existingPair === undefined) {
        return outcome("blocked", { operation: "install", state: "untrusted_units" });
      }
      if (existingTimer === undefined) {
        return outcome("blocked", { operation: "install", state: "timer_state_unknown" });
      }
      if (
        existingTimer.queryError ||
        existingTimer.enabled === "unknown" ||
        existingTimer.activity === "unknown"
      ) {
        return outcome("blocked", {
          operation: "install",
          state: "timer_state_unknown",
          timer: this.#timerQuerySummary(existingTimer),
        });
      }
      if (
        installationState === "installed" &&
        existingTimer.enabled === "enabled" &&
        existingTimer.activity === "active"
      ) {
        return outcome("success", {
          operation: "install",
          state: "already_installed",
          unitDirectory: preview.unitDirectory,
          timer: this.#timerQuerySummary(existingTimer),
        });
      }
      if (!(
        (existingTimer.enabled === "enabled" && existingTimer.activity === "active") ||
        (existingTimer.enabled === "disabled" && existingTimer.activity === "inactive")
      )) {
        return outcome("blocked", {
          operation: "install",
          state: "timer_state_inconsistent",
          timer: this.#timerQuerySummary(existingTimer),
        });
      }
    }

    const verification = await this.#verify(preview);
    if (!successful(verification)) {
      return outcome("blocked", {
        operation: "install",
        state: "unit_verification_failed",
        verification: commandSummary(verification),
      });
    }

    const created: CanonicalUnit[] = [];
    let quarantined: readonly QuarantinedUnit[] = [];
    let enableAttempted = false;
    try {
      let expectedPair = existingPair;
      if (legacy !== undefined) {
        const quarantine = await quarantineUnits(
          [legacy.pair.service, legacy.pair.timer],
          directory,
        );
        if (quarantine.entries === undefined) {
          return outcome("failed", {
            operation: "install",
            state: quarantine.restored ? "safe_write_failed" : "rollback_failed",
          });
        }
        quarantined = quarantine.entries;
        const service = await writeNewCanonicalUnit(
          preview.servicePath,
          Buffer.from(preview.service, "utf8"),
          directory,
        );
        if (service === "exists") {
          const rollback = await this.#rollbackLegacyUpgrade(
            created,
            quarantined,
            directory,
            false,
            existingTimer,
          );
          return outcome("blocked", {
            operation: "install",
            state: rollback.rolledBack ? "unit_write_conflict" : "rollback_failed",
            unit: this.#unitNames.service,
            ...(rollback.reason === undefined ? {} : { rollbackReason: rollback.reason }),
          });
        }
        created.push(service);
        const timer = await writeNewCanonicalUnit(
          preview.timerPath,
          Buffer.from(preview.timer, "utf8"),
          directory,
        );
        if (timer === "exists") {
          const rollback = await this.#rollbackLegacyUpgrade(
            created,
            quarantined,
            directory,
            false,
            existingTimer,
          );
          return outcome("blocked", {
            operation: "install",
            state: rollback.rolledBack ? "unit_write_conflict" : "rollback_failed",
            unit: this.#unitNames.timer,
            ...(rollback.reason === undefined ? {} : { rollbackReason: rollback.reason }),
          });
        }
        created.push(timer);
        expectedPair = { service, timer };
      } else if (installationState === "not_installed") {
        const service = await writeNewCanonicalUnit(
          preview.servicePath,
          Buffer.from(preview.service, "utf8"),
          directory,
        );
        if (service === "exists") {
          return outcome("blocked", {
            operation: "install",
            state: "unit_write_conflict",
            unit: this.#unitNames.service,
          });
        }
        created.push(service);
        const timer = await writeNewCanonicalUnit(
          preview.timerPath,
          Buffer.from(preview.timer, "utf8"),
          directory,
        );
        if (timer === "exists") {
          const rollback = await this.#rollbackInstall(created, directory, false);
          return outcome("blocked", {
            operation: "install",
            state: rollback.rolledBack ? "unit_write_conflict" : "rollback_failed",
            unit: this.#unitNames.timer,
            ...(rollback.reason === undefined ? {} : { rollbackReason: rollback.reason }),
          });
        }
        created.push(timer);
        expectedPair = { service, timer };
      }
      if (expectedPair === undefined) throw new Error("Canonical unit pair is unavailable.");

      const reload = await this.#reloadUserManager();
      const afterReload = await this.#observePair(preview, directory);
      if (!this.#sameCanonicalPair(afterReload, expectedPair)) {
        return outcome("blocked", {
          operation: "install",
          state: "unit_changed_after_reload",
          conflict: "canonical_identity_or_content_changed",
          units: this.#unitSummary(afterReload),
          reload: commandSummary(reload),
          enableAttempted: false,
          rollback: { action: "preserve_conflicting_units", successful: true },
        });
      }
      if (!successful(reload)) {
        const rollback =
          legacy === undefined
            ? created.length === 0
              ? { rolledBack: true as const }
              : await this.#rollbackInstall(created, directory, false)
            : await this.#rollbackLegacyUpgrade(
                created,
                quarantined,
                directory,
                false,
                existingTimer,
              );
        return outcome("failed", {
          operation: "install",
          state: rollback.rolledBack ? "daemon_reload_failed" : "rollback_failed",
          reload: commandSummary(reload),
          ...(rollback.reason === undefined ? {} : { rollbackReason: rollback.reason }),
        });
      }
      enableAttempted = true;
      const enable = await this.#systemctl(["enable", "--now", this.#unitNames.timer]);
      const afterEnable = await this.#observePair(preview, directory);
      if (!this.#sameCanonicalPair(afterEnable, expectedPair)) {
        const disable = await this.#systemctl(["disable", "--now", this.#unitNames.timer]);
        const rollbackSucceeded = successful(disable);
        return outcome("failed", {
          operation: "install",
          state: rollbackSucceeded ? "unit_changed_after_enable" : "rollback_failed",
          conflict: "unit_changed_after_enable",
          units: this.#unitSummary(afterEnable),
          enable: commandSummary(enable),
          rollback: {
            action: "disable_known_timer",
            successful: rollbackSucceeded,
            result: commandSummary(disable),
            foreignUnitsPreserved: true,
          },
        });
      }
      if (!successful(enable)) {
        const rollback =
          legacy === undefined
            ? await this.#rollbackInstall(created, directory, true)
            : await this.#rollbackLegacyUpgrade(
                created,
                quarantined,
                directory,
                true,
                existingTimer,
              );
        return outcome("failed", {
          operation: "install",
          state: rollback.rolledBack ? "timer_enable_failed" : "rollback_failed",
          enable: commandSummary(enable),
          ...(rollback.reason === undefined ? {} : { rollbackReason: rollback.reason }),
        });
      }
      if (legacy !== undefined && !(await discardQuarantinedUnits(quarantined, directory))) {
        return outcome("failed", { operation: "install", state: "legacy_cleanup_failed" });
      }
      return outcome("success", {
        operation: "install",
        state:
          legacy !== undefined
            ? "upgraded_legacy_installation"
            : installationState === "not_installed"
              ? "installed"
              : "enabled_existing_installation",
        unitDirectory: preview.unitDirectory,
        timer: this.#unitNames.timer,
      });
    } catch {
      const rollback =
        legacy === undefined
          ? await this.#rollbackInstall(created, directory, enableAttempted)
          : await this.#rollbackLegacyUpgrade(
              created,
              quarantined,
              directory,
              enableAttempted,
              existingTimer,
            );
      return outcome("failed", {
        operation: "install",
        state: rollback.rolledBack ? "safe_write_failed" : "rollback_failed",
        ...(rollback.reason === undefined ? {} : { rollbackReason: rollback.reason }),
      });
    }
  }

  async #uninstall(dryRun: boolean): Promise<CliCommandOutcome> {
    const preview = await this.preview();
    const directory = await this.#directory(preview, false);
    const observed = await this.#observePair(preview, directory);
    const installationState = this.#installationState(observed);
    if (dryRun) {
      return outcome("success", {
        operation: "uninstall",
        dryRun: true,
        state: installationState,
        units: this.#unitSummary(observed),
        unitDirectory: preview.unitDirectory,
      });
    }
    if (installationState === "not_installed") {
      return outcome("success", { operation: "uninstall", state: "not_installed" });
    }
    if (
      directory === undefined ||
      observed.service.kind !== "canonical" ||
      observed.service.unit === undefined ||
      observed.timer.kind !== "canonical" ||
      observed.timer.unit === undefined
    ) {
      return outcome("blocked", {
        operation: "uninstall",
        state: "untrusted_units",
        units: this.#unitSummary(observed),
      });
    }
    const original = Object.freeze({ service: observed.service.unit, timer: observed.timer.unit });
    const disable = await this.#systemctl(["disable", "--now", this.#unitNames.timer]);
    if (!successful(disable)) {
      return outcome("failed", {
        operation: "uninstall",
        state: "timer_disable_failed",
        disable: commandSummary(disable),
      });
    }

    const afterDisable = await this.#observePair(preview, directory);
    if (
      afterDisable.service.kind !== "canonical" ||
      afterDisable.service.unit === undefined ||
      !sameFileIdentity(afterDisable.service.unit.identity, original.service.identity) ||
      afterDisable.timer.kind !== "canonical" ||
      afterDisable.timer.unit === undefined ||
      !sameFileIdentity(afterDisable.timer.unit.identity, original.timer.identity)
    ) {
      return outcome("blocked", {
        operation: "uninstall",
        state: "unit_changed_after_disable",
        units: this.#unitSummary(afterDisable),
      });
    }

    const removal = await removeCanonicalUnits([original.service, original.timer], directory);
    if (!removal.removed) {
      return outcome("failed", {
        operation: "uninstall",
        state: removal.restored ? "unit_remove_failed_recovered" : "rollback_failed",
      });
    }
    const reload = await this.#reloadUserManager();
    const afterReload = await this.#observePair(preview, directory);
    if (!this.#pathsAbsent(afterReload)) {
      return outcome("failed", {
        operation: "uninstall",
        state: "unit_reappeared_after_reload",
        conflict: "unit_paths_not_absent",
        units: this.#unitSummary(afterReload),
        reload: commandSummary(reload),
        foreignUnitsPreserved: true,
      });
    }
    if (!successful(reload)) {
      const restored = await restoreTransaction([original.service, original.timer], [], directory);
      const restoredPair = restored
        ? this.#canonicalPair(await this.#observePair(preview, directory))
        : undefined;
      const recoveryReload =
        restoredPair === undefined ? undefined : await this.#reloadUserManager();
      const recoveredAfterReload =
        recoveryReload === undefined ? undefined : await this.#observePair(preview, directory);
      const recovered =
        restoredPair !== undefined &&
        recoveryReload !== undefined &&
        successful(recoveryReload) &&
        recoveredAfterReload !== undefined &&
        this.#sameCanonicalPair(recoveredAfterReload, restoredPair);
      return outcome("failed", {
        operation: "uninstall",
        state: recovered ? "daemon_reload_failed_recovered" : "rollback_failed",
        reload: commandSummary(reload),
      });
    }
    return outcome("success", { operation: "uninstall", state: "uninstalled" });
  }

  async #status(): Promise<CliCommandOutcome> {
    const preview = await this.preview();
    const directory = await this.#directory(preview, false);
    const observed = await this.#observePair(preview, directory);
    const installationState = this.#installationState(observed);
    this.#safePreflight(preview);
    if (installationState !== "installed") {
      return outcome("success", {
        operation: "status",
        installation: installationState,
        units: this.#unitSummary(observed),
        runtime: "configured",
        preflight: "exact_cycle_preview",
        timer: "not_checked",
      });
    }

    const query = await this.#queryTimer();
    const timer = query.queryError
      ? {
          state: "query_error",
          enabled: commandSummary(query.enabledResult),
          active: commandSummary(query.activeResult),
          failed: commandSummary(query.failedResult),
        }
      : {
          state: "queried",
          ...this.#timerQuerySummary(query),
        };
    return outcome("success", {
      operation: "status",
      installation: installationState,
      units: this.#unitSummary(observed),
      runtime: "configured",
      preflight: "exact_cycle_preview",
      timer,
    });
  }
}

export function createSystemdManager(
  runtimeEntrypoint: string,
  environment: NodeJS.ProcessEnv = process.env,
  runtimeAvailable = false,
): SystemdManager {
  return new SystemdManager({
    runtimeCommand: Object.freeze({
      executable: process.execPath,
      arguments: Object.freeze([runtimeEntrypoint, "cycle", "--all"]),
      environment,
    }),
    runtimeAvailable,
  });
}

export function createSystemdHandler(
  manager: Pick<SystemdManager, "handle">,
): (input: SystemdCommandInput) => Promise<CliCommandOutcome> {
  return (input) => manager.handle(input);
}
