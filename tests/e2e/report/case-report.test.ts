/**
 * E010a unit tests: `caseReportSchema` (case-report.ts) round-trips a real `CaseReport` built from
 * E007's own real `validateEvidence` (never a hand-rolled report), and rejects the shapes this
 * schema exists to reject: a `verdict` that disagrees with the embedded evidence/validation, and
 * a `caseId`/`caseRunId` mismatch between the report's own top-level fields and its embedded
 * evidence bundle/validation report.
 */
import { describe, expect, it } from "vitest";

import { buildGreenBundle, buildGreenExpectation } from "../evidence/fixtures.js";
import { validateEvidence } from "../evidence/validator.js";
import { caseReportSchema, type CaseReport } from "./case-report.js";

function greenCompletedReport(): CaseReport {
  const evidenceBundle = buildGreenBundle();
  const validation = validateEvidence(evidenceBundle, buildGreenExpectation());
  return caseReportSchema.parse({
    schemaVersion: 1,
    status: "completed",
    caseId: evidenceBundle.caseId,
    caseRunId: evidenceBundle.runId,
    verdict: "green",
    startedAt: "2026-08-06T11:00:00.000Z",
    finishedAt: "2026-08-06T12:00:00.000Z",
    stepLogPath: "/tmp/e2e-cases/run-e101-001.steps.json",
    evidenceBundle,
    validation,
  });
}

describe("caseReportSchema: completed reports", () => {
  it("round-trips a green report built from real collectEvidence/validateEvidence output", () => {
    const report = greenCompletedReport();

    expect(report.status).toBe("completed");
    expect(caseReportSchema.parse(JSON.parse(JSON.stringify(report)))).toEqual(report);
  });

  it("rejects a green verdict paired with a validation report that actually failed", () => {
    const evidenceBundle = buildGreenBundle();
    const expectation = { ...buildGreenExpectation(), linear: { issueId: "does-not-match" } };
    const validation = validateEvidence(evidenceBundle, expectation);
    expect(validation.overall).toBe("fail");

    expect(() =>
      caseReportSchema.parse({
        schemaVersion: 1,
        status: "completed",
        caseId: evidenceBundle.caseId,
        caseRunId: evidenceBundle.runId,
        verdict: "green",
        startedAt: "2026-08-06T11:00:00.000Z",
        finishedAt: "2026-08-06T12:00:00.000Z",
        stepLogPath: "/tmp/e2e-cases/run-e101-001.steps.json",
        evidenceBundle,
        validation,
      }),
    ).toThrow();
  });

  it("rejects a red verdict when the evidence/validation were actually fully green", () => {
    const report = greenCompletedReport();

    expect(() => caseReportSchema.parse({ ...report, verdict: "red" })).toThrow();
  });

  it("rejects a caseRunId that does not match the embedded evidence bundle's own runId", () => {
    const report = greenCompletedReport();

    expect(() => caseReportSchema.parse({ ...report, caseRunId: "run-some-other-case" })).toThrow();
  });

  it("rejects an unknown extra field (strict schema)", () => {
    const report = greenCompletedReport();

    expect(() =>
      caseReportSchema.parse({ ...report, unexpectedField: "should never be accepted" }),
    ).toThrow();
  });
});

describe("caseReportSchema: aborted reports", () => {
  it("round-trips an aborted report with no evidence fields at all", () => {
    const report = caseReportSchema.parse({
      schemaVersion: 1,
      status: "aborted",
      caseId: "E101",
      caseRunId: "e2e-e101-abc123",
      reason: "dispatch_did_not_yield_job_id",
      stepLogPath: "/tmp/e2e-cases/e2e-e101-abc123.steps.json",
    });

    expect(report).toMatchObject({ status: "aborted", reason: "dispatch_did_not_yield_job_id" });
    expect(caseReportSchema.parse(JSON.parse(JSON.stringify(report)))).toEqual(report);
  });

  it("rejects an aborted report that smuggles in an evidenceBundle field", () => {
    expect(() =>
      caseReportSchema.parse({
        schemaVersion: 1,
        status: "aborted",
        caseId: "E101",
        caseRunId: "e2e-e101-abc123",
        reason: "dispatch_did_not_yield_job_id",
        stepLogPath: "/tmp/e2e-cases/e2e-e101-abc123.steps.json",
        evidenceBundle: buildGreenBundle(),
      }),
    ).toThrow();
  });

  it("rejects an unknown reason code", () => {
    expect(() =>
      caseReportSchema.parse({
        schemaVersion: 1,
        status: "aborted",
        caseId: "E101",
        caseRunId: "e2e-e101-abc123",
        reason: "some_made_up_reason",
        stepLogPath: "/tmp/e2e-cases/e2e-e101-abc123.steps.json",
      }),
    ).toThrow();
  });
});
