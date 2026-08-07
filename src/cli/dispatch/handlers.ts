/**
 * C015a: CLI handler for `agent-team run --project <id> [--dry-run]`. Mirrors the exact shape
 * `createRegistrationProbeHandlers` (src/cli/registration/probe-handlers.ts) already established:
 * a fixed per-reason Traditional-Chinese message table for every `blocked` composition reason
 * (missing config -> exit code 3, zero external calls -- program.ts's `outcomeExitCode` maps
 * `state:"blocked"` to `cliExitCodes.blocked` unconditionally), and a `buildComposition` override
 * hook so tests can inject a fake composition without touching any real file/network.
 */
import { randomUUID } from "node:crypto";

import type { CliHandlers } from "../program.js";
import { LeaseCoordinator } from "../../application/leases/index.js";
import {
  buildDispatchComposition,
  dispatchOnce,
  type BuildDispatchCompositionResult,
  type DispatchCompositionBlockedReason,
} from "./composition.js";
import { InMemoryJobRepository, InMemoryLeaseRepository } from "./ephemeral-ports.js";

export interface CreateDispatchCliHandlersOptions {
  readonly agentTeamHome: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Injectable for tests; production defaults to the real `buildDispatchComposition`. */
  readonly buildComposition?: (
    options: Parameters<typeof buildDispatchComposition>[0],
  ) => Promise<BuildDispatchCompositionResult>;
  /** Injectable for tests (deterministic assertions); production defaults to a fresh random id
   * per invocation. This value is not a convention C015b needs to reconstruct -- it is durably
   * recorded on the persisted `Lease` itself (`Lease.holderId`), so C015b can always discover the
   * exact holder of an active lease by reading the lease file back. */
  readonly generateHolderId?: () => string;
}

type DispatchHandlers = Pick<CliHandlers, "run">;

const blockedMessages: Readonly<Record<DispatchCompositionBlockedReason, string>> = Object.freeze({
  draft_unavailable:
    "找不到有效的 Setup draft 檔（${AGENT_TEAM_HOME}/config/registration/<projectId>.draft.json），或格式不符 schema。",
  linear_api_key_missing: "缺少 LINEAR_API_KEY 環境變數。",
  routing_config_unavailable:
    "找不到有效的 Model Routing 設定檔（${AGENT_TEAM_HOME}/config/dispatch/routing.json），或格式不符 schema。",
  invalid_registry_entry: "專案設定物件本身不符合 Project schema。",
  trusted_config_missing: "專案 repository 內找不到 .agent-team/project.json。",
  trusted_config_unavailable: "讀取專案 repository 內 .agent-team/project.json 失敗。",
  trusted_config_invalid: "專案 repository 內 .agent-team/project.json 格式不符 schema。",
  secret_in_trusted_config: ".agent-team/project.json 內偵測到疑似機密內容，拒絕載入。",
  project_id_mismatch: "Draft 內的 project id 與 repository 內信任設定不一致。",
  default_branch_mismatch: "Draft 內的 defaultBranch 與 repository 內信任設定不一致。",
  platform_mismatch:
    "Draft 內的 workManagement／sourceControl 設定與 repository 內信任設定不一致。",
  activation_missing: "此 project 尚未完成 Registration Setup activation。",
  activation_unavailable: "讀取 Registration Setup activation 記錄失敗。",
  activation_invalid: "Registration Setup activation 記錄格式不符 schema。",
  registry_conflict: "此 project 與其他已註冊專案的 id／repository 衝突。",
});

function outcome(state: "success" | "failed" | "blocked", payload: unknown) {
  return Object.freeze({ state, message: JSON.stringify(payload) });
}

export function createDispatchCliHandlers(
  options: CreateDispatchCliHandlersOptions,
): DispatchHandlers {
  const generateHolderId = options.generateHolderId ?? (() => `cli-dispatch:${randomUUID()}`);

  return Object.freeze({
    async run(input) {
      if (input.projectId === undefined || input.projectId.trim().length === 0) {
        return outcome("blocked", {
          operation: "dispatch_run",
          state: "blocked",
          reason: "project_id_required",
          message: "run 需要 --project <project-id>。",
        });
      }
      const build = await (options.buildComposition ?? buildDispatchComposition)({
        agentTeamHome: options.agentTeamHome,
        projectId: input.projectId,
        ...(options.environment === undefined ? {} : { environment: options.environment }),
      });
      if (build.state !== "ready") {
        return outcome("blocked", {
          operation: "dispatch_run",
          state: "blocked",
          reason: build.reason,
          message: blockedMessages[build.reason],
        });
      }

      const holderId = generateHolderId();
      const dryRun = input.dryRun === true;
      const ports = dryRun
        ? {
            leases: new LeaseCoordinator(new InMemoryLeaseRepository()),
            jobs: new InMemoryJobRepository(),
          }
        : { leases: new LeaseCoordinator(build.value.leases), jobs: build.value.jobs };

      const { result, candidates, discoverySkipped } = await dispatchOnce(
        build.value,
        ports,
        holderId,
      );
      const candidateSummaries = candidates.map((candidate) => ({
        issueId: candidate.issue.id,
        externalId: candidate.issue.externalId,
        title: candidate.issue.title,
        agentRole: candidate.issue.agentRole,
        priority: candidate.issue.priority,
        readyAt: candidate.readyAt,
        stage: candidate.stage,
        workKind: candidate.workKind,
      }));

      if (dryRun) {
        return outcome("success", {
          operation: "dispatch_run",
          state: "dry_run",
          projectId: input.projectId,
          result,
          discoverySkipped,
          candidateSummaries,
        });
      }

      switch (result.kind) {
        case "dispatched":
          return outcome("success", {
            operation: "dispatch_run",
            state: "dispatched",
            projectId: input.projectId,
            jobId: result.job.id,
            issueId: result.job.issueId,
            leaseId: result.lease.id,
            holderId,
            skipped: result.skipped,
            discoverySkipped,
          });
        case "waiting":
          return outcome("success", {
            operation: "dispatch_run",
            state: "waiting",
            projectId: input.projectId,
            reason: result.reason,
            skipped: result.skipped,
            discoverySkipped,
          });
        case "blocked":
          return outcome("failed", {
            operation: "dispatch_run",
            state: "blocked",
            projectId: input.projectId,
            reason: result.reason,
            skipped: result.skipped,
            discoverySkipped,
          });
      }
    },
  });
}
