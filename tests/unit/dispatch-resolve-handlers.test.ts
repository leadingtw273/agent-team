/**
 * C015o decision 4 unit tests: `createDispatchResolveHandler` (src/cli/dispatch/
 * resolve-handlers.ts) -- the human-issued escape hatch out of `requires_manual` (or any other
 * stuck, non-terminal job-progress stage). Covers the acceptance criteria the coordinator named
 * explicitly: a wrong/mismatched confirmation phrase must be zero side effect (no progress write,
 * no admission release), `--as superseded` releases the admission claim while a plain
 * `requires_manual` state never would (this handler is the *only* path that legitimately releases
 * a stuck claim), `--as cancelled` behaves symmetrically, `--as superseded` without
 * `--superseded-by` is rejected before stdin is ever read, an already-terminal record is blocked,
 * a missing job is blocked, and a claim owned by a *different* job id is left untouched
 * (`admissionReleased: "owned_by_other_job"`) rather than blindly overwritten.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDispatchResolveHandler,
  dispatchResolveConfirmationPhrase,
} from "../../src/cli/dispatch/resolve-handlers.js";
import {
  FileJobProgressStore,
  type JobProgressRecordMutation,
} from "../../src/adapters/dispatch/job-progress-store.js";
import { FileIssueAdmissionStore } from "../../src/adapters/dispatch/issue-admission-store.js";
import {
  domainError,
  ok,
  parseIdentifier,
  type Identifier,
} from "../../src/domain/foundation/index.js";
import type { CreateDispatchResolveHandlerOptions } from "../../src/cli/dispatch/resolve-handlers.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-dispatch-resolve-"));
  temporaryDirectories.push(directory);
  return directory;
}

function id<Scope extends string>(scope: Scope, value: string): Identifier<Scope> {
  const parsed = parseIdentifier(scope, value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const projectId = id("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const issueId = id("issue", "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const jobA = "job_018f47d2-77a4-7cc1-8ef2-0123456789aa";
const jobB = "job_018f47d2-77a4-7cc1-8ef2-0123456789ab";
const leaseId = id("lease", "lease_018f47d2-77a4-7cc1-8ef2-0123456789ab");

function baseRecord(overrides: Partial<JobProgressRecordMutation> = {}): JobProgressRecordMutation {
  return {
    jobId: id("job", jobA),
    projectId,
    issueId,
    externalIssueId: "linear-issue-1",
    model: "claude-opus",
    stage: { kind: "requires_manual" },
    branch: "agent-team/job-018f47d2",
    worktreePath: "/tmp/sandbox-worktree",
    ...overrides,
  };
}

function protectedRegionRecord(): JobProgressRecordMutation {
  return baseRecord({
    stage: {
      kind: "requires_manual",
      cause: {
        stage: "dispatch",
        reasonCode: "protected_region_requires_human",
        attempts: { count: 1 },
      },
    },
    protectedRegionHandoff: {
      leaseId,
      holderId: "cli-dispatch:test-holder",
      workflowState: "confirmed",
      agentCondition: "confirmed",
      comment: "confirmed",
      leaseRelease: "confirmed",
    },
  });
}

async function* stdinOf(phrase: string): AsyncIterable<string> {
  await Promise.resolve();
  yield phrase;
}

async function setup(): Promise<{
  progress: FileJobProgressStore;
  admission: FileIssueAdmissionStore;
  progressDirectory: string;
}> {
  const root = await temporaryDirectory();
  const progressDirectory = join(root, "progress");
  const admissionDirectory = join(root, "admission");
  const progress = new FileJobProgressStore(progressDirectory);
  const admission = new FileIssueAdmissionStore(admissionDirectory);
  return { progress, admission, progressDirectory };
}

function createTestDispatchResolveHandler(
  options: Omit<CreateDispatchResolveHandlerOptions, "authority">,
) {
  return createDispatchResolveHandler({
    ...options,
    authority: {
      converge: async (record) => {
        const current = await options.progress.load(record.jobId);
        return !current.ok
          ? current
          : current.value === undefined
            ? { ok: false as const, error: domainError("not_found") }
            : ok({ record: current.value, release: () => Promise.resolve(ok(undefined)) });
      },
    },
  });
}

describe("createDispatchResolveHandler", () => {
  it("rejects a wrong confirmation phrase with zero side effects -- no progress write, no admission release", async () => {
    const { progress, admission } = await setup();
    await progress.compareAndSwap(jobA, null, baseRecord());
    const claimed = await admission.claim(projectId, issueId);
    if (!claimed.ok) throw new Error(claimed.error.code);
    await admission.attachJob(projectId, issueId, claimed.value.revision, jobA);

    const handler = createTestDispatchResolveHandler({
      progress,
      admission,
      stdin: stdinOf("wrong phrase"),
    });
    const result = await handler({ jobId: jobA, as: "cancelled" });
    expect(result.state).toBe("rejected");
    expect(JSON.parse(result.message ?? "{}")).toMatchObject({ reason: "confirmation_mismatch" });

    const record = await progress.load(jobA);
    expect(record).toMatchObject({ ok: true, value: { stage: { kind: "requires_manual" } } });
    const claim = await admission.load(projectId, issueId);
    expect(claim).toMatchObject({ ok: true, value: { state: "active" } });
  });

  it("rejects --as superseded without --superseded-by before ever reading stdin", async () => {
    const { progress, admission } = await setup();
    await progress.compareAndSwap(jobA, null, baseRecord());

    let stdinRead = false;
    async function* trackedStdin(): AsyncIterable<string> {
      stdinRead = true;
      await Promise.resolve();
      yield dispatchResolveConfirmationPhrase;
    }
    const handler = createTestDispatchResolveHandler({
      progress,
      admission,
      stdin: trackedStdin(),
    });
    const result = await handler({ jobId: jobA, as: "superseded" });
    expect(result.state).toBe("rejected");
    expect(JSON.parse(result.message ?? "{}")).toMatchObject({
      reason: "superseded_requires_superseded_by",
    });
    expect(stdinRead).toBe(false);
  });

  it("rejects --as cancelled carrying --superseded-by", async () => {
    const { progress, admission } = await setup();
    const handler = createTestDispatchResolveHandler({
      progress,
      admission,
      stdin: stdinOf(dispatchResolveConfirmationPhrase),
    });
    const result = await handler({ jobId: jobA, as: "cancelled", supersededByJobId: jobB });
    expect(result.state).toBe("rejected");
    expect(JSON.parse(result.message ?? "{}")).toMatchObject({
      reason: "cancelled_must_not_carry_superseded_by",
    });
  });

  it("blocks resolving a job id that has no progress record", async () => {
    const { progress, admission } = await setup();
    const handler = createTestDispatchResolveHandler({
      progress,
      admission,
      stdin: stdinOf(dispatchResolveConfirmationPhrase),
    });
    const result = await handler({ jobId: jobA, as: "cancelled" });
    expect(result.state).toBe("failed");
    expect(JSON.parse(result.message ?? "{}")).toMatchObject({
      state: "blocked",
      reason: "job_not_found",
    });
  });

  it("blocks resolving a job whose stage is already terminal (e.g. completed)", async () => {
    const { progress, admission } = await setup();
    await progress.compareAndSwap(jobA, null, baseRecord({ stage: { kind: "completed" } }));
    const handler = createTestDispatchResolveHandler({
      progress,
      admission,
      stdin: stdinOf(dispatchResolveConfirmationPhrase),
    });
    const result = await handler({ jobId: jobA, as: "cancelled" });
    expect(result.state).toBe("failed");
    expect(JSON.parse(result.message ?? "{}")).toMatchObject({
      state: "blocked",
      reason: "already_terminal",
    });
  });

  it("--as cancelled writes {kind:cancelled} and releases an active claim owned by this job", async () => {
    const { progress, admission } = await setup();
    await progress.compareAndSwap(jobA, null, baseRecord());
    const claimed = await admission.claim(projectId, issueId);
    if (!claimed.ok) throw new Error(claimed.error.code);
    await admission.attachJob(projectId, issueId, claimed.value.revision, jobA);

    const handler = createTestDispatchResolveHandler({
      progress,
      admission,
      stdin: stdinOf(dispatchResolveConfirmationPhrase),
    });
    const result = await handler({ jobId: jobA, as: "cancelled" });
    expect(result.state).toBe("success");
    expect(JSON.parse(result.message ?? "{}")).toMatchObject({
      state: "resolved",
      as: "cancelled",
      admissionReleased: "released",
    });

    const record = await progress.load(jobA);
    expect(record).toMatchObject({ ok: true, value: { stage: { kind: "cancelled" } } });
    const claim = await admission.load(projectId, issueId);
    expect(claim).toMatchObject({
      ok: true,
      value: { state: "released", releaseReason: "cancelled" },
    });

    // A fresh dispatch can now claim this issue again -- proves `superseded`/`cancelled` actually
    // release the guard that `requires_manual` deliberately never does.
    const reclaimed = await admission.claim(projectId, issueId);
    expect(reclaimed.ok).toBe(true);
  });

  it("--as cancelled removes protected-region handoff receipts before writing the terminal record", async () => {
    const { progress, admission } = await setup();
    await progress.compareAndSwap(jobA, null, protectedRegionRecord());
    const claimed = await admission.claim(projectId, issueId);
    if (!claimed.ok) throw new Error(claimed.error.code);
    await admission.attachJob(projectId, issueId, claimed.value.revision, jobA);

    const handler = createTestDispatchResolveHandler({
      progress,
      admission,
      stdin: stdinOf(dispatchResolveConfirmationPhrase),
    });
    const result = await handler({ jobId: jobA, as: "cancelled" });
    expect(result.state).toBe("success");

    const record = await progress.load(jobA);
    expect(record).toMatchObject({ ok: true, value: { stage: { kind: "cancelled" } } });
    if (!record.ok || record.value === undefined) throw new Error("expected terminal record");
    expect(record.value).not.toHaveProperty("protectedRegionHandoff");
    await expect(admission.load(projectId, issueId)).resolves.toMatchObject({
      ok: true,
      value: { state: "released", releaseReason: "cancelled" },
    });
  });

  /**
   * C016: the real-world case this whole ticket exists for -- a `paused` job-progress record
   * (written by `handlers.ts`'s new fix, job-progress-store.ts's own `checkpointId`-optional
   * `pauseReason`-carrying variant) must be resolvable by this handler exactly like
   * `requires_manual` already is: `paused` is not in `terminalStageKinds`, so nothing about this
   * handler needed to change for this to work -- this test is the end-to-end proof that the
   * ticket's fix (a `paused` record now actually existing) reconnects to this pre-existing escape
   * hatch, closing the loop the incident (`issue_78bf4038`/LEA-16) got stuck in.
   */
  it("--as cancelled resolves a paused-stage record (with checkpointId+pauseReason) exactly like requires_manual, releasing the claim and allowing re-admission", async () => {
    const { progress, admission } = await setup();
    await progress.compareAndSwap(
      jobA,
      null,
      baseRecord({
        stage: {
          kind: "paused",
          checkpointId: id("checkpoint", "checkpoint_018f47d2-77a4-7cc1-8ef2-0123456789ab"),
          pauseReason: "scope_overrun",
        },
      }),
    );
    const claimed = await admission.claim(projectId, issueId);
    if (!claimed.ok) throw new Error(claimed.error.code);
    await admission.attachJob(projectId, issueId, claimed.value.revision, jobA);

    const handler = createTestDispatchResolveHandler({
      progress,
      admission,
      stdin: stdinOf(dispatchResolveConfirmationPhrase),
    });
    const result = await handler({ jobId: jobA, as: "cancelled" });
    expect(result.state).toBe("success");
    expect(JSON.parse(result.message ?? "{}")).toMatchObject({
      state: "resolved",
      as: "cancelled",
      admissionReleased: "released",
    });

    const record = await progress.load(jobA);
    expect(record).toMatchObject({ ok: true, value: { stage: { kind: "cancelled" } } });
    const claim = await admission.load(projectId, issueId);
    expect(claim).toMatchObject({
      ok: true,
      value: { state: "released", releaseReason: "cancelled" },
    });

    // Same proof as the `requires_manual` case above: the issue can be claimed again -- the
    // exact liveness property the incident this ticket closes was missing entirely.
    const reclaimed = await admission.claim(projectId, issueId);
    expect(reclaimed.ok).toBe(true);
  });

  it("--as superseded --superseded-by writes {kind:superseded, supersededByJobId} and releases the claim with reason superseded", async () => {
    const { progress, admission } = await setup();
    await progress.compareAndSwap(jobA, null, baseRecord());
    const claimed = await admission.claim(projectId, issueId);
    if (!claimed.ok) throw new Error(claimed.error.code);
    await admission.attachJob(projectId, issueId, claimed.value.revision, jobA);

    const handler = createTestDispatchResolveHandler({
      progress,
      admission,
      stdin: stdinOf(dispatchResolveConfirmationPhrase),
    });
    const result = await handler({ jobId: jobA, as: "superseded", supersededByJobId: jobB });
    expect(result.state).toBe("success");
    expect(JSON.parse(result.message ?? "{}")).toMatchObject({
      state: "resolved",
      as: "superseded",
      supersededByJobId: jobB,
      admissionReleased: "released",
    });

    const record = await progress.load(jobA);
    expect(record).toMatchObject({
      ok: true,
      value: { stage: { kind: "superseded", supersededByJobId: jobB } },
    });
    const claim = await admission.load(projectId, issueId);
    expect(claim).toMatchObject({
      ok: true,
      value: {
        state: "released",
        releaseReason: "superseded",
        supersededByJobId: jobB,
      },
    });
  });

  it("--as superseded removes protected-region handoff receipts while preserving the successor", async () => {
    const { progress, admission } = await setup();
    await progress.compareAndSwap(jobA, null, protectedRegionRecord());
    const claimed = await admission.claim(projectId, issueId);
    if (!claimed.ok) throw new Error(claimed.error.code);
    await admission.attachJob(projectId, issueId, claimed.value.revision, jobA);

    const handler = createTestDispatchResolveHandler({
      progress,
      admission,
      stdin: stdinOf(dispatchResolveConfirmationPhrase),
    });
    const result = await handler({ jobId: jobA, as: "superseded", supersededByJobId: jobB });
    expect(result.state).toBe("success");

    const record = await progress.load(jobA);
    expect(record).toMatchObject({
      ok: true,
      value: { stage: { kind: "superseded", supersededByJobId: jobB } },
    });
    if (!record.ok || record.value === undefined) throw new Error("expected terminal record");
    expect(record.value).not.toHaveProperty("protectedRegionHandoff");
    await expect(admission.load(projectId, issueId)).resolves.toMatchObject({
      ok: true,
      value: {
        state: "released",
        releaseReason: "superseded",
        supersededByJobId: jobB,
      },
    });
  });

  it("leaves a claim owned by a *different* job id untouched -- reports owned_by_other_job, never blindly releases it", async () => {
    const { progress, admission } = await setup();
    await progress.compareAndSwap(jobA, null, baseRecord());
    const claimed = await admission.claim(projectId, issueId);
    if (!claimed.ok) throw new Error(claimed.error.code);
    // The active claim is owned by jobB, not the job this call resolves (jobA) -- simulates the
    // real duplicate-dispatch scenario this whole ticket exists to fix (issue already re-claimed
    // by a newer job by the time an operator gets around to resolving the old, stuck one).
    await admission.attachJob(projectId, issueId, claimed.value.revision, jobB);

    const handler = createTestDispatchResolveHandler({
      progress,
      admission,
      stdin: stdinOf(dispatchResolveConfirmationPhrase),
    });
    const result = await handler({ jobId: jobA, as: "cancelled" });
    expect(result.state).toBe("success");
    expect(JSON.parse(result.message ?? "{}")).toMatchObject({
      admissionReleased: "owned_by_other_job",
    });

    const claim = await admission.load(projectId, issueId);
    expect(claim).toMatchObject({ ok: true, value: { state: "active", jobId: jobB } });
  });

  it("no progress records are left behind by the confirmation-mismatch case (nothing written to disk at all)", async () => {
    const { progress, admission, progressDirectory } = await setup();
    await progress.compareAndSwap(jobA, null, baseRecord());
    const before = await readdir(progressDirectory);

    const handler = createTestDispatchResolveHandler({
      progress,
      admission,
      stdin: stdinOf("nope"),
    });
    await handler({ jobId: jobA, as: "cancelled" });

    const after = await readdir(progressDirectory);
    expect(after.sort()).toEqual(before.sort());
  });
});
