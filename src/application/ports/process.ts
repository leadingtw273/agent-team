import type { Instant } from "../../domain/foundation/index.js";
import type { AsyncPortResult, ReadOptions } from "./common.js";

export type ProcessSignal = "SIGINT" | "SIGTERM" | "SIGKILL";

export interface ProcessSpawnRequest {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly sensitiveEnvironmentKeys?: readonly string[];
  readonly stdin?: Uint8Array;
  readonly deadlineAt: Instant;
  readonly maxOutputBytes: number;
}

export interface ProcessOutputChunk {
  readonly sequence: number;
  readonly stream: "stdout" | "stderr";
  readonly bytes: Uint8Array;
  readonly observedAt: Instant;
}

export interface ProcessExit {
  readonly exitCode: number | null;
  readonly signal: ProcessSignal | null;
  readonly startedAt: Instant;
  readonly exitedAt: Instant;
  readonly outputTruncated: boolean;
}

export interface ChildProcessHandle {
  readonly pid: number;
  readonly output: AsyncIterable<ProcessOutputChunk>;
  wait(options?: ReadOptions): AsyncPortResult<ProcessExit>;
  sendSignal(signal: ProcessSignal, options?: ReadOptions): AsyncPortResult<void>;
}

export interface ProcessPort {
  spawn(request: ProcessSpawnRequest, options?: ReadOptions): AsyncPortResult<ChildProcessHandle>;
}
