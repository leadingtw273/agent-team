import { domainError, type DomainError } from "../../domain/foundation/index.js";
import { projectSchema } from "../../domain/project/index.js";
import { transitionWorkStatus } from "../../domain/workflow/index.js";
import type {
  ChangeRequestSnapshot,
  MutationOptions,
  WorkManagementIssueSnapshot,
} from "../ports/index.js";
import type {
  LifecycleFailureStage,
  LifecyclePipelineOutcome,
  LifecyclePipelinePorts,
  LifecyclePipelineRequest,
} from "./lifecycle-model.js";

const idempotencyPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@+-]{0,220}$/u;
const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;

function sameSha(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function mutation(request: LifecyclePipelineRequest, step: string): MutationOptions {
  return {
    idempotencyKey: `${request.idempotencyKeyPrefix}:${step}`,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  };
}

function failed(stage: LifecycleFailureStage, error: DomainError): LifecyclePipelineOutcome {
  return Object.freeze({ state: "failed", stage, error });
}

function validRequest(request: LifecyclePipelineRequest): boolean {
  return (
    projectSchema.safeParse(request.project).success &&
    request.externalIssueId.trim().length > 0 &&
    request.changeRequestId.trim().length > 0 &&
    idempotencyPattern.test(request.idempotencyKeyPrefix) &&
    (request.mergeAuthorizationHeadSha === undefined ||
      shaPattern.test(request.mergeAuthorizationHeadSha))
  );
}

function issueMatchesRequest(
  request: LifecyclePipelineRequest,
  issue: WorkManagementIssueSnapshot,
): boolean {
  return (
    issue.issue.projectId === request.project.id &&
    issue.issue.externalId === request.externalIssueId
  );
}

function mergeComment(
  request: LifecyclePipelineRequest,
  headSha: string,
  outOfProcess: boolean,
): string {
  const common = [
    "🤖 Agent Team｜團隊管理者",
    `- 狀態：GitHub PR 已合併，工單更新為已完成`,
    `- PR：${request.changeRequestId}`,
    `- Head SHA：${headSha}`,
  ];
  return outOfProcess
    ? [
        ...common,
        "- 稽核：流程外合併，缺少 Controller 的精確 Head 合併授權",
        "- 安全處置：已暫停此專案新的 Auto-merge，等待團隊管理者檢查",
        "- 後續：不自動 Revert；現有合併結果保留",
      ].join("\n")
    : [...common, "- 稽核：精確 Head 合併授權相符", "- 後續：等待下游生命週期對帳"].join("\n");
}

function closedComment(request: LifecyclePipelineRequest): string {
  return [
    "🤖 Agent Team｜團隊管理者",
    "- 狀態：GitHub PR 已關閉，但工單未取消",
    "- 原因：只有使用者明確取消可以將工單設為已取消",
    `- PR：${request.changeRequestId}`,
    "- 後續：工單標記為等待處理變更請求關閉，由團隊管理者判斷重開或另建 PR",
  ].join("\n");
}

function cancellationComment(
  request: LifecyclePipelineRequest,
  checkpoint: "not_required" | "preserved",
  checkpointId?: string,
): string {
  return [
    "🤖 Agent Team｜團隊管理者",
    "- 狀態：使用者已明確取消工單，未合併 PR 已關閉",
    `- PR：${request.changeRequestId}`,
    `- Checkpoint：${checkpoint === "preserved" ? (checkpointId ?? "已保存") : "無需建立"}`,
    "- 保留：Branch 與 Worktree 均未刪除，可供日後稽核或復航",
  ].join("\n");
}

export class LifecyclePipeline {
  constructor(readonly ports: LifecyclePipelinePorts) {}

  async run(request: LifecyclePipelineRequest): Promise<LifecyclePipelineOutcome> {
    if (!validRequest(request)) return failed("request", domainError("invariant_violation"));
    const changeRequestReference = {
      project: request.project,
      changeRequestId: request.changeRequestId,
    };
    const issueReference = {
      project: request.project,
      externalIssueId: request.externalIssueId,
    };
    const readOptions = request.signal === undefined ? {} : { signal: request.signal };
    const [changeRequest, issue] = await Promise.all([
      this.ports.sourceControl.getChangeRequest(changeRequestReference, readOptions),
      this.ports.workManagement.getIssue(issueReference, readOptions),
    ]);
    if (!changeRequest.ok) return failed("change_request", changeRequest.error);
    if (!issue.ok) return failed("issue", issue.error);
    if (
      changeRequest.value.baseBranch !== request.project.defaultBranch ||
      !issueMatchesRequest(request, issue.value)
    ) {
      return failed("request", domainError("conflict"));
    }

    if (changeRequest.value.state === "merged") {
      return this.#handleMerge(request, issue.value, changeRequest.value.headSha);
    }
    if (issue.value.workStatus === "canceled") {
      return this.#handleCancellation(request, changeRequest.value);
    }
    if (issue.value.workStatus === "completed") {
      return Object.freeze({ state: "unchanged", reason: "terminal_issue" });
    }
    if (changeRequest.value.state === "closed") {
      return this.#handleUnexpectedClosure(request, issue.value);
    }
    return Object.freeze({ state: "unchanged", reason: "open" });
  }

  async #handleMerge(
    request: LifecyclePipelineRequest,
    issue: WorkManagementIssueSnapshot,
    mergedHeadSha: string,
  ): Promise<LifecyclePipelineOutcome> {
    const authorized =
      issue.workStatus !== "canceled" &&
      request.mergeAuthorizationHeadSha !== undefined &&
      sameSha(request.mergeAuthorizationHeadSha, mergedHeadSha);
    if (!authorized) {
      const paused = await this.ports.policy.pauseAutoMerge(
        {
          project: request.project,
          reason: "out_of_process_merge",
          changeRequestId: request.changeRequestId,
          mergedHeadSha,
        },
        mutation(request, "pause-auto-merge"),
      );
      if (!paused.ok) return failed("policy", paused.error);
      if (paused.value.durability !== "confirmed") {
        return failed("policy", domainError("external_failure"));
      }
    }

    if (issue.workStatus !== "completed") {
      const transition = transitionWorkStatus(issue.workStatus, {
        target: "completed",
        cause: "github_merge_observed",
      });
      if (!transition.ok) return failed("work_status", transition.error);
      const completed = await this.ports.workManagement.setWorkStatus(
        { project: request.project, externalIssueId: request.externalIssueId },
        transition.value,
        mutation(request, "mark-completed"),
      );
      if (!completed.ok) return failed("work_status", completed.error);
      if (
        !issueMatchesRequest(request, completed.value) ||
        completed.value.workStatus !== "completed"
      ) {
        return failed("work_status", domainError("conflict"));
      }
    }
    const comment = await this.ports.workManagement.appendComment(
      { project: request.project, externalIssueId: request.externalIssueId },
      mergeComment(request, mergedHeadSha, !authorized),
      mutation(request, authorized ? "authorized-merge-comment" : "out-of-process-merge-comment"),
    );
    if (!comment.ok) return failed("comment", comment.error);
    return Object.freeze({
      state: "completed",
      merge: authorized ? "authorized" : "out_of_process",
      headSha: mergedHeadSha,
      autoMergePaused: !authorized,
    });
  }

  async #handleCancellation(
    request: LifecyclePipelineRequest,
    changeRequest: ChangeRequestSnapshot,
  ): Promise<LifecyclePipelineOutcome> {
    const prepared = await this.ports.cancellation.prepare(
      {
        project: request.project,
        externalIssueId: request.externalIssueId,
        changeRequest,
        preserveBranchAndWorktree: true,
      },
      mutation(request, "prepare-cancellation"),
    );
    if (!prepared.ok) return failed("checkpoint", prepared.error);
    if (!prepared.value.activeWorkStopped) {
      return failed("checkpoint", domainError("conflict"));
    }
    if (
      (prepared.value.checkpoint === "preserved" &&
        (prepared.value.checkpointId === undefined ||
          prepared.value.checkpointId.trim().length === 0)) ||
      (prepared.value.checkpoint === "not_required" && prepared.value.checkpointId !== undefined)
    ) {
      return failed("checkpoint", domainError("invariant_violation"));
    }
    const alreadyClosed = changeRequest.state === "closed";
    if (!alreadyClosed) {
      const closed = await this.ports.sourceControl.closeChangeRequest(
        { project: request.project, changeRequestId: request.changeRequestId },
        mutation(request, "close-change-request"),
      );
      if (!closed.ok) return failed("close_change_request", closed.error);
      if (closed.value.state !== "closed") {
        return failed("close_change_request", domainError("conflict"));
      }
    }
    const comment = await this.ports.workManagement.appendComment(
      { project: request.project, externalIssueId: request.externalIssueId },
      cancellationComment(request, prepared.value.checkpoint, prepared.value.checkpointId),
      mutation(request, "cancellation-comment"),
    );
    if (!comment.ok) return failed("comment", comment.error);
    return Object.freeze({
      state: "canceled",
      changeRequest: alreadyClosed ? "already_closed" : "closed",
      checkpoint: prepared.value.checkpoint,
      ...(prepared.value.checkpointId === undefined
        ? {}
        : { checkpointId: prepared.value.checkpointId }),
    });
  }

  async #handleUnexpectedClosure(
    request: LifecyclePipelineRequest,
    issue: WorkManagementIssueSnapshot,
  ): Promise<LifecyclePipelineOutcome> {
    const blocked = await this.ports.workManagement.setAgentCondition(
      { project: request.project, externalIssueId: request.externalIssueId },
      { status: "blocked", blockingReasons: ["change_request_closed"] },
      mutation(request, "block-closed-change-request"),
    );
    if (!blocked.ok) return failed("agent_condition", blocked.error);
    if (
      !issueMatchesRequest(request, blocked.value) ||
      blocked.value.agentCondition?.status !== "blocked" ||
      !blocked.value.agentCondition.blockingReasons.includes("change_request_closed") ||
      blocked.value.workStatus !== issue.workStatus
    ) {
      return failed("agent_condition", domainError("conflict"));
    }
    const comment = await this.ports.workManagement.appendComment(
      { project: request.project, externalIssueId: request.externalIssueId },
      closedComment(request),
      mutation(request, "closed-change-request-comment"),
    );
    if (!comment.ok) return failed("comment", comment.error);
    return Object.freeze({ state: "blocked", reason: "change_request_closed" });
  }
}
