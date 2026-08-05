import { domainError, type DomainError } from "../../domain/foundation/index.js";
import type { EffectiveTreeChange, ReviewIdentity } from "../../domain/review/index.js";
import type { CommitChecksSnapshot, ProviderPort, ProviderRunHandle } from "../ports/index.js";
import type { ProviderToolDecisionPort } from "./implementer-model.js";
import type {
  ReviewerFailureStage,
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
  | Readonly<{ kind: "failed"; stage: ReviewerFailureStage; error: DomainError }>;

interface EventCollection {
  readonly outputs: readonly string[];
  readonly error?: DomainError;
  readonly pauseSummary?: string;
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
  for await (const event of handle.events) {
    if (event.kind === "output" && event.stream === "stdout" && event.text.trim().length > 0) {
      outputs.push(event.text.trim());
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
      return Object.freeze({ outputs, error: decision.error });
    }
    const responded = await handle.respondToToolRequest(event.requestId, decision.value.response);
    if (!responded.ok) {
      await handle.interrupt();
      return Object.freeze({ outputs, error: responded.error });
    }
    if (decision.value.pause) {
      await handle.interrupt();
      return Object.freeze({ outputs, pauseSummary: decision.value.summary });
    }
  }
  return Object.freeze({ outputs: Object.freeze(outputs) });
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
  const started = await input.provider.start(
    {
      job: input.request.job,
      role: input.role,
      model: input.model,
      workingDirectory: input.request.worktree.path,
      requirementSnapshot: input.request.requirementSnapshot,
      controllerDirective: reviewerDirective(input.role, input.request, input.identity),
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
    return Object.freeze({
      kind: "failed",
      stage: "provider_run",
      error: completion.value.error,
    });
  }
  const output = collected.outputs.at(-1);
  if (output === undefined) {
    return Object.freeze({
      kind: "failed",
      stage: "report",
      error: domainError("external_failure"),
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return Object.freeze({
      kind: "failed",
      stage: "report",
      error: domainError("external_failure"),
    });
  }
  const report = reviewerReportSchema.safeParse(parsed);
  const evidenceSources = new Set(externalData.map((block) => block.source));
  if (
    !report.success ||
    !reviewerReportMatchesContext(
      report.data,
      input.role,
      input.identity,
      input.request,
      evidenceSources,
    )
  ) {
    return Object.freeze({
      kind: "failed",
      stage: "report",
      error: domainError("external_failure"),
    });
  }
  return Object.freeze({ kind: "completed", report: report.data });
}
