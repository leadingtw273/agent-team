/**
 * C015v: fixes a deadlock where two independently-correct earlier decisions interacted badly --
 * C015c made `LifecyclePolicyPort`'s NoOp production adapter honestly report `"unknown"` (it has no
 * real capability to pause anything), and C015t made the narrow `requires_manual` reconcile path
 * deliberately withhold merge authorization for out-of-process merges (never reverse-inferred from
 * head-SHA equality) -- but `#handleMerge` then treated *every* out-of-process merge's "unknown"
 * pause result as fail-closed, including the overwhelming common case where the change request is
 * already `merged` and there is structurally nothing left to pause. A real E101 job hit exactly
 * this: Linear could never reach Done, local progress could never reach `completed`, and the
 * admission claim could never release, for a PR that had genuinely, safely already merged.
 *
 * Scope boundary (explicit, not implicit): this ticket implements *only* the fact-convergence half
 * of the problem -- an already-merged change request can always converge to a truthful terminal
 * state (`completed` with an honest `autoMergeDisposition`, or `failed`/fail-closed if genuinely
 * ambiguous). It does **not** implement any real future-auto-merge-isolation capability (E116's own,
 * separate scope: e.g. a GitHub repository-level auto-merge disable, or a persistent per-project
 * quarantine) -- `NoOpAutoMergePauseAdapter` still has zero real pause capability after this ticket,
 * and this file's own audit-comment wording is deliberately written so it can never claim otherwise.
 * That capability, if ever required, needs its own ticket with its own persistent-quarantine design,
 * readback, and re-enable authorization -- it must never be satisfied by quietly reusing this
 * ticket's fact-convergence fix.
 */
import { domainError, type DomainError } from "../../domain/foundation/index.js";
import { projectSchema } from "../../domain/project/index.js";
import { createRequirementSnapshot, sha256Digest } from "../../domain/review/index.js";
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
  const lifecycleAudit = request.workStatusLifecycleAudit;
  return (
    projectSchema.safeParse(request.project).success &&
    request.externalIssueId.trim().length > 0 &&
    request.changeRequestId.trim().length > 0 &&
    idempotencyPattern.test(request.idempotencyKeyPrefix) &&
    (request.mergeAuthorizationHeadSha === undefined ||
      shaPattern.test(request.mergeAuthorizationHeadSha)) &&
    (request.humanAcceptance === undefined ||
      (request.humanAcceptance.state === "pending" &&
        /^[0-9a-f]{64}$/u.test(request.humanAcceptance.identityDigest) &&
        /^[0-9a-f]{64}$/u.test(request.humanAcceptance.requirementDigest) &&
        /^[0-9a-f]{64}$/u.test(request.humanAcceptance.humanSummaryDigest) &&
        shaPattern.test(request.humanAcceptance.mergeCommit) &&
        shaPattern.test(request.humanAcceptance.headSha) &&
        !Number.isNaN(Date.parse(request.humanAcceptance.mergedAt)))) &&
    (request.reviewerReplayAudit === undefined ||
      (/^[0-9a-f]{64}$/u.test(request.reviewerReplayAudit.checkpointDigest) &&
        Number.isInteger(request.reviewerReplayAudit.attemptTotal) &&
        request.reviewerReplayAudit.attemptTotal >= 1 &&
        request.reviewerReplayAudit.attemptTotal <= 2)) &&
    (lifecycleAudit === undefined ||
      (/^job_[0-9a-f-]{36}$/u.test(lifecycleAudit.jobId) &&
        (lifecycleAudit.workReceiptDigest === undefined ||
          /^[0-9a-f]{64}$/u.test(lifecycleAudit.workReceiptDigest)) &&
        (lifecycleAudit.reviewReceiptDigest === undefined ||
          /^[0-9a-f]{64}$/u.test(lifecycleAudit.reviewReceiptDigest))))
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

/**
 * C015v decision 3 (a hard wording rule, not a style choice): the `not_applicable` branch must
 * state plainly that the merged PR has no pending auto-merge left to cancel -- it must never reuse
 * the `paused` branch's "已暫停此專案新的 Auto-merge" wording, which would falsely claim a
 * project-wide safety action that never happened (E116's own, deliberately-deferred scope; see this
 * file's header). Every sentence here is a fixed template selected by `disposition`, never
 * freeform text, so this invariant cannot drift call by call.
 */
function mergeComment(
  request: LifecyclePipelineRequest,
  headSha: string,
  disposition: "not_required" | "paused" | "not_applicable",
  issue: WorkManagementIssueSnapshot,
): string {
  const awaitingAcceptance = request.humanAcceptance !== undefined;
  const common = [
    "🤖 Agent Team｜團隊管理者",
    awaitingAcceptance
      ? "- 狀態：GitHub PR 已合併，工程已完成；工單保留在審查中等待人類驗收"
      : "- 狀態：GitHub PR 已合併，工單更新為已完成",
    `- PR：${request.changeRequestId}`,
    `- Head SHA：${headSha}`,
    ...(request.workStatusLifecycleAudit === undefined
      ? []
      : [
          `- operation：${request.workStatusLifecycleAudit.operation}`,
          `- Job：${request.workStatusLifecycleAudit.jobId}`,
          `- Work receipt：${request.workStatusLifecycleAudit.workReceiptDigest ?? "unavailable"}`,
          `- Review receipt：${request.workStatusLifecycleAudit.reviewReceiptDigest ?? "unavailable"}`,
          `- Merge provenance：${disposition === "not_required" ? "controller_authorized" : "already_merged_external"}`,
          `- outcome：${request.workStatusLifecycleAudit.outcome}`,
        ]),
    ...(request.reviewerReplayAudit === undefined
      ? []
      : [
          ...(request.workStatusLifecycleAudit === undefined
            ? ["- operation：reviewer-replay"]
            : []),
          `- Review checkpoint：${request.reviewerReplayAudit.checkpointDigest}`,
          `- Reviewer attempts：${String(request.reviewerReplayAudit.attemptTotal)}｜outcome=${request.reviewerReplayAudit.outcome}`,
        ]),
    ...(request.humanAcceptance === undefined
      ? []
      : [
          `- Human acceptance：pending｜${request.humanAcceptance.identityDigest}`,
          `- 完成後會看到／能操作什麼：${issue.issue.humanSummary?.outcome ?? "請依工單的人類摘要確認成果"}`,
          `- 如何驗收：${issue.issue.humanSummary?.acceptance ?? "請由專案負責人明確接受或要求調整"}`,
        ]),
  ];
  if (disposition === "not_required") {
    return [...common, "- 稽核：精確 Head 合併授權相符", "- 後續：等待下游生命週期對帳"].join("\n");
  }
  const safetyLine =
    disposition === "paused"
      ? "- 安全處置：已暫停此專案新的 Auto-merge，等待團隊管理者檢查"
      : "- 安全處置：該 PR 已合併，無 pending auto-merge 可取消";
  return [
    ...common,
    "- 稽核：流程外合併，缺少 Controller 的精確 Head 合併授權",
    safetyLine,
    "- 後續：不自動 Revert；現有合併結果保留",
  ].join("\n");
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

function cancellationAfterMergeComment(
  request: LifecyclePipelineRequest,
  issue: WorkManagementIssueSnapshot,
  mergedHeadSha: string,
  checkpoint: "not_required" | "preserved",
  pauseDisposition: "paused" | "not_applicable",
  checkpointId?: string,
): string {
  const mergeMutations = request.cancellationRaceAudit?.mergeMutations ?? [];
  return [
    "🤖 Agent Team｜團隊管理者",
    "- 狀態：cancellation-after-merge（等待人工判定）",
    pauseDisposition === "paused"
      ? "- 安全處置：未標記完成、不自動 Revert，並已暫停此專案新的 Auto-merge"
      : "- 安全處置：未標記完成、不自動 Revert；目前無可用的專案級 Auto-merge 暫停能力",
    `- PR：${request.changeRequestId}`,
    `- PR Head：${mergedHeadSha}`,
    `- Linear providerUpdatedAt：${issue.updatedAt}`,
    "- Linear CAS revision：unavailable（Provider 未提供；不可用 updatedAt 冒充）",
    `- Controller observedAt：${request.cancellationRaceAudit?.observedAt ?? "unavailable"}`,
    ...(mergeMutations.length === 0
      ? ["- GitHub mutation attempt：unknown_or_out_of_process"]
      : mergeMutations.map(
          (attempt, index) =>
            `- GitHub mutation attempt ${String(index + 1)}：${attempt.kind}｜key=${attempt.idempotencyKey}｜attemptedAt=${attempt.attemptedAt}｜outcome=${attempt.outcome}`,
        )),
    `- Checkpoint：${checkpoint === "preserved" ? (checkpointId ?? "已保存") : "無需建立"}`,
    "- 保留：Branch 與 Worktree 均未刪除，交由團隊管理者稽核",
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

    if (changeRequest.value.state === "merged" && issue.value.workStatus === "canceled") {
      return this.#handleCancellationAfterMerge(request, changeRequest.value, issue.value);
    }
    if (issue.value.workStatus === "canceled") {
      return this.#handleCancellation(request, changeRequest.value, issue.value);
    }
    if (changeRequest.value.state === "merged") {
      return this.#handleMerge(request, issue.value, changeRequest.value);
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
    changeRequest: ChangeRequestSnapshot,
  ): Promise<LifecyclePipelineOutcome> {
    const mergedHeadSha = changeRequest.headSha;
    const currentRequirement = createRequirementSnapshot(issue.issue, issue.updatedAt);
    const currentHumanSummaryDigest =
      issue.issue.humanSummary === undefined ? undefined : sha256Digest(issue.issue.humanSummary);
    if (
      request.humanAcceptance !== undefined &&
      (changeRequest.mergeCommitSha === undefined ||
        changeRequest.mergedAt === undefined ||
        !sameSha(request.humanAcceptance.headSha, mergedHeadSha) ||
        !sameSha(request.humanAcceptance.mergeCommit, changeRequest.mergeCommitSha) ||
        request.humanAcceptance.mergedAt !== changeRequest.mergedAt ||
        !currentRequirement.ok ||
        currentRequirement.value.requirementsDigest !== request.humanAcceptance.requirementDigest ||
        currentHumanSummaryDigest === undefined ||
        !currentHumanSummaryDigest.ok ||
        currentHumanSummaryDigest.value !== request.humanAcceptance.humanSummaryDigest)
    ) {
      return failed("request", domainError("conflict"));
    }
    const authorized =
      issue.workStatus !== "canceled" &&
      request.mergeAuthorizationHeadSha !== undefined &&
      sameSha(request.mergeAuthorizationHeadSha, mergedHeadSha);
    // C015v decision 1: `autoMergeDisposition` defaults to `"not_required"` -- the in-process,
    // authorized-merge case, where pausing anything was never on the table. The `!authorized`
    // branch below is the *only* place this can become `"paused"`/`"not_applicable"`, and this
    // method -- having just performed (in `run()`, immediately before dispatching here) the
    // authoritative readback that proved `mergedHeadSha` is real -- is what supplies that fact to
    // `pauseAutoMerge` (via `reason: "out_of_process_merge"` + `mergedHeadSha`); the policy port
    // itself never independently re-derives "is this already merged" from anything else. `"unknown"`
    // (a genuine pause attempt that could not be confirmed) still fails closed exactly as before
    // this ticket -- only the previously-unreachable `"not_applicable"` case is new.
    let autoMergeDisposition: "not_required" | "paused" | "not_applicable" = "not_required";
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
      if (paused.value.state === "unknown") {
        return failed("policy", domainError("external_failure"));
      }
      autoMergeDisposition = paused.value.state;
    }

    if (request.humanAcceptance !== undefined && issue.workStatus !== "in_review") {
      return failed("work_status", domainError("conflict"));
    }
    if (request.humanAcceptance === undefined && issue.workStatus !== "completed") {
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
      mergeComment(request, mergedHeadSha, autoMergeDisposition, issue),
      mutation(
        request,
        request.humanAcceptance === undefined
          ? authorized
            ? "authorized-merge-comment"
            : "out-of-process-merge-comment"
          : authorized
            ? "human-acceptance-merge-comment"
            : "human-acceptance-external-merge-comment",
      ),
    );
    if (!comment.ok) return failed("comment", comment.error);
    return Object.freeze({
      state: "completed",
      merge: authorized ? "authorized" : "out_of_process",
      headSha: mergedHeadSha,
      autoMergeDisposition,
      ...(request.humanAcceptance === undefined ? {} : { humanAcceptance: "pending" as const }),
    });
  }

  async #handleCancellation(
    request: LifecyclePipelineRequest,
    changeRequest: ChangeRequestSnapshot,
    issue: WorkManagementIssueSnapshot,
  ): Promise<LifecyclePipelineOutcome> {
    const prepared = await this.ports.cancellation.prepare(
      {
        project: request.project,
        externalIssueId: request.externalIssueId,
        changeRequest,
        issue: issue.issue,
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
    // E115cap: lease release is sequenced strictly after the checkpoint (already durable, via
    // `prepared`, before this point) and after the PR close above -- never before either, so a
    // crash here can never leave a released lease with no checkpoint/closed-PR evidence behind it.
    const leaseReleased = await this.ports.leaseRelease.release(
      { project: request.project, externalIssueId: request.externalIssueId },
      mutation(request, "release-lease"),
    );
    if (!leaseReleased.ok) return failed("lease_release", leaseReleased.error);
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

  async #handleCancellationAfterMerge(
    request: LifecyclePipelineRequest,
    changeRequest: ChangeRequestSnapshot,
    issue: WorkManagementIssueSnapshot,
  ): Promise<LifecyclePipelineOutcome> {
    const prepared = await this.ports.cancellation.prepare(
      {
        project: request.project,
        externalIssueId: request.externalIssueId,
        changeRequest,
        issue: issue.issue,
        preserveBranchAndWorktree: true,
      },
      mutation(request, "prepare-cancellation-after-merge"),
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

    const paused = await this.ports.policy.pauseAutoMerge(
      {
        project: request.project,
        reason: "out_of_process_merge",
        changeRequestId: request.changeRequestId,
        mergedHeadSha: changeRequest.headSha,
      },
      mutation(request, "pause-auto-merge-after-cancellation-race"),
    );
    if (!paused.ok) return failed("policy", paused.error);
    if (paused.value.state === "unknown") {
      return failed("policy", domainError("external_failure"));
    }

    const leaseReleased = await this.ports.leaseRelease.release(
      { project: request.project, externalIssueId: request.externalIssueId },
      mutation(request, "release-lease-after-cancellation-race"),
    );
    if (!leaseReleased.ok) return failed("lease_release", leaseReleased.error);

    const comment = await this.ports.workManagement.appendComment(
      { project: request.project, externalIssueId: request.externalIssueId },
      cancellationAfterMergeComment(
        request,
        issue,
        changeRequest.headSha,
        prepared.value.checkpoint,
        paused.value.state,
        prepared.value.checkpointId,
      ),
      mutation(request, "cancellation-after-merge-comment"),
    );
    if (!comment.ok) return failed("comment", comment.error);
    return Object.freeze({ state: "blocked", reason: "cancellation_after_merge" });
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
