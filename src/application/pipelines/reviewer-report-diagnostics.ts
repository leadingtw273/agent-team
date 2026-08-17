import type { SafeReviewReportDiagnostic, SafeReviewReportIssueCode } from "./reviewer-model.js";

interface DiagnosticIssue {
  readonly code: string;
  readonly path: readonly PropertyKey[];
}

const literalChildren: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  "": new Set([
    "schemaVersion",
    "role",
    "verdict",
    "requirementsDigest",
    "headSha",
    "diffDigest",
    "evidenceDigest",
    "publicationDigest",
    "summary",
    "acceptanceCriteria",
    "qualityChecks",
    "findings",
  ]),
  "acceptanceCriteria.[*]": new Set(["criterion", "status", "summary", "evidenceSources"]),
  "qualityChecks.[*]": new Set(["dimension", "status", "summary", "evidenceSources"]),
  "findings.[*]": new Set([
    "severity",
    "title",
    "description",
    "acceptanceCriteria",
    "evidenceSources",
    "path",
    "line",
  ]),
});

const fixedMessages: Readonly<Record<SafeReviewReportIssueCode, string>> = Object.freeze({
  invalid_type: "Value type does not match the report schema.",
  invalid_value: "Value is outside the report schema allowlist.",
  too_small: "Value is below the report schema minimum.",
  too_big: "Value exceeds the report schema maximum.",
  invalid_format: "Value does not match the required report format.",
  unrecognized_keys: "Report contains one or more unrecognized keys.",
  invalid_union: "Value does not match an allowed report shape.",
  custom: "Report violates a cross-field contract.",
  other: "Report does not match the strict schema.",
});

function safeCode(code: string): SafeReviewReportIssueCode {
  return code in fixedMessages ? (code as SafeReviewReportIssueCode) : "other";
}

function normalizedPath(path: readonly PropertyKey[]): string {
  const output: string[] = [];
  for (const segment of path) {
    if (typeof segment === "number") {
      output.push("[*]");
      continue;
    }
    const parent = output.join(".");
    const allowed = literalChildren[parent];
    output.push(typeof segment === "string" && allowed?.has(segment) === true ? segment : "[*]");
  }
  return output.length === 0 ? "report" : output.join(".");
}

export function safeReviewReportDiagnostics(
  issues: readonly DiagnosticIssue[],
): readonly SafeReviewReportDiagnostic[] {
  const seen = new Set<string>();
  const diagnostics: SafeReviewReportDiagnostic[] = [];
  for (const issue of issues) {
    const code = safeCode(issue.code);
    const path = normalizedPath(issue.path);
    const key = `${code}:${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    diagnostics.push(Object.freeze({ code, path, message: fixedMessages[code] }));
    if (diagnostics.length >= 100) break;
  }
  return Object.freeze(diagnostics);
}
