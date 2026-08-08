/**
 * E010a: durable, read-back-verified persistence for `CaseReport` (case-report.ts) and its
 * sibling step log -- the "case report...落到 tests/e2e/report/ 期望的位置" half of this ticket.
 * Mirrors the rest of this codebase's own "atomic write -> mandatory read-back" shape
 * (`E2eCaseManifestStore` in ../harness/seed-reset-manifest.ts, `FileJobProgressStore` in
 * src/adapters/dispatch/job-progress-store.ts): `write`/`writeStepLog` below never report success
 * without first reading the just-written file back through its own schema.
 *
 * One case run's two files live side by side in the same `directory`:
 *   `<caseRunId>.json`        -- the `CaseReport` itself.
 *   `<caseRunId>.steps.json`  -- the step log `stepLogPath` points at.
 *
 * `listCaseReportsAsValidationReports` is the bridge E008's `buildAggregateReport` (aggregate.ts)
 * needs: it reads every report in `directory`, keeps only `status: "completed"` ones (an
 * `"aborted"` case never fabricates an `EvidenceValidationReport` -- see case-report.ts's own
 * header for why that is exactly equivalent to `missing_report`), and returns their embedded
 * `validation` field, already exactly the shape `buildAggregateReport` expects.
 */
import { readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../../src/domain/foundation/index.js";
import {
  AtomicFileStore,
  readJsonWithSchema,
  writeJsonWithSchema,
} from "../../../src/infrastructure/files/index.js";
import type { EvidenceValidationReport } from "../evidence/report.js";
import type { CaseRunnerStepRecord, StandardHappyPathOutcome } from "../harness/case-runner.js";
import {
  caseReportSchema,
  caseRunnerStepLogSchema,
  type CaseReport,
  type CaseRunnerStepLog,
} from "./case-report.js";

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function isNotFound(error: DomainError): boolean {
  return error.code === "not_found";
}

export class CaseReportStore {
  readonly #directory: string;
  readonly #store: AtomicFileStore;

  constructor(directory: string, store: AtomicFileStore = new AtomicFileStore()) {
    if (!isAbsolute(directory)) throw new Error("case_report_directory_must_be_absolute");
    this.#directory = directory;
    this.#store = store;
  }

  #reportPath(caseRunId: string): string {
    return join(this.#directory, `${caseRunId}.json`);
  }

  /** Public so a caller can populate `CaseReport.stepLogPath` before `write()` -- see
   * `persistStandardHappyPathCaseRun` below for the one place this ticket calls both in order. */
  stepLogPath(caseRunId: string): string {
    return join(this.#directory, `${caseRunId}.steps.json`);
  }

  async writeStepLog(
    caseRunId: string,
    steps: readonly CaseRunnerStepRecord[],
  ): Promise<Result<CaseRunnerStepLog, DomainError>> {
    const written = await writeJsonWithSchema(
      this.#store,
      this.stepLogPath(caseRunId),
      caseRunnerStepLogSchema,
      steps,
    );
    if (!written.ok) return written;
    if (written.value.durability !== "confirmed" || !written.value.readBack.ok) {
      return err(domainError("external_failure"));
    }
    return ok(written.value.readBack.value);
  }

  async readStepLog(
    caseRunId: string,
  ): Promise<Result<CaseRunnerStepLog | undefined, DomainError>> {
    const loaded = await readJsonWithSchema(this.stepLogPath(caseRunId), caseRunnerStepLogSchema);
    if (!loaded.ok) return isNotFound(loaded.error) ? ok(undefined) : loaded;
    return loaded;
  }

  async write(report: CaseReport): Promise<Result<CaseReport, DomainError>> {
    const written = await writeJsonWithSchema(
      this.#store,
      this.#reportPath(report.caseRunId),
      caseReportSchema,
      report,
    );
    if (!written.ok) return written;
    if (written.value.durability !== "confirmed" || !written.value.readBack.ok) {
      return err(domainError("external_failure"));
    }
    return ok(written.value.readBack.value);
  }

  async load(caseRunId: string): Promise<Result<CaseReport | undefined, DomainError>> {
    const loaded = await readJsonWithSchema(this.#reportPath(caseRunId), caseReportSchema);
    if (!loaded.ok) return isNotFound(loaded.error) ? ok(undefined) : loaded;
    return loaded;
  }

  /** Every `<caseRunId>.json` file in `directory` (never `.steps.json` siblings), sorted by file
   * name for deterministic output. A directory that does not exist yet is a genuine empty result
   * (`ok([])`), not an error -- mirrors `readCheckpointsForIssue`'s (../harness/checkpoint-reader.ts)
   * own "never had one yet is a normal state" rule. */
  async listAll(): Promise<Result<readonly CaseReport[], DomainError>> {
    let entries: string[];
    try {
      entries = await readdir(this.#directory);
    } catch (error) {
      if (hasNodeErrorCode(error, "ENOENT")) return ok(Object.freeze([]));
      return err(domainError("external_failure"));
    }

    const reportFiles = entries
      .filter((name) => name.endsWith(".json") && !name.endsWith(".steps.json"))
      .sort();

    const reports: CaseReport[] = [];
    for (const file of reportFiles) {
      const loaded = await readJsonWithSchema(join(this.#directory, file), caseReportSchema);
      if (!loaded.ok) return loaded;
      reports.push(loaded.value);
    }
    return ok(Object.freeze(reports));
  }
}

/**
 * Writes the step log first, then the `CaseReport` that references it (never the reverse -- a
 * report whose `stepLogPath` cannot be read back would be worse than no report at all), and
 * returns the report's own post-write read-back, exactly like this codebase's other durable
 * stores. The one call site this ticket wires up for both a completed and an aborted
 * `StandardHappyPathOutcome` (../harness/case-runner.ts).
 */
export async function persistStandardHappyPathCaseRun(
  store: CaseReportStore,
  outcome: StandardHappyPathOutcome,
): Promise<Result<CaseReport, DomainError>> {
  const stepLogWritten = await store.writeStepLog(outcome.caseRunId, outcome.steps);
  if (!stepLogWritten.ok) return stepLogWritten;

  const stepLogPath = store.stepLogPath(outcome.caseRunId);
  const report: CaseReport = outcome.aborted
    ? {
        schemaVersion: 1,
        status: "aborted",
        caseId: outcome.caseId,
        caseRunId: outcome.caseRunId,
        reason: outcome.reason,
        stepLogPath,
      }
    : {
        schemaVersion: 1,
        status: "completed",
        caseId: outcome.caseId,
        caseRunId: outcome.caseRunId,
        verdict: outcome.verdict,
        startedAt: outcome.startedAt,
        finishedAt: outcome.finishedAt,
        stepLogPath,
        evidenceBundle: outcome.evidenceBundle,
        validation: outcome.validation,
      };
  return store.write(report);
}

/**
 * The bridge to E008: every `status: "completed"` report in `store`'s directory, translated to
 * the `EvidenceValidationReport[]` `buildAggregateReport` (aggregate.ts) already knows how to
 * consume. An `"aborted"` report is filtered out, not converted -- see case-report.ts's own header
 * for why that is exactly equivalent to that case never having reported at all.
 */
export async function listCaseReportsAsValidationReports(
  store: CaseReportStore,
): Promise<Result<readonly EvidenceValidationReport[], DomainError>> {
  const all = await store.listAll();
  if (!all.ok) return all;
  return ok(
    Object.freeze(
      all.value
        .filter((report) => report.status === "completed")
        .map((report) => report.validation),
    ),
  );
}
