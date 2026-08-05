import { resolve } from "node:path";

import { domainError, type DomainError } from "../../domain/foundation/index.js";
import { consumeAttempt, jobSchema, type Job } from "../../domain/jobs/index.js";
import { createReviewIdentity } from "../../domain/review/index.js";
import type { CommitChecksSnapshot, MutationOptions } from "../ports/index.js";
import type {
  ReviewEvidenceBlock,
  ReviewerFailureStage,
  ReviewerPipelineOutcome,
  ReviewerPipelinePorts,
  ReviewerPipelineRequest,
} from "./reviewer-model.js";
import {
  anyReviewerAttemptLimitReached,
  requiredReviewerRoles,
  sameReviewSha,
  validReviewerRequest,
} from "./reviewer-policy.js";
import { runReviewerProvider } from "./reviewer-provider.js";

function mutation(request: ReviewerPipelineRequest, step: string): MutationOptions {
  return {
    idempotencyKey: `${request.idempotencyKeyPrefix}:${step}`,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  };
}

function failed(
  stage: ReviewerFailureStage,
  error: DomainError,
  job: Job,
): ReviewerPipelineOutcome {
  return Object.freeze({ state: "failed", stage, error, job });
}

export class ReviewerPipeline {
  constructor(readonly ports: ReviewerPipelinePorts) {}

  async run(request: ReviewerPipelineRequest): Promise<ReviewerPipelineOutcome> {
    if (!validReviewerRequest(request)) {
      return failed("request", domainError("invariant_violation"), request.job);
    }
    const roles = requiredReviewerRoles(request);
    if (
      (roles.includes("code_reviewer") && this.ports.codeReviewer === undefined) ||
      (roles.includes("visual_reviewer") && this.ports.visualReviewer === undefined)
    ) {
      return failed("request", domainError("invariant_violation"), request.job);
    }
    const reference = { project: request.project, changeRequestId: request.changeRequestId };
    const changeRequest = await this.ports.sourceControl.getChangeRequest(
      reference,
      request.signal === undefined ? {} : { signal: request.signal },
    );
    if (!changeRequest.ok) return failed("change_request", changeRequest.error, request.job);
    if (
      changeRequest.value.state !== "open" ||
      changeRequest.value.baseBranch !== request.project.defaultBranch ||
      changeRequest.value.headBranch !== request.worktree.branch ||
      !sameReviewSha(changeRequest.value.headSha, request.expectedHeadSha)
    ) {
      return failed("change_request", domainError("conflict"), request.job);
    }
    const checks = await this.ports.sourceControl.getCommitChecks(
      { project: request.project },
      request.expectedHeadSha,
      request.signal === undefined ? {} : { signal: request.signal },
    );
    if (!checks.ok) return failed("checks", checks.error, request.job);
    if (!sameReviewSha(checks.value.headSha, request.expectedHeadSha)) {
      return failed("checks", domainError("conflict"), request.job);
    }
    if (checks.value.aggregate !== "success") {
      return Object.freeze({
        state: "not_ready",
        reason: checks.value.aggregate === "pending" ? "ci_pending" : "ci_failed",
        job: request.job,
        changeRequest: changeRequest.value,
        checks: checks.value,
      });
    }
    if (anyReviewerAttemptLimitReached(request.job)) {
      return this.#checkpoint(request, checks.value);
    }

    const before = await this.ports.git.inspectWorktree(
      request.worktree,
      request.signal === undefined ? {} : { signal: request.signal },
    );
    const beforeChanges = await this.ports.git.inspectWorkingTree(
      request.worktree,
      request.signal === undefined ? {} : { signal: request.signal },
    );
    if (
      !before.ok ||
      !beforeChanges.ok ||
      !before.value.clean ||
      before.value.branch !== request.worktree.branch ||
      !sameReviewSha(before.value.headSha, request.expectedHeadSha) ||
      !sameReviewSha(beforeChanges.value.headSha, request.expectedHeadSha) ||
      beforeChanges.value.changes.length !== 0
    ) {
      const error = !before.ok
        ? before.error
        : !beforeChanges.ok
          ? beforeChanges.error
          : domainError("conflict");
      return failed("worktree", error, request.job);
    }
    const diff = await this.ports.git.getEffectiveTreeDiff(
      { rootPath: request.project.localRepositoryPath },
      request.baseRevision,
      request.expectedHeadSha,
      request.signal === undefined ? {} : { signal: request.signal },
    );
    if (!diff.ok) return failed("diff", diff.error, request.job);
    const identity = createReviewIdentity(
      request.requirementSnapshot,
      request.expectedHeadSha,
      diff.value,
    );
    if (!identity.ok) return failed("diff", identity.error, request.job);

    const evidence = await this.#verifyEvidence(request);
    if (!evidence.ok) return failed("evidence", evidence.error, request.job);
    const ready = await this.ports.sourceControl.markChangeRequestReady(
      reference,
      request.expectedHeadSha,
      mutation(request, "ready-for-review"),
    );
    if (!ready.ok) return failed("ready", ready.error, request.job);
    if (
      ready.value.state !== "open" ||
      ready.value.draft ||
      !sameReviewSha(ready.value.headSha, request.expectedHeadSha)
    ) {
      return failed("ready", domainError("conflict"), request.job);
    }

    const runs = await Promise.all(
      roles.map((role) => {
        const provider =
          role === "code_reviewer" ? this.ports.codeReviewer : this.ports.visualReviewer;
        const model = role === "code_reviewer" ? request.models.code : request.models.visual;
        if (provider === undefined || model === undefined) {
          return Promise.resolve({
            kind: "failed" as const,
            stage: "request" as const,
            error: domainError("invariant_violation"),
          });
        }
        return runReviewerProvider({
          role,
          provider,
          model,
          request,
          identity: identity.value,
          diff: diff.value,
          checks: checks.value,
          toolDecisions: this.ports.toolDecisions,
        });
      }),
    );
    const after = await this.ports.git.inspectWorktree(
      request.worktree,
      request.signal === undefined ? {} : { signal: request.signal },
    );
    const afterChanges = await this.ports.git.inspectWorkingTree(
      request.worktree,
      request.signal === undefined ? {} : { signal: request.signal },
    );
    if (
      !after.ok ||
      !afterChanges.ok ||
      !after.value.clean ||
      after.value.branch !== request.worktree.branch ||
      !sameReviewSha(after.value.headSha, request.expectedHeadSha) ||
      !sameReviewSha(afterChanges.value.headSha, request.expectedHeadSha) ||
      afterChanges.value.changes.length !== 0
    ) {
      const error = !after.ok
        ? after.error
        : !afterChanges.ok
          ? afterChanges.error
          : domainError("permission_denied");
      return failed("post_review_worktree", error, request.job);
    }

    const firstFailure = runs.find((run) => run.kind === "failed");
    if (firstFailure?.kind === "failed") {
      return failed(firstFailure.stage, firstFailure.error, request.job);
    }
    const firstPause = runs.find((run) => run.kind === "paused");
    if (firstPause?.kind === "paused") {
      return Object.freeze({
        state: "paused",
        reason: firstPause.reason,
        job: request.job,
        toolSummary: firstPause.summary,
      });
    }
    if (runs.some((run) => run.kind === "interrupted")) {
      return Object.freeze({ state: "paused", reason: "provider_interrupted", job: request.job });
    }

    const reports = Object.freeze(
      runs.flatMap((run) => (run.kind === "completed" ? [run.report] : [])),
    );
    if (reports.length !== roles.length) {
      return failed("report", domainError("external_failure"), request.job);
    }
    const consumed = consumeAttempt(request.job.attempts, "reviewRuns");
    if (!consumed.ok) return this.#checkpoint(request, checks.value);
    const reviewedJob = jobSchema.safeParse({ ...request.job, attempts: consumed.value });
    if (!reviewedJob.success) {
      return failed("request", domainError("invariant_violation"), request.job);
    }
    const persisted = await this.ports.jobs.update(
      reviewedJob.data,
      mutation(request, `review-run-${String(reviewedJob.data.attempts.reviewRuns)}`),
    );
    if (!persisted.ok) return failed("attempt_persistence", persisted.error, request.job);
    if (persisted.value.durability !== "confirmed") {
      return failed("attempt_persistence", domainError("external_failure"), request.job);
    }

    const common = Object.freeze({
      job: reviewedJob.data,
      changeRequest: ready.value,
      checks: checks.value,
      identity: identity.value,
      reports,
    });
    const clarificationFindings = reports.flatMap((report) =>
      report.findings.filter((finding) => finding.severity === "clarification"),
    );
    if (
      reports.some((report) => report.verdict === "clarification_required") ||
      clarificationFindings.length > 0
    ) {
      return Object.freeze({
        state: "clarification_required",
        ...common,
        findings: Object.freeze(clarificationFindings),
      });
    }
    const blockingFindings = reports.flatMap((report) =>
      report.findings.filter((finding) => finding.severity === "blocking"),
    );
    if (
      reports.some((report) => report.verdict === "changes_requested") ||
      blockingFindings.length > 0
    ) {
      return Object.freeze({
        state: "changes_requested",
        ...common,
        findings: Object.freeze(blockingFindings),
      });
    }
    return Object.freeze({ state: "approved", ...common });
  }

  async #verifyEvidence(
    request: ReviewerPipelineRequest,
  ): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; error: DomainError }>> {
    for (const evidence of request.evidence) {
      if (evidence.kind !== "file") continue;
      if (
        evidence.category === "visual_artifact" &&
        (evidence.repositoryPath === undefined ||
          resolve(evidence.path) !== resolve(request.worktree.path, evidence.repositoryPath))
      ) {
        return Object.freeze({ ok: false, error: domainError("conflict") });
      }
      const verified = await this.ports.evidenceIntegrity.verify(
        evidence,
        request.signal === undefined ? {} : { signal: request.signal },
      );
      if (!verified.ok) return verified;
      if (!verified.value.verified || verified.value.byteLength <= 0) {
        return Object.freeze({ ok: false, error: domainError("conflict") });
      }
    }
    const manifest = request.visualManifest;
    if (manifest === undefined) return Object.freeze({ ok: true });
    if (
      manifest.issueId !== request.requirementSnapshot.issue.id ||
      !sameReviewSha(manifest.commitSha, request.expectedHeadSha)
    ) {
      return Object.freeze({ ok: false, error: domainError("conflict") });
    }
    const criteria = new Set(request.requirementSnapshot.issue.acceptanceCriteria);
    const artifacts = request.evidence.filter(
      (block): block is Extract<ReviewEvidenceBlock, { kind: "file" }> =>
        block.kind === "file" && block.category === "visual_artifact",
    );
    if (
      manifest.artifacts.some(
        (artifact) =>
          artifact.acceptanceCriteria.some((criterion) => !criteria.has(criterion)) ||
          artifacts.filter(
            (evidence) =>
              evidence.repositoryPath === artifact.path &&
              evidence.sha256 === artifact.sha256 &&
              evidence.mediaType === artifact.mediaType,
          ).length !== 1,
      ) ||
      artifacts.length !== manifest.artifacts.length
    ) {
      return Object.freeze({ ok: false, error: domainError("conflict") });
    }
    return Object.freeze({ ok: true });
  }

  async #checkpoint(
    request: ReviewerPipelineRequest,
    checks: CommitChecksSnapshot,
  ): Promise<ReviewerPipelineOutcome> {
    const checkpoint = await this.ports.checkpoint.preserve(
      {
        job: request.job,
        worktree: request.worktree,
        requirementSnapshot: request.requirementSnapshot,
        reason: "attempt_limit_reached",
        checks,
      },
      mutation(request, "checkpoint-attempt-limit"),
    );
    if (!checkpoint.ok) return failed("checkpoint", checkpoint.error, request.job);
    if (checkpoint.value.checkpointId.trim().length === 0) {
      return failed("checkpoint", domainError("invariant_violation"), request.job);
    }
    return Object.freeze({
      state: "checkpointed",
      reason: "attempt_limit_reached",
      job: request.job,
      checkpointId: checkpoint.value.checkpointId,
      checks,
    });
  }
}
