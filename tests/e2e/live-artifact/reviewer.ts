import { z } from "zod";

import { GhTransport } from "../../../src/adapters/github/transport.js";
import { hasSafeDataShape } from "./boundary.js";
import {
  authorityReadSchema,
  digestIdentifier,
  digestSchema,
  headShaSchema,
  rawGithubObservationSchema,
  type Authority,
  type MissingReasonCode,
} from "./schema.js";

const reviewContext = "agent-team/review" as const;
const reviewMarker = /<!-- agent-team:review_evidence:[0-9a-f]{64} -->/u;
const commentPageSchema = z
  .object({
    count: z.number().int().nonnegative().max(100),
    comments: z
      .array(z.object({ htmlUrl: z.url(), body: z.string().max(1_000_000) }).strict())
      .max(100),
  })
  .strict();
const reviewPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("agent_team_review"),
    verdict: z.literal("approved"),
    identity: z
      .object({
        requirementsDigest: digestSchema,
        headSha: headShaSchema,
        diffDigest: digestSchema,
      })
      .strict(),
    reports: z
      .array(
        z
          .object({
            role: z.literal("code_reviewer"),
            verdict: z.literal("passed"),
            summary: z.string(),
            acceptanceCriteria: z.array(z.unknown()),
            qualityChecks: z.array(z.unknown()),
            findings: z.array(z.unknown()),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    findings: z.array(z.unknown()),
  })
  .strict();

export interface ReviewerIdentity {
  readonly role: "code_reviewer";
  readonly verdict: "passed";
  readonly headDigest: string;
  readonly requirementsDigest: string;
  readonly diffDigest: string;
}

function missing(reasonCode: MissingReasonCode): Authority<ReviewerIdentity> {
  return { status: "missing", reasonCode };
}

function parseExactlyOneFence(body: string): unknown {
  const fences = [...body.matchAll(/```json\s*([\s\S]*?)\s*```/gu)];
  if (fences.length !== 1 || fences[0]?.[1] === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(fences[0][1]);
    return parsed;
  } catch {
    return undefined;
  }
}

export async function readBoundReviewerIdentity(
  transport: Pick<GhTransport, "requestJson">,
  input: Readonly<{ repository: string; pullRequestNumber: number; github: unknown }>,
): Promise<Authority<ReviewerIdentity>> {
  if (!hasSafeDataShape(input.github)) return missing("parse_failed");
  const github = rawGithubObservationSchema.safeParse(input.github);
  if (
    !github.success ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/u.test(input.repository) ||
    !Number.isSafeInteger(input.pullRequestNumber) ||
    input.pullRequestNumber < 1
  )
    return missing("parse_failed");
  if (github.data.pullRequests.length !== 1)
    return missing(github.data.pullRequests.length === 0 ? "not_found" : "duplicate_result");
  const pullRequest = github.data.pullRequests[0];
  if (pullRequest === undefined) return missing("not_found");
  const statuses = pullRequest.statuses.filter(
    (status) =>
      status.context === reviewContext &&
      status.state === "success" &&
      status.headSha === pullRequest.headSha &&
      status.targetUrl !== null,
  );
  if (statuses.length !== 1)
    return missing(statuses.length === 0 ? "binding_missing" : "duplicate_result");
  const selected = statuses[0];
  if (selected?.targetUrl === null || selected === undefined) return missing("binding_missing");
  const matches: ReviewerIdentity[] = [];
  for (let page = 1; page <= 100; page += 1) {
    let response: Awaited<ReturnType<GhTransport["requestJson"]>>;
    try {
      response = await transport.requestJson(
        [
          "api",
          `repos/${input.repository}/issues/${String(input.pullRequestNumber)}/comments?per_page=100&page=${String(page)}`,
          "--method",
          "GET",
          "--jq",
          "{count:length,comments:[.[]|{htmlUrl:.html_url,body}]}",
        ],
        commentPageSchema,
      );
    } catch {
      return missing("read_failed");
    }
    if (!hasSafeDataShape(response) || !response.ok || !hasSafeDataShape(response.value))
      return missing("read_failed");
    const parsedPage = commentPageSchema.safeParse(response.value);
    if (!parsedPage.success) return missing("parse_failed");
    for (const comment of parsedPage.data.comments) {
      const markerCount = [...comment.body.matchAll(new RegExp(reviewMarker.source, "gu"))].length;
      if (comment.htmlUrl !== selected.targetUrl || markerCount === 0) continue;
      if (markerCount !== 1) return missing("binding_missing");
      const body = parseExactlyOneFence(comment.body);
      if (!hasSafeDataShape(body)) return missing("parse_failed");
      const review = reviewPayloadSchema.safeParse(body);
      if (
        !review.success ||
        review.data.identity.headSha !== pullRequest.headSha ||
        review.data.reports.length !== 1
      )
        return missing("binding_missing");
      const report = review.data.reports[0];
      if (report === undefined) return missing("parse_failed");
      matches.push({
        role: report.role,
        verdict: report.verdict,
        headDigest: digestIdentifier("github-head", review.data.identity.headSha),
        requirementsDigest: review.data.identity.requirementsDigest,
        diffDigest: review.data.identity.diffDigest,
      });
    }
    if (parsedPage.data.count < 100) break;
    if (page === 100) return missing("pagination_incomplete");
  }
  if (matches.length !== 1)
    return missing(matches.length === 0 ? "binding_missing" : "duplicate_result");
  const matched = matches[0];
  return matched === undefined
    ? missing("binding_missing")
    : { status: "present", evidence: matched };
}

export const reviewerAuthorityReadSchema = authorityReadSchema(reviewPayloadSchema);
