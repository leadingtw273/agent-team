/**
 * C016 unit tests: `createDispatchResolveLegacyClaimHandler` (src/cli/dispatch/
 * legacy-claim-handlers.ts) -- the controlled repair path for an admission claim with no
 * job-progress record to resolve against at all. Covers the acceptance criteria the ticket names
 * explicitly: the subject is the jobId (a claim.jobId mismatch is rejected, zero side effects), a
 * project/issue mismatch (no claim found at that composite key) is rejected, a wrong confirmation
 * phrase is rejected with zero side effects, a job-progress record already existing for --job
 * routes the operator to the normal `dispatch resolve` instead (rejected, zero side effects), and
 * a successful recovery releases the claim with `releaseReason:"legacy_recovered"` and leaves a
 * durable, on-disk audit trail (`releaseNote`) rather than deleting the claim file.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDispatchResolveLegacyClaimHandler,
  dispatchLegacyClaimConfirmationPhrase,
} from "../../src/cli/dispatch/legacy-claim-handlers.js";
import { FileJobProgressStore } from "../../src/adapters/dispatch/job-progress-store.js";
import { FileIssueAdmissionStore } from "../../src/adapters/dispatch/issue-admission-store.js";
import { parseIdentifier, type Identifier } from "../../src/domain/foundation/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-legacy-claim-"));
  temporaryDirectories.push(directory);
  return directory;
}

function id<Scope extends string>(scope: Scope, value: string): Identifier<Scope> {
  const parsed = parseIdentifier(scope, value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const projectId = id("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const otherProjectId = id("project", "project_018f47d2-77a4-7cc1-8ef2-9123456789ab");
const issueId = id("issue", "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const otherIssueId = id("issue", "issue_018f47d2-77a4-7cc1-8ef2-9123456789ab");
const jobA = "job_018f47d2-77a4-7cc1-8ef2-0123456789aa";
const jobB = "job_018f47d2-77a4-7cc1-8ef2-0123456789ab";
const auditNote =
  "job_5601c115-99ad-4f8b-a918-e7bb5b4c437e's paused outcome never persisted a progress record " +
  "(C016) -- verified claim.jobId matches before release. LEA-16.";

async function* stdinOf(phrase: string): AsyncIterable<string> {
  await Promise.resolve();
  yield phrase;
}

async function setup(): Promise<{
  progress: FileJobProgressStore;
  admission: FileIssueAdmissionStore;
}> {
  const root = await temporaryDirectory();
  const progress = new FileJobProgressStore(join(root, "progress"));
  const admission = new FileIssueAdmissionStore(join(root, "admission"));
  return { progress, admission };
}

/** Claims `issueId` on `projectId` and attaches `jobId` to it -- the exact shape a real
 * un-persisted-`paused` incident leaves behind (claim active, jobId attached, no progress
 * record). */
async function claimAndAttach(admission: FileIssueAdmissionStore, jobId: string): Promise<void> {
  const claimed = await admission.claim(projectId, issueId);
  if (!claimed.ok) throw new Error(claimed.error.code);
  const attached = await admission.attachJob(projectId, issueId, claimed.value.revision, jobId);
  if (!attached.ok) throw new Error(attached.error.code);
}

describe("createDispatchResolveLegacyClaimHandler", () => {
  it("rejects malformed input (bad ids, empty note) before ever reading stdin", async () => {
    const { progress, admission } = await setup();
    let stdinRead = false;
    async function* trackedStdin(): AsyncIterable<string> {
      stdinRead = true;
      await Promise.resolve();
      yield dispatchLegacyClaimConfirmationPhrase;
    }
    const handler = createDispatchResolveLegacyClaimHandler({
      progress,
      admission,
      stdin: trackedStdin(),
    });
    const result = await handler({
      jobId: "not-a-real-job-id",
      projectId,
      issueId,
      note: auditNote,
    });
    expect(result.state).toBe("rejected");
    expect(JSON.parse(result.message ?? "{}")).toMatchObject({ reason: "invalid_input" });
    expect(stdinRead).toBe(false);
  });

  it("rejects an empty (whitespace-only) note before ever reading stdin", async () => {
    const { progress, admission } = await setup();
    let stdinRead = false;
    async function* trackedStdin(): AsyncIterable<string> {
      stdinRead = true;
      await Promise.resolve();
      yield dispatchLegacyClaimConfirmationPhrase;
    }
    const handler = createDispatchResolveLegacyClaimHandler({
      progress,
      admission,
      stdin: trackedStdin(),
    });
    const result = await handler({ jobId: jobA, projectId, issueId, note: "   " });
    expect(result.state).toBe("rejected");
    expect(JSON.parse(result.message ?? "{}")).toMatchObject({ reason: "invalid_input" });
    expect(stdinRead).toBe(false);
  });

  it("rejects a wrong confirmation phrase with zero side effects -- claim stays active", async () => {
    const { progress, admission } = await setup();
    await claimAndAttach(admission, jobA);

    const handler = createDispatchResolveLegacyClaimHandler({
      progress,
      admission,
      stdin: stdinOf("wrong phrase"),
    });
    const result = await handler({ jobId: jobA, projectId, issueId, note: auditNote });
    expect(result.state).toBe("rejected");
    expect(JSON.parse(result.message ?? "{}")).toMatchObject({ reason: "confirmation_mismatch" });

    const claim = await admission.load(projectId, issueId);
    expect(claim).toMatchObject({ ok: true, value: { state: "active", jobId: jobA } });
  });

  it("rejects a wrong confirmation phrase that happens to be the *other* command's own phrase (dispatch resolve's, not this one's)", async () => {
    const { progress, admission } = await setup();
    await claimAndAttach(admission, jobA);

    const handler = createDispatchResolveLegacyClaimHandler({
      progress,
      admission,
      stdin: stdinOf("RESOLVE DISPATCH JOB"),
    });
    const result = await handler({ jobId: jobA, projectId, issueId, note: auditNote });
    expect(result.state).toBe("rejected");
    expect(JSON.parse(result.message ?? "{}")).toMatchObject({ reason: "confirmation_mismatch" });
  });

  /**
   * The command's own principal safety rail: this path is only for a claim that has *no*
   * job-progress record at all. If one exists, `dispatch resolve` is the correct (and strictly
   * safer, since it can see the job's real stage) tool -- this must block, never silently defer
   * to the other command or release anything.
   */
  it("blocks (zero side effects) when a job-progress record already exists for --job -- this is not the case this command is for", async () => {
    const { progress, admission } = await setup();
    await progress.compareAndSwap(jobA, null, {
      jobId: id("job", jobA),
      projectId,
      issueId,
      externalIssueId: "linear-issue-1",
      model: "claude-opus",
      stage: { kind: "requires_manual" },
      branch: "agent-team/job-018f47d2",
      worktreePath: "/tmp/sandbox-worktree",
    });
    await claimAndAttach(admission, jobA);

    const handler = createDispatchResolveLegacyClaimHandler({
      progress,
      admission,
      stdin: stdinOf(dispatchLegacyClaimConfirmationPhrase),
    });
    const result = await handler({ jobId: jobA, projectId, issueId, note: auditNote });
    expect(result.state).toBe("failed");
    expect(JSON.parse(result.message ?? "{}")).toMatchObject({
      state: "blocked",
      reason: "job_progress_record_exists",
    });

    const claim = await admission.load(projectId, issueId);
    expect(claim).toMatchObject({ ok: true, value: { state: "active", jobId: jobA } });
  });

  it("blocks when no claim exists at all for (--project, --issue)", async () => {
    const { progress, admission } = await setup();
    const handler = createDispatchResolveLegacyClaimHandler({
      progress,
      admission,
      stdin: stdinOf(dispatchLegacyClaimConfirmationPhrase),
    });
    const result = await handler({ jobId: jobA, projectId, issueId, note: auditNote });
    expect(result.state).toBe("failed");
    expect(JSON.parse(result.message ?? "{}")).toMatchObject({
      state: "blocked",
      reason: "claim_not_found",
    });
  });

  it("blocks when the claim at (--project, --issue) is already released -- nothing left to recover", async () => {
    const { progress, admission } = await setup();
    const claimed = await admission.claim(projectId, issueId);
    if (!claimed.ok) throw new Error(claimed.error.code);
    const released = await admission.release(
      projectId,
      issueId,
      claimed.value.revision,
      "not_dispatched",
    );
    if (!released.ok) throw new Error(released.error.code);

    const handler = createDispatchResolveLegacyClaimHandler({
      progress,
      admission,
      stdin: stdinOf(dispatchLegacyClaimConfirmationPhrase),
    });
    const result = await handler({ jobId: jobA, projectId, issueId, note: auditNote });
    expect(result.state).toBe("failed");
    expect(JSON.parse(result.message ?? "{}")).toMatchObject({
      state: "blocked",
      reason: "claim_not_active",
      currentState: "released",
    });
  });

  /**
   * The core cross-check codex's decision named explicitly: the subject is the jobId, never the
   * issue alone. A claim that exists and is active but is attached to a *different* job than the
   * one the operator named must never be released -- exactly the same "owned_by_other_job"
   * defense `dispatch resolve` already has, applied here before any release, not after.
   */
  it("blocks (zero side effects) when the claim's own jobId does not match --job", async () => {
    const { progress, admission } = await setup();
    await claimAndAttach(admission, jobB);

    const handler = createDispatchResolveLegacyClaimHandler({
      progress,
      admission,
      stdin: stdinOf(dispatchLegacyClaimConfirmationPhrase),
    });
    const result = await handler({ jobId: jobA, projectId, issueId, note: auditNote });
    expect(result.state).toBe("failed");
    expect(JSON.parse(result.message ?? "{}")).toMatchObject({
      state: "blocked",
      reason: "claim_job_mismatch",
    });

    const claim = await admission.load(projectId, issueId);
    expect(claim).toMatchObject({ ok: true, value: { state: "active", jobId: jobB } });
  });

  /** A jobless claim (the disclosed `attachJob`-best-effort crash window, composition.ts:299) is
   * a *different*, not-yet-handled gap -- this command's own jobId-match check must never treat
   * "no jobId at all" as a match either. */
  it("blocks (zero side effects) when the claim has no jobId attached at all", async () => {
    const { progress, admission } = await setup();
    const claimed = await admission.claim(projectId, issueId);
    if (!claimed.ok) throw new Error(claimed.error.code);

    const handler = createDispatchResolveLegacyClaimHandler({
      progress,
      admission,
      stdin: stdinOf(dispatchLegacyClaimConfirmationPhrase),
    });
    const result = await handler({ jobId: jobA, projectId, issueId, note: auditNote });
    expect(result.state).toBe("failed");
    expect(JSON.parse(result.message ?? "{}")).toMatchObject({
      state: "blocked",
      reason: "claim_job_mismatch",
    });

    const claim = await admission.load(projectId, issueId);
    expect(claim).toMatchObject({ ok: true, value: { state: "active" } });
  });

  /** Project/issue mismatch: a claim for a *different* composite key must never be found or
   * released by a call naming the wrong (--project, --issue) pair, even if --job happens to
   * match the real claim elsewhere. */
  it("reports claim_not_found (not a false match) when --project/--issue name a different composite key than the real claim", async () => {
    const { progress, admission } = await setup();
    await claimAndAttach(admission, jobA);

    // Two separate handlers, each with its own fresh stdin iterable -- `readStdinConfirmation`
    // consumes its iterable exactly once, so reusing one across two `handler()` calls would make
    // the second call observe an already-exhausted stream (a `confirmation_mismatch`, not the
    // `claim_not_found` this test is actually about).
    const wrongProject = await createDispatchResolveLegacyClaimHandler({
      progress,
      admission,
      stdin: stdinOf(dispatchLegacyClaimConfirmationPhrase),
    })({ jobId: jobA, projectId: otherProjectId, issueId, note: auditNote });
    expect(JSON.parse(wrongProject.message ?? "{}")).toMatchObject({
      reason: "claim_not_found",
    });
    const wrongIssue = await createDispatchResolveLegacyClaimHandler({
      progress,
      admission,
      stdin: stdinOf(dispatchLegacyClaimConfirmationPhrase),
    })({ jobId: jobA, projectId, issueId: otherIssueId, note: auditNote });
    expect(JSON.parse(wrongIssue.message ?? "{}")).toMatchObject({ reason: "claim_not_found" });

    // The real claim, at its real composite key, is still untouched by either failed attempt.
    const claim = await admission.load(projectId, issueId);
    expect(claim).toMatchObject({ ok: true, value: { state: "active", jobId: jobA } });
  });

  it("succeeds: releases the claim with releaseReason:legacy_recovered and the operator's own audit note, allowing re-admission", async () => {
    const { progress, admission } = await setup();
    await claimAndAttach(admission, jobA);

    const handler = createDispatchResolveLegacyClaimHandler({
      progress,
      admission,
      stdin: stdinOf(dispatchLegacyClaimConfirmationPhrase),
    });
    const result = await handler({ jobId: jobA, projectId, issueId, note: auditNote });
    expect(result.state).toBe("success");
    expect(JSON.parse(result.message ?? "{}")).toMatchObject({
      state: "released",
      jobId: jobA,
      projectId,
      issueId,
      note: auditNote,
    });

    const claim = await admission.load(projectId, issueId);
    expect(claim).toMatchObject({
      ok: true,
      value: {
        state: "released",
        releaseReason: "legacy_recovered",
        releaseNote: auditNote,
      },
    });

    // The whole point: a fresh dispatch can now claim this issue again -- the exact liveness
    // property the incident this ticket closes was permanently missing.
    const reclaimed = await admission.claim(projectId, issueId);
    expect(reclaimed.ok).toBe(true);
  });

  it("no progress records are left behind by any failed path (confirmation mismatch, job mismatch, ...) -- this handler never writes to the progress store at all", async () => {
    const { progress, admission } = await setup();
    await claimAndAttach(admission, jobB);

    const handler = createDispatchResolveLegacyClaimHandler({
      progress,
      admission,
      stdin: stdinOf(dispatchLegacyClaimConfirmationPhrase),
    });
    await handler({ jobId: jobA, projectId, issueId, note: auditNote });

    const record = await progress.load(jobA);
    expect(record).toEqual({ ok: true, value: undefined });
  });
});
