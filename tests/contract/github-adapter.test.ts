import { describe, expect, it } from "vitest";
import { z } from "zod";

import { GitHubAdapter, type GhJsonTransport } from "../../src/adapters/github/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../src/domain/foundation/index.js";
import { projectSchema, type Project } from "../../src/domain/project/index.js";

const sha = "0123456789abcdef0123456789abcdef01234567";
const nextSha = "fedcba9876543210fedcba9876543210fedcba98";
// C015x decision 2/3: `pull()`'s fixed default for the two new required projected fields --
// distinct from `sha`/`nextSha` (both head SHAs) so a test that asserts on `baseSha` specifically
// can never be confused with a head-SHA fixture value.
const baseCommitSha = "2222222222222222222222222222222222222222";
const timestamp = "2026-08-04T12:34:56Z";

const project: Project = projectSchema.parse({
  schemaVersion: 1,
  id: "project_12345678-1234-1234-9234-123456789abc",
  displayName: "Fixture",
  localRepositoryPath: "/tmp/fixture",
  defaultBranch: "main",
  workManagement: { provider: "linear", containerId: "team", projectId: "project" },
  sourceControl: { provider: "github", repository: "owner/repository" },
});

interface ScriptStep {
  readonly assert?: (arguments_: readonly string[]) => void;
  readonly value?: unknown;
  readonly error?: DomainError["code"];
}

class ScriptedTransport implements GhJsonTransport {
  readonly calls: string[][] = [];
  #steps: ScriptStep[];

  constructor(steps: readonly ScriptStep[]) {
    this.#steps = [...steps];
  }

  requestJson<Output>(
    arguments_: readonly string[],
    schema: z.ZodType<Output>,
  ): Promise<Result<Output, DomainError>> {
    this.calls.push([...arguments_]);
    const step = this.#steps.shift();
    if (step === undefined) return Promise.resolve(err(domainError("external_failure")));
    step.assert?.(arguments_);
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
    url: "https://github.com/owner/repository/pull/42",
    state: "open",
    draft: false,
    baseBranch: "main",
    headBranch: "task/fixture",
    headSha: sha,
    mergeability: "mergeable",
    mergeStateStatus: "clean",
    baseSha: baseCommitSha,
    autoMergeEnabled: false,
    updatedAt: timestamp,
    ...overrides,
  };
}

const reference = { project, changeRequestId: "42" } as const;
const mutation = { idempotencyKey: "attempt-1" } as const;

describe("GitHub source-control adapter", () => {
  it("maps a pull request and aggregates pending, success, and failed checks", async () => {
    const transport = new ScriptedTransport([
      { value: pull({ mergeability: "conflicting" }) },
      {
        value: {
          totalCount: 2,
          checks: [
            { name: "build", status: "completed", conclusion: "success", url: null },
            {
              name: "test",
              status: "completed",
              conclusion: "failure",
              url: "https://github.com/owner/repository/actions/runs/1",
            },
          ],
        },
      },
      { value: { totalCount: 0, checks: [] } },
    ]);
    const adapter = new GitHubAdapter(transport);

    const changeRequest = await adapter.getChangeRequest(reference);
    const failed = await adapter.getCommitChecks({ project }, sha);
    const absent = await adapter.getCommitChecks({ project }, sha);

    expect(changeRequest.ok && changeRequest.value.mergeability).toBe("conflicting");
    expect(changeRequest.ok && changeRequest.value.updatedAt).toBe("2026-08-04T12:34:56.000Z");
    expect(failed.ok && failed.value.aggregate).toBe("failure");
    expect(absent.ok && absent.value.aggregate).toBe("pending");
    transport.expectDone();
  });

  it("creates Draft PRs with read-back and reuses an identical open Draft", async () => {
    const command = {
      project,
      title: "A008 fixture",
      body: "Acceptance evidence",
      baseBranch: "main",
      headBranch: "task/fixture",
    } as const;
    const transport = new ScriptedTransport([
      { value: [] },
      {
        assert: (arguments_) => {
          expect(arguments_).toContain("draft=true");
          expect(arguments_).toContain("POST");
        },
        value: pull({ draft: true }),
      },
      { value: pull({ draft: true }) },
      // C015z decision (Q1): the list (idempotent-reuse) call now projects only the narrow
      // `{number,title,body,draft}` shape -- no `mergeable`/`mergeable_state`, matching GitHub's
      // real `pull-request-simple` list response (see
      // tests/contract/github-adapter-draft-candidate-projection.test.ts for the real-jq proof).
      {
        value: [{ number: 42, title: command.title, body: command.body, draft: true }],
      },
      // C015z decision (Q1): once a candidate matches, `createDraftChangeRequest` always re-fetches
      // the full detail snapshot by PR number before returning -- never hands back the narrow list
      // shape disguised as a `ChangeRequestSnapshot`.
      { value: pull({ draft: true }) },
    ]);
    const adapter = new GitHubAdapter(transport);

    const created = await adapter.createDraftChangeRequest(command, mutation);
    const reused = await adapter.createDraftChangeRequest(command, mutation);

    expect(created.ok && created.value.draft).toBe(true);
    expect(reused.ok && reused.value.number).toBe(42);
    expect(reused.ok && reused.value.mergeStateStatus).toBe("clean");
    expect(transport.calls.filter((call) => call.includes("POST"))).toHaveLength(1);
    transport.expectDone();
  });

  it("sets failure review status only when exact Head SHA read-back matches", async () => {
    const transport = new ScriptedTransport([
      {
        assert: (arguments_) => {
          expect(arguments_[1]).toContain(`/statuses/${sha}`);
        },
        value: { context: "agent-team/review", state: "failure" },
      },
      {
        value: {
          sha,
          statuses: [
            {
              context: "agent-team/review",
              state: "failure",
              description: "Reviewer rejected this SHA",
              targetUrl: null,
            },
          ],
        },
      },
    ]);
    const result = await new GitHubAdapter(transport).setCommitStatus(
      {
        project,
        headSha: sha,
        context: "agent-team/review",
        state: "failure",
        description: "Reviewer rejected this SHA",
      },
      mutation,
    );

    expect(result).toEqual({ ok: true, value: undefined });
    transport.expectDone();
  });

  it("reads commit statuses as an exact-SHA source-control snapshot", async () => {
    const transport = new ScriptedTransport([
      {
        value: {
          sha,
          statuses: [
            {
              context: "agent-team/review",
              state: "success",
              description: "Reviewer accepted this SHA",
              targetUrl: "https://example.invalid/review/42",
            },
          ],
        },
      },
    ]);
    const result = await new GitHubAdapter(transport).getCommitStatuses({ project }, sha);

    expect(result).toEqual({
      ok: true,
      value: {
        headSha: sha,
        statuses: [
          {
            context: "agent-team/review",
            state: "success",
            description: "Reviewer accepted this SHA",
            targetUrl: "https://example.invalid/review/42",
          },
        ],
      },
    });
    transport.expectDone();
  });

  it("rejects a commit-status read-back for a different SHA", async () => {
    const transport = new ScriptedTransport([{ value: { sha: nextSha, statuses: [] } }]);
    const result = await new GitHubAdapter(transport).getCommitStatuses({ project }, sha);

    expect(result.ok ? "ok" : result.error.code).toBe("conflict");
    transport.expectDone();
  });

  it("marks a Draft ready only for the exact Head SHA and confirms read-back", async () => {
    const transport = new ScriptedTransport([
      { value: pull({ draft: true }) },
      {
        assert: (arguments_) => {
          expect(arguments_).toContain("graphql");
          expect(arguments_.join(" ")).toContain("markPullRequestReadyForReview");
        },
        value: {
          data: {
            markPullRequestReadyForReview: {
              pullRequest: { id: "PR_node_fixture", isDraft: false },
            },
          },
        },
      },
      { value: pull({ draft: false }) },
    ]);
    const result = await new GitHubAdapter(transport).markChangeRequestReady(
      reference,
      sha,
      mutation,
    );

    expect(result.ok && result.value.draft).toBe(false);
    expect(result.ok && result.value.headSha).toBe(sha);
    transport.expectDone();
  });

  it("does not mark a Draft ready when the Head SHA changed", async () => {
    const transport = new ScriptedTransport([{ value: pull({ draft: true }) }]);
    const result = await new GitHubAdapter(transport).markChangeRequestReady(
      reference,
      "b".repeat(40),
      mutation,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("conflict");
    transport.expectDone();
  });

  it("detects a Head race after marking the Draft ready", async () => {
    const transport = new ScriptedTransport([
      { value: pull({ draft: true }) },
      {
        value: {
          data: {
            markPullRequestReadyForReview: {
              pullRequest: { id: "PR_node_fixture", isDraft: false },
            },
          },
        },
      },
      { value: pull({ draft: false, headSha: nextSha }) },
    ]);
    const result = await new GitHubAdapter(transport).markChangeRequestReady(
      reference,
      sha,
      mutation,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("conflict");
    transport.expectDone();
  });

  it("binds review comments to Head SHA and deduplicates retries with a hashed marker", async () => {
    let storedComment = "";
    const receipt = {
      id: "100",
      url: "https://github.com/owner/repository/pull/42#issuecomment-100",
      createdAt: timestamp,
      body: "",
    };
    const transport = new ScriptedTransport([
      { value: pull() },
      { value: { count: 0, matches: [] } },
      {
        assert: (arguments_) => {
          storedComment =
            arguments_.find((argument) => argument.startsWith("body="))?.slice(5) ?? "";
          expect(storedComment).toContain("Review passed");
          expect(storedComment).toMatch(/agent-team:review_evidence:[0-9a-f]{64}/u);
        },
        get value() {
          return { ...receipt, body: storedComment };
        },
      },
      {
        get value() {
          return { count: 1, matches: [{ ...receipt, body: storedComment }] };
        },
      },
      { value: pull() },
      { value: pull() },
      {
        get value() {
          return { count: 1, matches: [{ ...receipt, body: storedComment }] };
        },
      },
    ]);
    const adapter = new GitHubAdapter(transport);
    const command = {
      changeRequest: reference,
      expectedHeadSha: sha,
      kind: "review_evidence" as const,
      body: "Review passed",
    };

    const created = await adapter.appendChangeRequestComment(command, mutation);
    const reused = await adapter.appendChangeRequestComment(command, mutation);

    expect(created.ok && created.value.id).toBe("100");
    expect(reused).toEqual(created);
    expect(transport.calls.filter((call) => call.includes("POST"))).toHaveLength(1);
    transport.expectDone();
  });

  it("enables squash auto-merge only for the expected non-conflicting ready Head", async () => {
    const successTransport = new ScriptedTransport([
      { value: pull() },
      {
        assert: (arguments_) => {
          expect(arguments_).toContain("graphql");
          expect(arguments_).toContain(`expectedHeadOid=${sha}`);
          expect(arguments_).toContain("mergeMethod=SQUASH");
        },
        value: {
          data: { enablePullRequestAutoMerge: { pullRequest: { id: "PR_node_fixture" } } },
        },
      },
      { value: pull({ autoMergeEnabled: true }) },
    ]);
    const enabled = await new GitHubAdapter(successTransport).enableAutoMerge(
      reference,
      sha,
      mutation,
    );
    expect(enabled.ok && enabled.value.autoMergeEnabled).toBe(true);
    successTransport.expectDone();

    const changedHead = new ScriptedTransport([{ value: pull({ headSha: nextSha }) }]);
    const stale = await new GitHubAdapter(changedHead).enableAutoMerge(reference, sha, mutation);
    expect(stale.ok ? "ok" : stale.error.code).toBe("conflict");
    changedHead.expectDone();

    const conflict = new ScriptedTransport([{ value: pull({ mergeability: "conflicting" }) }]);
    const conflicting = await new GitHubAdapter(conflict).enableAutoMerge(reference, sha, mutation);
    expect(conflicting.ok ? "ok" : conflicting.error.code).toBe("conflict");
    conflict.expectDone();
  });

  it("O009d: squash-merges directly via REST PUT .../merge with an atomic sha guard, idempotent on already-merged, conflict on stale head or closed PR", async () => {
    const successTransport = new ScriptedTransport([
      { value: pull() },
      {
        assert: (arguments_) => {
          expect(arguments_).toContain("PUT");
          expect(arguments_.some((argument) => argument.includes("/pulls/42/merge"))).toBe(true);
          expect(arguments_).toContain("merge_method=squash");
          expect(arguments_).toContain(`sha=${sha}`);
        },
        value: { merged: true },
      },
      { value: pull({ state: "merged" }) },
    ]);
    const merged = await new GitHubAdapter(successTransport).squashMergeChangeRequest(
      reference,
      sha,
      mutation,
    );
    expect(merged.ok && merged.value.state).toBe("merged");
    successTransport.expectDone();

    // Idempotent: already-merged never even issues the PUT.
    const alreadyMergedTransport = new ScriptedTransport([{ value: pull({ state: "merged" }) }]);
    const alreadyMerged = await new GitHubAdapter(alreadyMergedTransport).squashMergeChangeRequest(
      reference,
      sha,
      mutation,
    );
    expect(alreadyMerged.ok && alreadyMerged.value.state).toBe("merged");
    alreadyMergedTransport.expectDone();

    // Stale head: conflict, no PUT attempted.
    const staleHeadTransport = new ScriptedTransport([{ value: pull({ headSha: nextSha }) }]);
    const staleHead = await new GitHubAdapter(staleHeadTransport).squashMergeChangeRequest(
      reference,
      sha,
      mutation,
    );
    expect(staleHead.ok ? "ok" : staleHead.error.code).toBe("conflict");
    staleHeadTransport.expectDone();

    // Closed (never merged): conflict, no PUT attempted.
    const closedTransport = new ScriptedTransport([{ value: pull({ state: "closed" }) }]);
    const closed = await new GitHubAdapter(closedTransport).squashMergeChangeRequest(
      reference,
      sha,
      mutation,
    );
    expect(closed.ok ? "ok" : closed.error.code).toBe("conflict");
    closedTransport.expectDone();

    // GitHub's own response says the merge did not actually happen: fails closed.
    const notMergedTransport = new ScriptedTransport([
      { value: pull() },
      { value: { merged: false } },
    ]);
    const notMerged = await new GitHubAdapter(notMergedTransport).squashMergeChangeRequest(
      reference,
      sha,
      mutation,
    );
    expect(notMerged.ok).toBe(false);
    notMergedTransport.expectDone();
  });

  it("closes an open PR with read-back and never closes a merged PR", async () => {
    const transport = new ScriptedTransport([
      { value: pull() },
      { value: pull({ state: "closed" }) },
      { value: pull({ state: "closed" }) },
      { value: pull({ state: "merged" }) },
    ]);
    const adapter = new GitHubAdapter(transport);

    const closed = await adapter.closeChangeRequest(reference, mutation);
    const merged = await adapter.closeChangeRequest(reference, mutation);

    expect(closed.ok && closed.value.state).toBe("closed");
    expect(merged.ok ? "ok" : merged.error.code).toBe("conflict");
    transport.expectDone();
  });

  it("fails closed for wrong providers, stale comment Heads, bad SHAs, and empty mutation keys", async () => {
    const linearProject = {
      ...project,
      sourceControl: { ...project.sourceControl, provider: "gitlab" },
    };
    const transport = new ScriptedTransport([{ value: pull({ headSha: nextSha }) }]);
    const adapter = new GitHubAdapter(transport);

    const wrongProvider = await adapter.getChangeRequest({
      project: linearProject,
      changeRequestId: "42",
    });
    const staleComment = await adapter.appendChangeRequestComment(
      {
        changeRequest: reference,
        expectedHeadSha: sha,
        kind: "automation",
        body: "Stale",
      },
      mutation,
    );
    const badSha = await adapter.getCommitChecks({ project }, "not-a-sha");
    const emptyKey = await adapter.closeChangeRequest(reference, { idempotencyKey: " " });

    expect(wrongProvider.ok ? "ok" : wrongProvider.error.code).toBe("external_failure");
    expect(staleComment.ok ? "ok" : staleComment.error.code).toBe("conflict");
    expect(badSha.ok ? "ok" : badSha.error.code).toBe("external_failure");
    expect(emptyKey.ok ? "ok" : emptyKey.error.code).toBe("external_failure");
    transport.expectDone();
  });

  it("C015x decision 1 step ①: reads GitHub's own live default_branch, adapter-only (never validates against project config itself)", async () => {
    const transport = new ScriptedTransport([
      {
        assert: (arguments_) => {
          expect(arguments_).toContain("api");
          expect(arguments_.some((argument) => argument.includes("repos/owner/repository"))).toBe(
            true,
          );
          expect(arguments_).not.toContain("PUT");
          expect(arguments_).not.toContain("POST");
        },
        value: { defaultBranch: "main" },
      },
    ]);
    const metadata = await new GitHubAdapter(transport).getRepositoryMetadata({ project });

    expect(metadata).toEqual({ ok: true, value: { defaultBranch: "main" } });
    transport.expectDone();
  });

  it("fails closed for a non-GitHub provider before ever calling the transport", async () => {
    const gitlabProject = {
      ...project,
      sourceControl: { ...project.sourceControl, provider: "gitlab" },
    };
    const transport = new ScriptedTransport([]);
    const result = await new GitHubAdapter(transport).getRepositoryMetadata({
      project: gitlabProject,
    });

    expect(result.ok ? "ok" : result.error.code).toBe("external_failure");
    transport.expectDone();
  });
});
