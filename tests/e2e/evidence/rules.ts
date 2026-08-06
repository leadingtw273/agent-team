/**
 * E007: the closed set of reconciliation rules this validator can ever report on, plus the closed
 * set of reasons a rule can fail for. Both are fixed enums (not free-form strings) deliberately --
 * a `ValidationReport` (report.ts) must never carry raw provider text (see this task's
 * secrets-hygiene invariant, the same one E005's `EvidenceMissingReason` follows): every failure a
 * caller sees is one of these named codes, nothing else.
 *
 * Adding a rule means adding a name here (and wiring it in validator.ts) -- there is no dynamic or
 * per-case rule registration.
 */

/**
 * - `bundle_case_identity_match` -- the bundle actually being validated is the bundle for *this*
 *   case (`caseId`/`runId`), not some other case's evidence handed in by mistake.
 * - `source_presence` -- delegates to E005's own `missingEvidenceSources`: all four named sources
 *   must be `present`. This is deliberately not re-implemented; E007 only reuses E005's verdict.
 * - `github_pull_request_number_match` / `github_head_sha_match` -- the collected PR is the exact
 *   PR (number, head SHA) this case expected, not merely *some* PR on the repository.
 * - `github_checks_head_sha_binding` / `github_statuses_head_sha_binding` -- the checks/statuses
 *   collected are bound to that *same* head SHA, not a stale or unrelated commit's checks.
 * - `linear_issue_id_match` -- the collected Linear issue is the exact issue this case expected.
 * - `linear_comment_timestamps_in_window` -- every Linear comment's `createdAt` falls inside the
 *   case's time window.
 * - `local_events_delivery_id_dedup` -- no `(provider, deliveryId)` pair in `inboxRecords` repeats
 *   (a repeat means the same webhook delivery was recorded twice -- a replay, not two events).
 * - `local_events_timestamps_monotonic` -- `events[].occurredAt` and `inboxRecords[].receivedAt`,
 *   read in the order the bundle carries them, never go backwards.
 * - `local_events_required_event_types_present` -- every event type this case declared mandatory
 *   actually appears at least once among the collected events.
 * - `checkpoint_case_binding` -- every collected checkpoint's `issueId`/`jobId` matches this case's
 *   own issue/job, not some other case's checkpoint that happened to be readable from the same
 *   directory.
 * - `timeline_no_timestamp_before_case_start` -- no timestamp from any of the four sources
 *   (Linear comments, local events, inbox records, checkpoints) precedes the case's own declared
 *   start (`timeWindow.from`) -- evidence cannot predate the case it is evidence for.
 */
export const evidenceValidationRuleIds = [
  "bundle_case_identity_match",
  "source_presence",
  "github_pull_request_number_match",
  "github_head_sha_match",
  "github_checks_head_sha_binding",
  "github_statuses_head_sha_binding",
  "linear_issue_id_match",
  "linear_comment_timestamps_in_window",
  "local_events_delivery_id_dedup",
  "local_events_timestamps_monotonic",
  "local_events_required_event_types_present",
  "checkpoint_case_binding",
  "timeline_no_timestamp_before_case_start",
] as const;
export type EvidenceValidationRuleId = (typeof evidenceValidationRuleIds)[number];

/**
 * Exactly one of these applies to every rule result. `"ok"` is reserved for `status: "pass"`;
 * every other code is a `status: "fail"` reason (never a raw provider error message or free text).
 */
export const evidenceValidationReasonCodes = [
  /** The rule passed. */
  "ok",
  /** The rule could not be evaluated because a source it depends on is `missing` in the bundle
   * (or, for `checkpoint_case_binding`, `present` but with an empty checkpoint list). Never
   * treated as a pass by omission -- an unverifiable rule is a fail. */
  "source_missing",
  /** A collected identifier/number/SHA does not equal the case's expected value. */
  "value_mismatch",
  /** Two fields that must reference the same underlying object (e.g. checks bound to the PR's
   * head SHA, or a checkpoint bound to this case's issue/job) do not agree with each other. */
  "binding_mismatch",
  /** A timestamp that must fall inside the case's time window falls outside it. */
  "timestamp_out_of_window",
  /** A timestamp precedes the case's own declared start. */
  "timestamp_before_case_start",
  /** A sequence of timestamps that must be non-decreasing goes backwards somewhere. */
  "timestamp_order_violation",
  /** The same `(provider, deliveryId)` pair appears more than once in `inboxRecords`. */
  "duplicate_delivery_id",
  /** A case-declared mandatory event type never appears among the collected local events. */
  "required_event_type_missing",
] as const;
export type EvidenceValidationReasonCode = (typeof evidenceValidationReasonCodes)[number];
