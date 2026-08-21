import {
  publicHumanAcceptanceProjection,
  type HumanAcceptanceStorePort,
} from "../../adapters/dispatch/index.js";
import type { WorkManagementPort } from "../../application/ports/index.js";
import type { Project } from "../../domain/project/index.js";
import { ok, type DomainError, type Result } from "../../domain/foundation/index.js";
import type { CliCommandOutcome } from "../program.js";

export interface HumanAcceptanceRuntime {
  readonly project: Project;
  readonly workManagement: Pick<WorkManagementPort, "getIssue" | "setWorkStatus" | "appendComment">;
}

export interface HumanAcceptanceHandlerOptions {
  readonly store: Pick<HumanAcceptanceStorePort, "listPending" | "listForIssue" | "decide">;
  readonly runtime: (projectId: string) => Promise<Result<HumanAcceptanceRuntime, DomainError>>;
}

export interface HumanAcceptanceHandlers {
  readonly humanAcceptanceList: (
    input: Readonly<{ projectId: string }>,
  ) => Promise<CliCommandOutcome>;
  readonly humanAcceptanceAccept: (
    input: Readonly<{ projectId: string; externalIssueId: string }>,
  ) => Promise<CliCommandOutcome>;
  readonly humanAcceptanceRequestAdjustment: (
    input: Readonly<{ projectId: string; externalIssueId: string }>,
  ) => Promise<CliCommandOutcome>;
}

function outcome(
  state: Extract<CliCommandOutcome["state"], "success" | "failed" | "blocked">,
  payload: Readonly<Record<string, unknown>>,
): CliCommandOutcome {
  return Object.freeze({ state, message: JSON.stringify(payload) });
}

function validInput(projectId: string, externalIssueId?: string): boolean {
  return (
    projectId.trim().length > 0 &&
    (externalIssueId === undefined || externalIssueId.trim().length > 0)
  );
}

export function createHumanAcceptanceHandlers(
  options: HumanAcceptanceHandlerOptions,
): HumanAcceptanceHandlers {
  return Object.freeze({
    async humanAcceptanceList(input: Readonly<{ projectId: string }>) {
      if (!validInput(input.projectId)) {
        return outcome("blocked", {
          operation: "human_acceptance_list",
          reason: "invalid_input",
        });
      }
      const pending = await options.store.listPending(input.projectId);
      if (!pending.ok) {
        return outcome("failed", {
          operation: "human_acceptance_list",
          reason: "state_unavailable",
          errorCode: pending.error.code,
        });
      }
      return outcome("success", {
        operation: "human_acceptance_list",
        projectId: input.projectId,
        count: pending.value.length,
        pending: pending.value.map(publicHumanAcceptanceProjection),
      });
    },

    async humanAcceptanceAccept(input: Readonly<{ projectId: string; externalIssueId: string }>) {
      if (!validInput(input.projectId, input.externalIssueId)) {
        return outcome("blocked", {
          operation: "human_acceptance_accept",
          reason: "invalid_input",
        });
      }
      const records = await options.store.listForIssue(input.projectId, input.externalIssueId);
      if (!records.ok) {
        return outcome("failed", {
          operation: "human_acceptance_accept",
          reason: "state_unavailable",
          errorCode: records.error.code,
        });
      }
      const record = [...records.value]
        .reverse()
        .find((candidate) => candidate.state === "pending" || candidate.state === "accepted");
      if (record === undefined) {
        return outcome("blocked", {
          operation: "human_acceptance_accept",
          reason: "pending_acceptance_not_found",
        });
      }
      const receiptId = `human-acceptance:${record.identityDigest}:accept`;
      const alreadyAccepted =
        record.state === "accepted" &&
        record.decisions.some(
          (decision) => decision.decision === "accept" && decision.decisionReceiptId === receiptId,
        );
      if (record.state === "accepted" && !alreadyAccepted) {
        return outcome("blocked", {
          operation: "human_acceptance_accept",
          reason: "acceptance_identity_conflict",
        });
      }
      const runtime = await options.runtime(input.projectId);
      if (!runtime.ok) {
        return outcome("failed", {
          operation: "human_acceptance_accept",
          reason: "runtime_unavailable",
          errorCode: runtime.error.code,
        });
      }
      const workItem = await runtime.value.workManagement.getIssue({
        project: runtime.value.project,
        externalIssueId: input.externalIssueId,
      });
      if (
        !workItem.ok ||
        workItem.value.issue.id !== record.identity.issueId ||
        workItem.value.issue.projectId !== record.identity.projectId ||
        (workItem.value.workStatus !== "in_review" && workItem.value.workStatus !== "completed")
      ) {
        return outcome("blocked", {
          operation: "human_acceptance_accept",
          reason: "work_item_identity_conflict",
        });
      }
      const accepted = alreadyAccepted
        ? ok(record)
        : await options.store.decide(record.identity, record.revision, "accept", receiptId);
      if (!accepted.ok) {
        return outcome("failed", {
          operation: "human_acceptance_accept",
          reason: "acceptance_write_failed",
          errorCode: accepted.error.code,
        });
      }
      if (workItem.value.workStatus !== "completed") {
        const completed = await runtime.value.workManagement.setWorkStatus(
          { project: runtime.value.project, externalIssueId: input.externalIssueId },
          "completed",
          {
            idempotencyKey: `human-acceptance:${record.identityDigest}:mark-done`,
            cause: "github_merge_observed",
          },
        );
        if (!completed.ok || completed.value.workStatus !== "completed") {
          return outcome("failed", {
            operation: "human_acceptance_accept",
            reason: "work_status_projection_failed",
          });
        }
      }
      const comment = await runtime.value.workManagement.appendComment(
        { project: runtime.value.project, externalIssueId: input.externalIssueId },
        "產品負責人已明確接受本次成果；Agent Team 已將工單標記為完成。",
        { idempotencyKey: `human-acceptance:${record.identityDigest}:accepted-comment` },
      );
      if (!comment.ok) {
        return outcome("failed", {
          operation: "human_acceptance_accept",
          reason: "comment_projection_failed",
          errorCode: comment.error.code,
        });
      }
      return outcome("success", {
        operation: "human_acceptance_accept",
        state: "accepted",
        acceptance: publicHumanAcceptanceProjection(accepted.value),
      });
    },

    async humanAcceptanceRequestAdjustment(
      input: Readonly<{ projectId: string; externalIssueId: string }>,
    ) {
      if (!validInput(input.projectId, input.externalIssueId)) {
        return outcome("blocked", {
          operation: "human_acceptance_request_adjustment",
          reason: "invalid_input",
        });
      }
      const pending = await options.store.listForIssue(input.projectId, input.externalIssueId);
      const record = pending.ok
        ? [...pending.value].reverse().find((candidate) => candidate.state === "pending")
        : undefined;
      if (!pending.ok || record === undefined) {
        return outcome(pending.ok ? "blocked" : "failed", {
          operation: "human_acceptance_request_adjustment",
          reason: pending.ok ? "pending_acceptance_not_found" : "state_unavailable",
          ...(pending.ok ? {} : { errorCode: pending.error.code }),
        });
      }
      const runtime = await options.runtime(input.projectId);
      if (!runtime.ok) {
        return outcome("failed", {
          operation: "human_acceptance_request_adjustment",
          reason: "runtime_unavailable",
          errorCode: runtime.error.code,
        });
      }
      const workItem = await runtime.value.workManagement.getIssue({
        project: runtime.value.project,
        externalIssueId: input.externalIssueId,
      });
      if (
        !workItem.ok ||
        workItem.value.issue.id !== record.identity.issueId ||
        workItem.value.issue.projectId !== record.identity.projectId ||
        workItem.value.workStatus !== "in_review"
      ) {
        return outcome("blocked", {
          operation: "human_acceptance_request_adjustment",
          reason: "work_item_identity_conflict",
        });
      }
      const comment = await runtime.value.workManagement.appendComment(
        { project: runtime.value.project, externalIssueId: input.externalIssueId },
        "產品負責人要求調整；本工單維持待驗收，Team Lead 將沿用既有建單流程安排修正。",
        { idempotencyKey: `human-acceptance:${record.identityDigest}:adjustment-requested` },
      );
      if (!comment.ok) {
        return outcome("failed", {
          operation: "human_acceptance_request_adjustment",
          reason: "comment_projection_failed",
          errorCode: comment.error.code,
        });
      }
      return outcome("success", {
        operation: "human_acceptance_request_adjustment",
        state: "pending",
        next: "team_lead_create_adjustment_issue",
        acceptance: publicHumanAcceptanceProjection(record),
      });
    },
  });
}
