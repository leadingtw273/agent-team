/**
 * E010a: turns the E101 hand-run bash loop (dispatch -> verify authoritative base -> poll sandbox
 * CI -> wait out the lease -> resume -> read job progress -> read back all four evidence sources)
 * into typed, composable, unit-testable primitives -- see
 * `/home/markchou/.claude/jobs/6152588f/tmp/e101-cycle2.sh` for the exact manual sequence this
 * file replaces.
 *
 * Every primitive below drives the *real* CLI as a subprocess (`node dist/cli/index.js <args>` --
 * production composition root, not an in-process mock: a Live E2E Case's whole point is proving
 * the real assembled binary behaves correctly end to end). Production wiring
 * (`buildProductionCaseRunnerPorts`) shells out for real, following the exact argv-safety
 * conventions `GhTransport` (../../../src/adapters/github/transport.ts) already established in
 * this codebase: array argv, never a shell, a bounded timeout, `windowsHide`. Every unit test in
 * case-runner.test.ts injects a fake `CaseRunnerPorts` instead -- no primitive here ever spawns a
 * process, calls `gh`/Linear, or sleeps for real inside this ticket's own test run.
 *
 * `runStandardHappyPathCase` is the one full composition this ticket is scoped to provide
 * (docs/plan.md's E102/E103-shaped "dispatch -> CI green -> resume -> evidence" happy path).
 * Other Live E2E Cases (E104-E118) that need different primitive combinations (kill a process,
 * stop the webhook runtime, force a diff swap, ...) are each their own later ticket's job to
 * compose from these same primitives, not this file's.
 *
 * Design choice, deliberate: once a case has a real `jobId` + `changeRequestId` + `headSha` to
 * look up, this composition never short-circuits on an unhappy intermediate signal (CI red,
 * resume landing somewhere unexpected) -- it always runs every remaining step and always ends by
 * collecting and validating evidence (E005/E007), exactly like this codebase's other harness
 * modules never let an early miss skip the rest of a fixed evaluation (see e.g. collector.ts's own
 * "never short-circuiting on an early miss" and validator.ts's "never short-circuits on the first
 * failure"). The case's `verdict` is only ever decided by what evidence actually reconciles to,
 * never by this runner's own belief about how the polling went; the step log is what a human reads
 * to find out *why* a red case went red. The only outcome that genuinely aborts early
 * (`aborted: true`, no evidence attempted) is a structural inability to even identify what to look
 * up at all -- dispatch never yielding a `jobId`, or that job's own progress record never
 * recording a change request/head SHA.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";

import { z } from "zod";

import {
  createClock,
  domainError,
  err,
  ok,
  type Clock,
  type DomainError,
  type Result,
} from "../../../src/domain/foundation/index.js";
import { defaultLeaseDurationMs } from "../../../src/application/leases/coordinator.js";
import { GhTransport, GitHubAdapter } from "../../../src/adapters/github/index.js";
import {
  FileJobProgressStore,
  type JobProgressRecord,
} from "../../../src/adapters/dispatch/job-progress-store.js";
import { defaultJobProgressDirectory } from "../../../src/cli/dispatch/resume-composition.js";
import { evidenceCaseDescriptionSchema } from "./case.js";
import { collectEvidence, type EvidenceCollectorPorts } from "./collector.js";
import { buildProductionEvidenceCollectorPorts } from "./ports.js";
import { placeholderProjectFor } from "./placeholder-project.js";
import type { EvidenceBundle } from "./schema.js";
import {
  evidenceValidationExpectationSchema,
  type EvidenceValidationExpectation,
} from "../evidence/expectation.js";
import { validateEvidence } from "../evidence/validator.js";
import type { EvidenceValidationReport } from "../evidence/report.js";

// ---------------------------------------------------------------------------------------------
// Step log: every primitive appends exactly one of these, in call order, to a case run's log.
// ---------------------------------------------------------------------------------------------

export interface CaseRunnerStepRecord {
  readonly stepId: string;
  readonly command: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly outcome: "ok" | "error";
  /** A short, human-readable summary of what happened -- never raw secrets: primitives only ever
   * summarize CLI stdout/stderr (this harness's own subprocess, whose output contract is this
   * repo's own CLI, not a third-party provider response) and typed port results, never an
   * environment variable or credential value. */
  readonly summary: string;
}

const maxSummaryLength = 500;

function summarize(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "(empty)";
  return trimmed.length <= maxSummaryLength
    ? trimmed
    : `${trimmed.slice(0, maxSummaryLength)}...(truncated)`;
}

async function withStep<Value>(
  clock: Pick<Clock, "now">,
  stepId: string,
  command: string,
  run: () => Promise<Readonly<{ value: Value; outcome: "ok" | "error"; summary: string }>>,
): Promise<Readonly<{ value: Value; step: CaseRunnerStepRecord }>> {
  const startedAt = clock.now();
  const { value, outcome, summary } = await run();
  const finishedAt = clock.now();
  return Object.freeze({
    value,
    step: Object.freeze({ stepId, command, startedAt, finishedAt, outcome, summary }),
  });
}

// ---------------------------------------------------------------------------------------------
// Ports: every primitive below is a function of one of these, never of a global/ambient effect.
// ---------------------------------------------------------------------------------------------

export interface CliProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliProcessPort {
  run(args: readonly string[]): Promise<CliProcessResult>;
}

export const sandboxCiConclusions = ["success", "failure", "cancelled", "skipped"] as const;
export type SandboxCiConclusion = (typeof sandboxCiConclusions)[number];

export interface SandboxCiSnapshot {
  readonly status: "queued" | "in_progress" | "completed";
  readonly conclusion: SandboxCiConclusion | null;
}

/** Read-only by construction: the one method here is a GET-shaped read, never a mutation -- see
 * `createGithubAdapterCiReadPort` below, which wraps the exact same already-vetted, read-only
 * `GitHubAdapter.getCommitChecks` this codebase's own E005 collector (ports.ts) already uses. */
export interface SandboxCiReadPort {
  readStatus(headSha: string): Promise<Result<SandboxCiSnapshot, DomainError>>;
}

export interface SleepPort {
  sleep(ms: number): Promise<void>;
}

/** Narrowed to the one read-only method this runner needs from `FileJobProgressStore` -- never
 * `compareAndSwap` (this harness never mutates a job-progress record; only `agent-team run` ever
 * does that, via the real CLI subprocess `cli` above). */
export interface JobProgressReadPort {
  load(jobId: string): Promise<Result<JobProgressRecord | undefined, DomainError>>;
}

export interface CaseRunnerPorts {
  readonly cli: CliProcessPort;
  readonly ci: SandboxCiReadPort;
  readonly sleep: SleepPort;
  readonly jobProgress: JobProgressReadPort;
  readonly evidence: EvidenceCollectorPorts;
  readonly clock: Pick<Clock, "now">;
}

// ---------------------------------------------------------------------------------------------
// Primitive: drive the real CLI (dispatch and resume are the same `run --project` command, per
// e101-cycle2.sh -- C015a's `run` handler itself decides whether to freshly dispatch or resume an
// already-in-flight job for that project).
// ---------------------------------------------------------------------------------------------

/** Deliberately lenient: this harness only ever extracts the handful of fields it needs to drive
 * its own next step (`jobId` to look up job-progress; `pipeline`/`changeRequestUrl` purely for the
 * step log's own summary). The CLI's own full output contract, and every `pipeline` variant it can
 * report, is `src/cli/dispatch/handlers.ts`'s concern and already covered by that module's own
 * tests -- this schema never re-validates it and `.loose()`s every other field rather than
 * rejecting output this runner does not itself need to fail on. */
const cliRunOutputSchema = z
  .object({
    jobId: z.string().trim().min(1).optional(),
    pipeline: z.string().trim().min(1).optional(),
    changeRequestUrl: z.string().trim().min(1).optional(),
  })
  .loose();
export type CliRunOutput = z.infer<typeof cliRunOutputSchema>;

function parseCliJsonOutput(stdout: string): Result<CliRunOutput, DomainError> {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(stdout);
  } catch {
    return err(domainError("invariant_violation"));
  }
  const parsed = cliRunOutputSchema.safeParse(parsedJson);
  return parsed.success ? ok(parsed.data) : err(domainError("invariant_violation"));
}

export interface CliInvocationOutcome {
  readonly output: Result<CliRunOutput, DomainError>;
  readonly raw: CliProcessResult;
  readonly step: CaseRunnerStepRecord;
}

async function runCliAndParse(
  ports: Pick<CaseRunnerPorts, "cli" | "clock">,
  stepId: string,
  args: readonly string[],
): Promise<CliInvocationOutcome> {
  const { value, step } = await withStep(
    ports.clock,
    stepId,
    `agent-team ${args.join(" ")}`,
    async () => {
      const raw = await ports.cli.run(args);
      const output = parseCliJsonOutput(raw.stdout);
      return {
        value: { output, raw },
        outcome: output.ok ? "ok" : "error",
        summary: output.ok
          ? summarize(raw.stdout)
          : summarize(`stdout: ${raw.stdout}\nstderr: ${raw.stderr}`),
      };
    },
  );
  return Object.freeze({ output: value.output, raw: value.raw, step });
}

/** C015a's "接單半場" -- polls Linear, evaluates eligibility, takes an admission lease and creates
 * a `Job` for `projectId`. Never called with `--dry-run`: a live case's whole point is a real,
 * durable job. */
export function dispatchJob(
  ports: Pick<CaseRunnerPorts, "cli" | "clock">,
  projectId: string,
): Promise<CliInvocationOutcome> {
  return runCliAndParse(ports, "dispatch", ["run", "--project", projectId]);
}

/** The exact same command as `dispatchJob` -- see this file's own header for why `run` is reused
 * rather than a separate CLI verb existing for resume. */
export function resumeJob(
  ports: Pick<CaseRunnerPorts, "cli" | "clock">,
  projectId: string,
): Promise<CliInvocationOutcome> {
  return runCliAndParse(ports, "resume", ["run", "--project", projectId]);
}

// ---------------------------------------------------------------------------------------------
// Primitive: read this job's own durable progress record (read-only; see `JobProgressReadPort`).
// ---------------------------------------------------------------------------------------------

export interface JobProgressReadOutcome {
  readonly record: Result<JobProgressRecord | undefined, DomainError>;
  readonly step: CaseRunnerStepRecord;
}

export async function readJobProgress(
  ports: Pick<CaseRunnerPorts, "jobProgress" | "clock">,
  jobId: string,
): Promise<JobProgressReadOutcome> {
  const { value, step } = await withStep(
    ports.clock,
    "read_job_progress",
    `read job-progress/${jobId}.json`,
    async () => {
      const record = await ports.jobProgress.load(jobId);
      return {
        value: record,
        outcome: record.ok ? "ok" : "error",
        summary: record.ok
          ? record.value === undefined
            ? "not_found"
            : `stage=${record.value.stage.kind}`
          : `error:${record.error.code}`,
      };
    },
  );
  return Object.freeze({ record: value, step });
}

// ---------------------------------------------------------------------------------------------
// Primitive: poll sandbox CI for a head SHA until it completes, fails, or the poll budget runs
// out. Mirrors O009f's own production CI-poll defaults (src/cli/registration/probe-composition.ts)
// for consistency, not by import (that file's own constants are private to the registration
// probe subsystem) -- 40 attempts * 15s = 10 minutes, "comfortably covers the sandbox's own
// observed ~2 minute CI run plus realistic GitHub Actions queueing slack" (same rationale, same
// sandbox).
// ---------------------------------------------------------------------------------------------

export interface PollOptions {
  readonly maxAttempts: number;
  readonly intervalMs: number;
}

export const defaultCiPollOptions: PollOptions = Object.freeze({
  maxAttempts: 40,
  intervalMs: 15_000,
});

export type SandboxCiPollOutcome =
  | Readonly<{ state: "success" }>
  | Readonly<{ state: "failure"; conclusion: SandboxCiConclusion | null }>
  | Readonly<{ state: "timeout" }>
  | Readonly<{ state: "read_error"; code: DomainError["code"] }>;

export interface SandboxCiPollResult {
  readonly outcome: SandboxCiPollOutcome;
  readonly step: CaseRunnerStepRecord;
}

export async function pollSandboxCi(
  ports: Pick<CaseRunnerPorts, "ci" | "sleep" | "clock">,
  headSha: string,
  options: PollOptions = defaultCiPollOptions,
): Promise<SandboxCiPollResult> {
  const { value, step } = await withStep<SandboxCiPollOutcome>(
    ports.clock,
    "poll_sandbox_ci",
    `poll CI for ${headSha} (max ${String(options.maxAttempts)} x ${String(options.intervalMs)}ms)`,
    async () => {
      for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
        const read = await ports.ci.readStatus(headSha);
        if (!read.ok) {
          return {
            value: { state: "read_error", code: read.error.code } as const,
            outcome: "error" as const,
            summary: `read_error(${read.error.code}) on attempt ${String(attempt)}`,
          };
        }
        if (read.value.status === "completed") {
          const outcome: SandboxCiPollOutcome =
            read.value.conclusion === "success"
              ? { state: "success" }
              : { state: "failure", conclusion: read.value.conclusion };
          return {
            value: outcome,
            outcome: outcome.state === "success" ? "ok" : "error",
            summary: `completed after ${String(attempt)} attempt(s): conclusion=${String(read.value.conclusion)}`,
          };
        }
        if (attempt < options.maxAttempts) await ports.sleep.sleep(options.intervalMs);
      }
      return {
        value: { state: "timeout" } as const,
        outcome: "error" as const,
        summary: `timed out after ${String(options.maxAttempts)} attempts`,
      };
    },
  );
  return Object.freeze({ outcome: value, step });
}

// ---------------------------------------------------------------------------------------------
// Primitive: wait out the admission lease so a resume is actually meaningful. Chunked (default
// 20s, mirroring e101-cycle2.sh's own `sleep 20` loop) so a caller's `sleep` port -- real or fake
// -- observes and can assert on individual chunk boundaries rather than one opaque multi-minute
// wait.
// ---------------------------------------------------------------------------------------------

/** 5.5 minutes: the real admission lease (`defaultLeaseDurationMs`,
 * src/application/leases/coordinator.ts) plus e101-cycle2.sh's own 30s safety margin. */
export const defaultLeaseWaitMs = defaultLeaseDurationMs + 30_000;
export const defaultLeaseWaitChunkMs = 20_000;

export interface LeaseWaitResult {
  readonly chunksWaited: number;
  readonly step: CaseRunnerStepRecord;
}

export async function waitForLeaseExpiry(
  ports: Pick<CaseRunnerPorts, "sleep" | "clock">,
  totalMs: number = defaultLeaseWaitMs,
  chunkMs: number = defaultLeaseWaitChunkMs,
): Promise<LeaseWaitResult> {
  const { value, step } = await withStep(
    ports.clock,
    "wait_lease_expiry",
    `sleep ${String(totalMs)}ms in <=${String(chunkMs)}ms chunks`,
    async () => {
      let remaining = totalMs;
      let chunksWaited = 0;
      while (remaining > 0) {
        const thisChunk = Math.min(chunkMs, remaining);
        await ports.sleep.sleep(thisChunk);
        remaining -= thisChunk;
        chunksWaited += 1;
      }
      return {
        value: chunksWaited,
        outcome: "ok" as const,
        summary: `waited ${String(totalMs)}ms across ${String(chunksWaited)} chunk(s)`,
      };
    },
  );
  return Object.freeze({ chunksWaited: value, step });
}

// ---------------------------------------------------------------------------------------------
// Composition: the one full "standard happy path" case this ticket provides
// (E102/E103-shaped: dispatch -> CI green -> lease expiry -> resume -> four-source evidence).
// ---------------------------------------------------------------------------------------------

export interface StandardHappyPathCommand {
  readonly caseId: string;
  readonly caseRunId: string;
  readonly projectId: string;
  readonly repository: string;
  readonly linear: Readonly<{ teamId: string; projectId: string }>;
  readonly timeWindow: Readonly<{ from: string; to: string }>;
  readonly requiredEventTypes: readonly string[];
  readonly leaseWaitMs?: number;
  readonly leaseWaitChunkMs?: number;
  readonly ciPoll?: PollOptions;
}

export type StandardHappyPathOutcome =
  | Readonly<{
      aborted: true;
      caseId: string;
      caseRunId: string;
      reason:
        | "dispatch_did_not_yield_job_id"
        | "job_progress_unavailable_after_dispatch"
        | "job_progress_missing_change_request";
      steps: readonly CaseRunnerStepRecord[];
    }>
  | Readonly<{
      aborted: false;
      caseId: string;
      caseRunId: string;
      verdict: "green" | "red";
      startedAt: string;
      finishedAt: string;
      evidenceBundle: EvidenceBundle;
      validation: EvidenceValidationReport;
      steps: readonly CaseRunnerStepRecord[];
    }>;

function aborted(
  caseId: string,
  caseRunId: string,
  reason: Extract<StandardHappyPathOutcome, { aborted: true }>["reason"],
  steps: readonly CaseRunnerStepRecord[],
): StandardHappyPathOutcome {
  return Object.freeze({ aborted: true, caseId, caseRunId, reason, steps: [...steps] });
}

export async function runStandardHappyPathCase(
  ports: CaseRunnerPorts,
  command: StandardHappyPathCommand,
): Promise<StandardHappyPathOutcome> {
  const steps: CaseRunnerStepRecord[] = [];
  const startedAt = ports.clock.now();

  const dispatch = await dispatchJob(ports, command.projectId);
  steps.push(dispatch.step);
  const jobId = dispatch.output.ok ? dispatch.output.value.jobId : undefined;
  if (jobId === undefined) {
    return aborted(command.caseId, command.caseRunId, "dispatch_did_not_yield_job_id", steps);
  }

  const progressAfterDispatch = await readJobProgress(ports, jobId);
  steps.push(progressAfterDispatch.step);
  if (!progressAfterDispatch.record.ok || progressAfterDispatch.record.value === undefined) {
    return aborted(
      command.caseId,
      command.caseRunId,
      "job_progress_unavailable_after_dispatch",
      steps,
    );
  }
  const afterDispatch = progressAfterDispatch.record.value;
  if (afterDispatch.changeRequestId === undefined || afterDispatch.headSha === undefined) {
    return aborted(command.caseId, command.caseRunId, "job_progress_missing_change_request", steps);
  }
  const changeRequestId = afterDispatch.changeRequestId;
  const headSha = afterDispatch.headSha;

  const ciResult = await pollSandboxCi(ports, headSha, command.ciPoll ?? defaultCiPollOptions);
  steps.push(ciResult.step);

  const leaseWait = await waitForLeaseExpiry(
    ports,
    command.leaseWaitMs ?? defaultLeaseWaitMs,
    command.leaseWaitChunkMs ?? defaultLeaseWaitChunkMs,
  );
  steps.push(leaseWait.step);

  const resume = await resumeJob(ports, command.projectId);
  steps.push(resume.step);

  const progressAfterResume = await readJobProgress(ports, jobId);
  steps.push(progressAfterResume.step);

  const evidenceCaseDescription = evidenceCaseDescriptionSchema.parse({
    caseId: command.caseId,
    runId: command.caseRunId,
    timeWindow: command.timeWindow,
    linear: {
      teamId: command.linear.teamId,
      projectId: command.linear.projectId,
      issueId: afterDispatch.externalIssueId,
    },
    github: {
      repository: command.repository,
      pullRequestNumber: Number(changeRequestId),
      headSha,
    },
  });

  const collected = await withStep(
    ports.clock,
    "collect_evidence",
    "collectEvidence(linear, github, localEvents, checkpoints)",
    async () => {
      const outcome = await collectEvidence(evidenceCaseDescription, ports.evidence, {
        clock: ports.clock,
      });
      return {
        value: outcome,
        outcome: outcome.state === "green" ? "ok" : "error",
        summary:
          outcome.state === "green"
            ? "green"
            : `not_green: missing=${outcome.missingSources.join(",")}`,
      };
    },
  );
  steps.push(collected.step);

  const expectation: EvidenceValidationExpectation = evidenceValidationExpectationSchema.parse({
    caseId: command.caseId,
    runId: command.caseRunId,
    timeWindow: command.timeWindow,
    linear: { issueId: afterDispatch.externalIssueId },
    github: { pullRequestNumber: Number(changeRequestId), headSha },
    checkpoint: { issueId: afterDispatch.externalIssueId, jobId },
    requiredEventTypes: command.requiredEventTypes,
  });

  const validation = validateEvidence(collected.value.bundle, expectation);
  const finishedAt = ports.clock.now();
  const verdict: "green" | "red" =
    collected.value.state === "green" && validation.overall === "pass" ? "green" : "red";

  return Object.freeze({
    aborted: false,
    caseId: command.caseId,
    caseRunId: command.caseRunId,
    verdict,
    startedAt,
    finishedAt,
    evidenceBundle: collected.value.bundle,
    validation,
    steps: [...steps],
  });
}

// ---------------------------------------------------------------------------------------------
// Production wiring -- the only place in this file that touches a real process, `gh`/Linear
// network calls, or a real timer. Mirrors `ports.ts`'s own
// `buildProductionEvidenceCollectorPorts` in spirit: every port constructed here is either the
// exact real CLI subprocess a Live E2E Case is meant to exercise, or an already-vetted read-only
// adapter this codebase already has -- nothing new is invented at the network/process boundary.
// ---------------------------------------------------------------------------------------------

function exitCodeOf(error: unknown): number | null {
  if (error === null || error === undefined) return 0;
  if (typeof error === "object" && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "number") return code;
  }
  return null;
}

export interface NodeCliProcessPortOptions {
  /** Absolute path to this repository's own `dist/cli/index.js` -- the real, built CLI a Live
   * E2E Case dispatches against production composition roots through, never an in-process
   * shortcut. */
  readonly cliEntryPath: string;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly nodeExecutable?: string;
  readonly maxOutputBytes?: number;
}

/** Real subprocess spawn, array argv only (never a shell) -- same convention as
 * `GhTransport#exec` (../../../src/adapters/github/transport.ts). */
export function createNodeCliProcessPort(options: NodeCliProcessPortOptions): CliProcessPort {
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutputBytes = options.maxOutputBytes ?? 16 * 1024 * 1024;
  return {
    run(args) {
      return new Promise((resolve) => {
        execFile(
          nodeExecutable,
          [options.cliEntryPath, ...args],
          {
            cwd: options.cwd,
            encoding: "utf8",
            env: { ...process.env, ...(options.env ?? {}) },
            maxBuffer: maxOutputBytes,
            timeout: timeoutMs,
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            resolve({ exitCode: exitCodeOf(error), stdout, stderr });
          },
        );
      });
    },
  };
}

/** Wraps the exact same read-only `GitHubAdapter.getCommitChecks` E005's own collector
 * (ports.ts's `buildGithubPort`) already uses -- never a new GitHub capability, never a mutation. */
export function createGithubAdapterCiReadPort(
  github: GitHubAdapter,
  repository: string,
): SandboxCiReadPort {
  const project = placeholderProjectFor(repository);
  return {
    async readStatus(headSha) {
      const checks = await github.getCommitChecks({ project }, headSha);
      if (!checks.ok) return checks;
      const status: SandboxCiSnapshot["status"] =
        checks.value.aggregate === "pending" ? "in_progress" : "completed";
      const conclusion: SandboxCiSnapshot["conclusion"] =
        checks.value.aggregate === "pending"
          ? null
          : checks.value.aggregate === "success"
            ? "success"
            : "failure";
      return ok({ status, conclusion });
    },
  };
}

export interface BuildProductionCaseRunnerPortsOptions {
  /** This repository's own checkout root -- where `dist/cli/index.js` (already built by a
   * separate, earlier `pnpm build`, never by this runner) lives. */
  readonly repositoryRoot: string;
  readonly agentTeamHome: string;
  readonly linearApiKey: string;
  /** `owner/repo` of the sandbox this case's PR/CI lives in. */
  readonly repository: string;
  readonly cliTimeoutMs?: number;
}

export function buildProductionCaseRunnerPorts(
  options: BuildProductionCaseRunnerPortsOptions,
): CaseRunnerPorts {
  const cli = createNodeCliProcessPort({
    cliEntryPath: join(options.repositoryRoot, "dist", "cli", "index.js"),
    cwd: options.repositoryRoot,
    env: { AGENT_TEAM_HOME: options.agentTeamHome, LINEAR_API_KEY: options.linearApiKey },
    ...(options.cliTimeoutMs === undefined ? {} : { timeoutMs: options.cliTimeoutMs }),
  });
  const github = new GitHubAdapter(new GhTransport());
  const ci = createGithubAdapterCiReadPort(github, options.repository);
  const sleep: SleepPort = {
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  const jobProgress = new FileJobProgressStore(defaultJobProgressDirectory(options.agentTeamHome));
  const evidence = buildProductionEvidenceCollectorPorts({
    agentTeamHome: options.agentTeamHome,
    linearApiKey: options.linearApiKey,
  });
  return Object.freeze({ cli, ci, sleep, jobProgress, evidence, clock: createClock() });
}
