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
  ReportContractFailureCategory,
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

/**
 * C015r decision 4: one fixed sentence per `ReportContractFailureCategory`, appended to a retry
 * attempt's directive -- never the previous attempt's raw invalid output (coordinator's explicit
 * requirement, and the reason this is a `switch` over a closed enum rather than a template that
 * could ever be handed free-form text). Each sentence names the *mechanical* fix, not the specific
 * value that was wrong (this function has no access to that, and must not be given it).
 */
function reportRetryFeedbackSentence(category: ReportContractFailureCategory): string {
  switch (category) {
    case "empty_output":
      return "Your previous attempt ended without producing the JSON report at all -- your final message this time must end with the completed skeleton below.";
    case "invalid_json":
      return "Your previous attempt's final message was not syntactically valid JSON -- copy the skeleton below exactly, including every brace, bracket, comma, and quote, and only replace the <...> placeholders.";
    case "preamble_or_trailing_content":
      return "Your previous attempt added a sentence before or after the JSON object -- this time your final message must contain nothing else at all, not even a short acknowledgement.";
    case "missing_field":
      return "Your previous attempt was missing one or more of the skeleton's required keys -- your final message must include every key that appears in the skeleton below, none renamed or removed.";
    case "enum_mismatch":
      return "Your previous attempt used a value for an enum field (verdict, status, or severity) that is not one of the exact values listed inside that field's own <...> placeholder -- use one of those exact values, not a synonym.";
    case "context_mismatch":
      return "Your previous attempt's requirementsDigest, headSha, diffDigest, acceptance criteria, quality dimensions, or evidenceSources did not match this run's own skeleton -- copy those values from the skeleton below exactly rather than restating them from memory.";
    case "schema_invalid":
      return "Your previous attempt did not match the required report structure -- follow the skeleton below exactly, key for key.";
  }
}

/**
 * C015r decision 2 (the core fix, replacing the coordinator's own earlier "just list the fields in
 * prose" Option A once C015q's real-CLI repro proved that alone is not reliable enough): builds a
 * literal, ready-to-copy JSON skeleton for this exact run -- every deterministic value (schemaVersion,
 * role, the three digests, every approved AC's `criterion` text, every required quality dimension for
 * this role) is *already filled in*; the only things left for the model to write are free text
 * (summary fields) and closed-enum choices, and every closed-enum placeholder spells out its own
 * complete, exact legal value list inline (mirroring what C015q's real repro proved *does* reliably
 * work for `verdict`, whose legal values were already spelled out this way before this ticket).
 * `evidenceSources` placeholders list every currently-allowed source verbatim, so the model never has
 * to invent or guess one. This function builds *only* the directive's text -- it does not change what
 * `reviewerReportSchema`/`reviewerReportMatchesContext` accept, and a skeleton copied byte-for-byte
 * with placeholders left unfilled would still, correctly, fail that unmodified validation.
 */
function reportSkeleton(
  role: RequiredReviewerRole,
  request: ReviewerPipelineRequest,
  identity: ReviewIdentity,
  evidenceSourceList: readonly string[],
): Readonly<Record<string, unknown>> {
  const qualityDimensions =
    role === "code_reviewer" ? codeQualityDimensions : visualQualityDimensions;
  const acceptanceCriteria = request.requirementSnapshot.issue.acceptanceCriteria ?? [];
  const evidenceSourcesPlaceholder = `<zero or more of, each copied exactly: ${evidenceSourceList.join(" | ")}>`;
  return Object.freeze({
    schemaVersion: 1,
    role,
    verdict: "<exactly one of: passed | changes_requested | clarification_required>",
    requirementsDigest: identity.requirementsDigest,
    headSha: identity.headSha,
    diffDigest: identity.diffDigest,
    ...(identity.evidenceDigest === undefined ? {} : { evidenceDigest: identity.evidenceDigest }),
    ...(identity.publicationDigest === undefined
      ? {}
      : { publicationDigest: identity.publicationDigest }),
    summary: "<replace with your own free-text summary of this review>",
    acceptanceCriteria: acceptanceCriteria.map((criterion) => ({
      criterion,
      status: "<exactly one of: passed | failed | clarification_required>",
      summary: "<replace with your own free-text summary for this criterion>",
      evidenceSources: [evidenceSourcesPlaceholder],
    })),
    qualityChecks: qualityDimensions.map((dimension) => ({
      dimension,
      status: "<exactly one of: passed | failed | not_applicable>",
      summary: "<replace with your own free-text summary for this dimension>",
      evidenceSources: [evidenceSourcesPlaceholder],
    })),
    findings:
      '<replace with your own JSON array of zero or more objects, each shaped exactly like: {"severity": "<exactly one of: blocking | advisory | clarification>", "title": "<short text>", "description": "<free text>", "acceptanceCriteria": ["<zero or more of the exact criterion strings above>"], "evidenceSources": [' +
      evidenceSourcesPlaceholder +
      '], "path": "<optional repository-relative path, or omit this key>", "line": "<optional positive integer, or omit this key>"} -- an empty top-level array [] is a complete, valid answer if there is nothing to report, but every individual finding object inside it must have at least one entry in acceptanceCriteria OR at least one entry in evidenceSources -- never both empty at the same time>',
  });
}

export function reviewerDirective(
  role: RequiredReviewerRole,
  request: ReviewerPipelineRequest,
  identity: ReviewIdentity,
  evidenceSourceList: readonly string[],
  retryFeedback?: Readonly<{ category: ReportContractFailureCategory }>,
): string {
  const skeleton = reportSkeleton(role, request, identity, evidenceSourceList);
  const instructions = [
    `Perform a fresh-context ${role} review.`,
    `Read only the approved repository at base revision ${request.baseRevision} and Head SHA ${identity.headSha}.`,
    "Do not use or infer implementer conversation, hidden reasoning, handoff notes, or unrelated logs.",
    "Check every acceptance criterion and the role quality rules. Do not modify files or merge.",
    "Below is the exact JSON skeleton for your report. Copy it exactly and replace every <...> placeholder with real content of the type described inside it; do not add, remove, rename, or reorder any key at any nesting level; keep every value that is not itself a <...> placeholder character-for-character unchanged, including schemaVersion, role, requirementsDigest, headSha, diffDigest, every acceptanceCriteria[].criterion, and every qualityChecks[].dimension.",
    "Every enum-valued field's only legal values are exactly the values written inside its own <...> placeholder in the skeleton -- never invent, abbreviate, translate, or substitute a synonym for any of them.",
    "Your entire final message must be that one completed JSON object and nothing else: no leading sentence, no trailing sentence, no Markdown code fence, not even a single extra character before the opening { or after the closing }.",
    ...(retryFeedback === undefined ? [] : [reportRetryFeedbackSentence(retryFeedback.category)]),
  ];
  return [...instructions, "JSON SKELETON (copy exactly, only replacing <...> placeholders):"]
    .join(" ")
    .concat("\n", JSON.stringify(skeleton, null, 2));
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
    report.evidenceDigest === identity.evidenceDigest &&
    report.publicationDigest === identity.publicationDigest &&
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
