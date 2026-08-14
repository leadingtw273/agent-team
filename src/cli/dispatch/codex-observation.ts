import type { ProcessPort } from "../../application/ports/index.js";
import type { CandidateObservation } from "../../application/routing/index.js";
import { createClock, instantFromDate, type Clock } from "../../domain/foundation/index.js";
import type { DispatchProviderConfig } from "./provider-config-store.js";

export async function observeCodexRouteCandidates(options: {
  readonly process: ProcessPort;
  readonly config: DispatchProviderConfig["codex"];
  readonly workingDirectory: string;
  readonly clock?: Clock;
  readonly timeoutMs?: number;
}): Promise<readonly CandidateObservation[]> {
  const clock = options.clock ?? createClock();
  const deadline = instantFromDate(
    new Date(Date.parse(clock.now()) + (options.timeoutMs ?? 10_000)),
  );
  let state: CandidateObservation["state"] = "provider_unavailable";
  if (deadline.ok) {
    const spawned = await options.process.spawn({
      executable: options.config.executable,
      arguments: ["--version"],
      workingDirectory: options.workingDirectory,
      deadlineAt: deadline.value,
      maxOutputBytes: 4096,
    });
    if (spawned.ok) {
      const exited = await spawned.value.wait();
      if (
        exited.ok &&
        exited.value.exitCode === 0 &&
        exited.value.signal === null &&
        !exited.value.outputTruncated
      ) {
        state = "ready";
      }
    }
  }
  return Object.freeze(
    options.config.models.map((model) =>
      Object.freeze({ provider: "codex" as const, model, state }),
    ),
  );
}
