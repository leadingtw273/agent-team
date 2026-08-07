/**
 * C015r decision 5 unit tests: `FileReviewReportDiagnosticsSidecar`
 * (src/adapters/dispatch/review-report-diagnostics-sidecar.ts) -- the observability sidecar that
 * closes the "zero留存" gap C015q's diagnosis named. Covers: 0600 file permission, Redactor
 * scrubbing, the hard size cap (with `truncated: true` recorded, never silently dropped), one file
 * per job id (a later write overwrites, never accumulates), and that this store's own record shape
 * is exactly `{jobId, category, capturedAt, truncated, originalByteLength, rejectedOutput}` -- no
 * other field ever appears here (this is the thing that must never reach `JobProgressRecord`/
 * `ResumeJobOutcome`/PR/Linear, so its own persisted shape must not accidentally grow into looking
 * like one of those).
 */
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileReviewReportDiagnosticsSidecar,
  defaultReviewReportSidecarMaxBytes,
  type ReviewReportSidecarRecord,
} from "../../src/adapters/dispatch/review-report-diagnostics-sidecar.js";
import { createFixedClock, parseInstant, type Instant } from "../../src/domain/foundation/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-review-report-sidecar-"));
  temporaryDirectories.push(directory);
  return directory;
}

function instant(value: string): Instant {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const now = instant("2026-08-07T12:00:00.000Z");
const jobId = "job_018f47d2-77a4-7cc1-8ef2-0123456789ab";

function noopRedactor() {
  return { redactText: (input: string) => input, redactUnknown: (input: unknown) => input };
}

describe("FileReviewReportDiagnosticsSidecar", () => {
  it("writes a 0600 file containing exactly the closed record shape, with the raw rejected text intact under the cap", async () => {
    const directory = await temporaryDirectory();
    const sidecar = new FileReviewReportDiagnosticsSidecar(
      directory,
      noopRedactor(),
      undefined,
      createFixedClock(now),
    );

    const written = await sidecar.record({
      jobId,
      category: "enum_mismatch",
      rejectedOutput: '{"verdict":"met"}',
    });
    expect(written.ok).toBe(true);
    if (!written.ok) return;

    const path = join(directory, `${jobId}.json`);
    expect(written.value.path).toBe(path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const parsed = JSON.parse(await readFile(path, "utf8")) as ReviewReportSidecarRecord;
    expect(parsed).toEqual({
      schemaVersion: 1,
      jobId,
      category: "enum_mismatch",
      capturedAt: now,
      truncated: false,
      originalByteLength: '{"verdict":"met"}'.length,
      rejectedOutput: '{"verdict":"met"}',
    });
  });

  it("passes the rejected text through the injected Redactor before writing", async () => {
    const directory = await temporaryDirectory();
    const redactor = {
      redactText: (input: string) => input.replaceAll("sk-ant-secret", "[REDACTED]"),
      redactUnknown: (input: unknown) => input,
    };
    const sidecar = new FileReviewReportDiagnosticsSidecar(
      directory,
      redactor,
      undefined,
      createFixedClock(now),
    );

    await sidecar.record({
      jobId,
      category: "schema_invalid",
      rejectedOutput: "leaked key sk-ant-secret in the report",
    });

    const path = join(directory, `${jobId}.json`);
    const content = await readFile(path, "utf8");
    expect(content).not.toContain("sk-ant-secret");
    expect(content).toContain("[REDACTED]");
  });

  it("truncates rejected text over the configured cap and records truncated:true, never silently dropping the field", async () => {
    const directory = await temporaryDirectory();
    const maxBytes = 32;
    const sidecar = new FileReviewReportDiagnosticsSidecar(
      directory,
      noopRedactor(),
      undefined,
      createFixedClock(now),
      maxBytes,
    );
    const huge = "x".repeat(200);

    const written = await sidecar.record({ jobId, category: "invalid_json", rejectedOutput: huge });
    expect(written.ok).toBe(true);

    const path = join(directory, `${jobId}.json`);
    const parsed = JSON.parse(await readFile(path, "utf8")) as ReviewReportSidecarRecord;
    expect(parsed.truncated).toBe(true);
    expect(parsed.originalByteLength).toBe(200);
    expect(Buffer.byteLength(parsed.rejectedOutput, "utf8")).toBe(maxBytes);
  });

  it("keeps at most one file per job id -- a second write overwrites, never accumulates", async () => {
    const directory = await temporaryDirectory();
    const sidecar = new FileReviewReportDiagnosticsSidecar(
      directory,
      noopRedactor(),
      undefined,
      createFixedClock(now),
    );

    await sidecar.record({ jobId, category: "empty_output", rejectedOutput: "first" });
    await sidecar.record({ jobId, category: "context_mismatch", rejectedOutput: "second" });

    const entries = await readdir(directory);
    expect(entries).toEqual([`${jobId}.json`]);
    const path = join(directory, `${jobId}.json`);
    const parsed = JSON.parse(await readFile(path, "utf8")) as ReviewReportSidecarRecord;
    expect(parsed.category).toBe("context_mismatch");
    expect(parsed.rejectedOutput).toBe("second");
  });

  it("default max bytes is a small, fixed diagnostic cap (not the multi-MB provider output ceiling)", () => {
    expect(defaultReviewReportSidecarMaxBytes).toBeLessThan(1_000_000);
    expect(defaultReviewReportSidecarMaxBytes).toBeGreaterThan(0);
  });
});
