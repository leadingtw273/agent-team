/**
 * E007: pure cross-source reconciliation over an already-collected `EvidenceBundle` (E005). This
 * module does no I/O of any kind -- `validateEvidence` is a plain function from
 * `(bundle, expectation)` to a `EvidenceValidationReport`; every Live E2E Case (E101-E118) calls
 * it after E005's collector has already produced the bundle it wants to reconcile.
 *
 * `evidenceBundleSchema.parse` runs first and is what rejects a tampered/over-permissive bundle
 * (e.g. an extra top-level or nested field a bad caller injected) -- E005's schema is `.strict()`
 * everywhere, so `parse` throws a `ZodError` for that case rather than this validator silently
 * accepting unknown data. A well-formed-but-*wrong* bundle (missing source, wrong SHA, wrong
 * issue id, ...) is not rejected here; it is what the rules below are for.
 */
import {
  evidenceBundleSchema,
  evidenceSourceNames,
  missingEvidenceSources,
  type EvidenceBundle,
} from "../harness/schema.js";
import {
  evidenceValidationExpectationSchema,
  type EvidenceValidationExpectation,
} from "./expectation.js";
import { evidenceValidationReportSchema, type EvidenceValidationReport } from "./report.js";
import type { EvidenceValidationReasonCode, EvidenceValidationRuleId } from "./rules.js";

interface DraftRuleResult {
  readonly ruleId: EvidenceValidationRuleId;
  readonly status: "pass" | "fail";
  readonly reasonCode: EvidenceValidationReasonCode;
}

function pass(ruleId: EvidenceValidationRuleId): DraftRuleResult {
  return { ruleId, status: "pass", reasonCode: "ok" };
}

function fail(
  ruleId: EvidenceValidationRuleId,
  reasonCode: EvidenceValidationReasonCode,
): DraftRuleResult {
  return { ruleId, status: "fail", reasonCode };
}

function isNonDecreasing(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous === undefined || current === undefined) continue; // unreachable: index in range
    if (current < previous) return false;
  }
  return true;
}

function withinWindow(
  timestamp: string,
  timeWindow: EvidenceValidationExpectation["timeWindow"],
): boolean {
  return timestamp >= timeWindow.from && timestamp <= timeWindow.to;
}

function evaluateBundleCaseIdentity(
  bundle: EvidenceBundle,
  expectation: EvidenceValidationExpectation,
): DraftRuleResult {
  const matches = bundle.caseId === expectation.caseId && bundle.runId === expectation.runId;
  return matches
    ? pass("bundle_case_identity_match")
    : fail("bundle_case_identity_match", "value_mismatch");
}

function evaluateSourcePresence(bundle: EvidenceBundle): DraftRuleResult {
  return missingEvidenceSources(bundle).length === 0
    ? pass("source_presence")
    : fail("source_presence", "source_missing");
}

function evaluateGithubRules(
  bundle: EvidenceBundle,
  expectation: EvidenceValidationExpectation,
): readonly DraftRuleResult[] {
  const ruleIds = [
    "github_pull_request_number_match",
    "github_head_sha_match",
    "github_checks_head_sha_binding",
    "github_statuses_head_sha_binding",
  ] as const;
  if (bundle.github.status !== "present") {
    return ruleIds.map((ruleId) => fail(ruleId, "source_missing"));
  }
  const { pullRequest, checks, statuses } = bundle.github.data;
  return [
    pullRequest.number === expectation.github.pullRequestNumber
      ? pass("github_pull_request_number_match")
      : fail("github_pull_request_number_match", "value_mismatch"),
    pullRequest.headSha === expectation.github.headSha
      ? pass("github_head_sha_match")
      : fail("github_head_sha_match", "value_mismatch"),
    checks.headSha === pullRequest.headSha
      ? pass("github_checks_head_sha_binding")
      : fail("github_checks_head_sha_binding", "binding_mismatch"),
    statuses.headSha === pullRequest.headSha
      ? pass("github_statuses_head_sha_binding")
      : fail("github_statuses_head_sha_binding", "binding_mismatch"),
  ];
}

function evaluateLinearRules(
  bundle: EvidenceBundle,
  expectation: EvidenceValidationExpectation,
): readonly DraftRuleResult[] {
  const ruleIds = ["linear_issue_id_match", "linear_comment_timestamps_in_window"] as const;
  if (bundle.linear.status !== "present") {
    return ruleIds.map((ruleId) => fail(ruleId, "source_missing"));
  }
  const { issueId, comments } = bundle.linear.data;
  const commentsInWindow = comments.every((comment) =>
    withinWindow(comment.createdAt, expectation.timeWindow),
  );
  return [
    issueId === expectation.linear.issueId
      ? pass("linear_issue_id_match")
      : fail("linear_issue_id_match", "value_mismatch"),
    commentsInWindow
      ? pass("linear_comment_timestamps_in_window")
      : fail("linear_comment_timestamps_in_window", "timestamp_out_of_window"),
  ];
}

function evaluateLocalEventsRules(
  bundle: EvidenceBundle,
  expectation: EvidenceValidationExpectation,
): readonly DraftRuleResult[] {
  const ruleIds = [
    "local_events_delivery_id_dedup",
    "local_events_timestamps_monotonic",
    "local_events_required_event_types_present",
  ] as const;
  if (bundle.localEvents.status !== "present") {
    return ruleIds.map((ruleId) => fail(ruleId, "source_missing"));
  }
  const { events, inboxRecords } = bundle.localEvents.data;

  const seenDeliveries = new Set<string>();
  let hasDuplicateDelivery = false;
  for (const record of inboxRecords) {
    const key = `${record.provider}:${record.deliveryId}`;
    if (seenDeliveries.has(key)) {
      hasDuplicateDelivery = true;
      break;
    }
    seenDeliveries.add(key);
  }

  const timestampsMonotonic =
    isNonDecreasing(events.map((event) => event.occurredAt)) &&
    isNonDecreasing(inboxRecords.map((record) => record.receivedAt));

  const collectedEventTypes = new Set(events.map((event) => event.eventType));
  const requiredEventTypesPresent = expectation.requiredEventTypes.every((eventType) =>
    collectedEventTypes.has(eventType),
  );

  return [
    hasDuplicateDelivery
      ? fail("local_events_delivery_id_dedup", "duplicate_delivery_id")
      : pass("local_events_delivery_id_dedup"),
    timestampsMonotonic
      ? pass("local_events_timestamps_monotonic")
      : fail("local_events_timestamps_monotonic", "timestamp_order_violation"),
    requiredEventTypesPresent
      ? pass("local_events_required_event_types_present")
      : fail("local_events_required_event_types_present", "required_event_type_missing"),
  ];
}

function evaluateCheckpointRule(
  bundle: EvidenceBundle,
  expectation: EvidenceValidationExpectation,
): DraftRuleResult {
  if (bundle.checkpoints.status !== "present") {
    return fail("checkpoint_case_binding", "source_missing");
  }
  const { checkpoints } = bundle.checkpoints.data;
  const bound =
    checkpoints.length > 0 &&
    checkpoints.every(
      (checkpoint) =>
        checkpoint.issueId === expectation.checkpoint.issueId &&
        checkpoint.jobId === expectation.checkpoint.jobId,
    );
  return bound
    ? pass("checkpoint_case_binding")
    : fail("checkpoint_case_binding", "binding_mismatch");
}

function evaluateTimelineRule(
  bundle: EvidenceBundle,
  expectation: EvidenceValidationExpectation,
): DraftRuleResult {
  const allSourcesPresent = evidenceSourceNames.every((name) => bundle[name].status === "present");
  if (
    !allSourcesPresent ||
    bundle.linear.status !== "present" ||
    bundle.localEvents.status !== "present" ||
    bundle.checkpoints.status !== "present"
  ) {
    return fail("timeline_no_timestamp_before_case_start", "source_missing");
  }
  const timestamps: readonly string[] = [
    ...bundle.linear.data.comments.map((comment) => comment.createdAt),
    ...bundle.localEvents.data.events.map((event) => event.occurredAt),
    ...bundle.localEvents.data.inboxRecords.map((record) => record.receivedAt),
    ...bundle.checkpoints.data.checkpoints.map((checkpoint) => checkpoint.createdAt),
  ];
  const anyBeforeCaseStart = timestamps.some(
    (timestamp) => timestamp < expectation.timeWindow.from,
  );
  return anyBeforeCaseStart
    ? fail("timeline_no_timestamp_before_case_start", "timestamp_before_case_start")
    : pass("timeline_no_timestamp_before_case_start");
}

/**
 * Reconciles a collected `EvidenceBundle` against what a case expected. Always evaluates every
 * rule in `evidenceValidationRuleIds` (rules.ts) -- never short-circuits on the first failure --
 * so a caller always gets the full picture of what did and did not reconcile.
 */
export function validateEvidence(
  bundleInput: EvidenceBundle,
  expectationInput: EvidenceValidationExpectation,
): EvidenceValidationReport {
  const bundle = evidenceBundleSchema.parse(bundleInput);
  const expectation = evidenceValidationExpectationSchema.parse(expectationInput);

  const rules: DraftRuleResult[] = [
    evaluateBundleCaseIdentity(bundle, expectation),
    evaluateSourcePresence(bundle),
    ...evaluateGithubRules(bundle, expectation),
    ...evaluateLinearRules(bundle, expectation),
    ...evaluateLocalEventsRules(bundle, expectation),
    evaluateCheckpointRule(bundle, expectation),
    evaluateTimelineRule(bundle, expectation),
  ];

  const overall = rules.some((rule) => rule.status === "fail")
    ? ("fail" as const)
    : ("pass" as const);

  return evidenceValidationReportSchema.parse({
    schemaVersion: 1,
    caseId: expectation.caseId,
    runId: expectation.runId,
    overall,
    rules,
  });
}
