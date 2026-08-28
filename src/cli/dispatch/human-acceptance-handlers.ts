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
  readonly store: Pick<
    HumanAcceptanceStorePort,
    "listPending" | "listForIssue" | "decide" | "invalidate"
  >;
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
      const records = await options.store.listForIssue(input.projectId, input.externalIssueId);
      const record = records.ok
        ? [...records.value].reverse().find((candidate) => {
            const receiptId = `human-acceptance:${candidate.identityDigest}:request-adjustment`;
            const requested = candidate.decisions.some(
              (decision) =>
                decision.decision === "request_adjustment" &&
                decision.decisionReceiptId === receiptId,
            );
            return (
              candidate.state === "pending" ||
              (candidate.state === "adjustment_pending" && requested) ||
              (candidate.state === "invalidated" &&
                candidate.invalidation?.reason === "reopened" &&
                requested)
            );
          })
        : undefined;
      if (!records.ok || record === undefined) {
        return outcome(records.ok ? "blocked" : "failed", {
          operation: "human_acceptance_request_adjustment",
          reason: records.ok ? "pending_acceptance_not_found" : "state_unavailable",
          ...(records.ok ? {} : { errorCode: records.error.code }),
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
        (workItem.value.workStatus !== "in_review" && workItem.value.workStatus !== "ready")
      ) {
        return outcome("blocked", {
          operation: "human_acceptance_request_adjustment",
          reason: "work_item_identity_conflict",
        });
      }
      const receiptId = `human-acceptance:${record.identityDigest}:request-adjustment`;
      const requested =
        record.state === "pending"
          ? await options.store.decide(
              record.identity,
              record.revision,
              "request_adjustment",
              receiptId,
            )
          : ok(record);
      if (!requested.ok) {
        return outcome("failed", {
          operation: "human_acceptance_request_adjustment",
          reason: "acceptance_write_failed",
          errorCode: requested.error.code,
        });
      }
      const invalidated = await options.store.invalidate(
        requested.value.identity,
        requested.value.revision,
        "reopened",
      );
      if (!invalidated.ok) {
        return outcome("failed", {
          operation: "human_acceptance_request_adjustment",
          reason: "acceptance_invalidation_failed",
          errorCode: invalidated.error.code,
        });
      }
      if (workItem.value.workStatus !== "ready") {
        const ready = await runtime.value.workManagement.setWorkStatus(
          { project: runtime.value.project, externalIssueId: input.externalIssueId },
          "ready",
          { idempotencyKey: `human-acceptance:${record.identityDigest}:return-ready` },
        );
        if (!ready.ok || ready.value.workStatus !== "ready") {
          return outcome("failed", {
            operation: "human_acceptance_request_adjustment",
            reason: "work_status_projection_failed",
          });
        }
      }
      const comment = await runtime.value.workManagement.appendComment(
        { project: runtime.value.project, externalIssueId: input.externalIssueId },
        "產品負責人要求調整；舊的人工驗收 checkpoint 已關閉，本工單已回到待執行並將在同一張單接續返工。",
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
        state: "reopened",
        next: "same_issue_rework",
        acceptance: publicHumanAcceptanceProjection(invalidated.value),
      });
    },
  });
}
