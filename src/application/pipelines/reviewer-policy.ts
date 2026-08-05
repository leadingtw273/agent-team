import { isAbsolute } from "node:path";

import { visualManifestSchema } from "../../domain/checkpoint/index.js";
import { parseInstant } from "../../domain/foundation/index.js";
import { attemptLimits, jobSchema, type Job } from "../../domain/jobs/index.js";
import { projectSchema, type AgentRole } from "../../domain/project/index.js";
import {
  requirementSnapshotSchema,
  type EffectiveTreeChange,
  type ReviewIdentity,
} from "../../domain/review/index.js";
import { trustedProjectConfigSchema } from "../projects/index.js";
import type { CommitChecksSnapshot, ExternalDataBlock } from "../ports/index.js";
import type {
  ReviewerPipelineRequest,
  ReviewerReport,
  ReviewQualityDimension,
} from "./reviewer-model.js";
import { reviewEvidenceBlockSchema } from "./reviewer-model.js";

const idempotencyPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@+-]{0,254}$/u;
const headShaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const generatedEvidenceSources = Object.freeze([
  "agent-team:review-identity",
  "agent-team:diff",
  "agent-team:ci",
  "agent-team:visual-manifest",
]);
const codeQualityDimensions = Object.freeze([
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
] as const satisfies readonly ReviewQualityDimension[]);
const visualQualityDimensions = Object.freeze([
  "layout",
  "spacing",
  "hierarchy",
  "readability",
  "style_consistency",
  "sizes_states",
  "accessibility",
  "broken_assets_clipping_flicker",
  "visual_regression",
] as const satisfies readonly ReviewQualityDimension[]);

export type RequiredReviewerRole = Extract<AgentRole, "code_reviewer" | "visual_reviewer">;

export function sameReviewSha(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function requiredReviewerRoles(
  request: ReviewerPipelineRequest,
): readonly RequiredReviewerRole[] {
  const requirement = request.requirementSnapshot.issue.reviewRequirement;
  if (requirement === "code_review") return ["code_reviewer"];
  if (requirement === "visual_review") return ["visual_reviewer"];
  if (requirement === "dual_review") return ["code_reviewer", "visual_reviewer"];
  return [];
}

export function validReviewerRequest(request: ReviewerPipelineRequest): boolean {
  const job = jobSchema.safeParse(request.job);
  const project = projectSchema.safeParse(request.project);
  const config = trustedProjectConfigSchema.safeParse(request.trustedConfig);
  const snapshot = requirementSnapshotSchema.safeParse(request.requirementSnapshot);
  const manifest =
    request.visualManifest === undefined
      ? undefined
      : visualManifestSchema.safeParse(request.visualManifest);
  const evidence = request.evidence.map((block) => reviewEvidenceBlockSchema.safeParse(block));
  const roles = requiredReviewerRoles(request);
  const sources = request.evidence.map((block) => block.source);
  const needsVisual = roles.includes("visual_reviewer");
  return (
    job.success &&
    project.success &&
    config.success &&
    snapshot.success &&
    manifest?.success !== false &&
    evidence.every((parsed) => parsed.success) &&
    job.data.projectId === project.data.id &&
    job.data.issueId === snapshot.data.issue.id &&
    snapshot.data.issue.projectId === project.data.id &&
    config.data.projectId === project.data.id &&
    config.data.defaultBranch === project.data.defaultBranch &&
    config.data.platforms.workManagement.provider === project.data.workManagement.provider &&
    config.data.platforms.workManagement.containerId === project.data.workManagement.containerId &&
    config.data.platforms.workManagement.projectId === project.data.workManagement.projectId &&
    config.data.platforms.sourceControl.provider === project.data.sourceControl.provider &&
    config.data.platforms.sourceControl.repository === project.data.sourceControl.repository &&
    request.worktree.repositoryRoot === project.data.localRepositoryPath &&
    request.worktree.branch.trim().length > 0 &&
    sameReviewSha(request.worktree.headSha, request.expectedHeadSha) &&
    snapshot.data.issue.acceptanceCriteria !== undefined &&
    snapshot.data.issue.acceptanceCriteria.length > 0 &&
    roles.length > 0 &&
    (roles.includes("code_reviewer")
      ? request.models.code?.trim().length !== 0 && request.models.code !== undefined
      : request.models.code === undefined) &&
    (needsVisual
      ? request.models.visual?.trim().length !== 0 &&
        request.models.visual !== undefined &&
        request.visualManifest !== undefined &&
        config.data.commands.visualReview.length > 0
      : request.models.visual === undefined && request.visualManifest === undefined) &&
    new Set(sources).size === sources.length &&
    sources.every((source) => !generatedEvidenceSources.includes(source)) &&
    idempotencyPattern.test(request.idempotencyKeyPrefix) &&
    request.idempotencyKeyPrefix.length <= 220 &&
    request.changeRequestId.trim().length > 0 &&
    request.baseRevision.trim().length > 0 &&
    headShaPattern.test(request.expectedHeadSha) &&
    isAbsolute(request.worktree.path) &&
    parseInstant(request.deadlineAt).ok
  );
}

export function anyReviewerAttemptLimitReached(job: Job): boolean {
  return (
    job.attempts.ciFixRounds >= attemptLimits.ciFixRounds ||
    job.attempts.reviewerFixRounds >= attemptLimits.reviewerFixRounds ||
    job.attempts.reviewRuns >= attemptLimits.reviewRuns
  );
}

export function evidenceForReviewerRole(
  request: ReviewerPipelineRequest,
  role: RequiredReviewerRole,
  identity: ReviewIdentity,
  diff: readonly EffectiveTreeChange[],
  checks: CommitChecksSnapshot,
): readonly ExternalDataBlock[] {
  const commonCategories = new Set(["related_failure_log", "benchmark", "known_issue"]);
  const selected = request.evidence.filter((block) =>
    role === "code_reviewer"
      ? commonCategories.has(block.category)
      : commonCategories.has(block.category) ||
        block.category === "visual_artifact" ||
        block.category === "visual_reference",
  );
  const external: ExternalDataBlock[] = [
    {
      kind: "text",
      source: "agent-team:review-identity",
      mediaType: "application/json",
      content: JSON.stringify(identity),
    },
    {
      kind: "text",
      source: "agent-team:diff",
      mediaType: "application/json",
      content: JSON.stringify(diff),
    },
    {
      kind: "text",
      source: "agent-team:ci",
      mediaType: "application/json",
      content: JSON.stringify(checks),
    },
    ...selected.map((block) =>
      block.kind === "text"
        ? {
            kind: "text" as const,
            source: block.source,
            mediaType: block.mediaType,
            content: block.content,
          }
        : {
            kind: "file" as const,
            source: block.source,
            mediaType: block.mediaType,
            path: block.path,
            sha256: block.sha256,
          },
    ),
  ];
  if (role === "visual_reviewer" && request.visualManifest !== undefined) {
    external.push({
      kind: "text",
      source: "agent-team:visual-manifest",
      mediaType: "application/json",
      content: JSON.stringify(request.visualManifest),
    });
  }
  return Object.freeze(external);
}

export function reviewerDirective(
  role: RequiredReviewerRole,
  request: ReviewerPipelineRequest,
  identity: ReviewIdentity,
): string {
  const qualityDimensions =
    role === "code_reviewer" ? codeQualityDimensions : visualQualityDimensions;
  return [
    `Perform a fresh-context ${role} review.`,
    `Read only the approved repository at base revision ${request.baseRevision} and Head SHA ${identity.headSha}.`,
    "Do not use or infer implementer conversation, hidden reasoning, handoff notes, or unrelated logs.",
    "Check every acceptance criterion and the role quality rules. Do not modify files or merge.",
    "Return only one JSON object with schemaVersion=1, role, verdict, requirementsDigest, headSha, diffDigest, summary, acceptanceCriteria, qualityChecks, and findings.",
    "acceptanceCriteria must contain each approved AC exactly once with status, summary, and evidenceSources.",
    `qualityChecks must contain each required dimension exactly once: ${qualityDimensions.join(", ")}.`,
    "Each finding requires severity, title, description, acceptanceCriteria[], evidenceSources[], and optional path/line.",
    "Verdict must be passed, changes_requested, or clarification_required. Do not use Markdown fences.",
  ].join(" ");
}

export function reviewerReportMatchesContext(
  report: ReviewerReport,
  role: RequiredReviewerRole,
  identity: ReviewIdentity,
  request: ReviewerPipelineRequest,
  evidenceSources: ReadonlySet<string>,
): boolean {
  const expectedCriteria = request.requirementSnapshot.issue.acceptanceCriteria ?? [];
  const criteria = new Set(expectedCriteria);
  const reviewedCriteria = report.acceptanceCriteria.map((item) => item.criterion);
  const expectedDimensions =
    role === "code_reviewer" ? codeQualityDimensions : visualQualityDimensions;
  const dimensionSet: ReadonlySet<ReviewQualityDimension> = new Set(expectedDimensions);
  const reviewedDimensions = report.qualityChecks.map((item) => item.dimension);
  const referencesAllowed = (sources: readonly string[]): boolean =>
    sources.every((source) => evidenceSources.has(source));
  const failedAcceptance = report.acceptanceCriteria.some((item) => item.status === "failed");
  const unclearAcceptance = report.acceptanceCriteria.some(
    (item) => item.status === "clarification_required",
  );
  const failedQuality = report.qualityChecks.some((item) => item.status === "failed");
  return (
    report.role === role &&
    report.requirementsDigest === identity.requirementsDigest &&
    sameReviewSha(report.headSha, identity.headSha) &&
    report.diffDigest === identity.diffDigest &&
    reviewedCriteria.length === expectedCriteria.length &&
    new Set(reviewedCriteria).size === reviewedCriteria.length &&
    reviewedCriteria.every((criterion) => criteria.has(criterion)) &&
    report.acceptanceCriteria.every(
      (item) =>
        referencesAllowed(item.evidenceSources) &&
        (role !== "visual_reviewer" || item.evidenceSources.length > 0),
    ) &&
    reviewedDimensions.length === expectedDimensions.length &&
    new Set(reviewedDimensions).size === reviewedDimensions.length &&
    reviewedDimensions.every((dimension) => dimensionSet.has(dimension)) &&
    report.qualityChecks.every((item) => referencesAllowed(item.evidenceSources)) &&
    report.findings.every(
      (finding) =>
        finding.acceptanceCriteria.every((criterion) => criteria.has(criterion)) &&
        finding.evidenceSources.every((source) => evidenceSources.has(source)),
    ) &&
    (report.verdict !== "passed" || (!failedAcceptance && !unclearAcceptance && !failedQuality)) &&
    (report.verdict !== "changes_requested" || failedAcceptance || failedQuality) &&
    (report.verdict !== "clarification_required" || unclearAcceptance)
  );
}
