import { domainError, type DomainError } from "../../domain/foundation/index.js";
import type { EffectiveTreeChange, ReviewIdentity } from "../../domain/review/index.js";
import type {
  CommitChecksSnapshot,
  ProviderEvent,
  ProviderPort,
  ProviderRunHandle,
} from "../ports/index.js";
import type { ProviderToolDecisionPort } from "./implementer-model.js";
import type {
  ReportContractFailureCategory,
  ReviewerFailureStage,
  ReviewerPipelineOutcome,
  ReviewerPipelineRequest,
  ReviewerReport,
} from "./reviewer-model.js";
import { reviewerReportSchema } from "./reviewer-model.js";
import {
  evidenceForReviewerRole,
  reviewerDirective,
  reviewerReportMatchesContext,
  type RequiredReviewerRole,
} from "./reviewer-policy.js";

export type ReviewerRunResult =
  | Readonly<{ kind: "completed"; report: ReviewerReport }>
  | Readonly<{ kind: "paused"; reason: "safety_approval_required"; summary: string }>
  | Readonly<{ kind: "interrupted" }>
  | Readonly<{
      kind: "failed";
      stage: ReviewerFailureStage;
      error: DomainError;
      /** C015r decision 4: only populated when `stage === "report"`. See `ReportContractFailureCategory`'s own header (reviewer-model.ts). */
      reportFailureCategory?: ReportContractFailureCategory;
      /** C015r decision 5: only populated when `stage === "report"`, pure data -- see this field's
       * own header on `ReviewerPipelineOutcome`'s "failed" variant (reviewer-model.ts) for the exact
       * handling rule (never persisted here; the CLI/adapter-layer sidecar decides that). */
      rejectedOutput?: string;
      reviewWait?: NonNullable<Extract<ReviewerPipelineOutcome, { state: "failed" }>["reviewWait"]>;
    }>;

interface EventCollection {
  readonly outputs: readonly string[];
  readonly error?: DomainError;
  readonly pauseSummary?: string;
  readonly quotaBoundary?: Extract<ProviderEvent, { kind: "quota_boundary" }>;
}

export interface RunReviewerProviderInput {
  readonly role: RequiredReviewerRole;
  readonly provider: ProviderPort;
  readonly model: string;
  readonly request: ReviewerPipelineRequest;
  readonly identity: ReviewIdentity;
  readonly diff: readonly EffectiveTreeChange[];
  readonly checks: CommitChecksSnapshot;
  readonly toolDecisions: ProviderToolDecisionPort;
}

async function collectEvents(
  handle: ProviderRunHandle,
  input: RunReviewerProviderInput,
): Promise<EventCollection> {
  const outputs: string[] = [];
  let quotaBoundary: EventCollection["quotaBoundary"];
  for await (const event of handle.events) {
    if (event.kind === "output" && event.stream === "stdout" && event.text.trim().length > 0) {
      outputs.push(event.text.trim());
      continue;
    }
    if (event.kind === "quota_boundary") {
      if (quotaBoundary === undefined || event.confidence === "confirmed") quotaBoundary = event;
      continue;
    }
    if (event.kind !== "tool_request") continue;
    const decision = await input.toolDecisions.decide(
      event,
      { job: input.request.job, project: input.request.project },
      input.request.signal === undefined ? {} : { signal: input.request.signal },
    );
    if (!decision.ok) {
      await handle.respondToToolRequest(event.requestId, "decline");
      await handle.interrupt();
      return Object.freeze({
        outputs,
        error: decision.error,
        ...(quotaBoundary === undefined ? {} : { quotaBoundary }),
      });
    }
    const responded = await handle.respondToToolRequest(event.requestId, decision.value.response);
    if (!responded.ok) {
      await handle.interrupt();
      return Object.freeze({
        outputs,
        error: responded.error,
        ...(quotaBoundary === undefined ? {} : { quotaBoundary }),
      });
    }
    if (decision.value.pause) {
      await handle.interrupt();
      return Object.freeze({
        outputs,
        pauseSummary: decision.value.summary,
        ...(quotaBoundary === undefined ? {} : { quotaBoundary }),
      });
    }
  }
  return Object.freeze({
    outputs: Object.freeze(outputs),
    ...(quotaBoundary === undefined ? {} : { quotaBoundary }),
  });
}

function reviewWaitSignal(
  input: RunReviewerProviderInput,
  collected: EventCollection,
  error: DomainError,
): NonNullable<Extract<ReviewerRunResult, { kind: "failed" }>["reviewWait"]> | undefined {
  const boundary = collected.quotaBoundary;
  if (
    input.role !== "code_reviewer" ||
    boundary === undefined ||
    (boundary.confidence === "confirmed" && error.code !== "rate_limited") ||
    (boundary.confidence === "unconfirmed" && error.code !== "quota_unknown")
  ) {
    return undefined;
  }
  return Object.freeze({
    confidence: boundary.confidence,
    ...(boundary.bucket === undefined ? {} : { bucket: boundary.bucket }),
    ...(boundary.resetAt === undefined ? {} : { resetAt: boundary.resetAt }),
    requirementsDigest: input.identity.requirementsDigest,
    headSha: input.identity.headSha,
    diffDigest: input.identity.diffDigest,
  });
}

/**
 * C015r decision 3 (deterministic syntax-only tolerance, exactly two steps, never more -- the
 * real-repro evidence behind this decision is in C015q's diagnosis, `/home/markchou/.claude/jobs/
 * 6152588f/tmp/c015q-diagnose.md`: a real reviewer run's final message was one preamble sentence
 * followed by an otherwise-valid JSON report). Step 1 strips exactly one layer of a Markdown code
 * fence wrapping the *entire* trimmed text (a no-op if there is none). Step 2 -- attempted only if
 * the text still does not parse after step 1 -- takes the substring from the first `{` to the last
 * `}`, exactly once. Whatever comes out of these two steps is hard-required to satisfy the
 * unmodified `reviewerReportSchema`/`reviewerReportMatchesContext` immediately afterward: this
 * function never guesses at a missing field, never relaxes an enum, never repairs malformed JSON --
 * it only strips *framing* a well-behaved model was told not to add in the first place (see
 * reviewer-policy.ts's skeleton-based directive, decision 2).
 */
function stripSingleMarkdownFence(text: string): string {
  const fence = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n?```$/u;
  const match = fence.exec(text);
  return match?.[1] === undefined ? text : match[1].trim();
}

function extractFirstToLastBrace(text: string): string | undefined {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return undefined;
  return text.slice(first, last + 1);
}

function canParse(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

interface TolerantParse {
  readonly candidate: string;
  /** True iff either tolerance step actually changed the text -- i.e. the model's own final
   * message was not, byte for byte, already nothing but the JSON object. Used only for decision 4's
   * `preamble_or_trailing_content` classification, never to relax validation itself. */
  readonly tolerated: boolean;
}

function tolerantParseCandidate(output: string): TolerantParse {
  const original = output.trim();
  if (canParse(original)) return { candidate: original, tolerated: false };
  const defenced = stripSingleMarkdownFence(original);
  if (canParse(defenced)) return { candidate: defenced, tolerated: defenced !== original };
  const extracted = extractFirstToLastBrace(defenced);
  if (extracted !== undefined) return { candidate: extracted, tolerated: true };
  return { candidate: defenced, tolerated: defenced !== original };
}

/** C015r decision 4's classifier -- see `ReportContractFailureCategory`'s own header
 * (reviewer-model.ts) for the fixed precedence order and why it is fixed. Pure function over
 * already-computed intermediate results; never re-parses or re-validates anything itself. */
function classifyReportFailure(
  tolerant: TolerantParse,
  parsed: Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false }>,
  schemaResult: ReturnType<typeof reviewerReportSchema.safeParse> | undefined,
  contextMatched: boolean | undefined,
): ReportContractFailureCategory {
  if (!parsed.ok) return "invalid_json";
  if (schemaResult === undefined) return "schema_invalid";
  if (!schemaResult.success) {
    if (tolerant.tolerated) return "preamble_or_trailing_content";
    const issues = schemaResult.error.issues;
    if (issues.some((issue) => issue.code === "invalid_value")) return "enum_mismatch";
    if (
      issues.some((issue) => issue.code === "invalid_type" || issue.code === "unrecognized_keys")
    ) {
      return "missing_field";
    }
    return "schema_invalid";
  }
  if (contextMatched === false) return "context_mismatch";
  return "schema_invalid";
}

function reportFailure(
  category: ReportContractFailureCategory,
  rejectedOutput: string | undefined,
): ReviewerRunResult {
  return Object.freeze({
    kind: "failed" as const,
    stage: "report" as const,
    error: domainError("external_failure"),
    reportFailureCategory: category,
    ...(rejectedOutput === undefined ? {} : { rejectedOutput }),
  });
}

export async function runReviewerProvider(
  input: RunReviewerProviderInput,
): Promise<ReviewerRunResult> {
  const externalData = evidenceForReviewerRole(
    input.request,
    input.role,
    input.identity,
    input.diff,
    input.checks,
  );
  const evidenceSourceList = externalData.map((block) => block.source);
  const started = await input.provider.start(
    {
      job: input.request.job,
      role: input.role,
      model: input.model,
      workingDirectory: input.request.worktree.path,
      requirementSnapshot: input.request.requirementSnapshot,
      controllerDirective: reviewerDirective(
        input.role,
        input.request,
        input.identity,
        evidenceSourceList,
        input.request.reportRetryFeedback,
      ),
      projectRules: Object.freeze([
        ...input.request.trustedConfig.projectRules,
        ...(input.request.trustedConfig.roleInstructions[input.role] ?? []),
      ]),
      externalData,
      deadlineAt: input.request.deadlineAt,
    },
    input.request.signal === undefined ? {} : { signal: input.request.signal },
  );
  if (!started.ok) {
    return Object.freeze({ kind: "failed", stage: "provider_start", error: started.error });
  }
  const events = collectEvents(started.value, input);
  const completion = await started.value.completion(
    input.request.signal === undefined ? {} : { signal: input.request.signal },
  );
  const collected = await events;
  if (collected.error !== undefined) {
    return Object.freeze({ kind: "failed", stage: "tool_decision", error: collected.error });
  }
  if (collected.pauseSummary !== undefined) {
    return Object.freeze({
      kind: "paused",
      reason: "safety_approval_required",
      summary: collected.pauseSummary,
    });
  }
  if (!completion.ok) {
    return Object.freeze({ kind: "failed", stage: "provider_run", error: completion.error });
  }
  if (completion.value.outcome === "interrupted") return Object.freeze({ kind: "interrupted" });
  if (completion.value.outcome !== "completed") {
    const reviewWait = reviewWaitSignal(input, collected, completion.value.error);
    return Object.freeze({
      kind: "failed",
      stage: "provider_run",
      error: completion.value.error,
      ...(reviewWait === undefined ? {} : { reviewWait }),
    });
  }
  const output = collected.outputs.at(-1);
  if (output === undefined) return reportFailure("empty_output", undefined);

  const tolerant = tolerantParseCandidate(output);
  let parsed: Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false }>;
  try {
    parsed = Object.freeze({ ok: true, value: JSON.parse(tolerant.candidate) as unknown });
  } catch {
    parsed = Object.freeze({ ok: false });
  }
  if (!parsed.ok) {
    return reportFailure(classifyReportFailure(tolerant, parsed, undefined, undefined), output);
  }

  const report = reviewerReportSchema.safeParse(parsed.value);
  const evidenceSources = new Set(evidenceSourceList);
  const contextMatched = report.success
    ? reviewerReportMatchesContext(
        report.data,
        input.role,
        input.identity,
        input.request,
        evidenceSources,
      )
    : undefined;
  if (!report.success || contextMatched === false) {
    return reportFailure(classifyReportFailure(tolerant, parsed, report, contextMatched), output);
  }
  return Object.freeze({ kind: "completed", report: report.data });
}
