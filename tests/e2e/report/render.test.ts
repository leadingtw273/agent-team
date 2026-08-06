/**
 * E008 unit tests for the optional markdown renderer. `renderAggregateReportMarkdown` is a pure,
 * deterministic serialization of an already-built `AggregateReport` (report.ts) -- it never
 * influences `overall`/`status` (that judgment is entirely `buildAggregateReport`'s, aggregate.ts),
 * and it never embeds a wall-clock timestamp or any other non-deterministic value, since the same
 * report must always render to the exact same markdown bytes.
 */
import { describe, expect, it } from "vitest";

import { buildAggregateReport } from "./aggregate.js";
import { e101ToE118CaseIds } from "./expected-cases.js";
import { buildGreenReportFor, buildRedReportFor } from "./fixtures.js";
import { renderAggregateReportMarkdown } from "./render.js";

describe("renderAggregateReportMarkdown", () => {
  it("renders OVERALL: GREEN and every case as green when the aggregate is green", () => {
    const reports = e101ToE118CaseIds.map((caseId) => buildGreenReportFor(caseId));
    const report = buildAggregateReport(reports, e101ToE118CaseIds);

    const markdown = renderAggregateReportMarkdown(report);

    expect(markdown).toContain("Overall: GREEN");
    expect(markdown).toContain("| E101 | green |");
    expect(markdown).toContain("| E118 | green |");
  });

  it("renders the failed rule/reasonCode pair for a red case", () => {
    const reports = e101ToE118CaseIds.map((caseId) =>
      caseId === "E104" ? buildRedReportFor(caseId) : buildGreenReportFor(caseId),
    );
    const report = buildAggregateReport(reports, e101ToE118CaseIds);

    const markdown = renderAggregateReportMarkdown(report);

    expect(markdown).toContain("Overall: RED");
    expect(markdown).toContain("linear_issue_id_match(value_mismatch)");
  });

  it("renders missing_report cases and lists unexpected reports", () => {
    const reports = [
      ...e101ToE118CaseIds
        .filter((caseId) => caseId !== "E109")
        .map((caseId) => buildGreenReportFor(caseId)),
      buildGreenReportFor("E999"),
    ];
    const report = buildAggregateReport(reports, e101ToE118CaseIds);

    const markdown = renderAggregateReportMarkdown(report);

    expect(markdown).toContain("| E109 | missing_report |");
    expect(markdown).toContain("Unexpected reports: E999");
  });

  it("is deterministic: same report renders to byte-identical markdown", () => {
    const reports = e101ToE118CaseIds.map((caseId) => buildGreenReportFor(caseId));
    const report = buildAggregateReport(reports, e101ToE118CaseIds);

    expect(renderAggregateReportMarkdown(report)).toBe(renderAggregateReportMarkdown(report));
  });
});
