/**
 * C015o decision 3 unit tests: `FileIssueAdmissionStore` (src/adapters/dispatch/
 * issue-admission-store.ts) -- the durable, CAS-guarded per-issue admission claim. Covers: claim
 * succeeds when none exists, re-claiming an active claim fails closed with `conflict`, exactly one
 * of two genuinely concurrent `claim()` calls on the same (projectId, issueId) succeeds (the store-
 * level property acceptance criterion (3) -- "兩個 dispatcher 競爭時最多一個 claim 成功" -- tests
 * directly), `attachJob`/`release` are real CAS (stale `expectedRevision` fails closed), `release`
 * requires a fixed reason and `supersededByJobId` exactly when `reason:"superseded"`, and a fresh
 * `claim()` after a genuine `release()` succeeds (a released claim is not permanently exhausted).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
  const directory = await mkdtemp(join(tmpdir(), "agent-team-issue-admission-"));
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
const jobA = id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789aa");
const jobB = id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab");

describe("FileIssueAdmissionStore", () => {
  it("claims a fresh issue and reports the claim back via load", async () => {
    const store = new FileIssueAdmissionStore(await temporaryDirectory());
    const claimed = await store.claim(projectId, issueId);
    expect(claimed).toMatchObject({ ok: true, value: { state: "active", revision: 0 } });
    const loaded = await store.load(projectId, issueId);
    expect(loaded).toEqual(claimed);
  });

  it("fails closed with conflict when claiming an already-active issue", async () => {
    const store = new FileIssueAdmissionStore(await temporaryDirectory());
    await store.claim(projectId, issueId);
    const second = await store.claim(projectId, issueId);
    expect(second.ok ? "ok" : second.error.code).toBe("conflict");
  });

  it("exactly one of two genuinely concurrent claims on the same issue succeeds", async () => {
    const store = new FileIssueAdmissionStore(await temporaryDirectory());
    const [first, second] = await Promise.all([
      store.claim(projectId, issueId),
      store.claim(projectId, issueId),
    ]);
    const succeeded = [first, second].filter((result) => result.ok);
    const failed = [first, second].filter(
      (result): result is Extract<typeof result, { ok: false }> => !result.ok,
    );
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error.code).toBe("conflict");
  });

  it("attachJob is a genuine CAS -- a stale expectedRevision fails closed", async () => {
    const store = new FileIssueAdmissionStore(await temporaryDirectory());
    const claimed = await store.claim(projectId, issueId);
    if (!claimed.ok) throw new Error(claimed.error.code);
    const attached = await store.attachJob(projectId, issueId, claimed.value.revision, jobA);
    expect(attached).toMatchObject({ ok: true, value: { jobId: jobA, revision: 1 } });

    const stale = await store.attachJob(projectId, issueId, claimed.value.revision, jobB);
    expect(stale.ok ? "ok" : stale.error.code).toBe("conflict");
  });

  it("release requires a fixed reason, and supersededByJobId exactly when superseded", async () => {
    const store = new FileIssueAdmissionStore(await temporaryDirectory());
    const claimed = await store.claim(projectId, issueId);
    if (!claimed.ok) throw new Error(claimed.error.code);

    // superseded without a supersededByJobId is rejected up front (invariant_violation, never
    // silently accepted).
    const invalid = await store.release(projectId, issueId, claimed.value.revision, "superseded");
    expect(invalid.ok ? "ok" : invalid.error.code).toBe("invariant_violation");

    const released = await store.release(
      projectId,
      issueId,
      claimed.value.revision,
      "superseded",
      jobB,
    );
    expect(released).toMatchObject({
      ok: true,
      value: { state: "released", releaseReason: "superseded", supersededByJobId: jobB },
    });
  });

  it("release is a genuine CAS -- a stale expectedRevision fails closed, never releasing twice", async () => {
    const store = new FileIssueAdmissionStore(await temporaryDirectory());
    const claimed = await store.claim(projectId, issueId);
    if (!claimed.ok) throw new Error(claimed.error.code);
    const released = await store.release(
      projectId,
      issueId,
      claimed.value.revision,
      "not_dispatched",
    );
    expect(released.ok).toBe(true);

    const staleReleaseAgain = await store.release(
      projectId,
      issueId,
      claimed.value.revision,
      "cancelled",
    );
    expect(staleReleaseAgain.ok ? "ok" : staleReleaseAgain.error.code).toBe("conflict");
  });

  it("a fresh claim after a genuine release succeeds -- a released claim is not permanently exhausted", async () => {
    const store = new FileIssueAdmissionStore(await temporaryDirectory());
    const first = await store.claim(projectId, issueId);
    if (!first.ok) throw new Error(first.error.code);
    const released = await store.release(
      projectId,
      issueId,
      first.value.revision,
      "not_dispatched",
    );
    if (!released.ok) throw new Error(released.error.code);

    const second = await store.claim(projectId, issueId);
    expect(second).toMatchObject({ ok: true, value: { state: "active", revision: 2 } });
  });

  it("load reports undefined for an issue that was never claimed", async () => {
    const store = new FileIssueAdmissionStore(await temporaryDirectory());
    const loaded = await store.load(projectId, issueId);
    expect(loaded).toEqual({ ok: true, value: undefined });
  });
});
