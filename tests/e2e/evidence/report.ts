/**
 * E007: the fixed-schema output of the validator (validator.ts) -- one entry per rule in
 * `evidenceValidationRuleIds` (rules.ts), always all of them, in the same order, every run. There
 * is no partial report: a rule that could not be checked (its source is missing) still gets an
 * entry, with `status: "fail"` and `reasonCode: "source_missing"` -- never omitted, never a silent
 * pass. `schemaVersion: 1` is a locked decision for this task.
 */
import { z } from "zod";

import { evidenceValidationReasonCodes, evidenceValidationRuleIds } from "./rules.js";

export const evidenceValidationRuleResultSchema = z
  .object({
    ruleId: z.enum(evidenceValidationRuleIds),
    status: z.enum(["pass", "fail"]),
    reasonCode: z.enum(evidenceValidationReasonCodes),
  })
  .strict()
  .refine(
    (result) =>
      result.status === "pass" ? result.reasonCode === "ok" : result.reasonCode !== "ok",
    'reasonCode must be "ok" iff status is "pass".',
  );
export type EvidenceValidationRuleResult = z.infer<typeof evidenceValidationRuleResultSchema>;

export const evidenceValidationReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    caseId: z.string().min(1),
    runId: z.string().min(1),
    overall: z.enum(["pass", "fail"]),
    rules: z.array(evidenceValidationRuleResultSchema),
  })
  .strict()
  .refine(
    (report) =>
      report.overall === (report.rules.some((rule) => rule.status === "fail") ? "fail" : "pass"),
    'overall must be "fail" iff at least one rule failed.',
  );
export type EvidenceValidationReport = z.infer<typeof evidenceValidationReportSchema>;
