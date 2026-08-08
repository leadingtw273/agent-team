/**
 * C017b (D2) unit tests: `CiLogExcerptDiagnosticsSidecar`
 * (src/adapters/dispatch/ci-log-excerpt-diagnostics-sidecar.ts) -- the minimal, non-backlog
 * observability adapter the coordinator's decision required. Covers: the closed record shape
 * (`schemaVersion`/`jobId`/`recordedAt`/`available`/`reason`/`sourceBytes`/`excerptBytes` -- never
 * anything else, and in particular never raw log content), 0600 file permission, one file per job
 * id (a later write overwrites, never accumulates), and that a throwing/rejecting write never
 * escapes `recordCiLogExcerpt` itself (it is declared `void`, not `Promise<...>`).
 */
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CiLogExcerptDiagnosticsSidecar,
  defaultCiLogExcerptDiagnosticsDirectory,
  type CiLogExcerptDiagnosticsRecord,
} from "../../src/adapters/dispatch/ci-log-excerpt-diagnostics-sidecar.js";
import { createFixedClock, parseInstant, type Instant } from "../../src/domain/foundation/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-ci-log-excerpt-diagnostics-"));
  temporaryDirectories.push(directory);
  return directory;
}

function instant(value: string): Instant {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const now = instant("2026-08-08T12:00:00.000Z");
const jobId = "job_018f47d2-77a4-7cc1-8ef2-0123456789ab";

describe("CiLogExcerptDiagnosticsSidecar", () => {
  it("writes a 0600 file containing exactly the closed available:true record shape", async () => {
    const agentTeamHome = await temporaryHome();
    const sidecar = new CiLogExcerptDiagnosticsSidecar({
      agentTeamHome,
      clock: createFixedClock(now),
    });

    sidecar.recordCiLogExcerpt({
      jobId,
      available: true,
      sourceBytes: 12_345,
      excerptBytes: 3_800,
    });
    await sidecar.flush();

    const path = join(defaultCiLogExcerptDiagnosticsDirectory(agentTeamHome), `${jobId}.json`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(await readFile(path, "utf8")) as CiLogExcerptDiagnosticsRecord;
    expect(parsed).toEqual({
      schemaVersion: 1,
      jobId,
      recordedAt: now,
      available: true,
      sourceBytes: 12_345,
      excerptBytes: 3_800,
    });
  });

  it("writes exactly {available:false, reason} with no byte-count fields when the log was unavailable", async () => {
    const agentTeamHome = await temporaryHome();
    const sidecar = new CiLogExcerptDiagnosticsSidecar({
      agentTeamHome,
      clock: createFixedClock(now),
    });

    sidecar.recordCiLogExcerpt({ jobId, available: false, reason: "log_transport_unavailable" });
    await sidecar.flush();

    const path = join(defaultCiLogExcerptDiagnosticsDirectory(agentTeamHome), `${jobId}.json`);
    const parsed = JSON.parse(await readFile(path, "utf8")) as CiLogExcerptDiagnosticsRecord;
    expect(parsed).toEqual({
      schemaVersion: 1,
      jobId,
      recordedAt: now,
      available: false,
      reason: "log_transport_unavailable",
    });
  });

  it("never persists raw log content -- only the closed field set, even if a caller tried to smuggle it in via reason", async () => {
    const agentTeamHome = await temporaryHome();
    const sidecar = new CiLogExcerptDiagnosticsSidecar({
      agentTeamHome,
      clock: createFixedClock(now),
    });
    const canary = "sk-ant-canary-must-never-be-persisted";

    sidecar.recordCiLogExcerpt({ jobId, available: true, sourceBytes: 10, excerptBytes: 10 });
    await sidecar.flush();

    const path = join(defaultCiLogExcerptDiagnosticsDirectory(agentTeamHome), `${jobId}.json`);
    const content = await readFile(path, "utf8");
    expect(content).not.toContain(canary);
    expect(Object.keys(JSON.parse(content) as object).sort()).toEqual(
      ["available", "excerptBytes", "jobId", "recordedAt", "schemaVersion", "sourceBytes"].sort(),
    );
  });

  it("keeps at most one file per job id -- a second call overwrites, never accumulates", async () => {
    const agentTeamHome = await temporaryHome();
    const sidecar = new CiLogExcerptDiagnosticsSidecar({
      agentTeamHome,
      clock: createFixedClock(now),
    });

    sidecar.recordCiLogExcerpt({ jobId, available: false, reason: "no_failing_checks" });
    await sidecar.flush();
    sidecar.recordCiLogExcerpt({ jobId, available: true, sourceBytes: 1, excerptBytes: 1 });
    await sidecar.flush();

    const directory = defaultCiLogExcerptDiagnosticsDirectory(agentTeamHome);
    const entries = await readdir(directory);
    expect(entries).toEqual([`${jobId}.json`]);
    const parsed = JSON.parse(
      await readFile(join(directory, `${jobId}.json`), "utf8"),
    ) as CiLogExcerptDiagnosticsRecord;
    expect(parsed.available).toBe(true);
  });

  it("never throws or rejects out of recordCiLogExcerpt even when the underlying write is impossible", () => {
    const sidecar = new CiLogExcerptDiagnosticsSidecar({
      agentTeamHome: "/nonexistent/definitely-not-writable/agent-team-home",
    });

    expect(() => {
      sidecar.recordCiLogExcerpt({ jobId, available: true, sourceBytes: 1, excerptBytes: 1 });
    }).not.toThrow();
  });

  it("ignores a blank or absurdly long jobId rather than writing a garbage path", async () => {
    const agentTeamHome = await temporaryHome();
    const sidecar = new CiLogExcerptDiagnosticsSidecar({
      agentTeamHome,
      clock: createFixedClock(now),
    });

    sidecar.recordCiLogExcerpt({ jobId: "   ", available: true, sourceBytes: 1, excerptBytes: 1 });
    sidecar.recordCiLogExcerpt({
      jobId: "x".repeat(256),
      available: true,
      sourceBytes: 1,
      excerptBytes: 1,
    });
    await sidecar.flush();

    const directory = defaultCiLogExcerptDiagnosticsDirectory(agentTeamHome);
    const entries = await readdir(directory).catch(() => []);
    expect(entries).toEqual([]);
  });
});
