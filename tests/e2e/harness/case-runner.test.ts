/**
 * E010a unit tests: every `case-runner.ts` primitive against fake ports (fake CLI subprocess,
 * fake CI read, fake sleep/clock, fake job-progress read, fake evidence collector ports) -- no
 * real process spawn, no real `gh`/Linear network call, no real timer, matching this ticket's own
 * "runner 原語單元測試（fake 子程序/clock）" requirement. Production wiring
 * (`buildProductionCaseRunnerPorts`/`createNodeCliProcessPort`/`createGithubAdapterCiReadPort`)
 * is exercised separately (live, env-gated) by case-runner-live.test.ts.
 */
import { describe, expect, it } from "vitest";

import {
  createFixedClock,
  domainError,
  err,
  ok,
  parseIdentifier,
  parseInstant,
  type DomainError,
  type Result,
} from "../../../src/domain/foundation/index.js";
import { headShaSchema, type HeadSha } from "../../../src/domain/review/index.js";
import type { JobProgressRecord } from "../../../src/adapters/dispatch/job-progress-store.js";
import type { EvidenceCollectorPorts } from "./collector.js";
import {
  dispatchJob,
  pollSandboxCi,
  readJobProgress,
  resumeJob,
  runStandardHappyPathCase,
  waitForLeaseExpiry,
  type CaseRunnerPorts,
  type CliProcessPort,
  type CliProcessResult,
  type JobProgressReadPort,
  type SandboxCiReadPort,
  type SandboxCiSnapshot,
  type SleepPort,
  type StandardHappyPathCommand,
} from "./case-runner.js";

const fixedNow = "2026-08-06T12:00:00.000Z" as never;
const clock = createFixedClock(fixedNow);

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

function headSha(value: string): HeadSha {
  const parsed = headShaSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid head sha fixture");
  return parsed.data;
}

const fixtureHeadSha = "a".repeat(40);
const fixtureJobId = id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const fixtureProjectDomainId = id("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const fixtureIssueDomainId = id("issue", "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab");

function baseJobProgressRecord(overrides: Partial<JobProgressRecord> = {}): JobProgressRecord {
  return {
    schemaVersion: 1,
    revision: 0,
    jobId: fixtureJobId,
    projectId: fixtureProjectDomainId,
    issueId: fixtureIssueDomainId,
    externalIssueId: "issue-e101",
    model: "claude-opus",
    stage: { kind: "ci_waiting" },
    branch: "agent-team/job-018f47d2",
    worktreePath: "/tmp/sandbox-worktree",
    changeRequestId: "42",
    headSha: headSha(fixtureHeadSha),
    updatedAt: instant("2026-08-06T11:00:00.000Z"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------------------

function fakeCliPort(responses: readonly CliProcessResult[]): CliProcessPort & {
  calls: (readonly string[])[];
} {
  const calls: (readonly string[])[] = [];
  let index = 0;
  return {
    calls,
    run(args) {
      calls.push(args);
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (response === undefined) throw new Error("unreachable: at least one fake response");
      return Promise.resolve(response);
    },
  };
}

function fakeSleep(): SleepPort & { readonly waited: number[] } {
  const waited: number[] = [];
  return {
    waited,
    sleep(ms) {
      waited.push(ms);
      return Promise.resolve();
    },
  };
}

function fakeJobProgress(
  records: Record<string, Result<JobProgressRecord | undefined, DomainError>>,
): JobProgressReadPort {
  return {
    load(jobId) {
      return Promise.resolve(records[jobId] ?? ok(undefined));
    },
  };
}

function fakeCi(sequence: readonly Result<SandboxCiSnapshot, DomainError>[]): SandboxCiReadPort {
  let index = 0;
  return {
    readStatus() {
      const value = sequence[Math.min(index, sequence.length - 1)];
      index += 1;
      if (value === undefined) throw new Error("unreachable: at least one fake CI result");
      return Promise.resolve(value);
    },
  };
}

function allGreenEvidencePorts(): EvidenceCollectorPorts {
  return {
    linear: {
      read: () =>
        Promise.resolve({
          ok: true,
          data: {
            issueId: "issue-e101",
            identifier: "AGT-101",
            title: "Sample issue",
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
              number: 42,
              state: "open",
              draft: false,
              headSha: fixtureHeadSha,
              baseBranch: "main",
              headBranch: "task/agt-101",
              url: "https://github.test/owner/sandbox/pull/42",
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
                correlationId: "e2e-e101-abc123",
                subjectKind: "job",
                subjectId: "job-018f47d2-77a4-7cc1-8ef2-0123456789ab",
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
                issueId: "issue-e101",
                jobId: "job-1",
                createdAt: "2026-08-06T08:00:00.000Z",
                reason: "manual",
              },
            ],
          },
        }),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// dispatchJob / resumeJob
// ---------------------------------------------------------------------------------------------

describe("dispatchJob / resumeJob", () => {
  it("parses jobId/pipeline/changeRequestUrl out of the CLI's JSON stdout and records an ok step", async () => {
    const cli = fakeCliPort([
      {
        exitCode: 0,
        stdout: JSON.stringify({
          jobId: "job-1",
          pipeline: "ci_waiting",
          changeRequestUrl: "https://github.test/owner/sandbox/pull/42",
        }),
        stderr: "",
      },
    ]);

    const result = await dispatchJob({ cli, clock }, "project-1");

    expect(cli.calls).toEqual([["run", "--project", "project-1"]]);
    expect(result.output.ok).toBe(true);
    if (result.output.ok) {
      expect(result.output.value.jobId).toBe("job-1");
      expect(result.output.value.pipeline).toBe("ci_waiting");
      expect(typeof result.output.value.changeRequestUrl).toBe("string");
    }
    expect(result.step.stepId).toBe("dispatch");
    expect(result.step.outcome).toBe("ok");
  });

  it("resumeJob issues the exact same `run --project` command as dispatchJob", async () => {
    const cli = fakeCliPort([
      { exitCode: 0, stdout: JSON.stringify({ jobId: "job-1" }), stderr: "" },
    ]);

    await resumeJob({ cli, clock }, "project-1");

    expect(cli.calls).toEqual([["run", "--project", "project-1"]]);
  });

  it("reports an error step, without throwing, when stdout is not valid JSON", async () => {
    const cli = fakeCliPort([{ exitCode: 1, stdout: "not json", stderr: "boom" }]);

    const result = await dispatchJob({ cli, clock }, "project-1");

    expect(result.output.ok).toBe(false);
    expect(result.step.outcome).toBe("error");
    expect(result.step.summary).toContain("boom");
  });
});

// ---------------------------------------------------------------------------------------------
// readJobProgress
// ---------------------------------------------------------------------------------------------

describe("readJobProgress", () => {
  it("reads back the record and reports its stage in the step summary", async () => {
    const record = baseJobProgressRecord();
    const jobProgress = fakeJobProgress({ "job-1": ok(record) });

    const result = await readJobProgress({ jobProgress, clock }, "job-1");

    expect(result.record).toEqual(ok(record));
    expect(result.step.outcome).toBe("ok");
    expect(result.step.summary).toBe("stage=ci_waiting");
  });

  it("reports not_found without treating it as an error result", async () => {
    const jobProgress = fakeJobProgress({ "job-1": ok(undefined) });

    const result = await readJobProgress({ jobProgress, clock }, "job-1");

    expect(result.record).toEqual(ok(undefined));
    expect(result.step.summary).toBe("not_found");
  });

  it("records an error step when the port itself fails", async () => {
    const jobProgress = fakeJobProgress({ "job-1": err(domainError("external_failure")) });

    const result = await readJobProgress({ jobProgress, clock }, "job-1");

    expect(result.record.ok).toBe(false);
    expect(result.step.outcome).toBe("error");
  });
});

// ---------------------------------------------------------------------------------------------
// pollSandboxCi
// ---------------------------------------------------------------------------------------------

describe("pollSandboxCi", () => {
  it("returns success on the first completed+success read, with no sleep call needed", async () => {
    const ci = fakeCi([ok({ status: "completed", conclusion: "success" })]);
    const sleep = fakeSleep();

    const result = await pollSandboxCi({ ci, sleep, clock }, "a".repeat(40), {
      maxAttempts: 5,
      intervalMs: 1_000,
    });

    expect(result.outcome).toEqual({ state: "success" });
    expect(sleep.waited).toEqual([]);
    expect(result.step.outcome).toBe("ok");
  });

  it("sleeps between not-yet-completed attempts, then reports failure on a completed+failure read", async () => {
    const ci = fakeCi([
      ok({ status: "in_progress", conclusion: null }),
      ok({ status: "in_progress", conclusion: null }),
      ok({ status: "completed", conclusion: "failure" }),
    ]);
    const sleep = fakeSleep();

    const result = await pollSandboxCi({ ci, sleep, clock }, "a".repeat(40), {
      maxAttempts: 5,
      intervalMs: 1_000,
    });

    expect(result.outcome).toEqual({ state: "failure", conclusion: "failure" });
    expect(sleep.waited).toEqual([1_000, 1_000]);
    expect(result.step.outcome).toBe("error");
  });

  it("gives up with state:timeout after exhausting maxAttempts, sleeping exactly maxAttempts-1 times", async () => {
    const ci = fakeCi([ok({ status: "in_progress", conclusion: null })]);
    const sleep = fakeSleep();

    const result = await pollSandboxCi({ ci, sleep, clock }, "a".repeat(40), {
      maxAttempts: 3,
      intervalMs: 500,
    });

    expect(result.outcome).toEqual({ state: "timeout" });
    expect(sleep.waited).toEqual([500, 500]);
  });

  it("stops immediately, without retrying, when the read port itself fails", async () => {
    const ci = fakeCi([err(domainError("unavailable"))]);
    const sleep = fakeSleep();

    const result = await pollSandboxCi({ ci, sleep, clock }, "a".repeat(40), {
      maxAttempts: 5,
      intervalMs: 1_000,
    });

    expect(result.outcome).toEqual({ state: "read_error", code: "unavailable" });
    expect(sleep.waited).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// waitForLeaseExpiry
// ---------------------------------------------------------------------------------------------

describe("waitForLeaseExpiry", () => {
  it("chunks a total wait into <=chunkMs sleeps, covering the exact total", async () => {
    const sleep = fakeSleep();

    const result = await waitForLeaseExpiry({ sleep, clock }, 45_000, 20_000);

    expect(sleep.waited).toEqual([20_000, 20_000, 5_000]);
    expect(result.chunksWaited).toBe(3);
    expect(result.step.outcome).toBe("ok");
  });

  it("performs exactly one sleep when the total is smaller than one chunk", async () => {
    const sleep = fakeSleep();

    const result = await waitForLeaseExpiry({ sleep, clock }, 5_000, 20_000);

    expect(sleep.waited).toEqual([5_000]);
    expect(result.chunksWaited).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// runStandardHappyPathCase: the full composition
// ---------------------------------------------------------------------------------------------

function standardCommand(
  overrides: Partial<StandardHappyPathCommand> = {},
): StandardHappyPathCommand {
  return {
    caseId: "E101",
    caseRunId: "e2e-e101-abc123",
    projectId: "project-1",
    repository: "owner/sandbox",
    linear: { teamId: "team-1", projectId: "linear-project-1" },
    timeWindow: { from: "2026-08-06T00:00:00.000Z", to: "2026-08-06T23:59:59.999Z" },
    requiredEventTypes: ["job.started"],
    ciPoll: { maxAttempts: 3, intervalMs: 1_000 },
    leaseWaitMs: 2_000,
    leaseWaitChunkMs: 1_000,
    ...overrides,
  };
}

function fullHappyPathPorts(): CaseRunnerPorts {
  const cli = fakeCliPort([
    { exitCode: 0, stdout: JSON.stringify({ jobId: "job-1", pipeline: "ci_waiting" }), stderr: "" },
    { exitCode: 0, stdout: JSON.stringify({ jobId: "job-1", pipeline: "activated" }), stderr: "" },
  ]);
  const jobProgress = fakeJobProgress({ "job-1": ok(baseJobProgressRecord()) });
  const ci = fakeCi([ok({ status: "completed", conclusion: "success" })]);
  const sleep = fakeSleep();
  return { cli, ci, sleep, jobProgress, evidence: allGreenEvidencePorts(), clock };
}

describe("runStandardHappyPathCase: full happy path", () => {
  it("dispatches, polls CI green, waits the lease, resumes, and produces a green case report", async () => {
    const outcome = await runStandardHappyPathCase(fullHappyPathPorts(), standardCommand());

    expect(outcome.aborted).toBe(false);
    if (outcome.aborted) return;
    expect(outcome.verdict).toBe("green");
    expect(outcome.caseId).toBe("E101");
    expect(outcome.caseRunId).toBe("e2e-e101-abc123");
    expect(outcome.evidenceBundle.caseId).toBe("E101");
    expect(outcome.validation.overall).toBe("pass");
    expect(outcome.steps.map((step) => step.stepId)).toEqual([
      "dispatch",
      "read_job_progress",
      "poll_sandbox_ci",
      "wait_lease_expiry",
      "resume",
      "read_job_progress",
      "collect_evidence",
    ]);
    expect(outcome.steps.every((step) => step.startedAt.length > 0)).toBe(true);
  });

  it("still completes through evidence collection -- as a red verdict -- when CI itself never goes green", async () => {
    const ports = fullHappyPathPorts();
    ports.ci.readStatus = () => Promise.resolve(ok({ status: "completed", conclusion: "failure" }));

    const outcome = await runStandardHappyPathCase(ports, standardCommand());

    expect(outcome.aborted).toBe(false);
    if (outcome.aborted) return;
    // Evidence itself is still fully green (this fake's evidence ports don't know about the CI
    // poll's own belief) -- the point of this test is that a red CI poll never aborts the run or
    // skips evidence collection, exactly per this module's own "never short-circuit" design.
    const ciStep = outcome.steps.find((step) => step.stepId === "poll_sandbox_ci");
    expect(ciStep?.outcome).toBe("error");
    expect(outcome.steps.some((step) => step.stepId === "collect_evidence")).toBe(true);
  });

  it("aborts with no evidence attempted when dispatch never yields a jobId", async () => {
    const ports = fullHappyPathPorts();
    ports.cli.run = () =>
      Promise.resolve({ exitCode: 0, stdout: JSON.stringify({ pipeline: "blocked" }), stderr: "" });

    const outcome = await runStandardHappyPathCase(ports, standardCommand());

    expect(outcome.aborted).toBe(true);
    if (!outcome.aborted) return;
    expect(outcome.reason).toBe("dispatch_did_not_yield_job_id");
    expect(outcome.steps).toHaveLength(1);
  });

  it("aborts when the dispatched job's own progress record can never be found", async () => {
    const ports = fullHappyPathPorts();
    ports.jobProgress.load = () => Promise.resolve(ok(undefined));

    const outcome = await runStandardHappyPathCase(ports, standardCommand());

    expect(outcome.aborted).toBe(true);
    if (!outcome.aborted) return;
    expect(outcome.reason).toBe("job_progress_unavailable_after_dispatch");
  });

  it("aborts when the job progress record has no changeRequestId/headSha to look evidence up by", async () => {
    const ports = fullHappyPathPorts();
    ports.jobProgress.load = () =>
      Promise.resolve(
        ok(baseJobProgressRecord({ changeRequestId: undefined, headSha: undefined })),
      );

    const outcome = await runStandardHappyPathCase(ports, standardCommand());

    expect(outcome.aborted).toBe(true);
    if (!outcome.aborted) return;
    expect(outcome.reason).toBe("job_progress_missing_change_request");
  });
});
