/**
 * E008: pure aggregation over already-produced E007 `EvidenceValidationReport`s -- this module does
 * no I/O of any kind and never executes model work or any E1xx Case itself (docs/plan.md:357).
 * `buildAggregateReport` is a plain function from `(reports, expectedCaseIds)` to an
 * `AggregateReport` (report.ts): every Live E2E Case (E101-E118) runs independently and hands its
 * own `validateEvidence` (../evidence/validator.ts) output here once all of them have run.
 *
 * Three ways a case can fail to be `green`, all forcing the *whole* aggregate `red` (never averaged
 * or partially green):
 *   - its report's `overall` is `"fail"` -- transcribed here as that report's failed rules;
 *   - no report was supplied for it at all (`missing_report`);
 *   - more than one report claimed the same case id (`anomaly: "duplicate_report"` -- never
 *     resolved by silently picking one, since that would accept a duplicated/spoofed report as the
 *     real one).
 * A report for a case id outside `expectedCaseIds` is never silently ignored either: it is
 * collected into `unexpectedCaseIds`, which alone is enough to force `overall: "red"`.
 */
import {
  evidenceValidationReportSchema,
  type EvidenceValidationReport,
} from "../evidence/report.js";
import { e101ToE118CaseIds } from "./expected-cases.js";
import {
  aggregateReportSchema,
  type AggregateCaseEntry,
  type AggregateFailedRule,
  type AggregateReport,
} from "./report.js";

function buildCaseEntry(
  caseId: string,
  reportsForCase: readonly EvidenceValidationReport[],
): AggregateCaseEntry {
  if (reportsForCase.length === 0) {
    return { caseId, status: "missing_report", failedRules: [] };
  }
  if (reportsForCase.length > 1) {
    return { caseId, status: "red", anomaly: "duplicate_report", failedRules: [] };
  }
  const report = reportsForCase[0];
  if (report === undefined) throw new Error("unreachable: length checked above");

  const failedRules: AggregateFailedRule[] = report.rules
    .filter((rule) => rule.status === "fail")
    .map((rule) => ({ ruleId: rule.ruleId, reasonCode: rule.reasonCode }));

  return {
    caseId,
    status: report.overall === "pass" ? "green" : "red",
    runId: report.runId,
    failedRules,
  };
}

/**
 * Aggregates `reports` against `expectedCaseIds` (defaults to the full E101-E118 list,
 * expected-cases.ts). Always evaluates every expected case -- never short-circuits on the first
 * red/missing case -- so a caller always gets the full picture of exactly which cases are not
 * green.
 */
export function buildAggregateReport(
  reports: readonly EvidenceValidationReport[],
  expectedCaseIds: readonly string[] = e101ToE118CaseIds,
): AggregateReport {
  const validatedReports = reports.map((report) => evidenceValidationReportSchema.parse(report));

  const reportsByCaseId = new Map<string, EvidenceValidationReport[]>();
  for (const report of validatedReports) {
    const existing = reportsByCaseId.get(report.caseId);
    if (existing === undefined) {
      reportsByCaseId.set(report.caseId, [report]);
    } else {
      existing.push(report);
    }
  }

  const expectedSet = new Set(expectedCaseIds);
  const cases = expectedCaseIds.map((caseId) =>
    buildCaseEntry(caseId, reportsByCaseId.get(caseId) ?? []),
  );

  const unexpectedCaseIds = [...reportsByCaseId.keys()]
    .filter((caseId) => !expectedSet.has(caseId))
    .sort((left, right) => left.localeCompare(right));

  const overall =
    cases.every((entry) => entry.status === "green") && unexpectedCaseIds.length === 0
      ? ("green" as const)
      : ("red" as const);

  return aggregateReportSchema.parse({
    schemaVersion: 1,
    expectedCaseIds: [...expectedCaseIds],
    overall,
    cases,
    unexpectedCaseIds,
  });
}
