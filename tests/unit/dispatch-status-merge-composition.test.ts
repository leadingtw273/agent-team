/**
 * C015c item 4 unit tests: `buildStatusMergePipelines`/`buildMergeGateSourceControl`
 * (src/cli/dispatch/status-merge-composition.ts). Two concerns:
 *
 * 1. The fail-closed GitHub-authentication-first prerequisite chain (mirroring
 *    dispatch-implementer-composition.test.ts's own convention).
 * 2. `buildMergeGateSourceControl`'s O009d direct-merge fallback -- the same decision logic as
 *    `createGitHubSquashMergePort` (tests/unit/registration-setup-squash-merge-fallback.test.ts),
 *    built fresh here against `SourceControlPort.enableAutoMerge`'s own return shape. Uses the
 *    same "drive a real `GitHubAdapter` through a scripted `GhJsonTransport`" technique as that
 *    file, so `GitHubAdapter.enableAutoMerge`/`squashMergeChangeRequest`'s own internal pre-check/
 *    mutation/readback call counts are exercised exactly as real GitHub would.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  buildStatusMergePipelines,
  buildMergeGateSourceControl,
} from "../../src/cli/dispatch/status-merge-composition.js";
import { GitHubAdapter, type GhJsonTransport } from "../../src/adapters/github/index.js";
import { FileAutoMergePauseStore } from "../../src/adapters/dispatch/auto-merge-pause-store.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../src/domain/foundation/index.js";

/** E116cap: `buildStatusMergePipelines` now always requires an `autoMergePauseStore` -- these tests
 * never exercise the gate's own pause check (that lives in tests/unit/merge-gate.test.ts and
 * tests/unit/dispatch-resume-composition.test.ts), so a throwaway, never-touched-on-disk store
 * pointed at a fixed absolute path is enough here. */
function autoMergePauseStore(): FileAutoMergePauseStore {
  return new FileAutoMergePauseStore("/tmp/agent-team-status-merge-composition-test-unused");
}

const sha = "0123456789abcdef0123456789abcdef01234567";
const otherSha = "fedcba9876543210fedcba9876543210fedcba98";
const timestamp = "2026-08-07T00:00:00Z";
const attemptedAt = "2026-08-07T00:00:00.000Z" as never;
const fixedClock = { now: () => attemptedAt };
const reference = Object.freeze({
  project: {
    id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab" as never,
    displayName: "Sandbox",
    localRepositoryPath: "/tmp/sandbox",
    defaultBranch: "main",
    workManagement: { provider: "linear", containerId: "team-1", projectId: "proj-1" },
    sourceControl: { provider: "github", repository: "owner/sandbox" },
  } as never,
  changeRequestId: "42",
});
const mutation = Object.freeze({ idempotencyKey: "merge-1" });
const externalIssueId = "LEA-1";

function workManagement(workStatus: "in_progress" | "in_review" | "canceled" = "in_review") {
  return {
    getIssue: () =>
      Promise.resolve(
        ok({
          issue: {
            schemaVersion: 1,
            id: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab",
            projectId: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
            externalId: externalIssueId,
            title: "Merge safely",
          },
          workStatus,
          updatedAt: timestamp,
          revision: timestamp,
        } as never),
      ),
  };
}

interface ScriptStep {
  readonly value?: unknown;
  readonly error?: DomainError["code"];
}

class ScriptedTransport implements GhJsonTransport {
  #steps: ScriptStep[];
  constructor(steps: readonly ScriptStep[]) {
    this.#steps = [...steps];
  }

  requestJson<Output>(
    _arguments_: readonly string[],
    schema: z.ZodType<Output>,
  ): Promise<Result<Output, DomainError>> {
    const step = this.#steps.shift();
    if (step === undefined) return Promise.resolve(err(domainError("external_failure")));
    if (step.error !== undefined) return Promise.resolve(err(domainError(step.error)));
    const parsed = schema.safeParse(step.value);
    return Promise.resolve(parsed.success ? ok(parsed.data) : err(domainError("external_failure")));
  }

  expectDone(): void {
    expect(this.#steps).toEqual([]);
  }
}

function pull(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    id: "PR_node_fixture",
    number: 42,
    url: "https://github.com/owner/sandbox/pull/42",
    state: "open",
    draft: false,
    baseBranch: "main",
    headBranch: "task/fixture",
    headSha: sha,
    mergeability: "mergeable",
    mergeStateStatus: "clean",
    baseSha: "2".repeat(40),
    autoMergeEnabled: false,
    updatedAt: timestamp,
    ...overrides,
  };
}

describe("buildStatusMergePipelines", () => {
  it("blocks with github_authentication_unavailable before constructing any port", async () => {
    const result = await buildStatusMergePipelines({
      autoMergePauseStore: autoMergePauseStore(),
      workManagement: workManagement(),
      githubTransport: {
        requestJson: () => Promise.reject(new Error("must never be called")),
        inspectAuthentication: () => Promise.resolve(err(domainError("permission_denied"))),
      },
    });
    expect(result).toEqual({ state: "blocked", reason: "github_authentication_unavailable" });
  });

  it("reaches state:ready with both coordinators constructed once GitHub auth succeeds", async () => {
    const result = await buildStatusMergePipelines({
      autoMergePauseStore: autoMergePauseStore(),
      workManagement: workManagement(),
      githubTransport: {
        requestJson: () => Promise.reject(new Error("unused in this test")),
        inspectAuthentication: () =>
          Promise.resolve(
            ok({ active: true as const, host: "github.com", accountFingerprint: "a".repeat(64) }),
          ),
      },
    });
    expect(result.state).toBe("ready");
    if (result.state !== "ready") return;
    expect(result.value.reviewStatus).toBeDefined();
    expect(result.value.autoMergeGate).toBeDefined();
  });
});

describe("buildMergeGateSourceControl: O009d direct-merge fallback", () => {
  it("enforce mode re-reads exact Linear status before the first GitHub mutation", async () => {
    const transport = new ScriptedTransport([]);
    const sourceControl = buildMergeGateSourceControl(
      new GitHubAdapter(transport),
      workManagement("in_progress"),
      fixedClock,
    );

    const result = await sourceControl.enableAutoMerge(
      reference,
      sha,
      mutation,
      externalIssueId,
      "in_review",
    );

    expect(result).toMatchObject({
      ok: true,
      value: { outcome: "mutation_failed", stage: "authorization", mutations: [] },
    });
    transport.expectDone();
  });

  it("does not invent a mutation receipt when auto-merge was already enabled", async () => {
    const transport = new ScriptedTransport([{ value: pull({ autoMergeEnabled: true }) }]);
    const sourceControl = buildMergeGateSourceControl(
      new GitHubAdapter(transport),
      workManagement(),
      fixedClock,
    );

    const result = await sourceControl.enableAutoMerge(reference, sha, mutation, externalIssueId);

    expect(result).toMatchObject({
      ok: true,
      value: { outcome: "enabled", mutations: [] },
    });
    transport.expectDone();
  });

  it("leaves the auto-merge-enabled success path unaffected -- fallback never triggered", async () => {
    const transport = new ScriptedTransport([
      { value: pull() }, // enableAutoMerge's own internal pre-check
      {
        value: { data: { enablePullRequestAutoMerge: { pullRequest: { id: "PR_node_fixture" } } } },
      },
      { value: pull({ autoMergeEnabled: true }) }, // enableAutoMerge's own readback
    ]);
    const sourceControl = buildMergeGateSourceControl(
      new GitHubAdapter(transport),
      workManagement(),
    );

    const result = await sourceControl.enableAutoMerge(reference, sha, mutation, externalIssueId);

    expect(result).toMatchObject({
      ok: true,
      value: {
        outcome: "enabled",
        changeRequest: { autoMergeEnabled: true },
        mutations: [
          {
            kind: "enable_auto_merge",
            idempotencyKey: "merge-1",
            outcome: "confirmed_enabled",
          },
        ],
      },
    });
    transport.expectDone();
  });

  it("preserves the real auto-merge attempt when the mutation was accepted but its read-back races to merged", async () => {
    const transport = new ScriptedTransport([
      { value: pull() },
      {
        value: { data: { enablePullRequestAutoMerge: { pullRequest: { id: "PR_node_fixture" } } } },
      },
      { error: "external_failure" },
      { value: pull({ state: "merged", mergeCommitSha: otherSha, mergedAt: timestamp }) },
    ]);
    const sourceControl = buildMergeGateSourceControl(
      new GitHubAdapter(transport),
      workManagement(),
      fixedClock,
    );

    const result = await sourceControl.enableAutoMerge(reference, sha, mutation, externalIssueId);

    expect(result).toEqual(
      ok({
        outcome: "merged_directly",
        headSha: sha,
        mutations: [
          {
            kind: "enable_auto_merge",
            idempotencyKey: "merge-1",
            attemptedAt,
            outcome: "request_accepted_readback_unknown",
          },
        ],
      }),
    );
    transport.expectDone();
  });

  it("falls back to a direct squash merge when enableAutoMerge fails and the PR is genuinely safe to merge directly", async () => {
    const transport = new ScriptedTransport([
      { value: pull() }, // enableAutoMerge's own internal pre-check
      { error: "external_failure" }, // enableAutoMerge's GraphQL call fails (clean-status case)
      { value: pull() }, // our fallback re-read: still open/mergeable/matching head
      { value: pull() }, // squashMergeChangeRequest's own internal pre-check
      { value: { merged: true } }, // direct PUT merge succeeds
      {
        value: pull({ state: "merged", mergeCommitSha: otherSha, mergedAt: timestamp }),
      }, // squashMergeChangeRequest's own readback
    ]);
    const sourceControl = buildMergeGateSourceControl(
      new GitHubAdapter(transport),
      workManagement(),
    );

    const result = await sourceControl.enableAutoMerge(reference, sha, mutation, externalIssueId);

    expect(result).toMatchObject({
      ok: true,
      value: {
        outcome: "merged_directly",
        headSha: sha,
        mutations: [
          { kind: "enable_auto_merge", idempotencyKey: "merge-1", outcome: "outcome_unknown" },
          { kind: "direct_squash", idempotencyKey: "merge-1", outcome: "merged_directly" },
        ],
      },
    });
    transport.expectDone();
  });

  it("preserves direct-squash success when REST confirmed merged but the final read-back failed", async () => {
    const transport = new ScriptedTransport([
      { value: pull() },
      { error: "external_failure" },
      { value: pull() },
      { value: pull() },
      { value: { merged: true } },
      { error: "external_failure" },
    ]);
    const sourceControl = buildMergeGateSourceControl(
      new GitHubAdapter(transport),
      workManagement(),
      fixedClock,
    );

    const result = await sourceControl.enableAutoMerge(reference, sha, mutation, externalIssueId);

    expect(result).toEqual(
      ok({
        outcome: "merged_directly",
        headSha: sha,
        mutations: [
          {
            kind: "enable_auto_merge",
            idempotencyKey: "merge-1",
            attemptedAt,
            outcome: "outcome_unknown",
          },
          {
            kind: "direct_squash",
            idempotencyKey: "merge-1",
            attemptedAt,
            outcome: "merged_directly",
          },
        ],
      }),
    );
    transport.expectDone();
  });

  it("returns the original enableAutoMerge error, without attempting a direct merge, when the fallback re-read shows the head moved", async () => {
    const transport = new ScriptedTransport([
      { value: pull() },
      { error: "external_failure" },
      { value: pull({ headSha: otherSha }) },
    ]);
    const sourceControl = buildMergeGateSourceControl(
      new GitHubAdapter(transport),
      workManagement(),
    );

    const result = await sourceControl.enableAutoMerge(reference, sha, mutation, externalIssueId);

    expect(result).toMatchObject({
      ok: true,
      value: {
        outcome: "mutation_failed",
        stage: "auto_merge",
        error: { code: "external_failure" },
        mutations: [{ kind: "enable_auto_merge", outcome: "outcome_unknown" }],
      },
    });
    transport.expectDone();
  });

  it("returns the original enableAutoMerge error -- not a new fallback error -- when the direct-merge attempt itself also fails", async () => {
    const transport = new ScriptedTransport([
      { value: pull() },
      { error: "external_failure" },
      { value: pull() },
      { value: pull() },
      { error: "conflict" },
    ]);
    const sourceControl = buildMergeGateSourceControl(
      new GitHubAdapter(transport),
      workManagement(),
    );

    const result = await sourceControl.enableAutoMerge(reference, sha, mutation, externalIssueId);

    expect(result).toMatchObject({
      ok: true,
      value: {
        outcome: "mutation_failed",
        stage: "auto_merge",
        error: { code: "external_failure" },
        mutations: [
          { kind: "enable_auto_merge", outcome: "outcome_unknown" },
          { kind: "direct_squash", outcome: "outcome_unknown" },
        ],
      },
    });
    transport.expectDone();
  });

  it("C035: re-reads Linear and skips direct squash when cancellation arrives after auto-merge fails", async () => {
    const transport = new ScriptedTransport([
      { value: pull() },
      { error: "external_failure" },
      { value: pull() },
    ]);
    const sourceControl = buildMergeGateSourceControl(
      new GitHubAdapter(transport),
      workManagement("canceled"),
    );

    const result = await sourceControl.enableAutoMerge(reference, sha, mutation, externalIssueId);

    expect(result).toMatchObject({
      ok: true,
      value: { outcome: "authorization_revoked", changeRequest: { state: "open" } },
    });
    transport.expectDone();
  });

  it("C035: fails closed without direct squash when the second Linear read is unavailable", async () => {
    const transport = new ScriptedTransport([
      { value: pull() },
      { error: "external_failure" },
      { value: pull() },
    ]);
    const sourceControl = buildMergeGateSourceControl(new GitHubAdapter(transport), {
      getIssue: () => Promise.resolve(err(domainError("unavailable"))),
    });

    const result = await sourceControl.enableAutoMerge(reference, sha, mutation, externalIssueId);

    expect(result).toMatchObject({
      ok: true,
      value: {
        outcome: "mutation_failed",
        stage: "authorization",
        error: { code: "unavailable" },
        mutations: [{ kind: "enable_auto_merge", outcome: "outcome_unknown" }],
      },
    });
    transport.expectDone();
  });
});
