import { getuid } from "node:process";

import type { ProcessPort, ReadOptions } from "../../../application/ports/index.js";
import {
  createClock,
  instantFromDate,
  type Clock,
  type Instant,
} from "../../../domain/foundation/index.js";
import { readClaudeStatusSnapshot, type ClaudeQuotaCollectorConfig } from "./quota-collector.js";

const defaultTimeoutMs = 45_000;
const defaultPollIntervalMs = 250;
const maximumTerminalOutputBytes = 256 * 1024;
const fixedPrompt = "Reply with exactly OK and nothing else.";
const fixedModel = "haiku";
const fixedSessionName = "agent-team-quota-refresh";
const endOfTransmission = Uint8Array.from([0x04, 0x04]);

export type ClaudeQuotaRefreshResult = Readonly<{
  state: "refreshed" | "failed";
  reason:
    | "snapshot_refreshed"
    | "process_unavailable"
    | "snapshot_not_refreshed"
    | "process_failed"
    | "interrupted";
}>;

export interface ClaudeQuotaRefresher {
  refresh(
    config: ClaudeQuotaCollectorConfig,
    options?: ReadOptions,
  ): Promise<ClaudeQuotaRefreshResult>;
}

export interface CreateClaudeQuotaRefresherOptions {
  readonly process: ProcessPort;
  readonly claudeExecutable?: string;
  readonly workingDirectory: string;
  readonly clock?: Clock;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly scriptExecutable?: string;
  readonly expectedUid?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function command(executable: string): string {
  const arguments_ = [
    fixedPrompt,
    "--model",
    fixedModel,
    "--effort",
    "low",
    "--tools",
    "",
    "--permission-mode",
    "dontAsk",
    "--disable-slash-commands",
    "--setting-sources",
    "user",
    "--no-chrome",
    "--name",
    fixedSessionName,
  ];
  return `exec ${[executable, ...arguments_].map(shellQuote).join(" ")}`;
}

function failed(reason: Exclude<ClaudeQuotaRefreshResult["reason"], "snapshot_refreshed">) {
  return Object.freeze({ state: "failed" as const, reason });
}

function refreshed(): ClaudeQuotaRefreshResult {
  return Object.freeze({ state: "refreshed", reason: "snapshot_refreshed" });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function instantMilliseconds(value: Instant): number | undefined {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

function isInterrupted(options: ReadOptions): boolean {
  return options.signal?.aborted === true;
}

export function createClaudeQuotaRefresher(
  options: CreateClaudeQuotaRefresherOptions,
): ClaudeQuotaRefresher {
  const clock = options.clock ?? createClock();
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
  const executable = options.claudeExecutable ?? "claude";
  const scriptExecutable = options.scriptExecutable ?? "/usr/bin/script";
  const expectedUid = options.expectedUid ?? getuid?.() ?? -1;
  const sleep = options.sleep ?? delay;

  return Object.freeze({
    async refresh(config: ClaudeQuotaCollectorConfig, readOptions: ReadOptions = {}) {
      if (isInterrupted(readOptions)) return failed("interrupted");
      const startedAt = clock.now();
      const startedMs = instantMilliseconds(startedAt);
      if (startedMs === undefined) return failed("process_unavailable");
      const deadline = instantFromDate(new Date(startedMs + timeoutMs));
      if (!deadline.ok) return failed("process_unavailable");

      const baseline = await readClaudeStatusSnapshot(
        config.statusSnapshotPath,
        expectedUid,
        startedAt,
        Number.MAX_SAFE_INTEGER,
      );
      const baselineMs =
        baseline.state === "ready" ? instantMilliseconds(baseline.observedAt) : undefined;
      const spawned = await options.process.spawn(
        {
          executable: scriptExecutable,
          arguments: [
            "--quiet",
            "--return",
            "--flush",
            "--command",
            command(executable),
            "/dev/null",
          ],
          workingDirectory: options.workingDirectory,
          keepStdinOpen: true,
          deadlineAt: deadline.value,
          maxOutputBytes: maximumTerminalOutputBytes,
        },
        readOptions,
      );
      if (!spawned.ok) return failed("process_unavailable");

      const handle = spawned.value;
      const drained = (async () => {
        try {
          for await (const chunk of handle.output) {
            // TUI/model output is untrusted and is intentionally discarded.
            void chunk;
          }
        } catch {
          // wait() below remains the process authority.
        }
      })();
      const completion = handle.wait(readOptions);
      let sawFreshSnapshot = false;

      const maximumPolls = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
      for (let poll = 0; poll <= maximumPolls; poll += 1) {
        if (isInterrupted(readOptions)) {
          await handle.sendSignal("SIGTERM");
          await completion;
          await drained;
          return failed("interrupted");
        }
        const candidate = await readClaudeStatusSnapshot(
          config.statusSnapshotPath,
          expectedUid,
          clock.now(),
          config.maxSampleAgeMs,
        );
        if (candidate.state === "ready") {
          const candidateMs = instantMilliseconds(candidate.observedAt);
          if (
            candidateMs !== undefined &&
            candidateMs >= Math.floor(startedMs / 1_000) * 1_000 &&
            (baselineMs === undefined || candidateMs > baselineMs)
          ) {
            sawFreshSnapshot = true;
            break;
          }
        }
        const step = await Promise.race([
          completion.then((result) => ({ kind: "exit" as const, result })),
          sleep(pollIntervalMs).then(() => ({ kind: "poll" as const })),
        ]);
        if (step.kind === "exit") {
          await drained;
          return failed("snapshot_not_refreshed");
        }
      }

      if (!sawFreshSnapshot) {
        await handle.sendSignal("SIGTERM");
        await completion;
        await drained;
        return failed("snapshot_not_refreshed");
      }
      const wrote = await handle.writeStdin(endOfTransmission);
      if (!wrote.ok) {
        await completion;
        await drained;
        return failed("process_failed");
      }
      await handle.closeStdin();
      const exited = await completion;
      await drained;
      return exited.ok &&
        exited.value.exitCode === 0 &&
        exited.value.signal === null &&
        !exited.value.outputTruncated
        ? refreshed()
        : failed("process_failed");
    },
  });
}
