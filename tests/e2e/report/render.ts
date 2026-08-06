/**
 * E008: an optional, deterministic markdown serialization of an already-built `AggregateReport`
 * (report.ts) for a human reader -- purely a rendering of what `buildAggregateReport`
 * (aggregate.ts) already decided. This module never re-derives or overrides `overall`/`status`,
 * never performs I/O, and never embeds a wall-clock timestamp or any other value that would vary
 * between two calls given the same `AggregateReport` -- the same report always renders to the same
 * markdown bytes.
 */
import type { AggregateCaseEntry, AggregateReport } from "./report.js";

function formatFailedRules(entry: AggregateCaseEntry): string {
  if (entry.anomaly !== undefined) return `anomaly:${entry.anomaly}`;
  if (entry.failedRules.length === 0) return "-";
  return entry.failedRules.map((rule) => `${rule.ruleId}(${rule.reasonCode})`).join("; ");
}

export function renderAggregateReportMarkdown(report: AggregateReport): string {
  const lines: string[] = [
    `# E101-E118 Aggregate Report (schemaVersion ${String(report.schemaVersion)})`,
    "",
    `Overall: ${report.overall.toUpperCase()}`,
    "",
    "| Case | Status | Failed Rules |",
    "| --- | --- | --- |",
  ];

  for (const entry of report.cases) {
    lines.push(`| ${entry.caseId} | ${entry.status} | ${formatFailedRules(entry)} |`);
  }

  if (report.unexpectedCaseIds.length > 0) {
    lines.push("");
    lines.push(`Unexpected reports: ${report.unexpectedCaseIds.join(", ")}`);
  }

  lines.push("");
  return lines.join("\n");
}
