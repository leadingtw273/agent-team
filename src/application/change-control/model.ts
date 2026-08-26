import { z } from "zod";

import type { DomainError } from "../../domain/foundation/index.js";
import type { Job } from "../../domain/jobs/index.js";
import type { Issue, Project } from "../../domain/project/index.js";
import type { RequirementSnapshot } from "../../domain/review/index.js";
import type { GitWorktree } from "../ports/index.js";
import type { AsyncPortResult, MutationOptions } from "../ports/common.js";

export const changeAssessmentSchema = z
  .object({
    schemaVersion: z.literal(1),
    narrativeChange: z.enum(["none", "clerical", "clarification", "observable_change", "unknown"]),
    observableOutcomeChanged: z.union([z.boolean(), z.literal("unknown")]),
    externalServiceAdded: z.union([z.boolean(), z.literal("unknown")]),
    dangerousOperationAdded: z.union([z.boolean(), z.literal("unknown")]),
    deliverableChanged: z.union([z.boolean(), z.literal("unknown")]),
    edgeCaseAdded: z.union([z.boolean(), z.literal("unknown")]),
    summary: z.string().trim().min(1).max(16_384),
    evidenceSources: z.array(z.string().trim().min(1).max(1_024)).min(1).max(100),
  })
  .strict();

export type ChangeAssessment = z.infer<typeof changeAssessmentSchema>;

export type RequirementChangeReason =
  | "acceptance_criteria_changed"
  | "scope_changed"
  | "dependencies_changed"
  | "agent_role_changed"
  | "review_requirement_changed"
  | "estimate_changed"
  | "constraints_changed"
  | "risks_changed"
  | "change_regions_changed"
  | "skill_selection_changed"
  | "observable_outcome_changed"
  | "external_service_added"
  | "dangerous_operation_added"
  | "deliverable_changed"
  | "edge_case_added"
  | "uncertain_change";

export type RequirementChangeClassification =
  | Readonly<{ kind: "no_change"; changedFields: readonly string[] }>
  | Readonly<{ kind: "small_supplement"; changedFields: readonly string[] }>
  | Readonly<{
      kind: "substantive";
      changedFields: readonly string[];
      reasons: readonly RequirementChangeReason[];
    }>;

export interface ChangeControlPersistencePort {
  recordSupplement(
    request: Readonly<{
      job: Job;
      project: Project;
      currentSnapshot: RequirementSnapshot;
      proposedIssue: Issue;
      assessment: ChangeAssessment;
      changedFields: readonly string[];
      preserveApprovedSnapshot: true;
    }>,
    options: MutationOptions,
  ): AsyncPortResult<Readonly<{ supplementId: string; durability: "confirmed" | "unknown" }>>;

  checkpointAndReturnToBacklog(
    request: Readonly<{
      job: Job;
      project: Project;
      worktree: GitWorktree;
      currentSnapshot: RequirementSnapshot;
      proposedIssue: Issue;
      assessment: ChangeAssessment;
      changedFields: readonly string[];
      reasons: readonly RequirementChangeReason[];
      requiresUserReapproval: true;
    }>,
    options: MutationOptions,
  ): AsyncPortResult<Readonly<{ checkpointId: string; durability: "confirmed" | "unknown" }>>;
}

export interface ChangeControlRequest {
  readonly job: Job;
  readonly project: Project;
  readonly worktree: GitWorktree;
  readonly currentSnapshot: RequirementSnapshot;
  readonly proposedIssue: Issue;
  readonly assessment: ChangeAssessment;
  readonly idempotencyKeyPrefix: string;
  readonly signal?: AbortSignal;
}

export type ChangeControlFailureStage = "request" | "supplement" | "checkpoint";

export type ChangeControlOutcome =
  | Readonly<{ state: "unchanged" }>
  | Readonly<{
      state: "continue";
      supplementId: string;
      approvedSnapshot: RequirementSnapshot;
      changedFields: readonly string[];
    }>
  | Readonly<{
      state: "requires_reapproval";
      checkpointId: string;
      reasons: readonly RequirementChangeReason[];
      changedFields: readonly string[];
    }>
  | Readonly<{
      state: "failed";
      stage: ChangeControlFailureStage;
      error: DomainError;
    }>;
