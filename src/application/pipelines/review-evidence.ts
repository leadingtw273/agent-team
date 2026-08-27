import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import {
  acceptanceCriterionReviewSchema,
  qualityCheckSchema,
  reviewFindingSchema,
  type ReviewerPipelineOutcome,
} from "./reviewer-model.js";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const headShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);

export const publishedReviewIdentitySchema = z
  .object({
    requirementsDigest: digestSchema,
    headSha: headShaSchema,
    diffDigest: digestSchema,
    evidenceDigest: digestSchema.optional(),
    publicationDigest: digestSchema.optional(),
  })
  .strict();

const publishedReportSchema = z
  .object({
    role: z.enum(["code_reviewer", "visual_reviewer"]),
    verdict: z.enum(["passed", "changes_requested", "clarification_required"]),
    summary: z.string().trim().min(1).max(65_536),
    acceptanceCriteria: z.array(acceptanceCriterionReviewSchema).min(1).max(100),
    qualityChecks: z.array(qualityCheckSchema).min(1).max(100),
    findings: z.array(reviewFindingSchema).max(1_000),
  })
  .strict();

export const publishedReviewEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("agent_team_review"),
    verdict: z.enum(["approved", "changes_requested", "clarification_required"]),
    identity: publishedReviewIdentitySchema,
    reports: z.array(publishedReportSchema).min(1).max(2),
    findings: z.array(reviewFindingSchema).max(1_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.reports.map((report) => report.role)).size !== value.reports.length) {
      context.addIssue({ code: "custom", path: ["reports"], message: "Roles must be unique." });
    }
    const expectedFindings = value.reports.flatMap((report) =>
      report.findings.filter((finding) =>
        value.verdict === "changes_requested"
          ? finding.severity === "blocking"
          : value.verdict === "clarification_required"
            ? finding.severity === "clarification"
            : false,
      ),
    );
    if (!isDeepStrictEqual(value.findings, expectedFindings)) {
      context.addIssue({
        code: "custom",
        path: ["findings"],
        message: "Top-level findings must match the published decision findings.",
      });
    }
    const expectedVerdict = value.reports.some(
      (report) => report.verdict === "clarification_required",
    )
      ? "clarification_required"
      : value.reports.some((report) => report.verdict === "changes_requested")
        ? "changes_requested"
        : "approved";
    if (value.verdict !== expectedVerdict) {
      context.addIssue({ code: "custom", path: ["verdict"], message: "Verdict mismatch." });
    }
  });

export type PublishedReviewEvidence = z.infer<typeof publishedReviewEvidenceSchema>;

export interface ParsedPublishedReviewEvidence extends PublishedReviewEvidence {
  readonly markerDigest: string;
}

const publishedBodyPattern =
  /^Agent Team review: \*\*(approved|changes_requested|clarification_required)\*\*\n\n```json\n([\s\S]*?)\n```\n\n<!-- agent-team:review_evidence:([0-9a-f]{64}) -->$/u;

export function renderReviewComment(
  decision: Extract<
    ReviewerPipelineOutcome,
    { state: "approved" | "changes_requested" | "clarification_required" }
  >,
): string {
  const findings = "findings" in decision ? decision.findings : [];
  return [
    `Agent Team review: **${decision.state}**`,
    "",
    "```json",
    JSON.stringify(
      {
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
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

export function parsePublishedReviewEvidence(
  body: string,
): Result<ParsedPublishedReviewEvidence, DomainError> {
  const match = publishedBodyPattern.exec(body);
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
    return err(domainError("external_failure"));
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(match[2]);
  } catch {
    return err(domainError("external_failure"));
  }
  const parsed = publishedReviewEvidenceSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.verdict !== match[1]) {
    return err(domainError("external_failure"));
  }
  return ok(Object.freeze({ ...parsed.data, markerDigest: match[3] }));
}

export function publishedIdentityMatches(
  published: PublishedReviewEvidence["identity"],
  expected: PublishedReviewEvidence["identity"],
): boolean {
  return isDeepStrictEqual(published, expected);
}
