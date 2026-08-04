import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";

import type {
  ChildProcessHandle,
  ProcessExit,
  ProcessOutputChunk,
  ProcessPort,
  ProcessSignal,
  ProcessSpawnRequest,
} from "../../application/ports/process.js";
import type { ReadOptions } from "../../application/ports/common.js";
import {
  createClock,
  domainError,
  err,
  ok,
  parseInstant,
  type Clock,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import { Redactor } from "../../infrastructure/redaction/index.js";

const maximumOutputBytes = 64 * 1024 * 1024;
const maximumInputBytes = 16 * 1024 * 1024;
const maximumArgumentBytes = 1024 * 1024;
const environmentKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const supportedSignals = new Set<ProcessSignal>(["SIGINT", "SIGTERM", "SIGKILL"]);

export interface ChildProcessRunnerOptions {
  readonly clock?: Clock;
  readonly killGraceMs?: number;
}

class OutputLog implements AsyncIterable<ProcessOutputChunk> {
  readonly #chunks: ProcessOutputChunk[] = [];
  readonly #waiters = new Set<() => void>();
  #closed = false;

  append(chunk: ProcessOutputChunk): void {
    if (this.#closed) return;
    this.#chunks.push(Object.freeze(chunk));
    this.#wake();
  }

  close(): void {
    this.#closed = true;
    this.#wake();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ProcessOutputChunk> {
    let index = 0;
    for (;;) {
      const chunk = this.#chunks[index];
      if (chunk !== undefined) {
        index += 1;
        yield chunk;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#waiters.add(resolve);
      });
    }
  }

  #wake(): void {
    for (const resolve of this.#waiters) resolve();
    this.#waiters.clear();
  }
}

interface StreamState {
  readonly decoder: TextDecoder;
  pending: string;
}

function failure<Value>(code: DomainError["code"]): Result<Value, DomainError> {
  return err(domainError(code));
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function processError(error: unknown): DomainError {
  if (typeof error === "object" && error !== null) {
    const name = "name" in error ? error.name : undefined;
    const code = "code" in error ? error.code : undefined;
    if (name === "AbortError" || code === "ABORT_ERR") return domainError("interrupted");
    if (code === "ENOENT") return domainError("unavailable");
    if (code === "EACCES" || code === "EPERM") return domainError("permission_denied");
  }
  return domainError("external_failure");
}

function validRequest(request: ProcessSpawnRequest): boolean {
  const environmentEntries = Object.entries(request.environment ?? {});
  const sensitiveKeys = request.sensitiveEnvironmentKeys ?? [];
  return (
    request.executable.length > 0 &&
    request.executable.length <= 4_096 &&
    !request.executable.includes("\u0000") &&
    isAbsolute(request.workingDirectory) &&
    request.workingDirectory.length <= 4_096 &&
    !request.workingDirectory.includes("\u0000") &&
    request.arguments.length <= 1_000 &&
    request.arguments.every(
      (argument) => argument.length <= 100_000 && !argument.includes("\u0000"),
    ) &&
    request.arguments.reduce((size, argument) => size + Buffer.byteLength(argument), 0) <=
      maximumArgumentBytes &&
    environmentEntries.length <= 1_000 &&
    environmentEntries.every(
      ([key, value]) =>
        environmentKeyPattern.test(key) &&
        value.length <= maximumArgumentBytes &&
        !value.includes("\u0000"),
    ) &&
    sensitiveKeys.length === new Set(sensitiveKeys).size &&
    sensitiveKeys.every((key) => environmentKeyPattern.test(key)) &&
    (request.stdin?.byteLength ?? 0) <= maximumInputBytes &&
    Number.isSafeInteger(request.maxOutputBytes) &&
    request.maxOutputBytes > 0 &&
    request.maxOutputBytes <= maximumOutputBytes &&
    parseInstant(request.deadlineAt).ok
  );
}

function waitWithSignal<Value>(
  promise: Promise<Result<Value, DomainError>>,
  options: ReadOptions,
): Promise<Result<Value, DomainError>> {
  if (options.signal === undefined) return promise;
  const signal = options.signal;
  if (signal.aborted) return Promise.resolve(failure("interrupted"));
  return new Promise((resolve) => {
    const abort = () => {
      resolve(failure("interrupted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void promise.then((result) => {
      signal.removeEventListener("abort", abort);
      resolve(result);
    });
  });
}

class NodeChildProcessHandle implements ChildProcessHandle {
  readonly pid: number;
  readonly output: AsyncIterable<ProcessOutputChunk>;
  readonly #child: ChildProcess;
  readonly #completion: Promise<Result<ProcessExit, DomainError>>;
  #exited = false;

  constructor(
    child: ChildProcess,
    output: OutputLog,
    completion: Promise<Result<ProcessExit, DomainError>>,
  ) {
    if (child.pid === undefined) throw new Error("child_pid_unavailable");
    this.pid = child.pid;
    this.#child = child;
    this.output = output;
    this.#completion = completion;
    child.once("close", () => {
      this.#exited = true;
    });
  }

  wait(options: ReadOptions = {}): Promise<Result<ProcessExit, DomainError>> {
    return waitWithSignal(this.#completion, options);
  }

  sendSignal(signal: ProcessSignal, options: ReadOptions = {}): Promise<Result<void, DomainError>> {
    if (options.signal?.aborted === true) return Promise.resolve(failure("interrupted"));
    if (!supportedSignals.has(signal) || this.#exited) return Promise.resolve(failure("conflict"));
    try {
      return Promise.resolve(this.#child.kill(signal) ? ok(undefined) : failure("conflict"));
    } catch {
      return Promise.resolve(failure("external_failure"));
    }
  }
}

export class ChildProcessRunner implements ProcessPort {
  readonly #clock: Clock;
  readonly #killGraceMs: number;

  constructor(options: ChildProcessRunnerOptions = {}) {
    this.#clock = options.clock ?? createClock();
    const killGraceMs = options.killGraceMs ?? 1_000;
    this.#killGraceMs =
      Number.isSafeInteger(killGraceMs) && killGraceMs >= 10 && killGraceMs <= 60_000
        ? killGraceMs
        : 1_000;
  }

  async spawn(
    request: ProcessSpawnRequest,
    options: ReadOptions = {},
  ): Promise<Result<ChildProcessHandle, DomainError>> {
    if (!validRequest(request)) return failure("external_failure");
    if (signalAborted(options.signal)) return failure("interrupted");
    const deadlineMs = Date.parse(request.deadlineAt);
    if (deadlineMs <= Date.now()) return failure("timeout");

    const environment = { ...process.env, ...(request.environment ?? {}) };
    const secrets = (request.sensitiveEnvironmentKeys ?? [])
      .map((key) => environment[key])
      .filter((value): value is string => value !== undefined && value.length > 0);
    const redactor = new Redactor({
      secrets,
      sensitiveKeys: request.sensitiveEnvironmentKeys ?? [],
    });
    const holdOutputUntilClose = secrets.some((secret) => /[\r\n]/u.test(secret));
    const output = new OutputLog();
    const startedAt = this.#clock.now();
    const child = spawn(request.executable, [...request.arguments], {
      cwd: request.workingDirectory,
      env: environment,
      shell: false,
      detached: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const streamStates = {
      stdout: { decoder: new TextDecoder("utf-8", { fatal: false }), pending: "" },
      stderr: { decoder: new TextDecoder("utf-8", { fatal: false }), pending: "" },
    } satisfies Record<"stdout" | "stderr", StreamState>;
    let sequence = 0;
    let capturedBytes = 0;
    let acceptedInputBytes = 0;
    let outputTruncated = false;
    const timers: { deadline?: NodeJS.Timeout; kill?: NodeJS.Timeout } = {};

    const appendText = (stream: "stdout" | "stderr", text: string) => {
      if (text.length === 0) return;
      const redacted = Buffer.from(redactor.redactText(text), "utf8");
      const remaining = request.maxOutputBytes - capturedBytes;
      if (remaining <= 0) {
        outputTruncated = true;
        return;
      }
      const bytes = redacted.byteLength <= remaining ? redacted : redacted.subarray(0, remaining);
      if (bytes.byteLength < redacted.byteLength) outputTruncated = true;
      capturedBytes += bytes.byteLength;
      sequence += 1;
      output.append({
        sequence,
        stream,
        bytes: Uint8Array.from(bytes),
        observedAt: this.#clock.now(),
      });
    };
    const acceptData = (stream: "stdout" | "stderr", bytes: Buffer) => {
      const remainingInputBytes = request.maxOutputBytes - acceptedInputBytes;
      if (remainingInputBytes <= 0) {
        outputTruncated = true;
        return;
      }
      const acceptedBytes =
        bytes.byteLength <= remainingInputBytes ? bytes : bytes.subarray(0, remainingInputBytes);
      acceptedInputBytes += acceptedBytes.byteLength;
      if (acceptedBytes.byteLength < bytes.byteLength) outputTruncated = true;
      const state = streamStates[stream];
      state.pending += state.decoder.decode(acceptedBytes, { stream: true });
      if (holdOutputUntilClose) return;
      const boundary = state.pending.lastIndexOf("\n");
      if (boundary < 0) return;
      const complete = state.pending.slice(0, boundary + 1);
      state.pending = state.pending.slice(boundary + 1);
      appendText(stream, complete);
    };
    const flush = (stream: "stdout" | "stderr") => {
      const state = streamStates[stream];
      state.pending += state.decoder.decode();
      appendText(stream, state.pending);
      state.pending = "";
    };

    child.stdout.on("data", (bytes: Buffer) => {
      acceptData("stdout", bytes);
    });
    child.stderr.on("data", (bytes: Buffer) => {
      acceptData("stderr", bytes);
    });
    child.stdin.on("error", () => undefined);

    let resolveCompletion: ((result: Result<ProcessExit, DomainError>) => void) | undefined;
    const completion = new Promise<Result<ProcessExit, DomainError>>((resolve) => {
      resolveCompletion = resolve;
    });
    child.once("error", (error) => {
      if (timers.deadline !== undefined) clearTimeout(timers.deadline);
      if (timers.kill !== undefined) clearTimeout(timers.kill);
      flush("stdout");
      flush("stderr");
      output.close();
      resolveCompletion?.(err(processError(error)));
    });
    child.once("close", (exitCode, signal) => {
      if (timers.deadline !== undefined) clearTimeout(timers.deadline);
      if (timers.kill !== undefined) clearTimeout(timers.kill);
      flush("stdout");
      flush("stderr");
      output.close();
      if (signal !== null && !supportedSignals.has(signal as ProcessSignal)) {
        resolveCompletion?.(failure("external_failure"));
        return;
      }
      resolveCompletion?.(
        ok({
          exitCode,
          signal: signal as ProcessSignal | null,
          startedAt,
          exitedAt: this.#clock.now(),
          outputTruncated,
        }),
      );
    });

    const spawned = await new Promise<Result<void, DomainError>>((resolve) => {
      child.once("spawn", () => {
        resolve(ok(undefined));
      });
      child.once("error", (error) => {
        resolve(err(processError(error)));
      });
    });
    if (!spawned.ok) return spawned;
    if (signalAborted(options.signal)) {
      child.kill("SIGTERM");
      return failure("interrupted");
    }
    const handle = new NodeChildProcessHandle(child, output, completion);
    const deadlineDelay = Math.max(0, deadlineMs - Date.now());
    timers.deadline = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      timers.kill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, this.#killGraceMs);
      timers.kill.unref();
    }, deadlineDelay);
    timers.deadline.unref();

    if (request.stdin === undefined) child.stdin.end();
    else child.stdin.end(Buffer.from(request.stdin));
    return ok(handle);
  }
}
