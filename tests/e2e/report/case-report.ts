/**
 * E010a: the fixed-schema, on-disk record one Live E2E Case run (E101-E118) leaves behind after
 * `runStandardHappyPathCase` (../harness/case-runner.ts) finishes -- what `case-report-store.ts`
 * persists and reads back, and what `listCaseReportsAsValidationReports` there converts into the
 * `EvidenceValidationReport[]` E008's `buildAggregateReport` (aggregate.ts) already knows how to
 * consume. This module does no I/O of any kind -- it is schema only, mirroring every other
 * `report.ts` in this `tests/e2e/` tree (evidence/report.ts, report/report.ts).
 *
 * Two shapes, discriminated on `status`:
 * - `"completed"` -- the case ran all the way through to evidence collection/validation (E005/E007
 *   both ran); `verdict` is derived, never asserted independently of the evidence it is derived
 *   from (see the top-level `.refine()` below) -- a caller can never construct a `"green"` report
 *   whose own `evidenceBundle`/`validation` disagree with that verdict.
 * - `"aborted"` -- the case runner could not even identify what to look up (dispatch never
 *   yielded a job id, or that job's own progress record never recorded a change request/head SHA)
 *   -- no evidence was ever attempted, so there is deliberately no `evidenceBundle`/`validation`
 *   field to fabricate. `listCaseReportsAsValidationReports` never invents one either: an aborted
 *   case's report is not translated into an `EvidenceValidationReport` at all, which is exactly
 *   equivalent, from the aggregate's own point of view, to that case never having reported at all
 *   (`missing_report` -- the aggregate's own existing, correct verdict for "no evidence exists").
 */
import { z } from "zod";

import { canonicalInstantPattern, parseInstant } from "../../../src/domain/foundation/index.js";
import { evidenceBundleSchema, isEvidenceBundleGreen } from "../harness/schema.js";
import { evidenceValidationReportSchema } from "../evidence/report.js";

const instantSchema = z
  .string()
  .regex(canonicalInstantPattern)
  .refine((value) => parseInstant(value).ok, "Timestamp must be a canonical ISO instant.");

/**
 * On-disk mirror of `CaseRunnerStepRecord` (../harness/case-runner.ts) -- a *separate* schema
 * declaration, deliberately not an import from that module: `tests/e2e/harness/` is this tree's
 * base layer (evidence/ and report/ both already depend on it; see evidence/validator.ts's own
 * import of harness/schema.js), and this module must never invert that direction by having the
 * harness import a report-layer schema. `case-report-store.test.ts` round-trips real
 * `CaseRunnerStepRecord`s produced by the real runner through this schema, so any drift between
 * the two shapes fails a test rather than silently passing.
 */
export const caseRunnerStepRecordSchema = z
  .object({
    stepId: z.string().trim().min(1).max(128),
    command: z.string().trim().min(1).max(2_000),
    startedAt: instantSchema,
    finishedAt: instantSchema,
    outcome: z.enum(["ok", "error"]),
    summary: z.string().max(600),
  })
  .strict();
export type CaseRunnerStepRecordShape = z.infer<typeof caseRunnerStepRecordSchema>;

export const caseRunnerStepLogSchema = z.array(caseRunnerStepRecordSchema).max(1_000);
export type CaseRunnerStepLog = z.infer<typeof caseRunnerStepLogSchema>;

const caseIdSchema = z.string().trim().min(1).max(64);
const caseRunIdSchema = z.string().trim().min(1).max(128);
const stepLogPathSchema = z.string().trim().min(1).max(1_024);

const completedCaseReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal("completed"),
    caseId: caseIdSchema,
    caseRunId: caseRunIdSchema,
    verdict: z.enum(["green", "red"]),
    startedAt: instantSchema,
    finishedAt: instantSchema,
    stepLogPath: stepLogPathSchema,
    evidenceBundle: evidenceBundleSchema,
    validation: evidenceValidationReportSchema,
  })
  .strict();

export const abortedCaseReportReasons = [
  "dispatch_did_not_yield_job_id",
  "job_progress_unavailable_after_dispatch",
  "job_progress_missing_change_request",
] as const;
export type AbortedCaseReportReason = (typeof abortedCaseReportReasons)[number];

const abortedCaseReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal("aborted"),
    caseId: caseIdSchema,
    caseRunId: caseRunIdSchema,
    reason: z.enum(abortedCaseReportReasons),
    stepLogPath: stepLogPathSchema,
  })
  .strict();

export const caseReportSchema = z
  .discriminatedUnion("status", [completedCaseReportSchema, abortedCaseReportSchema])
  .refine((report) => {
    if (report.status === "aborted") return true;
    const bundleGreen = isEvidenceBundleGreen(report.evidenceBundle);
    const validationPassed = report.validation.overall === "pass";
    const derivedVerdict = bundleGreen && validationPassed ? "green" : "red";
    return (
      report.verdict === derivedVerdict &&
      report.caseId === report.evidenceBundle.caseId &&
      report.caseId === report.validation.caseId &&
      report.caseRunId === report.evidenceBundle.runId &&
      report.caseRunId === report.validation.runId
    );
  }, "verdict must equal (every evidence source present AND validation passed); caseId/caseRunId must match the embedded evidence/validation exactly.");

export type CaseReport = z.infer<typeof caseReportSchema>;
