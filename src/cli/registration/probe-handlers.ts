import type { RegistrationCliHandlers } from "../program.js";
import { registrationProbeRunConfirmationPhrase } from "./confirmation.js";
import { readStdinConfirmation } from "./confirmation.js";
import {
  buildRegistrationProbeComposition,
  type RegistrationProbeCompositionBlockedReason,
} from "./probe-composition.js";

export interface CreateRegistrationProbeHandlersOptions {
  readonly agentTeamHome: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly stdin?: AsyncIterable<Uint8Array | string>;
  /** Injectable for tests; production defaults to the real buildRegistrationProbeComposition. */
  readonly buildComposition?: typeof buildRegistrationProbeComposition;
}

type ProbeHandlers = Pick<RegistrationCliHandlers, "probeRun" | "probeStatus">;

const blockedMessages: Readonly<Record<RegistrationProbeCompositionBlockedReason, string>> =
  Object.freeze({
    draft_unavailable:
      "找不到有效的 Setup draft 檔（${AGENT_TEAM_HOME}/config/registration/<projectId>.draft.json），或格式不符 schema。",
    probe_config_unavailable:
      "找不到有效的 Probe 設定檔（${AGENT_TEAM_HOME}/config/registration/<projectId>.probe.json），或格式不符 schema。",
    linear_api_key_missing: "缺少 LINEAR_API_KEY 環境變數。",
    github_authentication_unavailable: "gh 尚未通過身分驗證（gh auth status 失敗）。",
    webhook_secret_unavailable:
      "找不到有效的 Webhook secret 檔（${AGENT_TEAM_HOME}/secrets/{github,linear}-webhook-secret），或權限不是 0600。",
    activation_not_found: "此 project 尚未完成 Registration Setup activation，無法執行 Probe。",
  });

function outcome(state: "success" | "failed" | "blocked" | "rejected", payload: unknown) {
  return Object.freeze({ state, message: JSON.stringify(payload) });
}

async function requireReadyComposition(
  options: CreateRegistrationProbeHandlersOptions,
  input: Readonly<{ projectId: string }>,
) {
  const build = await (options.buildComposition ?? buildRegistrationProbeComposition)({
    agentTeamHome: options.agentTeamHome,
    projectId: input.projectId,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  });
  if (build.state !== "ready") {
    return {
      ready: false as const,
      outcome: outcome("blocked", {
        operation: "registration_probe",
        state: "blocked",
        reason: build.reason,
        message: blockedMessages[build.reason],
      }),
    };
  }
  return { ready: true as const, value: build.value };
}

export function createRegistrationProbeHandlers(
  options: CreateRegistrationProbeHandlersOptions,
): ProbeHandlers {
  const stdin = options.stdin ?? process.stdin;

  return Object.freeze({
    async probeRun(input) {
      const confirmation = await readStdinConfirmation(stdin);
      if (!confirmation.ok || confirmation.value !== registrationProbeRunConfirmationPhrase) {
        return outcome("rejected", {
          operation: "registration_probe_run",
          state: "rejected",
          reason: "confirmation_mismatch",
        });
      }
      const built = await requireReadyComposition(options, input);
      if (!built.ready) return built.outcome;

      const runOutcome = await built.value.coordinator.start(built.value.command);
      switch (runOutcome.state) {
        case "verified":
          return outcome("success", {
            operation: "registration_probe_run",
            state: "verified",
            runId: runOutcome.run.runId,
          });
        case "incomplete":
          return outcome("blocked", {
            operation: "registration_probe_run",
            state: "incomplete",
            reason: runOutcome.reason,
          });
        case "cleanup_required":
          return outcome("failed", {
            operation: "registration_probe_run",
            state: "cleanup_required",
            runId: runOutcome.run.runId,
            cleanup: runOutcome.run.cleanup,
          });
        case "failed":
          return outcome("failed", {
            operation: "registration_probe_run",
            state: "failed",
            stage: runOutcome.stage,
            reason: runOutcome.reason,
            runId: runOutcome.run.runId,
          });
      }
    },

    async probeStatus(input) {
      const built = await requireReadyComposition(options, input);
      if (!built.ready) return built.outcome;

      const active = await built.value.journal.listActiveForProject(built.value.command.project.id);
      if (!active.ok) {
        return outcome("failed", {
          operation: "registration_probe_status",
          state: "failed",
          reason: "journal_read_failed",
        });
      }
      return outcome("success", {
        operation: "registration_probe_status",
        state: active.value.length === 0 ? "idle" : "active",
        activeRuns: active.value.map((run) => ({ runId: run.runId, phase: run.phase })),
      });
    },
  });
}
