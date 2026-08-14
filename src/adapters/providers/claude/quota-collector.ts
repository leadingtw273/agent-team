import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { getuid } from "node:process";

import { z } from "zod";

import type { ProcessPort } from "../../../application/ports/index.js";
import {
  createClock,
  instantFromDate,
  type Clock,
  type Instant,
} from "../../../domain/foundation/index.js";

const maximumOutputBytes = 32 * 1024;
const maximumSnapshotBytes = 64 * 1024;
const defaultTimeoutMs = 10_000;
const maximumJsonDepth = 32;
const dangerousObjectKeys = new Set(["__proto__", "constructor", "prototype"]);

const authSchema = z
  .object({
    loggedIn: z.literal(true),
    authMethod: z.literal("claude.ai"),
    apiProvider: z.literal("firstParty"),
    email: z.string().nullable(),
    orgId: z.string().min(1),
    orgName: z.string().nullable(),
    subscriptionType: z.string().min(1),
  })
  .strict();

const bucketSchema = z
  .object({
    used_percentage: z.number().min(0).max(100),
    resets_at: z.number().int().positive(),
  })
  .strict();

const statusSnapshotSchema = z
  .object({
    schema: z.literal(1),
    probe_ts: z.number().int().positive(),
    session_id: z.string().min(1),
    rate_limits: z.object({ five_hour: bucketSchema, seven_day: bucketSchema }).strict(),
  })
  .strict();

export interface ClaudeQuotaCollectorConfig {
  readonly statusSnapshotPath: string;
  readonly expectedCliVersion: string;
  readonly maxSampleAgeMs: number;
}

export type ClaudeQuotaDiagnosticResult =
  | Readonly<{
      provider: "claude";
      state: "full";
      accountFingerprint: string;
      cliVersion: string;
      observedAt: Instant;
      provenance: "claude_status_line_v1";
      buckets: Readonly<{
        weekly: Readonly<{ remainingPercent: number; resetsAt: Instant }>;
        fiveHour: Readonly<{ remainingPercent: number; resetsAt: Instant }>;
      }>;
    }>
  | Readonly<{
      provider: "claude";
      state: "unknown";
      reason:
        | "auth_unavailable"
        | "version_unavailable"
        | "runtime_context_changed"
        | "snapshot_unavailable"
        | "snapshot_stale";
    }>;

export interface ClaudeQuotaCollector {
  collect(config: ClaudeQuotaCollectorConfig): Promise<ClaudeQuotaDiagnosticResult>;
}

export interface CreateClaudeQuotaCollectorOptions {
  readonly process: ProcessPort;
  readonly executable?: string;
  readonly workingDirectory: string;
  readonly clock?: Clock;
  readonly timeoutMs?: number;
  readonly expectedUid?: number;
}

type CommandResult = Readonly<{ stdout: Uint8Array }>;

async function runCommand(
  processPort: ProcessPort,
  executable: string,
  arguments_: readonly string[],
  workingDirectory: string,
  clock: Clock,
  timeoutMs: number,
): Promise<CommandResult | undefined> {
  const deadline = instantFromDate(new Date(Date.parse(clock.now()) + timeoutMs));
  if (!deadline.ok) return undefined;
  const spawned = await processPort.spawn({
    executable,
    arguments: arguments_,
    workingDirectory,
    deadlineAt: deadline.value,
    maxOutputBytes: maximumOutputBytes,
  });
  if (!spawned.ok) return undefined;
  const output: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  try {
    for await (const chunk of spawned.value.output) {
      if (chunk.stream === "stderr") stderrBytes += chunk.bytes.byteLength;
      else {
        stdoutBytes += chunk.bytes.byteLength;
        output.push(Buffer.from(chunk.bytes));
      }
      if (stdoutBytes + stderrBytes > maximumOutputBytes) return undefined;
    }
  } catch {
    return undefined;
  }
  const exited = await spawned.value.wait();
  if (
    !exited.ok ||
    exited.value.exitCode !== 0 ||
    exited.value.signal !== null ||
    exited.value.outputTruncated ||
    stderrBytes !== 0 ||
    stdoutBytes === 0
  ) {
    return undefined;
  }
  return Object.freeze({ stdout: Uint8Array.from(Buffer.concat(output)) });
}

type StrictJsonValue =
  null | boolean | number | string | readonly StrictJsonValue[] | StrictJsonObject;
interface StrictJsonObject {
  readonly [key: string]: StrictJsonValue;
}

class StrictJsonParser {
  #offset = 0;

  constructor(private readonly source: string) {}

  parse(): StrictJsonValue {
    const value = this.#parseValue(0);
    this.#skipWhitespace();
    if (this.#offset !== this.source.length) throw new SyntaxError("trailing_json_data");
    return value;
  }

  #parseValue(depth: number): StrictJsonValue {
    if (depth > maximumJsonDepth) throw new SyntaxError("json_depth_exceeded");
    this.#skipWhitespace();
    const character = this.source[this.#offset];
    if (character === "{") return this.#parseObject(depth);
    if (character === "[") return this.#parseArray(depth);
    if (character === '"') return this.#parseString();
    for (const [literal, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (this.source.startsWith(literal, this.#offset)) {
        this.#offset += literal.length;
        return value;
      }
    }
    return this.#parseNumber();
  }

  #parseObject(depth: number): StrictJsonObject {
    this.#expect("{");
    this.#skipWhitespace();
    const object = Object.create(null) as Record<string, StrictJsonValue>;
    const keys = new Set<string>();
    if (this.source[this.#offset] === "}") {
      this.#offset += 1;
      return Object.freeze(object);
    }
    for (;;) {
      this.#skipWhitespace();
      if (this.source[this.#offset] !== '"') throw new SyntaxError("json_key_expected");
      const key = this.#parseString();
      if (keys.has(key) || dangerousObjectKeys.has(key))
        throw new SyntaxError("duplicate_json_key");
      keys.add(key);
      this.#skipWhitespace();
      this.#expect(":");
      object[key] = this.#parseValue(depth + 1);
      this.#skipWhitespace();
      if (this.source[this.#offset] === "}") {
        this.#offset += 1;
        return Object.freeze(object);
      }
      this.#expect(",");
    }
  }

  #parseArray(depth: number): readonly StrictJsonValue[] {
    this.#expect("[");
    this.#skipWhitespace();
    const values: StrictJsonValue[] = [];
    if (this.source[this.#offset] === "]") {
      this.#offset += 1;
      return Object.freeze(values);
    }
    for (;;) {
      values.push(this.#parseValue(depth + 1));
      this.#skipWhitespace();
      if (this.source[this.#offset] === "]") {
        this.#offset += 1;
        return Object.freeze(values);
      }
      this.#expect(",");
    }
  }

  #parseString(): string {
    const start = this.#offset;
    this.#expect('"');
    let escaped = false;
    while (this.#offset < this.source.length) {
      const character = this.source[this.#offset];
      this.#offset += 1;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === '"') {
        const parsed: unknown = JSON.parse(this.source.slice(start, this.#offset));
        if (typeof parsed !== "string") throw new SyntaxError("json_string_expected");
        return parsed;
      }
    }
    throw new SyntaxError("unterminated_json_string");
  }

  #parseNumber(): number {
    const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(
      this.source.slice(this.#offset),
    )?.[0];
    if (token === undefined) throw new SyntaxError("json_value_expected");
    this.#offset += token.length;
    const value = Number(token);
    if (!Number.isFinite(value)) throw new SyntaxError("json_number_invalid");
    return value;
  }

  #skipWhitespace(): void {
    while (/^[\t\n\r ]$/u.test(this.source[this.#offset] ?? "")) this.#offset += 1;
  }

  #expect(character: string): void {
    if (this.source[this.#offset] !== character) throw new SyntaxError("malformed_json");
    this.#offset += 1;
  }
}

function decodeJson(bytes: Uint8Array): unknown {
  try {
    return new StrictJsonParser(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).parse();
  } catch {
    return undefined;
  }
}

function normalizeVersion(bytes: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trimEnd();
    const match = /^(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?: \(Claude Code\))?$/u.exec(text);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function fingerprint(orgId: string): string {
  return createHash("sha256")
    .update("agent-team:claude-org:v1\0", "utf8")
    .update(orgId, "utf8")
    .digest("hex");
}

export type ClaudeStatusSnapshotReadResult =
  | Readonly<{
      state: "ready";
      observedAt: Instant;
      weekly: Readonly<{ remainingPercent: number; resetsAt: Instant }>;
      fiveHour: Readonly<{ remainingPercent: number; resetsAt: Instant }>;
    }>
  | Readonly<{ state: "unavailable" | "stale" }>;

export async function readClaudeStatusSnapshot(
  path: string,
  expectedUid: number,
  now: Instant,
  maxSampleAgeMs: number,
): Promise<ClaudeStatusSnapshotReadResult> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.uid !== BigInt(expectedUid) ||
        (before.mode & 0o777n) !== 0o600n ||
        before.nlink !== 1n ||
        before.size <= 0n ||
        before.size > BigInt(maximumSnapshotBytes)
      ) {
        return Object.freeze({ state: "unavailable" });
      }
      const bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs
      ) {
        return Object.freeze({ state: "unavailable" });
      }
      const verified = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const canonical = await verified.stat({ bigint: true });
        if (canonical.dev !== before.dev || canonical.ino !== before.ino) {
          return Object.freeze({ state: "unavailable" });
        }
      } finally {
        await verified.close();
      }
      const parsed = statusSnapshotSchema.safeParse(decodeJson(bytes));
      if (!parsed.success) return Object.freeze({ state: "unavailable" });
      const probeMillis = parsed.data.probe_ts * 1_000;
      if (before.mtimeNs / 1_000_000_000n !== BigInt(parsed.data.probe_ts)) {
        return Object.freeze({ state: "unavailable" });
      }
      const nowMillis = Date.parse(now);
      const age = nowMillis - probeMillis;
      if (!Number.isFinite(age) || age < 0 || age > maxSampleAgeMs) {
        return Object.freeze({ state: "stale" });
      }
      const observedAtResult = instantFromDate(new Date(probeMillis));
      const weeklyReset = instantFromDate(
        new Date(parsed.data.rate_limits.seven_day.resets_at * 1_000),
      );
      const fiveHourReset = instantFromDate(
        new Date(parsed.data.rate_limits.five_hour.resets_at * 1_000),
      );
      if (
        !observedAtResult.ok ||
        !weeklyReset.ok ||
        !fiveHourReset.ok ||
        Date.parse(weeklyReset.value) <= nowMillis ||
        Date.parse(fiveHourReset.value) <= nowMillis
      ) {
        return Object.freeze({ state: "unavailable" });
      }
      return Object.freeze({
        state: "ready",
        observedAt: observedAtResult.value,
        weekly: Object.freeze({
          remainingPercent: 100 - parsed.data.rate_limits.seven_day.used_percentage,
          resetsAt: weeklyReset.value,
        }),
        fiveHour: Object.freeze({
          remainingPercent: 100 - parsed.data.rate_limits.five_hour.used_percentage,
          resetsAt: fiveHourReset.value,
        }),
      });
    } finally {
      await handle.close();
    }
  } catch {
    return Object.freeze({ state: "unavailable" });
  }
}

export function createClaudeQuotaCollector(
  options: CreateClaudeQuotaCollectorOptions,
): ClaudeQuotaCollector {
  const clock = options.clock ?? createClock();
  const executable = options.executable ?? "claude";
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const expectedUid = options.expectedUid ?? getuid?.() ?? -1;
  return Object.freeze({
    async collect(config: ClaudeQuotaCollectorConfig) {
      const authBeforeRaw = await runCommand(
        options.process,
        executable,
        ["auth", "status", "--json"],
        options.workingDirectory,
        clock,
        timeoutMs,
      );
      const authBefore = authSchema.safeParse(
        authBeforeRaw === undefined ? undefined : decodeJson(authBeforeRaw.stdout),
      );
      if (!authBefore.success) {
        return Object.freeze({ provider: "claude", state: "unknown", reason: "auth_unavailable" });
      }
      const versionBeforeRaw = await runCommand(
        options.process,
        executable,
        ["--version"],
        options.workingDirectory,
        clock,
        timeoutMs,
      );
      const versionBefore =
        versionBeforeRaw === undefined ? undefined : normalizeVersion(versionBeforeRaw.stdout);
      if (versionBefore === undefined || versionBefore !== config.expectedCliVersion) {
        return Object.freeze({
          provider: "claude",
          state: "unknown",
          reason: "version_unavailable",
        });
      }
      const snapshot = await readClaudeStatusSnapshot(
        config.statusSnapshotPath,
        expectedUid,
        clock.now(),
        config.maxSampleAgeMs,
      );
      if (snapshot.state !== "ready") {
        return Object.freeze({
          provider: "claude",
          state: "unknown",
          reason: snapshot.state === "stale" ? "snapshot_stale" : "snapshot_unavailable",
        });
      }
      const versionAfterRaw = await runCommand(
        options.process,
        executable,
        ["--version"],
        options.workingDirectory,
        clock,
        timeoutMs,
      );
      const authAfterRaw = await runCommand(
        options.process,
        executable,
        ["auth", "status", "--json"],
        options.workingDirectory,
        clock,
        timeoutMs,
      );
      const versionAfter =
        versionAfterRaw === undefined ? undefined : normalizeVersion(versionAfterRaw.stdout);
      const authAfter = authSchema.safeParse(
        authAfterRaw === undefined ? undefined : decodeJson(authAfterRaw.stdout),
      );
      if (
        versionAfter !== versionBefore ||
        !authAfter.success ||
        authAfter.data.orgId !== authBefore.data.orgId
      ) {
        return Object.freeze({
          provider: "claude",
          state: "unknown",
          reason: "runtime_context_changed",
        });
      }
      return Object.freeze({
        provider: "claude",
        state: "full",
        accountFingerprint: fingerprint(authBefore.data.orgId),
        cliVersion: versionBefore,
        observedAt: snapshot.observedAt,
        provenance: "claude_status_line_v1",
        buckets: Object.freeze({ weekly: snapshot.weekly, fiveHour: snapshot.fiveHour }),
      });
    },
  });
}
