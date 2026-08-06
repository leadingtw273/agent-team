/**
 * E008 unit tests. `buildAggregateReport` is a pure function (no I/O), so every test here works
 * directly on plain fixture reports (fixtures.ts) built through E007's real `validateEvidence` --
 * never a hand-rolled `ValidationReport`. Required behaviours (docs/plan.md:357):
 *   1. every expected case green -> overall green
 *   2. any one case red -> overall red
 *   3. any one case missing its report entirely -> overall red
 *   4. an extra report for a case id outside the expected list -> overall red (anti-impersonation)
 *   5. deterministic: same input -> byte-identical output
 */
import { describe, expect, it } from "vitest";

import { buildAggregateReport } from "./aggregate.js";
import { e101ToE118CaseIds } from "./expected-cases.js";
import { buildGreenReportFor, buildRedReportFor } from "./fixtures.js";

describe("buildAggregateReport: expected-case list", () => {
  it("defines exactly the 18 E101-E118 case ids, in order", () => {
    expect(e101ToE118CaseIds).toHaveLength(18);
    expect(e101ToE118CaseIds[0]).toBe("E101");
    expect(e101ToE118CaseIds[e101ToE118CaseIds.length - 1]).toBe("E118");
    expect(new Set(e101ToE118CaseIds).size).toBe(18);
  });
});

describe("buildAggregateReport: all green", () => {
  it("reports overall green when every expected case has a fully-green report", () => {
    const reports = e101ToE118CaseIds.map((caseId) => buildGreenReportFor(caseId));

    const report = buildAggregateReport(reports, e101ToE118CaseIds);

    expect(report.schemaVersion).toBe(1);
    expect(report.overall).toBe("green");
    expect(report.unexpectedCaseIds).toEqual([]);
    expect(report.cases).toHaveLength(18);
    expect(report.cases.map((entry) => entry.caseId)).toEqual([...e101ToE118CaseIds]);
    for (const entry of report.cases) {
      expect(entry.status).toBe("green");
      expect(entry.failedRules).toEqual([]);
      expect(entry.anomaly).toBeUndefined();
      expect(entry.runId).toBeDefined();
    }
  });
});

describe("buildAggregateReport: one case red", () => {
  it("forces overall red when exactly one expected case's report is red, others stay green", () => {
    const reports = e101ToE118CaseIds.map((caseId) =>
      caseId === "E103" ? buildRedReportFor(caseId) : buildGreenReportFor(caseId),
    );

    const report = buildAggregateReport(reports, e101ToE118CaseIds);

    expect(report.overall).toBe("red");
    const e103 = report.cases.find((entry) => entry.caseId === "E103");
    expect(e103?.status).toBe("red");
    expect(e103?.failedRules).toEqual(
      expect.arrayContaining([{ ruleId: "linear_issue_id_match", reasonCode: "value_mismatch" }]),
    );
    for (const entry of report.cases) {
      if (entry.caseId === "E103") continue;
      expect(entry.status).toBe("green");
    }
  });
});

describe("buildAggregateReport: one case missing its report", () => {
  it("forces overall red when exactly one expected case never got any report at all", () => {
    const reports = e101ToE118CaseIds
      .filter((caseId) => caseId !== "E107")
      .map((caseId) => buildGreenReportFor(caseId));

    const report = buildAggregateReport(reports, e101ToE118CaseIds);

    expect(report.overall).toBe("red");
    const e107 = report.cases.find((entry) => entry.caseId === "E107");
    expect(e107).toMatchObject({ status: "missing_report", failedRules: [] });
    expect(e107?.runId).toBeUndefined();
    for (const entry of report.cases) {
      if (entry.caseId === "E107") continue;
      expect(entry.status).toBe("green");
    }
  });

  it("reports every expected case as missing_report when no reports were supplied at all", () => {
    const report = buildAggregateReport([], e101ToE118CaseIds);

    expect(report.overall).toBe("red");
    expect(report.cases.every((entry) => entry.status === "missing_report")).toBe(true);
  });
});

describe("buildAggregateReport: unexpected / impersonating report", () => {
  it("forces overall red when a report is supplied for a case id outside the expected list, even though every expected case is green", () => {
    const reports = [
      ...e101ToE118CaseIds.map((caseId) => buildGreenReportFor(caseId)),
      buildGreenReportFor("E999"),
    ];

    const report = buildAggregateReport(reports, e101ToE118CaseIds);

    expect(report.overall).toBe("red");
    expect(report.unexpectedCaseIds).toEqual(["E999"]);
    expect(report.cases.every((entry) => entry.status === "green")).toBe(true);
  });

  it("sorts and deduplicates multiple unexpected case ids", () => {
    const reports = [
      ...e101ToE118CaseIds.map((caseId) => buildGreenReportFor(caseId)),
      buildGreenReportFor("E999"),
      buildGreenReportFor("E200"),
      buildGreenReportFor("E999"),
    ];

    const report = buildAggregateReport(reports, e101ToE118CaseIds);

    expect(report.unexpectedCaseIds).toEqual(["E200", "E999"]);
  });
});

describe("buildAggregateReport: duplicate report for an expected case (anti-impersonation)", () => {
  it("forces that case red with a duplicate_report anomaly instead of silently picking one report", () => {
    const reports = [
      ...e101ToE118CaseIds.map((caseId) => buildGreenReportFor(caseId)),
      buildGreenReportFor("E101", "run-e101-002"),
    ];

    const report = buildAggregateReport(reports, e101ToE118CaseIds);

    expect(report.overall).toBe("red");
    const e101 = report.cases.find((entry) => entry.caseId === "E101");
    expect(e101).toMatchObject({ status: "red", anomaly: "duplicate_report", failedRules: [] });
    expect(e101?.runId).toBeUndefined();
  });
});

describe("buildAggregateReport: determinism", () => {
  it("produces byte-identical JSON for the same input, called twice", () => {
    const reports = e101ToE118CaseIds.map((caseId) =>
      caseId === "E110" ? buildRedReportFor(caseId) : buildGreenReportFor(caseId),
    );

    const first = JSON.stringify(buildAggregateReport(reports, e101ToE118CaseIds));
    const second = JSON.stringify(buildAggregateReport(reports, e101ToE118CaseIds));

    expect(first).toBe(second);
  });

  it("is unaffected by input report order", () => {
    const reports = e101ToE118CaseIds.map((caseId) =>
      caseId === "E115" ? buildRedReportFor(caseId) : buildGreenReportFor(caseId),
    );
    const reversed = [...reports].reverse();

    const forward = JSON.stringify(buildAggregateReport(reports, e101ToE118CaseIds));
    const backward = JSON.stringify(buildAggregateReport(reversed, e101ToE118CaseIds));

    expect(forward).toBe(backward);
  });

  it("defaults expectedCaseIds to the full E101-E118 list when not supplied", () => {
    const reports = e101ToE118CaseIds.map((caseId) => buildGreenReportFor(caseId));

    const report = buildAggregateReport(reports);

    expect(report.expectedCaseIds).toEqual([...e101ToE118CaseIds]);
    expect(report.overall).toBe("green");
  });
});
