import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

import {
  createClock,
  instantFromDate,
  type Clock,
  type Instant,
} from "../../../domain/foundation/index.js";

const maximumOutputBytes = 64 * 1024;
const defaultTimeoutMs = 15_000;

export interface CodexQuotaCollectorConfig {
  readonly expectedCliVersion: string;
}

export type CodexQuotaDiagnosticResult =
  | Readonly<{
      provider: "codex";
      state: "partial";
      reason: "five_hour_unavailable" | "admission_not_enabled";
      accountFingerprint: string;
      cliVersion: string;
      observedAt: Instant;
      provenance: "codex_app_server_v1";
      buckets: Readonly<{
        weekly?: Readonly<{ remainingPercent: number; resetsAt: Instant }>;
        fiveHour?: Readonly<{ remainingPercent: number; resetsAt: Instant }>;
      }>;
    }>
  | Readonly<{
      provider: "codex";
      state: "unknown";
      reason: "app_server_unavailable" | "runtime_context_changed" | "version_unavailable";
    }>;

export interface CodexQuotaCollector {
  collect(config: CodexQuotaCollectorConfig): Promise<CodexQuotaDiagnosticResult>;
}

export interface CodexAppServerEpoch {
  readonly cliVersion: string;
  readonly accountBefore: unknown;
  readonly rateLimits: unknown;
  readonly accountAfter: unknown;
}

export interface CodexAppServerEpochPort {
  read(executable: string, timeoutMs: number): Promise<CodexAppServerEpoch | undefined>;
}

type JsonRecord = Readonly<Record<string, unknown>>;

function record(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function hasExactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === expected.length &&
    actual.every((key) => typeof key === "string" && expected.includes(key))
  );
}

function normalizeVersion(text: string): string | undefined {
  const match = /^codex-cli (\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/u.exec(text.trimEnd());
  return match?.[1];
}

function accountIdentity(input: unknown): Readonly<{ digest: string; plan: string }> | undefined {
  const account = record(record(input)?.["account"]);
  const email = account?.["email"];
  const plan = account?.["planType"];
  if (account?.["type"] !== "chatgpt" || typeof email !== "string" || typeof plan !== "string") {
    return undefined;
  }
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0 || plan.trim().length === 0) return undefined;
  return Object.freeze({
    digest: createHash("sha256")
      .update("agent-team:codex-account:v1\0", "utf8")
      .update(normalized, "utf8")
      .digest("hex"),
    plan,
  });
}

function parseWindow(
  input: unknown,
  duration: 300 | 10_080,
  nowMillis: number,
): Readonly<{ remainingPercent: number; resetsAt: Instant }> | undefined {
  const window = record(input);
  if (
    window === undefined ||
    !hasExactKeys(window, ["usedPercent", "windowDurationMins", "resetsAt"]) ||
    window["windowDurationMins"] !== duration
  ) {
    return undefined;
  }
  const used = window["usedPercent"];
  const reset = window["resetsAt"];
  if (
    typeof used !== "number" ||
    !Number.isFinite(used) ||
    used < 0 ||
    used > 100 ||
    typeof reset !== "number" ||
    !Number.isSafeInteger(reset)
  ) {
    return undefined;
  }
  const instant = instantFromDate(new Date(reset * 1_000));
  return instant.ok && Date.parse(instant.value) > nowMillis
    ? Object.freeze({ remainingPercent: 100 - used, resetsAt: instant.value })
    : undefined;
}

class NodeCodexAppServerEpochPort implements CodexAppServerEpochPort {
  async read(executable: string, timeoutMs: number): Promise<CodexAppServerEpoch | undefined> {
    const version = await new Promise<string | undefined>((resolve) => {
      const child = spawn(executable, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
      const output: Buffer[] = [];
      let bytes = 0;
      let stderrBytes = 0;
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes <= maximumOutputBytes) output.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
      });
      child.once("error", () => {
        resolve(undefined);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        if (code !== 0 || signal !== null || stderrBytes !== 0 || bytes > maximumOutputBytes) {
          resolve(undefined);
          return;
        }
        try {
          resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(output)));
        } catch {
          resolve(undefined);
        }
      });
    });
    if (version === undefined) return undefined;

    return await new Promise<CodexAppServerEpoch | undefined>((resolve) => {
      const child = spawn(executable, ["app-server", "--stdio"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const lines = createInterface({ input: child.stdout });
      const pending = new Map<number, (value: unknown) => void>();
      let totalBytes = 0;
      let invalid = false;
      let settled = false;
      const finish = (value: CodexAppServerEpoch | undefined): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        lines.close();
        child.stdin.end();
        child.kill("SIGTERM");
        resolve(value);
      };
      const timer = setTimeout(() => {
        finish(undefined);
      }, timeoutMs);
      child.stderr.on("data", (chunk: Buffer) => {
        totalBytes += chunk.byteLength;
        invalid = true;
        if (totalBytes > maximumOutputBytes) finish(undefined);
      });
      child.once("error", () => {
        finish(undefined);
      });
      lines.on("line", (line) => {
        totalBytes += Buffer.byteLength(line);
        if (totalBytes > maximumOutputBytes) {
          finish(undefined);
          return;
        }
        let message: JsonRecord | undefined;
        try {
          message = record(JSON.parse(line) as unknown);
        } catch {
          invalid = true;
          return;
        }
        const id = message?.["id"];
        if (typeof id !== "number" || !pending.has(id)) return;
        const complete = pending.get(id);
        pending.delete(id);
        complete?.(message?.["error"] === undefined ? message?.["result"] : undefined);
      });
      const write = (message: JsonRecord): boolean =>
        child.stdin.write(`${JSON.stringify(message)}\n`);
      const request = (id: number, method: string, params?: JsonRecord): Promise<unknown> =>
        new Promise((complete) => {
          pending.set(id, complete);
          write(params === undefined ? { method, id } : { method, id, params });
        });
      void (async () => {
        const initialized = await request(0, "initialize", {
          clientInfo: {
            name: "agent_team_quota_probe",
            title: "Agent Team quota probe",
            version: "1.0.0",
          },
          capabilities: { optOutNotificationMethods: ["account/rateLimits/updated"] },
        });
        if (initialized === undefined || (() => invalid)()) {
          finish(undefined);
          return;
        }
        write({ method: "initialized", params: {} });
        const accountBefore = await request(1, "account/read", { refreshToken: false });
        const rateLimits = await request(2, "account/rateLimits/read");
        const accountAfter = await request(3, "account/read", { refreshToken: false });
        finish(
          (() => invalid)() ||
            accountBefore === undefined ||
            rateLimits === undefined ||
            accountAfter === undefined
            ? undefined
            : Object.freeze({ cliVersion: version, accountBefore, rateLimits, accountAfter }),
        );
      })().catch(() => {
        finish(undefined);
      });
    });
  }
}

export interface CreateCodexQuotaCollectorOptions {
  readonly executable?: string;
  readonly timeoutMs?: number;
  readonly clock?: Clock;
  readonly epoch?: CodexAppServerEpochPort;
}

export function createCodexQuotaCollector(
  options: CreateCodexQuotaCollectorOptions = {},
): CodexQuotaCollector {
  const executable = options.executable ?? "codex";
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const clock = options.clock ?? createClock();
  const epoch = options.epoch ?? new NodeCodexAppServerEpochPort();
  return Object.freeze({
    async collect(config: CodexQuotaCollectorConfig) {
      const observed = await epoch.read(executable, timeoutMs);
      if (observed === undefined) {
        return Object.freeze({
          provider: "codex",
          state: "unknown",
          reason: "app_server_unavailable",
        });
      }
      const version = normalizeVersion(observed.cliVersion);
      if (version === undefined || version !== config.expectedCliVersion) {
        return Object.freeze({
          provider: "codex",
          state: "unknown",
          reason: "version_unavailable",
        });
      }
      const before = accountIdentity(observed.accountBefore);
      const after = accountIdentity(observed.accountAfter);
      if (before === undefined || after?.digest !== before.digest || after.plan !== before.plan) {
        return Object.freeze({
          provider: "codex",
          state: "unknown",
          reason: "runtime_context_changed",
        });
      }
      const now = clock.now();
      const nowMillis = Date.parse(now);
      const limits = record(record(observed.rateLimits)?.["rateLimits"]);
      if (limits === undefined) {
        return Object.freeze({
          provider: "codex",
          state: "unknown",
          reason: "app_server_unavailable",
        });
      }
      const windows = [limits["primary"], limits["secondary"]];
      if (
        windows.some((window) => {
          if (window === null || window === undefined) return false;
          const parsed = record(window);
          return (
            parsed === undefined ||
            !hasExactKeys(parsed, ["usedPercent", "windowDurationMins", "resetsAt"])
          );
        })
      ) {
        return Object.freeze({
          provider: "codex",
          state: "unknown",
          reason: "app_server_unavailable",
        });
      }
      const weekly = windows.map((window) => parseWindow(window, 10_080, nowMillis)).find(Boolean);
      const fiveHour = windows.map((window) => parseWindow(window, 300, nowMillis)).find(Boolean);
      if (weekly === undefined && fiveHour === undefined) {
        return Object.freeze({
          provider: "codex",
          state: "unknown",
          reason: "app_server_unavailable",
        });
      }
      return Object.freeze({
        provider: "codex",
        state: "partial",
        reason: fiveHour === undefined ? "five_hour_unavailable" : "admission_not_enabled",
        accountFingerprint: before.digest,
        cliVersion: version,
        observedAt: now,
        provenance: "codex_app_server_v1",
        buckets: Object.freeze({
          ...(weekly === undefined ? {} : { weekly }),
          ...(fiveHour === undefined ? {} : { fiveHour }),
        }),
      });
    },
  });
}
