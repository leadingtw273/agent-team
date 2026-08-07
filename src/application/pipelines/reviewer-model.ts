import { z } from "zod";

import type { VisualManifest } from "../../domain/checkpoint/index.js";
import type { DomainError, Instant } from "../../domain/foundation/index.js";
import type { Job } from "../../domain/jobs/index.js";
import type { Project } from "../../domain/project/index.js";
import type { ReviewIdentity, RequirementSnapshot } from "../../domain/review/index.js";
import { repositoryRelativePathSchema } from "../../domain/project/index.js";
import type { TrustedProjectConfig } from "../projects/index.js";
import type {
  ChangeRequestSnapshot,
  CommitChecksSnapshot,
  GitPort,
  GitWorktree,
  ProviderPort,
  SourceControlPort,
} from "../ports/index.js";
import type { AsyncPortResult, MutationOptions, ReadOptions } from "../ports/common.js";
import type { ProviderToolDecisionPort } from "./implementer-model.js";

const nonEmptyTextSchema = z.string().trim().min(1).max(65_536);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const headShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);

export const reviewEvidenceCategorySchema = z.enum([
  "related_failure_log",
  "benchmark",
  "known_issue",
  "visual_artifact",
  "visual_reference",
]);
export type ReviewEvidenceCategory = z.infer<typeof reviewEvidenceCategorySchema>;

const reviewEvidenceBaseSchema = z.object({
  category: reviewEvidenceCategorySchema,
  source: z.string().trim().min(1).max(1_024),
  mediaType: z.string().trim().min(1).max(255),
});

export const reviewEvidenceBlockSchema = z.discriminatedUnion("kind", [
  reviewEvidenceBaseSchema
    .extend({ kind: z.literal("text"), content: z.string().max(1_048_576) })
    .strict(),
  reviewEvidenceBaseSchema
    .extend({
      kind: z.literal("file"),
      path: z.string().trim().min(1).max(4_096),
      sha256: sha256Schema,
      repositoryPath: repositoryRelativePathSchema.optional(),
    })
    .strict()
    .superRefine((evidence, context) => {
      if (evidence.category === "visual_artifact" && evidence.repositoryPath === undefined) {
        context.addIssue({
          code: "custom",
          message: "Visual artifacts must identify their repository-relative Manifest path.",
          path: ["repositoryPath"],
        });
      }
    }),
]);
export type ReviewEvidenceBlock = z.infer<typeof reviewEvidenceBlockSchema>;

export const reviewFindingSchema = z
  .object({
    severity: z.enum(["blocking", "advisory", "clarification"]),
    title: z.string().trim().min(1).max(255),
    description: nonEmptyTextSchema,
    acceptanceCriteria: z.array(nonEmptyTextSchema).max(100),
    evidenceSources: z.array(z.string().trim().min(1).max(1_024)).max(100),
    path: repositoryRelativePathSchema.optional(),
    line: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((finding, context) => {
    if (finding.line !== undefined && finding.path === undefined) {
      context.addIssue({
        code: "custom",
        message: "A line number requires a repository path.",
        path: ["line"],
      });
    }
    if (finding.acceptanceCriteria.length === 0 && finding.evidenceSources.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Every finding must bind to an AC or evidence source.",
      });
    }
  });
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

export const reviewQualityDimensionSchema = z.enum([
  "test_effectiveness",
  "correctness",
  "error_handling",
  "boundaries",
  "security",
  "secrets",
  "readability",
  "module_boundaries",
  "maintainability",
  "duplication_overdesign",
  "compatibility",
  "scope",
  "documentation_migrations",
  "layout",
  "spacing",
  "hierarchy",
  "style_consistency",
  "sizes_states",
  "accessibility",
  "broken_assets_clipping_flicker",
  "visual_regression",
]);
export type ReviewQualityDimension = z.infer<typeof reviewQualityDimensionSchema>;

const reviewEvidenceReferencesSchema = z.array(z.string().trim().min(1).max(1_024)).max(100);

export const acceptanceCriterionReviewSchema = z
  .object({
    criterion: nonEmptyTextSchema,
    status: z.enum(["passed", "failed", "clarification_required"]),
    summary: nonEmptyTextSchema,
    evidenceSources: reviewEvidenceReferencesSchema,
  })
  .strict();

export const qualityCheckSchema = z
  .object({
    dimension: reviewQualityDimensionSchema,
    status: z.enum(["passed", "failed", "not_applicable"]),
    summary: nonEmptyTextSchema,
    evidenceSources: reviewEvidenceReferencesSchema,
  })
  .strict();

export const reviewerReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    role: z.enum(["code_reviewer", "visual_reviewer"]),
    verdict: z.enum(["passed", "changes_requested", "clarification_required"]),
    requirementsDigest: sha256Schema,
    headSha: headShaSchema,
    diffDigest: sha256Schema,
    summary: nonEmptyTextSchema,
    acceptanceCriteria: z.array(acceptanceCriterionReviewSchema).min(1).max(100),
    qualityChecks: z.array(qualityCheckSchema).min(1).max(100),
    findings: z.array(reviewFindingSchema).max(1_000),
  })
  .strict()
  .superRefine((report, context) => {
    const blockers = report.findings.some((finding) => finding.severity === "blocking");
    const clarifications = report.findings.some((finding) => finding.severity === "clarification");
    if (report.verdict === "passed" && (blockers || clarifications)) {
      context.addIssue({ code: "custom", message: "A passed report cannot contain blockers." });
    }
    if (report.verdict === "changes_requested" && !blockers) {
      context.addIssue({ code: "custom", message: "Changes requested requires a blocker." });
    }
    if (report.verdict === "clarification_required" && !clarifications) {
      context.addIssue({
        code: "custom",
        message: "Clarification required needs a clarification finding.",
      });
    }
  });
export type ReviewerReport = z.infer<typeof reviewerReportSchema>;

/**
 * C015r decision 4 (failure-reason propagation, deliberately *not* a policy/verdict change): the
 * deterministic classification `reviewer-provider.ts`'s tolerant parser computes for *why* a
 * `report`-stage provider output still failed even after decision 3's two-step syntactic tolerance
 * (strip one Markdown fence layer, then extract the first `{` through the last `}` once). This is a
 * closed, small enum precisely so it can be persisted (job-progress-store.ts's
 * `review_report_pending_retry`/`requires_manual.cause` -- never the provider's own raw text) and
 * fed back into a retry's own directive as a fixed sentence (reviewer-policy.ts) -- never by
 * reflowing the invalid output itself back to the model (coordinator's explicit requirement).
 *
 * Precedence when multiple conditions could apply (documented once here, not re-derived per call
 * site): `empty_output` > `invalid_json` > `preamble_or_trailing_content` > `missing_field` >
 * `enum_mismatch` > `context_mismatch` > `schema_invalid` (catch-all). Earlier categories are
 * checked first because they block ever reaching the later, more specific checks (e.g. you cannot
 * classify *which* schema issue occurred without first having valid JSON at all).
 */
export const reportContractFailureCategorySchema = z.enum([
  "empty_output",
  "invalid_json",
  "preamble_or_trailing_content",
  "missing_field",
  "enum_mismatch",
  "context_mismatch",
  "schema_invalid",
]);
export type ReportContractFailureCategory = z.infer<typeof reportContractFailureCategorySchema>;

export interface ReviewerEvidenceIntegrityPort {
  verify(
    evidence: Extract<ReviewEvidenceBlock, { kind: "file" }>,
    options?: ReadOptions,
  ): AsyncPortResult<Readonly<{ verified: boolean; byteLength: number }>>;
}

export interface ReviewerJobPort {
  update(
    job: Job,
    options: MutationOptions,
  ): AsyncPortResult<Readonly<{ durability: "confirmed" | "unknown" }>>;
}

export interface ReviewerCheckpointPort {
  preserve(
    request: Readonly<{
      job: Job;
      worktree: GitWorktree;
      requirementSnapshot: RequirementSnapshot;
      reason: "attempt_limit_reached";
      checks: CommitChecksSnapshot;
    }>,
    options: MutationOptions,
  ): AsyncPortResult<Readonly<{ checkpointId: string }>>;
}

export interface ReviewerPipelinePorts {
  readonly git: Pick<GitPort, "inspectWorktree" | "inspectWorkingTree" | "getEffectiveTreeDiff">;
  readonly sourceControl: Pick<
    SourceControlPort,
    "getChangeRequest" | "getCommitChecks" | "markChangeRequestReady"
  >;
  readonly codeReviewer?: ProviderPort;
  readonly visualReviewer?: ProviderPort;
  readonly toolDecisions: ProviderToolDecisionPort;
  readonly evidenceIntegrity: ReviewerEvidenceIntegrityPort;
  readonly jobs: ReviewerJobPort;
  readonly checkpoint: ReviewerCheckpointPort;
}

export interface ReviewerPipelineRequest {
  readonly job: Job;
  readonly project: Project;
  readonly trustedConfig: TrustedProjectConfig;
  readonly requirementSnapshot: RequirementSnapshot;
  readonly worktree: GitWorktree;
  readonly changeRequestId: string;
  readonly baseRevision: string;
  readonly expectedHeadSha: string;
  readonly models: Readonly<{ code?: string; visual?: string }>;
  readonly evidence: readonly ReviewEvidenceBlock[];
  readonly visualManifest?: VisualManifest;
  readonly deadlineAt: Instant;
  readonly idempotencyKeyPrefix: string;
  readonly signal?: AbortSignal;
  /** C015r decision 4: set only when this run is a bounded, dedicated report-contract retry (the
   * previous attempt's `report`-stage output failed decision 3's tolerant parse/schema/context
   * checks) -- `reviewerDirective` (reviewer-policy.ts) appends one fixed sentence keyed by
   * `category`, never the previous attempt's raw invalid text (coordinator's explicit requirement:
   * "不得回灌模型原始無效輸出"). Absent on a first attempt. */
  readonly reportRetryFeedback?: Readonly<{ category: ReportContractFailureCategory }>;
}

export type ReviewerFailureStage =
  | "request"
  | "change_request"
  | "checks"
  | "worktree"
  | "diff"
  | "evidence"
  | "checkpoint"
  | "ready"
  | "provider_start"
  | "provider_run"
  | "tool_decision"
  | "report"
  | "post_review_worktree"
  | "attempt_persistence";

interface ReviewOutcomeEvidence {
  readonly job: Job;
  readonly changeRequest: ChangeRequestSnapshot;
  readonly checks: CommitChecksSnapshot;
  readonly identity: ReviewIdentity;
  readonly reports: readonly ReviewerReport[];
}

export type ReviewerPipelineOutcome =
  | (Readonly<{ state: "approved" }> & ReviewOutcomeEvidence)
  | (Readonly<{ state: "changes_requested"; findings: readonly ReviewFinding[] }> &
      ReviewOutcomeEvidence)
  | (Readonly<{ state: "clarification_required"; findings: readonly ReviewFinding[] }> &
      ReviewOutcomeEvidence)
  | Readonly<{
      state: "not_ready";
      reason: "ci_pending" | "ci_failed";
      job: Job;
      changeRequest: ChangeRequestSnapshot;
      checks: CommitChecksSnapshot;
    }>
  | Readonly<{
      state: "checkpointed";
      reason: "attempt_limit_reached";
      job: Job;
      checkpointId: string;
      checks: CommitChecksSnapshot;
    }>
  | Readonly<{
      state: "paused";
      reason: "safety_approval_required" | "provider_interrupted";
      job: Job;
      toolSummary?: string;
    }>
  | Readonly<{
      state: "failed";
      stage: ReviewerFailureStage;
      error: DomainError;
      job: Job;
      /** C015r decision 4: only ever populated when `stage === "report"` -- see
       * `ReportContractFailureCategory`'s own header for what this is and why it exists. */
      reportFailureCategory?: ReportContractFailureCategory;
      /** C015r decision 5 (observability sidecar, pure data propagation -- the CLI/adapter layer,
       * never this application layer, decides whether/where to persist it): the exact text that
       * failed decision 3's tolerant parse/schema/context checks, only ever populated when
       * `stage === "report"`. This field is intentionally excluded from every other outcome shape
       * (never on `changes_requested`/`approved`/etc.) and callers must never copy it into a durable
       * `JobProgressRecord`/`cause`, an `agent-team run` CLI outcome, a PR, or Linear -- it exists
       * solely so the CLI-layer diagnostic sidecar (decision 5) can write it, Redactor-scrubbed,
       * size-capped, 0600, somewhere that is not any of those. */
      rejectedOutput?: string;
    }>;
