import { domainError, type DomainError } from "../../domain/foundation/index.js";
import { jobSchema } from "../../domain/jobs/index.js";
import { issueSchema, projectSchema } from "../../domain/project/index.js";
import { requirementSnapshotSchema } from "../../domain/review/index.js";
import type { MutationOptions } from "../ports/index.js";
import type {
  ChangeControlFailureStage,
  ChangeControlOutcome,
  ChangeControlPersistencePort,
  ChangeControlRequest,
} from "./model.js";
import { changeAssessmentSchema } from "./model.js";
import { classifyRequirementChange } from "./policy.js";

const idempotencyPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@+-]{0,220}$/u;

function mutation(request: ChangeControlRequest, step: string): MutationOptions {
  return {
    idempotencyKey: `${request.idempotencyKeyPrefix}:${step}`,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  };
}

function failed(stage: ChangeControlFailureStage, error: DomainError): ChangeControlOutcome {
  return Object.freeze({ state: "failed", stage, error });
}

function validRequest(request: ChangeControlRequest): boolean {
  return (
    jobSchema.safeParse(request.job).success &&
    projectSchema.safeParse(request.project).success &&
    requirementSnapshotSchema.safeParse(request.currentSnapshot).success &&
    issueSchema.safeParse(request.proposedIssue).success &&
    changeAssessmentSchema.safeParse(request.assessment).success &&
    request.job.projectId === request.project.id &&
    request.job.issueId === request.currentSnapshot.issue.id &&
    request.currentSnapshot.issue.projectId === request.project.id &&
    request.proposedIssue.id === request.currentSnapshot.issue.id &&
    request.proposedIssue.projectId === request.project.id &&
    request.proposedIssue.externalId === request.currentSnapshot.issue.externalId &&
    request.worktree.repositoryRoot === request.project.localRepositoryPath &&
    request.worktree.branch.trim().length > 0 &&
    idempotencyPattern.test(request.idempotencyKeyPrefix)
  );
}

export class ChangeControlCoordinator {
  constructor(readonly persistence: ChangeControlPersistencePort) {}

  async evaluate(request: ChangeControlRequest): Promise<ChangeControlOutcome> {
    if (!validRequest(request)) return failed("request", domainError("invariant_violation"));
    const classification = classifyRequirementChange(
      request.currentSnapshot.issue,
      request.proposedIssue,
      request.assessment,
    );
    if (classification.kind === "no_change") return Object.freeze({ state: "unchanged" });
    if (classification.kind === "small_supplement") {
      const recorded = await this.persistence.recordSupplement(
        {
          job: request.job,
          project: request.project,
          currentSnapshot: request.currentSnapshot,
          proposedIssue: request.proposedIssue,
          assessment: request.assessment,
          changedFields: classification.changedFields,
          preserveApprovedSnapshot: true,
        },
        mutation(request, "record-supplement"),
      );
      if (!recorded.ok) return failed("supplement", recorded.error);
      if (
        recorded.value.durability !== "confirmed" ||
        recorded.value.supplementId.trim().length === 0
      ) {
        return failed("supplement", domainError("external_failure"));
      }
      return Object.freeze({
        state: "continue",
        supplementId: recorded.value.supplementId,
        approvedSnapshot: request.currentSnapshot,
        changedFields: classification.changedFields,
      });
    }

    const checkpoint = await this.persistence.checkpointAndReturnToBacklog(
      {
        job: request.job,
        project: request.project,
        worktree: request.worktree,
        currentSnapshot: request.currentSnapshot,
        proposedIssue: request.proposedIssue,
        assessment: request.assessment,
        changedFields: classification.changedFields,
        reasons: classification.reasons,
        requiresUserReapproval: true,
      },
      mutation(request, "checkpoint-and-return-to-backlog"),
    );
    if (!checkpoint.ok) return failed("checkpoint", checkpoint.error);
    if (
      checkpoint.value.durability !== "confirmed" ||
      checkpoint.value.checkpointId.trim().length === 0
    ) {
      return failed("checkpoint", domainError("external_failure"));
    }
    return Object.freeze({
      state: "requires_reapproval",
      checkpointId: checkpoint.value.checkpointId,
      reasons: classification.reasons,
      changedFields: classification.changedFields,
    });
  }
}
