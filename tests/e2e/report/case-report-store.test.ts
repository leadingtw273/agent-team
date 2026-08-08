/**
 * E010a unit tests: `CaseReportStore` (case-report-store.ts) against a real temp directory (real
 * filesystem, real `AtomicFileStore`/`writeJsonWithSchema` -- write -> mandatory read-back is the
 * exact behaviour under test, so faking the filesystem here would test nothing) and, separately,
 * the bridge to E008: `listCaseReportsAsValidationReports` feeding `buildAggregateReport`
 * (aggregate.ts) directly, including this ticket's own "any case missing its evidence forces the
 * whole aggregate red" requirement (docs/plan.md:357) when a case run never even produced a
 * report (an `"aborted"` `StandardHappyPathOutcome`, persisted but correctly excluded).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildAggregateReport } from "./aggregate.js";
import { e101ToE118CaseIds } from "./expected-cases.js";
import { buildGreenBundle, buildGreenExpectation } from "../evidence/fixtures.js";
import { validateEvidence } from "../evidence/validator.js";
import type { CaseRunnerStepRecord, StandardHappyPathOutcome } from "../harness/case-runner.js";
import {
  CaseReportStore,
  listCaseReportsAsValidationReports,
  persistStandardHappyPathCaseRun,
} from "./case-report-store.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "e010a-case-reports-"));
  temporaryDirectories.push(directory);
  return directory;
}

const fixtureStep: CaseRunnerStepRecord = {
  stepId: "dispatch",
  command: "agent-team run --project project-1",
  startedAt: "2026-08-06T11:00:00.000Z",
  finishedAt: "2026-08-06T11:00:01.000Z",
  outcome: "ok",
  summary: "jobId=job-1",
};

function completedOutcomeFor(caseId: string, caseRunId: string): StandardHappyPathOutcome {
  const evidenceBundle = { ...buildGreenBundle(), caseId, runId: caseRunId };
  const expectation = { ...buildGreenExpectation(), caseId, runId: caseRunId };
  const validation = validateEvidence(evidenceBundle, expectation);
  return {
    aborted: false,
    caseId,
    caseRunId,
    verdict: "green",
    startedAt: "2026-08-06T11:00:00.000Z",
    finishedAt: "2026-08-06T11:10:00.000Z",
    evidenceBundle,
    validation,
    steps: [fixtureStep],
  };
}

function abortedOutcomeFor(caseId: string, caseRunId: string): StandardHappyPathOutcome {
  return {
    aborted: true,
    caseId,
    caseRunId,
    reason: "dispatch_did_not_yield_job_id",
    steps: [fixtureStep],
  };
}

describe("CaseReportStore: write/load/listAll", () => {
  it("writes a completed case report and its step log, and reads both back byte-identical", async () => {
    const store = new CaseReportStore(await temporaryDirectory());
    const outcome = completedOutcomeFor("E101", "e2e-e101-abc123");

    const written = await persistStandardHappyPathCaseRun(store, outcome);
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.value.status).toBe("completed");
    expect(written.value.status === "completed" && written.value.verdict).toBe("green");

    const loaded = await store.load("e2e-e101-abc123");
    expect(loaded).toEqual({ ok: true, value: written.value });

    const stepLog = await store.readStepLog("e2e-e101-abc123");
    expect(stepLog).toEqual({ ok: true, value: [fixtureStep] });
  });

  it("writes an aborted case report with no evidence, and its own step log", async () => {
    const store = new CaseReportStore(await temporaryDirectory());
    const outcome = abortedOutcomeFor("E103", "e2e-e103-def456");

    const written = await persistStandardHappyPathCaseRun(store, outcome);
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.value).toMatchObject({
      status: "aborted",
      reason: "dispatch_did_not_yield_job_id",
    });

    const stepLog = await store.readStepLog("e2e-e103-def456");
    expect(stepLog.ok && stepLog.value).toEqual([fixtureStep]);
  });

  it("load returns ok(undefined) for a caseRunId that was never written", async () => {
    const store = new CaseReportStore(await temporaryDirectory());

    const loaded = await store.load("never-written");

    expect(loaded).toEqual({ ok: true, value: undefined });
  });

  it("listAll returns an empty array for a directory that does not exist yet, never an error", async () => {
    const directory = join(await temporaryDirectory(), "does-not-exist-yet");
    const store = new CaseReportStore(directory);

    const listed = await store.listAll();

    expect(listed).toEqual({ ok: true, value: [] });
  });

  it("listAll returns every persisted report, sorted, and never a .steps.json sidecar file", async () => {
    const store = new CaseReportStore(await temporaryDirectory());
    await persistStandardHappyPathCaseRun(store, completedOutcomeFor("E102", "e2e-e102-b"));
    await persistStandardHappyPathCaseRun(store, completedOutcomeFor("E101", "e2e-e101-a"));

    const listed = await store.listAll();

    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((report) => report.caseRunId)).toEqual(["e2e-e101-a", "e2e-e102-b"]);
  });
});

describe("listCaseReportsAsValidationReports -> buildAggregateReport", () => {
  it("feeds a fully green set of completed case reports through to an overall-green aggregate", async () => {
    const store = new CaseReportStore(await temporaryDirectory());
    for (const caseId of e101ToE118CaseIds) {
      const written = await persistStandardHappyPathCaseRun(
        store,
        completedOutcomeFor(caseId, `run-${caseId.toLowerCase()}-001`),
      );
      expect(written.ok).toBe(true);
    }

    const reports = await listCaseReportsAsValidationReports(store);
    expect(reports.ok).toBe(true);
    if (!reports.ok) return;

    const aggregate = buildAggregateReport(reports.value, e101ToE118CaseIds);
    expect(aggregate.overall).toBe("green");
    expect(aggregate.cases).toHaveLength(18);
  });

  it("forces the aggregate red when one expected case's run aborted (never fabricates its evidence)", async () => {
    const store = new CaseReportStore(await temporaryDirectory());
    for (const caseId of e101ToE118CaseIds) {
      if (caseId === "E107") {
        await persistStandardHappyPathCaseRun(
          store,
          abortedOutcomeFor(caseId, `run-${caseId.toLowerCase()}-001`),
        );
        continue;
      }
      await persistStandardHappyPathCaseRun(
        store,
        completedOutcomeFor(caseId, `run-${caseId.toLowerCase()}-001`),
      );
    }

    const reports = await listCaseReportsAsValidationReports(store);
    expect(reports.ok).toBe(true);
    if (!reports.ok) return;
    // The aborted case contributed no EvidenceValidationReport at all.
    expect(reports.value).toHaveLength(17);

    const aggregate = buildAggregateReport(reports.value, e101ToE118CaseIds);
    expect(aggregate.overall).toBe("red");
    const e107 = aggregate.cases.find((entry) => entry.caseId === "E107");
    expect(e107).toMatchObject({ status: "missing_report", failedRules: [] });
  });

  it("forces the aggregate red when no case ever reported at all (empty directory)", async () => {
    const store = new CaseReportStore(await temporaryDirectory());

    const reports = await listCaseReportsAsValidationReports(store);
    expect(reports.ok).toBe(true);
    if (!reports.ok) return;

    const aggregate = buildAggregateReport(reports.value, e101ToE118CaseIds);
    expect(aggregate.overall).toBe("red");
    expect(aggregate.cases.every((entry) => entry.status === "missing_report")).toBe(true);
  });
});
