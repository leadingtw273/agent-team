import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import type {
  GitPort,
  RegistrationCompiledCliProbePort,
  RegistrationLocalRepositoryProbePort,
  RegistrationNodeRuntimeProbePort,
  ReadOptions,
} from "../../application/ports/index.js";
import { LocalGitAdapter } from "../git/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";

const defaultCliTimeoutMs = 3_000;
const defaultRequiredNodeMajor = 24;
const versionPattern = /\b([0-9]+)\.([0-9]+)\.([0-9]+)(?:[-+][0-9A-Za-z.-]+)?\b/u;
const exactCliVersionPattern = /^v?([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)\s*$/u;

export interface LocalRegistrationReadOnlyProbeOptions {
  readonly repositoryRoot?: string;
  readonly compiledCliPath?: string;
  readonly git?: Pick<GitPort, "inspectRepository">;
  readonly nodeVersion?: () => string;
  readonly nodeExecutable?: string;
  readonly now?: () => string;
  readonly requiredNodeMajor?: number;
  readonly cliTimeoutMs?: number;
  readonly cliRunner?: CompiledCliCommandRunner;
}

export interface LocalRegistrationReadOnlyProbes {
  readonly localRepository: RegistrationLocalRepositoryProbePort;
  readonly nodeRuntime: RegistrationNodeRuntimeProbePort;
  readonly compiledCli: RegistrationCompiledCliProbePort;
}

export interface CompiledCliCommandRunner {
  readonly run: (
    input: Readonly<{
      executable: string;
      arguments: readonly string[];
      timeoutMs: number;
      signal?: AbortSignal;
    }>,
  ) => Promise<Result<string, DomainError>>;
}

function validNodeMajor(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 99
    ? value
    : defaultRequiredNodeMajor;
}

function validCliTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 30_000
    ? value
    : defaultCliTimeoutMs;
}

function observedAt(clock: () => string): string {
  const candidate = clock();
  return Number.isFinite(Date.parse(candidate)) ? candidate : new Date().toISOString();
}

function invalidPath(path: string | undefined): boolean {
  return path === undefined || path.length === 0 || path.length > 4_096 || !isAbsolute(path);
}

function processError(error: unknown): DomainError {
  if (typeof error === "object" && error !== null) {
    const code = "code" in error ? error.code : undefined;
    const killed = "killed" in error ? error.killed : undefined;
    const name = "name" in error ? error.name : undefined;
    if (name === "AbortError") return domainError("interrupted");
    if (killed === true) return domainError("timeout");
    if (code === "ENOENT") return domainError("not_found");
  }
  return domainError("unavailable");
}

const defaultCompiledCliCommandRunner: CompiledCliCommandRunner = Object.freeze({
  run: (input: Parameters<CompiledCliCommandRunner["run"]>[0]) =>
    new Promise<Result<string, DomainError>>((resolve) => {
      const { executable, arguments: arguments_, timeoutMs, signal } = input;
      execFile(
        executable,
        [...arguments_],
        {
          encoding: "utf8",
          maxBuffer: 8_192,
          timeout: timeoutMs,
          windowsHide: true,
          ...(signal === undefined ? {} : { signal }),
        },
        (error, stdout) => {
          if (error !== null) {
            resolve(err(processError(error)));
            return;
          }
          resolve(ok(stdout));
        },
      );
    }),
});

/**
 * Concrete local O002 probes. All filesystem and child-process work is read-only:
 * Git only inspects, Node reads its own version, and the compiled CLI only receives
 * `--version`. Neither raw output nor filesystem paths reach the UI evidence.
 */
export class LocalRegistrationReadOnlyProbeAdapter implements LocalRegistrationReadOnlyProbes {
  readonly localRepository: RegistrationLocalRepositoryProbePort;
  readonly nodeRuntime: RegistrationNodeRuntimeProbePort;
  readonly compiledCli: RegistrationCompiledCliProbePort;

  readonly #repositoryRoot: string | undefined;
  readonly #compiledCliPath: string | undefined;
  readonly #git: Pick<GitPort, "inspectRepository">;
  readonly #nodeVersion: () => string;
  readonly #nodeExecutable: string;
  readonly #now: () => string;
  readonly #requiredNodeMajor: number;
  readonly #cliTimeoutMs: number;
  readonly #cliRunner: CompiledCliCommandRunner;

  constructor(options: LocalRegistrationReadOnlyProbeOptions = {}) {
    this.#repositoryRoot = options.repositoryRoot;
    this.#compiledCliPath = options.compiledCliPath;
    this.#git = options.git ?? new LocalGitAdapter();
    this.#nodeVersion = options.nodeVersion ?? (() => process.versions.node);
    this.#nodeExecutable = options.nodeExecutable ?? process.execPath;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#requiredNodeMajor = validNodeMajor(options.requiredNodeMajor);
    this.#cliTimeoutMs = validCliTimeout(options.cliTimeoutMs);
    this.#cliRunner = options.cliRunner ?? defaultCompiledCliCommandRunner;
    this.localRepository = Object.freeze({
      inspect: (readOptions?: ReadOptions) => this.inspectRepository(readOptions),
    });
    this.nodeRuntime = Object.freeze({
      inspect: (readOptions?: ReadOptions) => this.inspectNodeRuntime(readOptions),
    });
    this.compiledCli = Object.freeze({
      inspect: (readOptions?: ReadOptions) => this.inspectCompiledCli(readOptions),
    });
  }

  private async inspectRepository(
    options: ReadOptions = {},
  ): ReturnType<RegistrationLocalRepositoryProbePort["inspect"]> {
    const at = observedAt(this.#now);
    const repositoryRoot = this.#repositoryRoot;
    if (repositoryRoot === undefined || invalidPath(repositoryRoot)) {
      return ok({
        state: "unknown",
        evidence: Object.freeze(["尚未設定本機 Repository 路徑。"]),
        provenance: "local_git",
        observedAt: at,
      });
    }
    const result = await this.#git.inspectRepository({ rootPath: repositoryRoot }, options);
    if (!result.ok) return result;
    return ok({
      state: "passed",
      evidence: Object.freeze([
        `已確認本機 Git Repository；工作樹目前${result.value.clean ? "乾淨" : "有未提交變更"}。`,
      ]),
      provenance: "local_git",
      observedAt: at,
    });
  }

  private inspectNodeRuntime(
    options: ReadOptions = {},
  ): ReturnType<RegistrationNodeRuntimeProbePort["inspect"]> {
    if (options.signal?.aborted === true) return Promise.resolve(err(domainError("interrupted")));
    const at = observedAt(this.#now);
    const version = this.#nodeVersion();
    const match = versionPattern.exec(version);
    if (match === null) return Promise.resolve(err(domainError("external_failure")));
    const major = Number(match[1]);
    if (!Number.isSafeInteger(major)) return Promise.resolve(err(domainError("external_failure")));
    return Promise.resolve(
      ok({
        state: major === this.#requiredNodeMajor ? "passed" : "failed",
        evidence: Object.freeze([
          `已偵測 Node.js ${String(major)}.x；專案要求 Node.js ${String(this.#requiredNodeMajor)}.x。`,
        ]),
        provenance: "node_runtime",
        observedAt: at,
      }),
    );
  }

  private async inspectCompiledCli(
    options: ReadOptions = {},
  ): ReturnType<RegistrationCompiledCliProbePort["inspect"]> {
    const at = observedAt(this.#now);
    const compiledCliPath = this.#compiledCliPath;
    if (compiledCliPath === undefined || invalidPath(compiledCliPath)) {
      return ok({
        state: "unknown",
        evidence: Object.freeze(["尚未設定編譯後 Agent Team CLI 路徑。"]),
        provenance: "compiled_cli",
        observedAt: at,
      });
    }
    if (options.signal?.aborted === true) return err(domainError("interrupted"));
    try {
      const entry = await lstat(compiledCliPath);
      if (!entry.isFile() || entry.isSymbolicLink()) return err(domainError("not_found"));
    } catch {
      return err(domainError("not_found"));
    }
    const output = await this.#cliRunner.run({
      executable: this.#nodeExecutable,
      arguments: Object.freeze([compiledCliPath, "--version"]),
      timeoutMs: this.#cliTimeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!output.ok) return output;
    const version =
      output.value.length <= 128 ? exactCliVersionPattern.exec(output.value)?.[1] : undefined;
    if (version === undefined) return err(domainError("external_failure"));
    return ok({
      state: "passed",
      evidence: Object.freeze([`已安全執行編譯後 CLI 的 --version；版本 ${version}。`]),
      provenance: "compiled_cli",
      observedAt: at,
    });
  }
}
