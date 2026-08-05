import { domainError, type DomainError } from "../../domain/foundation/index.js";
import { jobSchema } from "../../domain/jobs/index.js";
import { projectSchema } from "../../domain/project/index.js";
import {
  compareReviewIdentity,
  createReviewIdentity,
  requirementSnapshotSchema,
} from "../../domain/review/index.js";
import type { MutationOptions } from "../ports/index.js";
import type {
  ConflictEscalationReason,
  ConflictFailureStage,
  ConflictPipelineOutcome,
  ConflictPipelinePorts,
  ConflictPipelineRequest,
  ConflictResolverRole,
} from "./conflict-model.js";
import { conflictAssessmentSchema } from "./conflict-model.js";
import { classifyConflict, requirementEscalationReason } from "./conflict-policy.js";

const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const idempotencyPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@+-]{0,220}$/u;

function sameSha(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function mutation(request: ConflictPipelineRequest, step: string): MutationOptions {
  return {
    idempotencyKey: `${request.idempotencyKeyPrefix}:${step}`,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  };
}

function failed(stage: ConflictFailureStage, error: DomainError): ConflictPipelineOutcome {
  return Object.freeze({ state: "failed", stage, error });
}

function validRequest(request: ConflictPipelineRequest): boolean {
  return (
    jobSchema.safeParse(request.job).success &&
    projectSchema.safeParse(request.project).success &&
    requirementSnapshotSchema.safeParse(request.requirementSnapshot).success &&
    conflictAssessmentSchema.safeParse(request.assessment).success &&
    request.job.projectId === request.project.id &&
    request.job.issueId === request.requirementSnapshot.issue.id &&
    request.requirementSnapshot.issue.projectId === request.project.id &&
    request.worktree.repositoryRoot === request.project.localRepositoryPath &&
    request.worktree.branch.trim().length > 0 &&
    sameSha(request.worktree.headSha, request.expectedHeadSha) &&
    shaPattern.test(request.expectedHeadSha) &&
    shaPattern.test(request.baseRevision) &&
    request.changeRequestId.trim().length > 0 &&
    request.originalImplementerId.trim().length > 0 &&
    idempotencyPattern.test(request.idempotencyKeyPrefix) &&
    (request.previousReviewIdentity === undefined ||
      (shaPattern.test(request.previousReviewIdentity.headSha) &&
        sameSha(request.previousReviewIdentity.headSha, request.expectedHeadSha) &&
        /^[0-9a-f]{64}$/u.test(request.previousReviewIdentity.requirementsDigest) &&
        /^[0-9a-f]{64}$/u.test(request.previousReviewIdentity.diffDigest)))
  );
}

export class ConflictPipeline {
  constructor(readonly ports: ConflictPipelinePorts) {}

  async run(request: ConflictPipelineRequest): Promise<ConflictPipelineOutcome> {
    if (!validRequest(request)) return failed("request", domainError("invariant_violation"));
    const reference = { project: request.project, changeRequestId: request.changeRequestId };
    const readOptions = request.signal === undefined ? {} : { signal: request.signal };
    const changeRequest = await this.ports.sourceControl.getChangeRequest(reference, readOptions);
    if (!changeRequest.ok) return failed("change_request", changeRequest.error);
    if (
      changeRequest.value.state !== "open" ||
      changeRequest.value.baseBranch !== request.project.defaultBranch ||
      changeRequest.value.headBranch !== request.worktree.branch ||
      !sameSha(changeRequest.value.headSha, request.expectedHeadSha)
    ) {
      return failed("change_request", domainError("conflict"));
    }
    if (changeRequest.value.mergeability === "unknown") {
      return Object.freeze({ state: "waiting", reason: "mergeability_unknown" });
    }
    if (changeRequest.value.mergeability === "mergeable") {
      return Object.freeze({ state: "not_required", reason: "no_longer_conflicting" });
    }
    const clean = await this.#verifyCleanWorktree(request, request.expectedHeadSha);
    if (!clean.ok) return failed("worktree", clean.error);

    const classification = classifyConflict(request.assessment);
    if (classification === "requirements") {
      return this.#escalate(
        request,
        changeRequest.value,
        requirementEscalationReason(request.assessment),
        request.assessment.summary,
      );
    }

    let role: ConflictResolverRole = "integration_engineer";
    if (classification === "simple") {
      const claim = await this.ports.attempts.claimSimpleAttempt(
        {
          jobId: request.job.id,
          changeRequestId: request.changeRequestId,
          baseRevision: request.baseRevision,
        },
        mutation(request, "claim-simple-attempt"),
      );
      if (!claim.ok) return failed("attempt", claim.error);
      if (claim.value.durability !== "confirmed") {
        return failed("attempt", domainError("external_failure"));
      }
      role = claim.value.state === "acquired" ? "implementer" : "integration_engineer";
    }

    const resolved = await this.ports.resolution.resolve(
      {
        job: request.job,
        project: request.project,
        worktree: request.worktree,
        changeRequest: changeRequest.value,
        requirementSnapshot: request.requirementSnapshot,
        assessment: request.assessment,
        assignee: {
          role,
          ...(role === "implementer" ? { agentId: request.originalImplementerId } : {}),
        },
      },
      mutation(request, `resolve-${role}`),
    );
    if (!resolved.ok) return failed("resolution", resolved.error);
    if (resolved.value.state === "unresolved") {
      if (role === "implementer") {
        return Object.freeze({
          state: "reroute_required",
          role: "integration_engineer",
          reason: "simple_attempt_unresolved",
        });
      }
      return this.#escalate(
        request,
        changeRequest.value,
        "integration_unresolved",
        resolved.value.summary,
      );
    }
    if (
      !shaPattern.test(resolved.value.pushedHeadSha) ||
      sameSha(resolved.value.pushedHeadSha, request.expectedHeadSha)
    ) {
      return failed("resolution", domainError("conflict"));
    }

    const afterWorktree = await this.#verifyCleanWorktree(request, resolved.value.pushedHeadSha);
    if (!afterWorktree.ok) return failed("worktree", afterWorktree.error);
    const afterChangeRequest = await this.ports.sourceControl.getChangeRequest(
      reference,
      readOptions,
    );
    if (!afterChangeRequest.ok) return failed("change_request", afterChangeRequest.error);
    if (
      afterChangeRequest.value.state !== "open" ||
      afterChangeRequest.value.baseBranch !== request.project.defaultBranch ||
      afterChangeRequest.value.headBranch !== request.worktree.branch ||
      !sameSha(afterChangeRequest.value.headSha, resolved.value.pushedHeadSha)
    ) {
      return failed("change_request", domainError("conflict"));
    }
    if (afterChangeRequest.value.mergeability === "conflicting") {
      if (role === "implementer") {
        return Object.freeze({
          state: "reroute_required",
          role: "integration_engineer",
          reason: "simple_attempt_unresolved",
        });
      }
      return this.#escalate(
        request,
        afterChangeRequest.value,
        "integration_unresolved",
        "The integration engineer pushed a conflict resolution, but GitHub remains conflicting.",
        { ...request.worktree, headSha: resolved.value.pushedHeadSha },
      );
    }
    const diff = await this.ports.git.getEffectiveTreeDiff(
      { rootPath: request.project.localRepositoryPath },
      request.baseRevision,
      resolved.value.pushedHeadSha,
      readOptions,
    );
    if (!diff.ok) return failed("diff", diff.error);
    const identity = createReviewIdentity(
      request.requirementSnapshot,
      resolved.value.pushedHeadSha,
      diff.value,
    );
    if (!identity.ok) return failed("diff", identity.error);
    const validation =
      request.previousReviewIdentity !== undefined &&
      compareReviewIdentity(request.previousReviewIdentity, identity.value) === "ci_revalidation"
        ? "ci_only"
        : "ci_and_review";
    return Object.freeze({
      state: "resolved",
      role,
      headSha: resolved.value.pushedHeadSha,
      identity: identity.value,
      validation,
    });
  }

  async #verifyCleanWorktree(
    request: ConflictPipelineRequest,
    expectedHeadSha: string,
  ): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; error: DomainError }>> {
    const readOptions = request.signal === undefined ? {} : { signal: request.signal };
    const [worktree, changes] = await Promise.all([
      this.ports.git.inspectWorktree(request.worktree, readOptions),
      this.ports.git.inspectWorkingTree(request.worktree, readOptions),
    ]);
    if (!worktree.ok) return worktree;
    if (!changes.ok) return changes;
    return worktree.value.clean &&
      worktree.value.branch === request.worktree.branch &&
      sameSha(worktree.value.headSha, expectedHeadSha) &&
      sameSha(changes.value.headSha, expectedHeadSha) &&
      changes.value.changes.length === 0
      ? Object.freeze({ ok: true })
      : Object.freeze({ ok: false, error: domainError("conflict") });
  }

  async #escalate(
    request: ConflictPipelineRequest,
    changeRequest: Parameters<
      ConflictPipelinePorts["escalation"]["checkpointAndEscalate"]
    >[0]["changeRequest"],
    reason: ConflictEscalationReason,
    summary: string,
    worktree = request.worktree,
  ): Promise<ConflictPipelineOutcome> {
    const escalated = await this.ports.escalation.checkpointAndEscalate(
      {
        job: request.job,
        project: request.project,
        worktree,
        changeRequest,
        requirementSnapshot: request.requirementSnapshot,
        assessment: request.assessment,
        reason,
        summary,
      },
      mutation(request, `escalate-${reason}`),
    );
    if (!escalated.ok) return failed("escalation", escalated.error);
    if (
      escalated.value.durability !== "confirmed" ||
      escalated.value.checkpointId.trim().length === 0
    ) {
      return failed("escalation", domainError("external_failure"));
    }
    return Object.freeze({
      state: "escalated",
      reason,
      checkpointId: escalated.value.checkpointId,
    });
  }
}
