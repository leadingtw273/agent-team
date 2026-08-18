import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileIssueScopeLock,
  issueScopeDigest,
} from "../../src/adapters/dispatch/issue-scope-lock.js";
import { parseIdentifier } from "../../src/domain/foundation/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-issue-scope-lock-"));
  temporaryDirectories.push(directory);
  return directory;
}

function projectId(): string {
  const parsed = parseIdentifier("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab");
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const scope = Object.freeze({ projectId: projectId(), externalIssueId: "linear-issue-53" });

describe("FileIssueScopeLock", () => {
  it("uses one stable namespace for every caller route", () => {
    expect(issueScopeDigest(scope)).toEqual(issueScopeDigest({ ...scope }));
    const other = issueScopeDigest({ ...scope, externalIssueId: "linear-issue-54" });
    expect(other).not.toEqual(issueScopeDigest(scope));
  });

  it("allows exactly one of dispatch/resume/webhook to own the same Issue", async () => {
    const lock = new FileIssueScopeLock(await temporaryDirectory());
    const results = await Promise.all([
      lock.acquire(scope, "dispatch:job-1"),
      lock.acquire(scope, "resume:job-1"),
      lock.acquire(scope, "webhook:delivery-1"),
    ]);
    const winners = results.filter((result) => result.ok);
    const losers = results.filter((result) => !result.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(2);
    expect(losers.every((result) => result.error.code === "conflict")).toBe(true);
    const winner = winners[0];
    if (!winner?.ok) return;
    expect(await winner.value.release()).toEqual({ ok: true, value: undefined });

    const recovered = await lock.acquire(scope, "reconcile:job-1");
    expect(recovered.ok).toBe(true);
    if (recovered.ok) await recovered.value.release();
  });

  it("rejects malformed scope and holder without creating another namespace", async () => {
    const lock = new FileIssueScopeLock(await temporaryDirectory());
    const badScope = await lock.acquire({ projectId: "wrong", externalIssueId: "issue" }, "holder");
    const badHolder = await lock.acquire(scope, " ");
    expect(badScope.ok ? "ok" : badScope.error.code).toBe("invariant_violation");
    expect(badHolder.ok ? "ok" : badHolder.error.code).toBe("invariant_violation");
  });
});
