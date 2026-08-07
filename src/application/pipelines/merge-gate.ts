import { domainError, type DomainError } from "../../domain/foundation/index.js";
import {
  compareReviewIdentity,
  createReviewIdentity,
  type ReviewIdentity,
} from "../../domain/review/index.js";
import type { MutationOptions } from "../ports/index.js";
import {
  REVIEW_STATUS_CONTEXT,
  type BeginReviewOutcome,
  type BeginReviewRequest,
  type EnableAutoMergeOutcome,
  type EnableAutoMergeRequest,
  type MergeGateFailureStage,
  type MergeGatePorts,
  type RecordReviewOutcome,
  type RecordReviewRequest,
  type RecordedReviewApproval,
  type ReviewDecision,
  type ReviewStatusFailureStage,
  type ReviewStatusPorts,
} from "./merge-gate-model.js";
import { reviewerReportSchema } from "./reviewer-model.js";

function sameSha(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function validBaseRequest(request: BeginReviewRequest): boolean {
  return (
    request.changeRequestId.trim().length > 0 &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(request.expectedHeadSha) &&
    request.idempotencyKeyPrefix.trim().length > 0
  );
}

function mutation(request: BeginReviewRequest, step: string): MutationOptions {
  return {
    idempotencyKey: `${request.idempotencyKeyPrefix}:${step}`,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  };
}

function reviewFailure(
  stage: ReviewStatusFailureStage,
  error: DomainError,
): BeginReviewOutcome & RecordReviewOutcome {
  return Object.freeze({ state: "failed", stage, error });
}

function mergeFailure(stage: MergeGateFailureStage, error: DomainError): EnableAutoMergeOutcome {
  return Object.freeze({ state: "failed", stage, error });
}

/**
 * C015t decision 1: a change request found `state:"merged"` at the exact head this gate was asked
 * to authorize, at a point in `enable()` that is strictly *before* this call could itself have
 * caused a merge -- always `"already_merged_external"`, never `"directly_merged"` (the latter can
 * only come from the fallback squash this gate's own `enableAutoMerge` port call may perform,
 * handled separately below, never from a plain readback).
 */
function alreadyMergedExternally(
  snapshot: Readonly<{ state: string; headSha: string }>,
  expectedHeadSha: string,
): boolean {
  return snapshot.state === "merged" && sameSha(snapshot.headSha, expectedHeadSha);
}

function decisionMatchesRequest(request: RecordReviewRequest): boolean {
  const { decision } = request;
  const reportsValid = decision.reports.every(
    (report) => reviewerReportSchema.safeParse(report).success,
  );
  const verdictMatches =
    decision.state === "approved"
      ? decision.reports.every((report) => report.verdict === "passed")
      : decision.state === "changes_requested"
        ? decision.reports.some((report) => report.verdict === "changes_requested")
        : decision.reports.some((report) => report.verdict === "clarification_required");
  return (
    reportsValid &&
    verdictMatches &&
    sameSha(decision.identity.headSha, request.expectedHeadSha) &&
    sameSha(decision.changeRequest.headSha, request.expectedHeadSha) &&
    sameSha(decision.checks.headSha, request.expectedHeadSha) &&
    decision.checks.aggregate === "success" &&
    decision.reports.length > 0 &&
    decision.reports.every(
      (report) =>
        sameSha(report.headSha, decision.identity.headSha) &&
        report.requirementsDigest === decision.identity.requirementsDigest &&
        report.diffDigest === decision.identity.diffDigest,
    )
  );
}

function validApproval(request: EnableAutoMergeRequest): boolean {
  const requiredRoles: readonly ("code_reviewer" | "visual_reviewer")[] =
    request.requirementSnapshot.issue.reviewRequirement === "code_review"
      ? ["code_reviewer"]
      : request.requirementSnapshot.issue.reviewRequirement === "visual_review"
        ? ["visual_reviewer"]
        : request.requirementSnapshot.issue.reviewRequirement === "dual_review"
          ? ["code_reviewer", "visual_reviewer"]
          : [];
  const actualRoles = request.approval.reports.map((report) => report.role);
  return (
    requiredRoles.length > 0 &&
    new Set(actualRoles).size === actualRoles.length &&
    requiredRoles.every((role) => actualRoles.includes(role)) &&
    actualRoles.every((role) => requiredRoles.includes(role)) &&
    request.approval.reports.every(
      (report) =>
        reviewerReportSchema.safeParse(report).success &&
        report.verdict === "passed" &&
        sameSha(report.headSha, request.approval.identity.headSha) &&
        report.requirementsDigest === request.approval.identity.requirementsDigest &&
        report.diffDigest === request.approval.identity.diffDigest,
    )
  );
}

function reviewComment(decision: ReviewDecision): string {
  const findings = "findings" in decision ? decision.findings : [];
  const evidence = {
    schemaVersion: 1,
    kind: "agent_team_review",
    verdict: decision.state,
    identity: decision.identity,
    reports: decision.reports.map((report) => ({
      role: report.role,
      verdict: report.verdict,
      summary: report.summary,
      acceptanceCriteria: report.acceptanceCriteria,
      qualityChecks: report.qualityChecks,
      findings: report.findings,
    })),
    findings,
  };
  return [
    `Agent Team review: **${decision.state}**`,
    "",
    "```json",
    JSON.stringify(evidence, null, 2),
    "```",
  ].join("\n");
}

function reuseComment(approved: ReviewIdentity, current: ReviewIdentity): string {
  return [
    "Agent Team review reused after commit-only change.",
    "",
    "```json",
    JSON.stringify(
      {
        schemaVersion: 1,
        kind: "agent_team_review_reuse",
        reason: "requirements_and_effective_diff_unchanged",
        approvedIdentity: approved,
        currentIdentity: current,
        action: "ci_revalidated_without_new_reviewer_run",
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

function invalidationComment(
  reason: "requirements_changed" | "effective_diff_changed",
  approved: ReviewIdentity,
  current: ReviewIdentity,
): string {
  return [
    `Agent Team review invalidated: **${reason.replaceAll("_", " ")}**.`,
    "",
    "```json",
    JSON.stringify(
      {
        schemaVersion: 1,
        kind: "agent_team_review_invalidation",
        reason,
        approvedIdentity: approved,
        currentIdentity: current,
        action: "full_review_required",
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

export class ReviewStatusCoordinator {
  constructor(readonly ports: ReviewStatusPorts) {}

  async begin(request: BeginReviewRequest): Promise<BeginReviewOutcome> {
    if (!validBaseRequest(request)) {
      return reviewFailure("request", domainError("invariant_violation"));
    }
    const reference = { project: request.project, changeRequestId: request.changeRequestId };
    const changeRequest = await this.ports.sourceControl.getChangeRequest(
      reference,
      request.signal === undefined ? {} : { signal: request.signal },
    );
    if (!changeRequest.ok) return reviewFailure("change_request", changeRequest.error);
    if (
      changeRequest.value.state !== "open" ||
      changeRequest.value.baseBranch !== request.project.defaultBranch ||
      !sameSha(changeRequest.value.headSha, request.expectedHeadSha)
    ) {
      return reviewFailure("change_request", domainError("conflict"));
    }
    const checks = await this.ports.sourceControl.getCommitChecks(
      { project: request.project },
      request.expectedHeadSha,
      request.signal === undefined ? {} : { signal: request.signal },
    );
    if (!checks.ok) return reviewFailure("checks", checks.error);
    if (!sameSha(checks.value.headSha, request.expectedHeadSha)) {
      return reviewFailure("checks", domainError("conflict"));
    }
    if (checks.value.aggregate !== "success") {
      return Object.freeze({
        state: "not_ready",
        reason: checks.value.aggregate === "pending" ? "ci_pending" : "ci_failed",
        changeRequest: changeRequest.value,
        checks: checks.value,
      });
    }

    const statuses = await this.ports.sourceControl.getCommitStatuses(
      { project: request.project },
      request.expectedHeadSha,
      request.signal === undefined ? {} : { signal: request.signal },
    );
    if (!statuses.ok) return reviewFailure("status", statuses.error);
    if (!sameSha(statuses.value.headSha, request.expectedHeadSha)) {
      return reviewFailure("status", domainError("conflict"));
    }
    if (
      statuses.value.statuses.some(
        (status) => status.context === REVIEW_STATUS_CONTEXT && status.state === "success",
      )
    ) {
      return Object.freeze({
        state: "already_approved",
        changeRequest: changeRequest.value,
        checks: checks.value,
      });
    }

    const status = await this.ports.sourceControl.setCommitStatus(
      {
        project: request.project,
        headSha: request.expectedHeadSha,
        context: REVIEW_STATUS_CONTEXT,
        state: "pending",
        description: "Agent Team reviewer is evaluating this exact commit",
      },
      mutation(request, "review-pending"),
    );
    if (!status.ok) return reviewFailure("status", status.error);
    return Object.freeze({
      state: "pending",
      changeRequest: changeRequest.value,
      checks: checks.value,
    });
  }

  async record(request: RecordReviewRequest): Promise<RecordReviewOutcome> {
    if (!validBaseRequest(request) || !decisionMatchesRequest(request)) {
      return reviewFailure("request", domainError("invariant_violation"));
    }
    const reference = { project: request.project, changeRequestId: request.changeRequestId };
    const current = await this.ports.sourceControl.getChangeRequest(
      reference,
      request.signal === undefined ? {} : { signal: request.signal },
    );
    if (!current.ok) return reviewFailure("change_request", current.error);
    if (
      current.value.state !== "open" ||
      current.value.draft ||
      current.value.baseBranch !== request.project.defaultBranch ||
      !sameSha(current.value.headSha, request.expectedHeadSha)
    ) {
      return reviewFailure("change_request", domainError("conflict"));
    }
    const checks = await this.ports.sourceControl.getCommitChecks(
      { project: request.project },
      request.expectedHeadSha,
      request.signal === undefined ? {} : { signal: request.signal },
    );
    if (!checks.ok) return reviewFailure("checks", checks.error);
    if (
      !sameSha(checks.value.headSha, request.expectedHeadSha) ||
      checks.value.aggregate !== "success"
    ) {
      return reviewFailure("checks", domainError("conflict"));
    }

    const comment = await this.ports.sourceControl.appendChangeRequestComment(
      {
        changeRequest: reference,
        expectedHeadSha: request.expectedHeadSha,
        kind: "review_evidence",
        body: reviewComment(request.decision),
      },
      mutation(request, `review-${request.decision.state}-comment`),
    );
    if (!comment.ok) return reviewFailure("comment", comment.error);
    const approved = request.decision.state === "approved";
    const status = await this.ports.sourceControl.setCommitStatus(
      {
        project: request.project,
        headSha: request.expectedHeadSha,
        context: REVIEW_STATUS_CONTEXT,
        state: approved ? "success" : "failure",
        description: approved
          ? "Agent Team review passed for this exact commit"
          : `Agent Team review requires ${request.decision.state.replaceAll("_", " ")}`,
        targetUrl: comment.value.url,
      },
      mutation(request, `review-${request.decision.state}-status`),
    );
    if (!status.ok) return reviewFailure("status", status.error);
    if (!approved) {
      return Object.freeze({
        state: "rejected",
        reason: request.decision.state,
        evidenceComment: comment.value,
      });
    }
    const approval: RecordedReviewApproval = Object.freeze({
      changeRequestId: request.changeRequestId,
      identity: request.decision.identity,
      reports: request.decision.reports,
      evidenceComment: comment.value,
    });
    return Object.freeze({ state: "approved", approval });
  }
}

export class AutoMergeGate {
  constructor(readonly ports: MergeGatePorts) {}

  async enable(request: EnableAutoMergeRequest): Promise<EnableAutoMergeOutcome> {
    if (
      !validBaseRequest(request) ||
      request.baseRevision.trim().length === 0 ||
      request.approval.changeRequestId !== request.changeRequestId ||
      !validApproval(request)
    ) {
      return mergeFailure("request", domainError("invariant_violation"));
    }
    const reference = { project: request.project, changeRequestId: request.changeRequestId };
    const current = await this.ports.sourceControl.getChangeRequest(
      reference,
      request.signal === undefined ? {} : { signal: request.signal },
    );
    if (!current.ok) return mergeFailure("change_request", current.error);
    if (alreadyMergedExternally(current.value, request.expectedHeadSha)) {
      return Object.freeze({ state: "already_merged_external", changeRequest: current.value });
    }
    if (
      current.value.state !== "open" ||
      current.value.baseBranch !== request.project.defaultBranch ||
      !sameSha(current.value.headSha, request.expectedHeadSha)
    ) {
      return mergeFailure("change_request", domainError("conflict"));
    }
    if (current.value.draft) return Object.freeze({ state: "not_ready", reason: "draft" });
    if (current.value.mergeability === "conflicting") {
      return Object.freeze({ state: "not_ready", reason: "merge_conflict" });
    }
    if (current.value.mergeability === "unknown") {
      return Object.freeze({ state: "not_ready", reason: "mergeability_unknown" });
    }
    // C015y decision D (arm-time interception, point 1 of 3): `mergeability === "mergeable"` can
    // still be BEHIND -- `mergeability` is derived only from GitHub's boolean `.mergeable`, which
    // says nothing about O004's `strictRequiredStatusChecksPolicy` ruleset ever refusing to
    // execute the merge while behind. Never arm auto-merge on a BEHIND PR in the first place; see
    // this outcome's own header (merge-gate-model.ts) for the other two interception points.
    if (current.value.mergeStateStatus === "behind") {
      return Object.freeze({ state: "not_ready", reason: "behind" });
    }

    const checks = await this.ports.sourceControl.getCommitChecks(
      { project: request.project },
      request.expectedHeadSha,
      request.signal === undefined ? {} : { signal: request.signal },
    );
    if (!checks.ok) return mergeFailure("checks", checks.error);
    if (!sameSha(checks.value.headSha, request.expectedHeadSha)) {
      return mergeFailure("checks", domainError("conflict"));
    }
    if (checks.value.aggregate !== "success") {
      return Object.freeze({
        state: "not_ready",
        reason: checks.value.aggregate === "pending" ? "ci_pending" : "ci_failed",
      });
    }

    const diff = await this.ports.git.getEffectiveTreeDiff(
      { rootPath: request.project.localRepositoryPath },
      request.baseRevision,
      request.expectedHeadSha,
      request.signal === undefined ? {} : { signal: request.signal },
    );
    if (!diff.ok) return mergeFailure("diff", diff.error);
    const identity = createReviewIdentity(
      request.requirementSnapshot,
      request.expectedHeadSha,
      diff.value,
    );
    if (!identity.ok) return mergeFailure("diff", identity.error);
    const reuse = compareReviewIdentity(request.approval.identity, identity.value);
    if (reuse === "full_review") {
      const reason =
        request.approval.identity.requirementsDigest !== identity.value.requirementsDigest
          ? "requirements_changed"
          : "effective_diff_changed";
      const comment = await this.ports.sourceControl.appendChangeRequestComment(
        {
          changeRequest: reference,
          expectedHeadSha: request.expectedHeadSha,
          kind: "automation",
          body: invalidationComment(reason, request.approval.identity, identity.value),
        },
        mutation(request, `review-invalidated-${reason}-comment`),
      );
      if (!comment.ok) return mergeFailure("comment", comment.error);
      const invalidated = await this.ports.sourceControl.setCommitStatus(
        {
          project: request.project,
          headSha: request.expectedHeadSha,
          context: REVIEW_STATUS_CONTEXT,
          state: "failure",
          description: `Agent Team review invalidated: ${reason.replaceAll("_", " ")}`,
          targetUrl: comment.value.url,
        },
        mutation(request, `review-invalidated-${reason}`),
      );
      if (!invalidated.ok) return mergeFailure("status", invalidated.error);
      return Object.freeze({ state: "re_review_required", reason, identity: identity.value });
    }

    if (reuse === "ci_revalidation") {
      const comment = await this.ports.sourceControl.appendChangeRequestComment(
        {
          changeRequest: reference,
          expectedHeadSha: request.expectedHeadSha,
          kind: "automation",
          body: reuseComment(request.approval.identity, identity.value),
        },
        mutation(request, "review-reuse-comment"),
      );
      if (!comment.ok) return mergeFailure("comment", comment.error);
      const reusedStatus = await this.ports.sourceControl.setCommitStatus(
        {
          project: request.project,
          headSha: request.expectedHeadSha,
          context: REVIEW_STATUS_CONTEXT,
          state: "success",
          description: "Review reused after unchanged diff and successful CI",
          targetUrl: comment.value.url,
        },
        mutation(request, "review-reuse-status"),
      );
      if (!reusedStatus.ok) return mergeFailure("status", reusedStatus.error);
    }

    const statuses = await this.ports.sourceControl.getCommitStatuses(
      { project: request.project },
      request.expectedHeadSha,
      request.signal === undefined ? {} : { signal: request.signal },
    );
    if (!statuses.ok) return mergeFailure("status", statuses.error);
    if (!sameSha(statuses.value.headSha, request.expectedHeadSha)) {
      return mergeFailure("status", domainError("conflict"));
    }
    if (
      !statuses.value.statuses.some(
        (status) => status.context === REVIEW_STATUS_CONTEXT && status.state === "success",
      )
    ) {
      return Object.freeze({ state: "not_ready", reason: "review_status_missing" });
    }

    const beforeMerge = await this.ports.sourceControl.getChangeRequest(
      reference,
      request.signal === undefined ? {} : { signal: request.signal },
    );
    if (!beforeMerge.ok) return mergeFailure("change_request", beforeMerge.error);
    if (alreadyMergedExternally(beforeMerge.value, request.expectedHeadSha)) {
      return Object.freeze({ state: "already_merged_external", changeRequest: beforeMerge.value });
    }
    // C015y decision D (arm-time interception, point 2 of 3): catches a PR that only became
    // BEHIND in the narrow window between the very first readback above and this immediately-
    // pre-merge one -- same `not_ready`/`"behind"` shape as point 1, not folded into the generic
    // `mergeFailure("change_request", conflict)` block below, so `resumeUnderLease`'s own
    // `switch(enabled.reason)` handles both interception points identically.
    if (beforeMerge.value.mergeStateStatus === "behind") {
      return Object.freeze({ state: "not_ready", reason: "behind" });
    }
    if (
      beforeMerge.value.state !== "open" ||
      beforeMerge.value.draft ||
      beforeMerge.value.mergeability !== "mergeable" ||
      !sameSha(beforeMerge.value.headSha, request.expectedHeadSha)
    ) {
      return mergeFailure("change_request", domainError("conflict"));
    }
    const enabled = await this.ports.sourceControl.enableAutoMerge(
      reference,
      request.expectedHeadSha,
      mutation(request, "enable-auto-merge"),
    );
    if (!enabled.ok) return mergeFailure("auto_merge", enabled.error);
    const attempt = enabled.value;
    // C015t decision 1: `attempt.outcome` is the one place provenance ("did this call cause the
    // merge, or find one already there") is decided -- by `buildMergeGateSourceControl`
    // (src/cli/dispatch/status-merge-composition.ts), the only composition root that knows whether
    // it personally invoked the direct-squash fallback. This gate never re-derives that from head-
    // SHA equality; it only validates the returned snapshot is internally consistent.
    if (attempt.outcome === "merged_directly" || attempt.outcome === "merged_externally") {
      if (
        !sameSha(attempt.changeRequest.headSha, request.expectedHeadSha) ||
        attempt.changeRequest.state !== "merged"
      ) {
        return mergeFailure("auto_merge", domainError("conflict"));
      }
      return Object.freeze({
        state:
          attempt.outcome === "merged_directly" ? "directly_merged" : "already_merged_external",
        changeRequest: attempt.changeRequest,
      });
    }
    if (
      attempt.changeRequest.state !== "open" ||
      attempt.changeRequest.draft ||
      !attempt.changeRequest.autoMergeEnabled ||
      !sameSha(attempt.changeRequest.headSha, request.expectedHeadSha)
    ) {
      return mergeFailure("auto_merge", domainError("conflict"));
    }
    return Object.freeze({
      state: "auto_merge_enabled",
      reuse,
      identity: identity.value,
      changeRequest: attempt.changeRequest,
    });
  }
}
