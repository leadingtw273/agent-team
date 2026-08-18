import type { SourceControlPort, WorkManagementPort } from "../../application/ports/index.js";
import { REVIEW_STATUS_CONTEXT } from "../../application/pipelines/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Instant,
  type Result,
} from "../../domain/foundation/index.js";
import type { Project } from "../../domain/project/index.js";
import { createAgentCondition, type BlockingReason } from "../../domain/workflow/index.js";
import type { WorkStatusLifecycleMode } from "../../application/projects/index.js";

export interface ReviewerWaitPublicationRequest {
  readonly project: Project;
  readonly externalIssueId: string;
  readonly changeRequestId: string;
  readonly headSha: string;
  readonly confidence: "confirmed" | "unconfirmed";
  readonly bucket?: "weekly" | "five_hour" | "model_weekly";
  readonly resetAt?: Instant;
  readonly idempotencyKeyPrefix: string;
  readonly lifecycleMode?: WorkStatusLifecycleMode;
}

export interface ReviewerWaitPublicationPort {
  publish(request: ReviewerWaitPublicationRequest): Promise<Result<void, DomainError>>;
}

function blockingReason(request: ReviewerWaitPublicationRequest): BlockingReason {
  if (request.confidence === "unconfirmed") return "quota_unknown";
  if (request.bucket === "five_hour") return "five_hour_limit";
  if (request.bucket === "weekly" || request.bucket === "model_weekly") {
    return "weekly_quota_exhausted";
  }
  return "quota_unknown";
}

function waitComment(request: ReviewerWaitPublicationRequest): string {
  if (request.confidence === "unconfirmed") {
    return (
      "Claude 必要代碼審查遇到 429，但沒有收到官方 rejected 額度牆事件；目前只能判定為" +
      "未確認限流。審查結果未採用，agent-team/review 維持 pending，Auto-merge 不會啟用。" +
      "請確認 Claude 可用性後，以受控 reviewer resume 命令重試。"
    );
  }
  const bucket =
    request.bucket === "five_hour"
      ? "五小時窗口"
      : request.bucket === "weekly"
        ? "七天窗口"
        : request.bucket === "model_weekly"
          ? "模型別週窗口"
          : "未標示窗口";
  return (
    `Claude 必要代碼審查遇到已確認的額度牆（${bucket}）。審查結果未採用，` +
    "agent-team/review 維持 pending，Auto-merge 不會啟用。" +
    (request.resetAt === undefined
      ? "官方事件未提供可信 reset；請確認額度恢復後，以受控 reviewer resume 命令重試。"
      : `預計可於 ${request.resetAt} 之後由控制器建立全新的 Claude 審查 Session 重試。`)
  );
}

export class ReviewerWaitPublicationCoordinator implements ReviewerWaitPublicationPort {
  constructor(
    private readonly workManagement: Pick<
      WorkManagementPort,
      "setWorkStatus" | "setAgentCondition" | "appendComment"
    >,
    private readonly sourceControl: Pick<
      SourceControlPort,
      "getChangeRequest" | "getCommitStatuses" | "setCommitStatus"
    >,
  ) {}

  async publish(request: ReviewerWaitPublicationRequest): Promise<Result<void, DomainError>> {
    const reference = { project: request.project, externalIssueId: request.externalIssueId };
    const changeRequest = { project: request.project, changeRequestId: request.changeRequestId };
    const current = await this.sourceControl.getChangeRequest(changeRequest);
    if (
      !current.ok ||
      current.value.state !== "open" ||
      current.value.headSha.toLowerCase() !== request.headSha.toLowerCase()
    ) {
      return current.ok ? err(domainError("conflict")) : current;
    }

    const lifecycleMode = request.lifecycleMode ?? "off";
    if (lifecycleMode === "off") {
      const workStatus = await this.workManagement.setWorkStatus(reference, "in_review", {
        idempotencyKey: `${request.idempotencyKeyPrefix}:linear-work-status`,
      });
      if (!workStatus.ok || workStatus.value.workStatus !== "in_review") {
        return workStatus.ok ? err(domainError("conflict")) : workStatus;
      }
    }
    if (lifecycleMode !== "observe") {
      const reason = blockingReason(request);
      const condition = await this.workManagement.setAgentCondition(
        reference,
        createAgentCondition("waiting", [reason]),
        { idempotencyKey: `${request.idempotencyKeyPrefix}:linear-agent-condition` },
      );
      if (
        !condition.ok ||
        condition.value.agentCondition?.status !== "waiting" ||
        condition.value.agentCondition.blockingReasons[0] !== reason
      ) {
        return condition.ok ? err(domainError("conflict")) : condition;
      }
      const comment = await this.workManagement.appendComment(reference, waitComment(request), {
        idempotencyKey: `${request.idempotencyKeyPrefix}:linear-comment`,
      });
      if (!comment.ok) return comment;
    }

    const statuses = await this.sourceControl.getCommitStatuses(
      { project: request.project },
      request.headSha,
    );
    if (!statuses.ok || statuses.value.headSha.toLowerCase() !== request.headSha.toLowerCase()) {
      return statuses.ok ? err(domainError("conflict")) : statuses;
    }
    const reviewStatus = statuses.value.statuses.find(
      (status) => status.context === REVIEW_STATUS_CONTEXT,
    );
    if (reviewStatus?.state !== "pending") {
      const pending = await this.sourceControl.setCommitStatus(
        {
          project: request.project,
          headSha: request.headSha,
          context: REVIEW_STATUS_CONTEXT,
          state: "pending",
          description: "Agent Team reviewer is waiting; review is not complete",
        },
        { idempotencyKey: `${request.idempotencyKeyPrefix}:github-review-pending` },
      );
      if (!pending.ok) return pending;
    }
    return ok(undefined);
  }
}
