import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileHumanAcceptanceStore,
  publicHumanAcceptanceProjection,
} from "../../src/adapters/dispatch/human-acceptance-store.js";
import { createFixedClock, parseInstant } from "../../src/domain/foundation/index.js";
import type { HumanAcceptanceIdentity } from "../../src/domain/acceptance/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-human-acceptance-"));
  temporaryDirectories.push(directory);
  return directory;
}

function instant(value: string) {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const now = instant("2026-08-21T03:00:00.000Z");
const mergedAt = instant("2026-08-21T02:59:00.000Z");
const projectId = "project_018f47d2-77a4-7cc1-8ef2-0123456789ab" as const;
const issueId = "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab" as const;

function identity(overrides: Partial<HumanAcceptanceIdentity> = {}): HumanAcceptanceIdentity {
  return {
    projectId,
    issueId,
    jobId: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    requirementDigest: "a".repeat(64),
    mergeCommit: "b".repeat(40),
    ...overrides,
  } as HumanAcceptanceIdentity;
}

function input(identityValue = identity()) {
  return {
    identity: identityValue,
    externalIssueId: "linear-issue-1",
    changeRequest: {
      url: "https://github.com/owner/repository/pull/1",
      number: 1,
      headSha: "c".repeat(40),
    },
    humanSummaryDigest: "d".repeat(64),
    mergedAt,
  };
}

async function store() {
  const directory = await temporaryDirectory();
  return {
    directory,
    store: new FileHumanAcceptanceStore(directory, undefined, createFixedClock(now)),
  };
}

describe("FileHumanAcceptanceStore", () => {
  it("creates one private pending generation and lists only active acceptance", async () => {
    const fixture = await store();
    const created = await fixture.store.createPending(input());
    expect(created).toMatchObject({
      ok: true,
      value: { revision: 0, state: "pending", externalIssueId: "linear-issue-1" },
    });
    if (!created.ok) return;
    await expect(fixture.store.load(projectId, created.value.identityDigest)).resolves.toEqual(
      created,
    );
    await expect(fixture.store.listPending(projectId)).resolves.toMatchObject({
      ok: true,
      value: [{ identityDigest: created.value.identityDigest }],
    });

    const mode = (await import("node:fs/promises")).stat(
      join(fixture.directory, `${projectId}.json`),
    );
    expect((await mode).mode & 0o077).toBe(0);
  });

  it("makes identical create and decision receipts idempotent", async () => {
    const fixture = await store();
    const first = await fixture.store.createPending(input());
    const replay = await fixture.store.createPending(input());
    expect(replay).toEqual(first);
    if (!first.ok) return;

    const accepted = await fixture.store.decide(
      identity(),
      first.value.revision,
      "accept",
      "receipt-accept-1",
    );
    expect(accepted).toMatchObject({ ok: true, value: { state: "accepted", revision: 1 } });
    const acceptedReplay = await fixture.store.decide(
      identity(),
      first.value.revision,
      "accept",
      "receipt-accept-1",
    );
    expect(acceptedReplay).toEqual(accepted);
    await expect(fixture.store.listPending(projectId)).resolves.toEqual({ ok: true, value: [] });
  });

  it("allows exactly one winner in a competing decision CAS", async () => {
    const fixture = await store();
    const created = await fixture.store.createPending(input());
    if (!created.ok) throw new Error(created.error.code);
    const outcomes = await Promise.all([
      fixture.store.decide(identity(), created.value.revision, "accept", "receipt-race-a"),
      fixture.store.decide(
        identity(),
        created.value.revision,
        "request_adjustment",
        "receipt-race-b",
      ),
    ]);
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.ok)).toMatchObject([
      { ok: false, error: { code: "conflict" } },
    ]);
  });

  it("reserves, attaches, and completes adjustments without duplicate sequence", async () => {
    const fixture = await store();
    const created = await fixture.store.createPending(input());
    if (!created.ok) throw new Error(created.error.code);
    const requested = await fixture.store.decide(
      identity(),
      created.value.revision,
      "request_adjustment",
      "receipt-adjust-1",
    );
    if (!requested.ok) throw new Error(requested.error.code);
    expect(requested.value).toMatchObject({
      state: "adjustment_pending",
      decisions: [{ sequence: 1, decision: "request_adjustment" }],
      adjustments: [{ sequence: 1, decisionReceiptId: "receipt-adjust-1" }],
    });

    const attached = await fixture.store.attachAdjustment(
      identity(),
      requested.value.revision,
      "receipt-adjust-1",
      "linear-adjustment-1",
    );
    if (!attached.ok) throw new Error(attached.error.code);
    const attachedReplay = await fixture.store.attachAdjustment(
      identity(),
      requested.value.revision,
      "receipt-adjust-1",
      "linear-adjustment-1",
    );
    expect(attachedReplay).toEqual(attached);

    const completed = await fixture.store.completeAdjustment(
      identity(),
      attached.value.revision,
      "linear-adjustment-1",
      "e".repeat(40),
      now,
    );
    expect(completed).toMatchObject({
      ok: true,
      value: { state: "pending", adjustments: [{ completion: { mergeCommit: "e".repeat(40) } }] },
    });
    if (!completed.ok) return;
    const completionReplay = await fixture.store.completeAdjustment(
      identity(),
      attached.value.revision,
      "linear-adjustment-1",
      "e".repeat(40),
      now,
    );
    expect(completionReplay).toEqual(completed);
  });

  it("invalidates one generation and preserves it when a reopened generation is created", async () => {
    const fixture = await store();
    const first = await fixture.store.createPending(input());
    if (!first.ok) throw new Error(first.error.code);
    const invalidated = await fixture.store.invalidate(
      identity(),
      first.value.revision,
      "reopened",
    );
    expect(invalidated).toMatchObject({ ok: true, value: { state: "invalidated" } });
    if (!invalidated.ok) return;
    expect(await fixture.store.invalidate(identity(), first.value.revision, "reopened")).toEqual(
      invalidated,
    );

    const nextIdentity = identity({
      jobId: "job_018f47d2-77a4-7cc1-8ef2-1123456789ab" as HumanAcceptanceIdentity["jobId"],
      mergeCommit: "f".repeat(40),
    });
    const next = await fixture.store.createPending(input(nextIdentity));
    expect(next).toMatchObject({ ok: true, value: { state: "pending" } });
    await expect(fixture.store.listPending(projectId)).resolves.toMatchObject({
      ok: true,
      value: [{ identity: nextIdentity }],
    });
  });

  it("rejects receipt reuse across generations", async () => {
    const fixture = await store();
    const first = await fixture.store.createPending(input());
    if (!first.ok) throw new Error(first.error.code);
    const accepted = await fixture.store.decide(
      identity(),
      first.value.revision,
      "accept",
      "receipt-global-1",
    );
    if (!accepted.ok) throw new Error(accepted.error.code);
    const nextIdentity = identity({
      jobId: "job_018f47d2-77a4-7cc1-8ef2-1123456789ab" as HumanAcceptanceIdentity["jobId"],
      mergeCommit: "f".repeat(40),
    });
    const next = await fixture.store.createPending(input(nextIdentity));
    if (!next.ok) throw new Error(next.error.code);
    await expect(
      fixture.store.decide(nextIdentity, next.value.revision, "accept", "receipt-global-1"),
    ).resolves.toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("fails closed on corrupted state without overwriting it", async () => {
    const fixture = await store();
    const path = join(fixture.directory, `${projectId}.json`);
    await writeFile(path, '{"schemaVersion":999,"secret":"must-stay"}\n', { mode: 0o600 });
    const before = await readFile(path, "utf8");
    await expect(fixture.store.listPending(projectId)).resolves.toMatchObject({
      ok: false,
      error: { code: "invariant_violation" },
    });
    await expect(fixture.store.createPending(input())).resolves.toMatchObject({
      ok: false,
      error: { code: "invariant_violation" },
    });
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("public projection omits private digests, decisions, receipts, and adjustment details", async () => {
    const fixture = await store();
    const created = await fixture.store.createPending(input());
    if (!created.ok) throw new Error(created.error.code);
    const projection = publicHumanAcceptanceProjection(created.value);
    expect(projection).toEqual({
      projectId,
      issueId,
      externalIssueId: "linear-issue-1",
      state: "pending",
      pendingSince: now,
      changeRequestUrl: "https://github.com/owner/repository/pull/1",
      adjustmentCount: 0,
    });
    expect(JSON.stringify(projection)).not.toMatch(/digest|receipt|decision|mergeCommit|headSha/iu);
  });
});
