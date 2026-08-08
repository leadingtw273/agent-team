/**
 * E010a smoke test (always on, no env gate needed -- entirely fake ports, no real process spawn,
 * no real network call): proves the whole pipeline this ticket wires up actually holds together
 * end to end -- `runStandardHappyPathCase` (case-runner.ts) -> `persistStandardHappyPathCaseRun`
 * (../report/case-report-store.ts) -> a real filesystem read-back -> `listCaseReportsAsValidationReports`
 * -> `buildAggregateReport` (../report/aggregate.ts) reporting green.
 *
 * This is the ticket's own "重演『E101 標準流程』的殼" requirement, satisfied via the "不真的建
 * Linear 工單也可以" option: every port is a fake (dispatch/resume never spawn a real CLI process,
 * CI polling never calls `gh`, evidence collection never touches real Linear/GitHub) -- this test
 * proves the *runner's own structure*, not a live sandbox. The gated, real-CLI-subprocess
 * counterpart is case-runner-live.test.ts (default-skipped, per this ticket's own env-var gating
 * requirement).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createFixedClock,
  ok,
  parseIdentifier,
  parseInstant,
} from "../../../src/domain/foundation/index.js";
import { headShaSchema } from "../../../src/domain/review/index.js";
import { buildAggregateReport } from "../report/aggregate.js";
import { CaseReportStore, persistStandardHappyPathCaseRun } from "../report/case-report-store.js";
import type { EvidenceCollectorPorts } from "./collector.js";
import {
  runStandardHappyPathCase,
  type CaseRunnerPorts,
  type StandardHappyPathCommand,
} from "./case-runner.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "e010a-case-runner-smoke-"));
  temporaryDirectories.push(directory);
  return directory;
}

const fixtureHeadSha = "b".repeat(40);

function id<Scope extends string>(scope: Scope, value: string) {
  const parsed = parseIdentifier(scope, value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function instant(value: string) {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function headSha(value: string) {
  const parsed = headShaSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid head sha fixture");
  return parsed.data;
}

function fakePorts(): CaseRunnerPorts {
  const clock = createFixedClock("2026-08-06T12:00:00.000Z" as never);
  const evidence: EvidenceCollectorPorts = {
    linear: {
      read: () =>
        Promise.resolve({
          ok: true,
          data: {
            issueId: "issue-e101-smoke",
            identifier: "AGT-101",
            title: "Smoke test issue",
            workStatus: "in_review",
            updatedAt: "2026-08-06T10:00:00.000Z",
            comments: [
              { id: "comment-1", body: "Looks good", createdAt: "2026-08-06T10:05:00.000Z" },
            ],
          },
        }),
    },
    github: {
      read: () =>
        Promise.resolve({
          ok: true,
          data: {
            pullRequest: {
              number: 99,
              state: "open",
              draft: false,
              headSha: fixtureHeadSha,
              baseBranch: "main",
              headBranch: "agent-team/job-smoke",
              url: "https://github.test/owner/sandbox/pull/99",
              mergeability: "mergeable",
              autoMergeEnabled: false,
            },
            checks: {
              headSha: fixtureHeadSha,
              aggregate: "success",
              checks: [{ name: "CI", status: "completed", conclusion: "success" }],
            },
            statuses: {
              headSha: fixtureHeadSha,
              statuses: [{ context: "agent-team/review", state: "success" }],
            },
          },
        }),
    },
    localEvents: {
      read: () =>
        Promise.resolve({
          ok: true,
          data: {
            events: [
              {
                eventId: "event-1",
                eventType: "job.started",
                occurredAt: "2026-08-06T08:30:00.000Z",
                correlationId: "e2e-e101-smoke-000001",
                subjectKind: "job",
                subjectId: "job-smoke-1",
              },
            ],
            inboxRecords: [
              {
                provider: "github",
                deliveryId: "delivery-1",
                eventType: "pull_request",
                receivedAt: "2026-08-06T09:00:00.000Z",
              },
            ],
          },
        }),
    },
    checkpoints: {
      read: () =>
        Promise.resolve({
          ok: true,
          data: {
            checkpoints: [
              {
                id: "checkpoint-1",
                projectId: "project-1",
                issueId: "issue-e101-smoke",
                jobId: "job-smoke-1",
                createdAt: "2026-08-06T08:00:00.000Z",
                reason: "manual",
              },
            ],
          },
        }),
    },
  };

  return {
    clock,
    evidence,
    cli: {
      run: (args) => {
        if (args[0] !== "run") throw new Error(`unexpected CLI invocation: ${args.join(" ")}`);
        return Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({ jobId: "job-smoke-1", pipeline: "ci_waiting" }),
          stderr: "",
        });
      },
    },
    ci: {
      readStatus: () =>
        Promise.resolve(ok({ status: "completed" as const, conclusion: "success" as const })),
    },
    sleep: { sleep: () => Promise.resolve() },
    jobProgress: {
      load: () =>
        Promise.resolve(
          ok({
            schemaVersion: 1 as const,
            revision: 0,
            jobId: id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab"),
            projectId: id("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab"),
            issueId: id("issue", "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab"),
            externalIssueId: "issue-e101-smoke",
            model: "claude-opus",
            stage: { kind: "ci_waiting" as const },
            branch: "agent-team/job-smoke-1",
            worktreePath: "/tmp/sandbox-worktree-smoke",
            changeRequestId: "99",
            headSha: headSha(fixtureHeadSha),
            updatedAt: instant("2026-08-06T11:00:00.000Z"),
          }),
        ),
    },
  };
}

function smokeCommand(): StandardHappyPathCommand {
  return {
    caseId: "E101",
    caseRunId: "e2e-e101-smoke-000001",
    projectId: "project-1",
    repository: "owner/sandbox",
    linear: { teamId: "team-1", projectId: "linear-project-1" },
    timeWindow: { from: "2026-08-06T00:00:00.000Z", to: "2026-08-06T23:59:59.999Z" },
    requiredEventTypes: ["job.started"],
    ciPoll: { maxAttempts: 1, intervalMs: 0 },
    leaseWaitMs: 0,
    leaseWaitChunkMs: 1,
  };
}

describe("E010a smoke: runner -> persistence -> aggregate, end to end (fake ports)", () => {
  it("produces a green case run, persists it with a verified read-back, and aggregates green", async () => {
    const outcome = await runStandardHappyPathCase(fakePorts(), smokeCommand());
    expect(outcome.aborted).toBe(false);
    if (outcome.aborted) return;
    expect(outcome.verdict).toBe("green");

    const directory = await temporaryDirectory();
    const store = new CaseReportStore(directory);
    const written = await persistStandardHappyPathCaseRun(store, outcome);
    expect(written.ok).toBe(true);

    // read-back verification, independent of `write`'s own internal read-back.
    const readBack = await store.load(outcome.caseRunId);
    expect(readBack).toEqual({ ok: true, value: written.ok ? written.value : undefined });
    const stepLog = await store.readStepLog(outcome.caseRunId);
    expect(stepLog.ok && (stepLog.value?.length ?? -1)).toBe(outcome.steps.length);

    const { listCaseReportsAsValidationReports } = await import("../report/case-report-store.js");
    const reports = await listCaseReportsAsValidationReports(store);
    expect(reports.ok).toBe(true);
    if (!reports.ok) return;

    const aggregate = buildAggregateReport(reports.value, ["E101"]);
    expect(aggregate.overall).toBe("green");
    expect(aggregate.cases).toEqual([
      { caseId: "E101", status: "green", runId: outcome.caseRunId, failedRules: [] },
    ]);
  });
});
