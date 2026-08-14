import type { Clock } from "../../domain/foundation/index.js";
import { createClock } from "../../domain/foundation/index.js";
import type { ClaudeQuotaCollector } from "../../adapters/providers/claude/index.js";
import type { CodexQuotaCollector } from "../../adapters/providers/codex/index.js";
import type { CliCommandOutcome } from "../program.js";
import { defaultQuotaHostConfigPath, readQuotaHostConfig } from "./config-store.js";

export type QuotaProbeProvider = "claude" | "codex" | "all";

export interface CreateQuotaProbeStatusHandlerOptions {
  readonly agentTeamHome: string;
  readonly claude: ClaudeQuotaCollector;
  readonly codex: CodexQuotaCollector;
  readonly clock?: Clock;
}

export function createQuotaProbeStatusHandler(
  options: CreateQuotaProbeStatusHandlerOptions,
): (input: Readonly<{ provider: QuotaProbeProvider }>) => Promise<CliCommandOutcome> {
  const clock = options.clock ?? createClock();
  return async (input) => {
    const config = await readQuotaHostConfig(defaultQuotaHostConfigPath(options.agentTeamHome));
    const results = [];
    if (input.provider === "claude" || input.provider === "all") {
      results.push(
        config.ok && config.value.claude.enabled
          ? await options.claude.collect(config.value.claude)
          : Object.freeze({
              provider: "claude" as const,
              state: "unknown" as const,
              reason: config.ok ? ("config_unavailable" as const) : config.reason,
            }),
      );
    }
    if (input.provider === "codex" || input.provider === "all") {
      results.push(
        config.ok && config.value.codex.diagnosticEnabled
          ? await options.codex.collect(config.value.codex)
          : Object.freeze({
              provider: "codex" as const,
              state: "unknown" as const,
              reason: config.ok ? ("config_unavailable" as const) : config.reason,
            }),
      );
    }
    return Object.freeze({
      state: "success" as const,
      message: JSON.stringify({
        schema: "agent-team-quota-probe-status",
        version: 1,
        observedAt: clock.now(),
        results,
      }),
    });
  };
}
