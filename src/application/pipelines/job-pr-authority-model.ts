import { z } from "zod";

import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import {
  issueIdSchema,
  jobIdSchema,
  projectIdSchema,
} from "../../domain/jobs/index.js";
import { canonicalSerialize, sha256Digest } from "../../domain/review/index.js";

const branchSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u)
  .refine(
    (branch) =>
      !branch.includes("..") &&
      !branch.includes("//") &&
      !branch.endsWith(".") &&
      !branch.endsWith("/") &&
      !branch.endsWith(".lock"),
  );
const headShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const eventIdSchema = z.string().regex(/^lifecycle_[0-9a-f]{64}$/u);
const schemaVersion = z.literal(1);
const prNumberSchema = z.number().int().positive();
const ownershipEpochSchema = z.number().int().positive();

const sharedIdentity = {
  schemaVersion,
  projectId: projectIdSchema,
  issueId: issueIdSchema,
};

const jobStartedShape = {
  ...sharedIdentity,
  kind: z.literal("job_started"),
  jobId: jobIdSchema,
};
const prBoundShape = {
  ...sharedIdentity,
  kind: z.literal("pr_bound"),
  jobId: jobIdSchema,
  prNumber: prNumberSchema,
  branch: branchSchema,
  initialHeadSha: headShaSchema,
  ownershipEpoch: ownershipEpochSchema,
};
const jobCancelledShape = {
  ...sharedIdentity,
  kind: z.literal("job_cancelled"),
  jobId: jobIdSchema,
};
const jobSupersededShape = {
  ...sharedIdentity,
  kind: z.literal("job_superseded"),
  oldJobId: jobIdSchema,
  newJobId: jobIdSchema,
};
const prHandoffShape = {
  ...sharedIdentity,
  kind: z.literal("pr_handoff"),
  prNumber: prNumberSchema,
  oldJobId: jobIdSchema,
  newJobId: jobIdSchema,
  priorOwnershipEpoch: ownershipEpochSchema,
  ownershipEpoch: ownershipEpochSchema,
  handoffHeadSha: headShaSchema,
};
const jobCompletedShape = {
  ...sharedIdentity,
  kind: z.literal("job_completed"),
  jobId: jobIdSchema,
  prNumber: prNumberSchema,
  mergeCommitSha: headShaSchema,
};
const authorityConflictShape = {
  ...sharedIdentity,
  kind: z.literal("authority_conflict"),
  jobId: jobIdSchema,
  prNumber: prNumberSchema.optional(),
  conflictClass: z.enum([
    "multiple_pr_candidates",
    "pr_identity_mismatch",
    "owner_conflict",
    "unsettled_pr",
    "linear_github_mismatch",
  ]),
  conflictEpoch: ownershipEpochSchema,
  observedIdentityDigest: digestSchema,
};
export const managedMutationIntentSchema = z.enum([
  "git_push",
  "pr_create",
  "pr_update",
  "pr_ready",
  "pr_close",
  "pr_comment",
  "commit_status",
  "review_status",
  "auto_merge",
  "merge",
  "linear_lifecycle",
  "linear_work_status",
  "linear_agent_condition",
]);
export type ManagedMutationIntent = z.infer<typeof managedMutationIntentSchema>;

const escalationRequestedShape = {
  ...sharedIdentity,
  kind: z.literal("escalation_requested"),
  jobId: jobIdSchema,
  prNumber: prNumberSchema.optional(),
  headSha: headShaSchema.optional(),
  mutationIntent: managedMutationIntentSchema,
  identityDigest: digestSchema,
  escalationEpoch: ownershipEpochSchema,
  attemptCount: z.number().int().min(1).max(2),
  decisionQuestion: z.enum([
    "retry_or_abandon",
    "select_authority",
    "repair_credentials",
    "manual_recovery",
  ]),
};
const externalMergeObservedShape = {
  ...sharedIdentity,
  kind: z.literal("external_merge_observed"),
  prNumber: prNumberSchema,
  mergeCommitSha: headShaSchema,
};

const inputVariants = [
  z.object(jobStartedShape).strict(),
  z.object(prBoundShape).strict(),
  z.object(jobCancelledShape).strict(),
  z.object(jobSupersededShape).strict(),
  z.object(prHandoffShape).strict(),
  z.object(jobCompletedShape).strict(),
  z.object(authorityConflictShape).strict(),
  z.object(escalationRequestedShape).strict(),
  z.object(externalMergeObservedShape).strict(),
] as const;

export const jobPrLifecycleEventInputSchema = z.discriminatedUnion("kind", inputVariants);
export type JobPrLifecycleEventInput = z.infer<typeof jobPrLifecycleEventInputSchema>;

const eventVariants = [
  z.object({ ...jobStartedShape, eventId: eventIdSchema }).strict(),
  z.object({ ...prBoundShape, eventId: eventIdSchema }).strict(),
  z.object({ ...jobCancelledShape, eventId: eventIdSchema }).strict(),
  z.object({ ...jobSupersededShape, eventId: eventIdSchema }).strict(),
  z.object({ ...prHandoffShape, eventId: eventIdSchema }).strict(),
  z.object({ ...jobCompletedShape, eventId: eventIdSchema }).strict(),
  z.object({ ...authorityConflictShape, eventId: eventIdSchema }).strict(),
  z.object({ ...escalationRequestedShape, eventId: eventIdSchema }).strict(),
  z.object({ ...externalMergeObservedShape, eventId: eventIdSchema }).strict(),
] as const;

function canonicalEventIdentity(event: JobPrLifecycleEventInput): Readonly<Record<string, unknown>> {
  switch (event.kind) {
    case "job_started":
    case "job_cancelled":
      return { kind: event.kind, issueId: event.issueId, jobId: event.jobId };
    case "pr_bound":
      return {
        kind: event.kind,
        issueId: event.issueId,
        jobId: event.jobId,
        prNumber: event.prNumber,
        branch: event.branch,
        initialHeadSha: event.initialHeadSha,
        ownershipEpoch: event.ownershipEpoch,
      };
    case "job_superseded":
      return {
        kind: event.kind,
        issueId: event.issueId,
        oldJobId: event.oldJobId,
        newJobId: event.newJobId,
      };
    case "pr_handoff":
      return {
        kind: event.kind,
        issueId: event.issueId,
        prNumber: event.prNumber,
        oldJobId: event.oldJobId,
        newJobId: event.newJobId,
        priorOwnershipEpoch: event.priorOwnershipEpoch,
        ownershipEpoch: event.ownershipEpoch,
        handoffHeadSha: event.handoffHeadSha,
      };
    case "job_completed":
      return { kind: event.kind, issueId: event.issueId, jobId: event.jobId };
    case "authority_conflict":
      return {
        kind: event.kind,
        issueId: event.issueId,
        jobId: event.jobId,
        ...(event.prNumber === undefined ? {} : { prNumber: event.prNumber }),
        conflictClass: event.conflictClass,
        conflictEpoch: event.conflictEpoch,
        observedIdentityDigest: event.observedIdentityDigest,
      };
    case "escalation_requested":
      return {
        kind: event.kind,
        issueId: event.issueId,
        jobId: event.jobId,
        mutationIntent: event.mutationIntent,
        identityDigest: event.identityDigest,
        escalationEpoch: event.escalationEpoch,
      };
    case "external_merge_observed":
      return {
        kind: event.kind,
        issueId: event.issueId,
        prNumber: event.prNumber,
        mergeCommitSha: event.mergeCommitSha,
      };
  }
}

function lifecycleEventId(
  event: JobPrLifecycleEventInput,
): Result<string, DomainError<"invariant_violation">> {
  const digest = sha256Digest(canonicalEventIdentity(event));
  return digest.ok ? ok(`lifecycle_${digest.value}`) : digest;
}

export const jobPrLifecycleEventSchema = z
  .discriminatedUnion("kind", eventVariants)
  .superRefine((event, context) => {
    const { eventId: _eventId, ...input } = event;
    void _eventId;
    const expected = lifecycleEventId(input);
    if (!expected.ok || expected.value !== event.eventId) {
      context.addIssue({ code: "custom", path: ["eventId"], message: "non_canonical_event_id" });
    }
    if (
      event.kind === "pr_handoff" &&
      (event.ownershipEpoch !== event.priorOwnershipEpoch + 1 || event.oldJobId === event.newJobId)
    ) {
      context.addIssue({ code: "custom", path: ["ownershipEpoch"], message: "invalid_handoff" });
    }
  });
export type JobPrLifecycleEvent = z.infer<typeof jobPrLifecycleEventSchema>;

export type PullRequestAuthorityProjection =
  | Readonly<{ state: "none" }>
  | Readonly<{
      state: "owned" | "unsettled";
      prNumber: number;
      ownerJobId: z.infer<typeof jobIdSchema>;
      ownershipEpoch: number;
    }>
  | Readonly<{ state: "conflict"; prNumber: number }>;

/** Projects one PR's public owner from append-only lifecycle comments. Input order must be the
 * provider's complete oldest-to-newest comment order. Duplicate event IDs are idempotent. */
export function projectPullRequestAuthority(
  events: readonly JobPrLifecycleEvent[],
  prNumber: number,
): PullRequestAuthorityProjection {
  const unique: JobPrLifecycleEvent[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (!seen.has(event.eventId)) unique.push(event);
    seen.add(event.eventId);
  }
  const terminalJobs = new Set<string>();
  for (const event of unique) {
    if (
      event.kind === "job_cancelled" ||
      event.kind === "job_completed"
    ) {
      terminalJobs.add(event.jobId);
    } else if (event.kind === "job_superseded") {
      terminalJobs.add(event.oldJobId);
    }
  }

  let owner: { jobId: z.infer<typeof jobIdSchema>; epoch: number } | undefined;
  for (const event of unique) {
    if (event.kind === "pr_bound" && event.prNumber === prNumber) {
      if (owner !== undefined || event.ownershipEpoch !== 1) return { state: "conflict", prNumber };
      owner = { jobId: event.jobId, epoch: event.ownershipEpoch };
    } else if (event.kind === "pr_handoff" && event.prNumber === prNumber) {
      if (owner === undefined) return { state: "conflict", prNumber };
      if (
        event.oldJobId !== owner.jobId ||
        event.priorOwnershipEpoch !== owner.epoch ||
        event.ownershipEpoch !== owner.epoch + 1
      ) {
        return { state: "conflict", prNumber };
      }
      owner = { jobId: event.newJobId, epoch: event.ownershipEpoch };
    }
  }
  if (owner === undefined) return { state: "none" };
  return {
    state: terminalJobs.has(owner.jobId) ? "unsettled" : "owned",
    prNumber,
    ownerJobId: owner.jobId,
    ownershipEpoch: owner.epoch,
  };
}

export function createJobPrLifecycleEvent(
  input: JobPrLifecycleEventInput,
): Result<JobPrLifecycleEvent, DomainError<"invariant_violation">> {
  const parsed = jobPrLifecycleEventInputSchema.safeParse(input);
  if (!parsed.success) return err(domainError("invariant_violation"));
  const eventId = lifecycleEventId(parsed.data);
  if (!eventId.ok) return eventId;
  const event = jobPrLifecycleEventSchema.safeParse({ ...parsed.data, eventId: eventId.value });
  return event.success ? ok(event.data) : err(domainError("invariant_violation"));
}

export const pullRequestBackPointerSchema = z
  .object({
    schemaVersion,
    projectId: projectIdSchema,
    issueId: issueIdSchema,
    jobId: jobIdSchema,
    branch: branchSchema,
  })
  .strict();
export type PullRequestBackPointer = z.infer<typeof pullRequestBackPointerSchema>;

export function createPullRequestBackPointer(
  input: PullRequestBackPointer,
): Result<PullRequestBackPointer, DomainError<"invariant_violation">> {
  const parsed = pullRequestBackPointerSchema.safeParse(input);
  return parsed.success ? ok(parsed.data) : err(domainError("invariant_violation"));
}

const lifecycleMarkerStart = "<!-- agent-team-lifecycle:v1\n";
const pullRequestMarkerStart = "<!-- agent-team-pr:v1\n";
const markerEnd = "\n-->";

type MarkedPayload =
  | Readonly<{ state: "absent" }>
  | Readonly<{ state: "invalid" }>
  | Readonly<{ state: "found"; payload: string }>;

function markedPayload(body: string, start: string): MarkedPayload {
  const first = body.indexOf(start);
  if (first < 0) return { state: "absent" };
  if (body.includes(start, first + start.length)) return { state: "invalid" };
  const payloadStart = first + start.length;
  const end = body.indexOf(markerEnd, payloadStart);
  if (end < 0) return { state: "invalid" };
  return { state: "found", payload: body.slice(payloadStart, end) };
}

export function formatJobPrLifecycleComment(
  humanSummary: string,
  event: JobPrLifecycleEvent,
): Result<string, DomainError<"invariant_violation">> {
  const summary = humanSummary.trim();
  const parsed = jobPrLifecycleEventSchema.safeParse(event);
  if (
    summary.length === 0 ||
    summary.length > 4_000 ||
    summary.includes(lifecycleMarkerStart) ||
    !parsed.success
  ) {
    return err(domainError("invariant_violation"));
  }
  const serialized = canonicalSerialize(parsed.data);
  return serialized.ok
    ? ok(`${summary}\n\n${lifecycleMarkerStart}${serialized.value}${markerEnd}`)
    : serialized;
}

export function parseJobPrLifecycleComment(body: string): JobPrLifecycleEvent | undefined {
  const payload = markedPayload(body, lifecycleMarkerStart);
  if (payload.state !== "found") return undefined;
  try {
    const parsed = jobPrLifecycleEventSchema.safeParse(JSON.parse(payload.payload) as unknown);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function appendPullRequestBackPointer(
  humanBody: string,
  pointer: PullRequestBackPointer,
): Result<string, DomainError<"invariant_violation">> {
  const body = humanBody.trim();
  const parsed = pullRequestBackPointerSchema.safeParse(pointer);
  if (body.length === 0 || body.includes(pullRequestMarkerStart) || !parsed.success) {
    return err(domainError("invariant_violation"));
  }
  const serialized = canonicalSerialize(parsed.data);
  if (!serialized.ok) return serialized;
  const combined = `${body}\n\n${pullRequestMarkerStart}${serialized.value}${markerEnd}`;
  return combined.length <= 65_536 ? ok(combined) : err(domainError("invariant_violation"));
}

export function parsePullRequestBackPointer(
  body: string,
): Result<PullRequestBackPointer | undefined, DomainError<"conflict">> {
  const payload = markedPayload(body, pullRequestMarkerStart);
  if (payload.state === "absent") return ok(undefined);
  if (payload.state === "invalid") return err(domainError("conflict"));
  try {
    const parsed = pullRequestBackPointerSchema.safeParse(JSON.parse(payload.payload) as unknown);
    return parsed.success ? ok(parsed.data) : err(domainError("conflict"));
  } catch {
    return err(domainError("conflict"));
  }
}
