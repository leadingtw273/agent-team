/**
 * E008 test-only fixtures: build real `EvidenceValidationReport`s (E007) for arbitrary case ids by
 * reusing E007's own green bundle/expectation pair (../evidence/fixtures.ts) and its real
 * `validateEvidence` (../evidence/validator.ts) -- never a hand-rolled report object, so a fixture
 * here can never drift from what the actual validator would produce.
 */
import { buildGreenBundle, buildGreenExpectation } from "../evidence/fixtures.js";
import type { EvidenceValidationExpectation } from "../evidence/expectation.js";
import type { EvidenceValidationReport } from "../evidence/report.js";
import { validateEvidence } from "../evidence/validator.js";
import type { EvidenceBundle } from "../harness/schema.js";

function defaultRunId(caseId: string): string {
  return `run-${caseId.toLowerCase()}-001`;
}

/** A fully-green report for `caseId`: every one of E007's rules passes. */
export function buildGreenReportFor(
  caseId: string,
  runId: string = defaultRunId(caseId),
): EvidenceValidationReport {
  const bundle: EvidenceBundle = { ...structuredClone(buildGreenBundle()), caseId, runId };
  const expectation: EvidenceValidationExpectation = {
    ...structuredClone(buildGreenExpectation()),
    caseId,
    runId,
  };
  return validateEvidence(bundle, expectation);
}

/** A report for `caseId` with exactly one failing rule (`linear_issue_id_match`). */
export function buildRedReportFor(
  caseId: string,
  runId: string = defaultRunId(caseId),
): EvidenceValidationReport {
  const bundle: EvidenceBundle = { ...structuredClone(buildGreenBundle()), caseId, runId };
  const expectation: EvidenceValidationExpectation = {
    ...structuredClone(buildGreenExpectation()),
    caseId,
    runId,
    linear: { issueId: "does-not-match" },
  };
  return validateEvidence(bundle, expectation);
}
