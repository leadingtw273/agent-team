import { z } from "zod";

import type { DomainError } from "../../domain/foundation/index.js";
import type { Job } from "../../domain/jobs/index.js";
import type { AgentRole, Project } from "../../domain/project/index.js";
import type { ReviewIdentity, RequirementSnapshot } from "../../domain/review/index.js";
import type {
  ChangeRequestSnapshot,
  GitPort,
  GitWorktree,
  SourceControlPort,
} from "../ports/index.js";
import type { AsyncPortResult, MutationOptions } from "../ports/common.js";

const nonEmptyText = z.string().trim().min(1).max(16_384);

export const conflictAssessmentSchema = z
  .object({
    schemaVersion: z.literal(1),
    requirementsCompatibility: z.enum(["compatible", "incompatible", "unknown"]),
    resolutionNature: z.enum(["mechanical", "semantic", "unknown"]),
    summary: nonEmptyText,
    evidenceSources: z.array(z.string().trim().min(1).max(1_024)).min(1).max(100),
  })
  .strict();

export type ConflictAssessment = z.infer<typeof conflictAssessmentSchema>;
export type ConflictClassification = "simple" | "semantic" | "requirements";
export type ConflictResolverRole = Extract<AgentRole, "implementer" | "integration_engineer">;

export interface ConflictAttemptPort {
  claimSimpleAttempt(
    request: Readonly<{ jobId: string; changeRequestId: string; baseRevision: string }>,
    options: MutationOptions,
  ): AsyncPortResult<
    Readonly<{ state: "acquired" | "already_used"; durability: "confirmed" | "unknown" }>
  >;
}

export interface ConflictResolutionPort {
  resolve(
    request: Readonly<{
      job: Job;
      project: Project;
      worktree: GitWorktree;
      changeRequest: ChangeRequestSnapshot;
      requirementSnapshot: RequirementSnapshot;
      assessment: ConflictAssessment;
      assignee: Readonly<{
        role: ConflictResolverRole;
        agentId?: string;
      }>;
    }>,
    options: MutationOptions,
  ): AsyncPortResult<
    | Readonly<{ state: "resolved"; pushedHeadSha: string }>
    | Readonly<{ state: "unresolved"; summary: string }>
  >;
}

export type ConflictEscalationReason =
  "requirements_conflict" | "requirements_unknown" | "integration_unresolved";

export interface ConflictEscalationPort {
  checkpointAndEscalate(
    request: Readonly<{
      job: Job;
      project: Project;
      worktree: GitWorktree;
      changeRequest: ChangeRequestSnapshot;
      requirementSnapshot: RequirementSnapshot;
      assessment: ConflictAssessment;
      reason: ConflictEscalationReason;
      summary: string;
    }>,
    options: MutationOptions,
  ): AsyncPortResult<Readonly<{ checkpointId: string; durability: "confirmed" | "unknown" }>>;
}

export interface ConflictPipelinePorts {
  readonly git: Pick<GitPort, "inspectWorktree" | "inspectWorkingTree" | "getEffectiveTreeDiff">;
  readonly sourceControl: Pick<SourceControlPort, "getChangeRequest">;
  readonly attempts: ConflictAttemptPort;
  readonly resolution: ConflictResolutionPort;
  readonly escalation: ConflictEscalationPort;
}

export interface ConflictPipelineRequest {
  readonly job: Job;
  readonly project: Project;
  readonly worktree: GitWorktree;
  readonly changeRequestId: string;
  readonly expectedHeadSha: string;
  readonly baseRevision: string;
  readonly requirementSnapshot: RequirementSnapshot;
  readonly assessment: ConflictAssessment;
  readonly originalImplementerId: string;
  readonly previousReviewIdentity?: ReviewIdentity;
  readonly idempotencyKeyPrefix: string;
  readonly signal?: AbortSignal;
}

export type ConflictFailureStage =
  "request" | "change_request" | "worktree" | "attempt" | "resolution" | "escalation" | "diff";

export type ConflictPipelineOutcome =
  | Readonly<{ state: "not_required"; reason: "no_longer_conflicting" }>
  | Readonly<{ state: "waiting"; reason: "mergeability_unknown" }>
  | Readonly<{
      state: "reroute_required";
      role: "integration_engineer";
      reason: "simple_attempt_unresolved";
    }>
  | Readonly<{
      state: "escalated";
      reason: ConflictEscalationReason;
      checkpointId: string;
    }>
  | Readonly<{
      state: "resolved";
      role: ConflictResolverRole;
      headSha: string;
      identity: ReviewIdentity;
      validation: "ci_only" | "ci_and_review";
    }>
  | Readonly<{
      state: "failed";
      stage: ConflictFailureStage;
      error: DomainError;
    }>;
