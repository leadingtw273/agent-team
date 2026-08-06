/**
 * E008: the fixed-schema output of `buildAggregateReport` (aggregate.ts) -- one entry per case in
 * the caller's expected-case list (default `e101ToE118CaseIds`, expected-cases.ts), always all of
 * them, in the same order, every run. A case's entry only ever carries E007's own fixed
 * `ruleId`/`reasonCode` pairs (report.ts, evidence/rules.ts) for its failed rules -- never a raw
 * provider message or other free-form text, per this task's "only transcribe E007's fixed codes"
 * invariant. `schemaVersion: 1` is a locked decision for this task.
 */
import { z } from "zod";

import { evidenceValidationReasonCodes, evidenceValidationRuleIds } from "../evidence/rules.js";

/** One rule failure transcribed from an E007 `EvidenceValidationReport`, unmodified. */
export const aggregateFailedRuleSchema = z
  .object({
    ruleId: z.enum(evidenceValidationRuleIds),
    reasonCode: z.enum(evidenceValidationReasonCodes),
  })
  .strict();
export type AggregateFailedRule = z.infer<typeof aggregateFailedRuleSchema>;

/**
 * - `green` -- exactly one `ValidationReport` was supplied for this case and its `overall` was
 *   `"pass"`.
 * - `red` -- exactly one `ValidationReport` was supplied and its `overall` was `"fail"`, or more
 *   than one report was supplied for the same case id (see `anomaly: "duplicate_report"` below).
 * - `missing_report` -- no `ValidationReport` was supplied for this case id at all.
 */
export const aggregateCaseStatuses = ["green", "red", "missing_report"] as const;
export type AggregateCaseStatus = (typeof aggregateCaseStatuses)[number];

/**
 * `duplicate_report` -- more than one `ValidationReport` was supplied claiming the same expected
 * case id. This is never resolved by picking one and discarding the rest (that would silently
 * accept a spoofed/duplicated report as if it were the real one); the case is forced `red` instead.
 */
export const aggregateCaseAnomalies = ["duplicate_report"] as const;
export type AggregateCaseAnomaly = (typeof aggregateCaseAnomalies)[number];

export const aggregateCaseEntrySchema = z
  .object({
    caseId: z.string().trim().min(1),
    status: z.enum(aggregateCaseStatuses),
    runId: z.string().trim().min(1).optional(),
    anomaly: z.enum(aggregateCaseAnomalies).optional(),
    failedRules: z.array(aggregateFailedRuleSchema),
  })
  .strict()
  .refine((entry) => {
    if (entry.status === "green") {
      return (
        entry.runId !== undefined && entry.anomaly === undefined && entry.failedRules.length === 0
      );
    }
    if (entry.status === "missing_report") {
      return (
        entry.runId === undefined && entry.anomaly === undefined && entry.failedRules.length === 0
      );
    }
    // status === "red"
    return entry.anomaly !== undefined || entry.failedRules.length > 0;
  }, "runId/anomaly/failedRules must be consistent with status.");
export type AggregateCaseEntry = z.infer<typeof aggregateCaseEntrySchema>;

export const aggregateReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    expectedCaseIds: z.array(z.string().trim().min(1)).min(1),
    overall: z.enum(["green", "red"]),
    cases: z.array(aggregateCaseEntrySchema),
    /** Case ids `buildAggregateReport` received a report for but that are not in
     * `expectedCaseIds` -- always sorted ascending, deduplicated. Non-empty here forces
     * `overall: "red"` regardless of every expected case's own status. */
    unexpectedCaseIds: z.array(z.string().trim().min(1)),
  })
  .strict()
  .refine(
    (report) =>
      report.overall ===
      (report.cases.every((entry) => entry.status === "green") &&
      report.unexpectedCaseIds.length === 0
        ? "green"
        : "red"),
    'overall must be "green" iff every case is green and there are no unexpected reports.',
  );
export type AggregateReport = z.infer<typeof aggregateReportSchema>;
