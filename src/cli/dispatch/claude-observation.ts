/**
 * C015b item 2: the minimal *real* `routeObservations` source for the single-Claude-provider
 * path (`leadi` 已裁決單 Claude provider 最小路徑). "Real" specifically means: this actually
 * spawns the configured executable (`--version`, a real bounded child process via the injected
 * `ProcessPort`) and observes whether it exits zero -- unlike `ClaudeRunner.inspectCapabilities()`
 * (src/adapters/providers/claude/runner.ts), which is a static echo of its own constructor
 * options and never touches a real process, this function is the one place in C015b that
 * genuinely asks "is Claude alive right now."
 *
 * Quota is deliberately NOT attempted here. T03A's composition calls this liveness-only probe
 * solely after a separate trusted quota observation is already ready, then intersects the two
 * results; this function's `"ready"` therefore means only "the executable answered", never
 * "admission is safe" on its own. Every observation it returns is either `"ready"` or
 * `"provider_unavailable"`; quota and provider-slot states belong to their own policy layers.
 */
import type { ProcessPort } from "../../application/ports/index.js";
import type { CandidateObservation } from "../../application/routing/index.js";
import {
  createClock,
  instantFromDate,
  type Clock,
  type Instant,
} from "../../domain/foundation/index.js";
import type { DispatchProviderConfig } from "./provider-config-store.js";

export interface ObserveClaudeRouteCandidatesOptions {
  readonly process: ProcessPort;
  readonly config: DispatchProviderConfig["claude"];
  /** Must be an absolute, real directory the spawned process can use as its cwd -- the capability
   * probe does not write anything, but `ProcessSpawnRequest.workingDirectory` is mandatory. */
  readonly workingDirectory: string;
  readonly clock?: Clock;
  /** Bounded per the same "no unbounded child process" invariant every other `ProcessPort`
   * caller in this codebase respects (R001). Default is deliberately short: this is a liveness
   * probe, not real work. */
  readonly timeoutMs?: number;
}

const defaultCapabilityCheckTimeoutMs = 10_000;
const capabilityCheckMaxOutputBytes = 4096;

export async function observeClaudeRouteCandidates(
  options: ObserveClaudeRouteCandidatesOptions,
): Promise<readonly CandidateObservation[]> {
  const clock = options.clock ?? createClock();
  const timeoutMs = options.timeoutMs ?? defaultCapabilityCheckTimeoutMs;
  const deadline = instantFromDate(new Date(Date.parse(clock.now()) + timeoutMs));

  const state = deadline.ok
    ? await probe(
        options.process,
        options.config.executable,
        options.workingDirectory,
        deadline.value,
      )
    : ("provider_unavailable" as const);

  return Object.freeze(
    options.config.models.map((model) =>
      Object.freeze({ provider: "claude" as const, model, state }),
    ),
  );
}

async function probe(
  processPort: ProcessPort,
  executable: string,
  workingDirectory: string,
  deadlineAt: Instant,
): Promise<"ready" | "provider_unavailable"> {
  const spawned = await processPort.spawn({
    executable,
    arguments: ["--version"],
    workingDirectory,
    deadlineAt,
    maxOutputBytes: capabilityCheckMaxOutputBytes,
  });
  if (!spawned.ok) return "provider_unavailable";
  const exit = await spawned.value.wait();
  return exit.ok && exit.value.exitCode === 0 ? "ready" : "provider_unavailable";
}
