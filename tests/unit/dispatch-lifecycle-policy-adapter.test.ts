/**
 * C015c item 5 unit test: `NoOpAutoMergePauseAdapter`
 * (src/cli/dispatch/lifecycle-policy-adapter.ts) -- the disclosed, deliberately no-op
 * `LifecyclePolicyPort.pauseAutoMerge` implementation (see that file's header for why: no adapter
 * anywhere exposes a real "disable auto-merge" host capability).
 *
 * C015v decision 1/4 (supersedes the C015c-era assertions this file used to make): the adapter now
 * reports `{state:"not_applicable", ...}` for its one real call site -- an already-merged change
 * request has structurally nothing left to pause -- instead of the old `{durability:"unknown"}`,
 * which forced `LifecyclePipeline` to fail closed on *every* out-of-process merge, including this
 * overwhelming common case (a real E101 job deadlocked on exactly this before C015v). The second
 * test below is the **production-composition seam test** codex's review named as the exact gap
 * that let this deadlock ship undetected: it drives the real `buildLifecyclePipeline` factory
 * (src/cli/dispatch/lifecycle-composition.ts) -- not `LifecyclePipeline` with hand-picked ports,
 * and not a mocked `LifecyclePolicyPort` -- with the real `NoOpAutoMergePauseAdapter`, the real
 * `LinearWorkManagementAdapter`, and the real `JobProgressLifecycleCancellationAdapter` all wired
 * together exactly as production does; only the outermost transport-level boundaries
 * (`GhJsonTransport`, `LinearWorkManagementReadModel`/`LinearWorkManagementMutationClient`, and the
 * job-progress store's own temp-directory root) are faked.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { NoOpAutoMergePauseAdapter } from "../../src/cli/dispatch/lifecycle-policy-adapter.js";
import { buildLifecyclePipeline } from "../../src/cli/dispatch/lifecycle-composition.js";
import type { LinearWorkManagementReadModel } from "../../src/cli/dispatch/work-management-adapter.js";
import type { LinearWorkManagementMutationClient } from "../../src/cli/dispatch/work-management-adapter.js";
import { FileJobProgressStore } from "../../src/adapters/dispatch/job-progress-store.js";
import type { GhJsonTransport } from "../../src/adapters/github/index.js";
import { LifecyclePipeline } from "../../src/application/pipelines/index.js";
import { LeaseCoordinator } from "../../src/application/leases/index.js";
import { InMemoryLeaseRepository } from "../../src/cli/dispatch/ephemeral-ports.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../src/domain/foundation/index.js";
import { projectSchema, type Project } from "../../src/domain/project/index.js";

function project(): Project {
  return projectSchema.parse({
    schemaVersion: 1,
    id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    displayName: "Sandbox",
    localRepositoryPath: "/tmp/sandbox",
    defaultBranch: "main",
    workManagement: { provider: "linear", containerId: "team-1", projectId: "proj-1" },
    sourceControl: { provider: "github", repository: "owner/sandbox" },
  });
}

describe("NoOpAutoMergePauseAdapter", () => {
  it('reports state:"not_applicable" (never a false "confirmed" pause) -- the only honest answer for its one real call site', async () => {
    const adapter = new NoOpAutoMergePauseAdapter();

    const result = await adapter.pauseAutoMerge(
      {
        project: project(),
        reason: "out_of_process_merge",
        changeRequestId: "42",
        mergedHeadSha: "a".repeat(40),
      },
      { idempotencyKey: "pause-1" },
    );
    expect(result).toEqual({
      ok: true,
      value: {
        state: "not_applicable",
        reason: "change_request_already_merged",
        observedState: "merged",
      },
    });
  });
});

/** Pops one scripted step per `requestJson` call, regardless of arguments -- same technique as
 * tests/unit/squash-merge-fallback-parity.test.ts's own `ScriptedTransport`. */
class ScriptedTransport implements GhJsonTransport {
  #steps: Readonly<{ value?: unknown; error?: DomainError["code"] }>[];
  constructor(steps: readonly Readonly<{ value?: unknown; error?: DomainError["code"] }>[]) {
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
    number: 7,
    url: "https://github.com/owner/sandbox/pull/7",
    state: "merged",
    draft: false,
    baseBranch: "main",
    headBranch: "agent-team/job-1",
    headSha: "a".repeat(40),
    mergeability: "mergeable",
    mergeStateStatus: "clean",
    baseSha: "2".repeat(40),
    autoMergeEnabled: false,
    updatedAt: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryAgentTeamHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-lifecycle-seam-"));
  temporaryDirectories.push(directory);
  return directory;
}

function temporaryProgressStore(agentTeamHome: string): FileJobProgressStore {
  return new FileJobProgressStore(join(agentTeamHome, "state", "job-progress"));
}

describe("buildLifecyclePipeline production-composition seam (C015v decision 4)", () => {
  it("an out-of-process merge converges to completed end to end through the real production wiring -- GitHubAdapter + LinearWorkManagementAdapter + the real NoOpAutoMergePauseAdapter, not a mocked LifecyclePolicyPort", async () => {
    const headSha = "a".repeat(40);
    const githubTransport = new ScriptedTransport([{ value: pull({ headSha }) }]);
    const calls: string[] = [];
    const readModel: LinearWorkManagementReadModel = {
      readContext: () => Promise.resolve(ok({} as never)),
      readIssue: () => {
        calls.push("readIssue");
        return Promise.resolve(
          ok({
            id: "linear-issue-1",
            identifier: "SBX-1",
            title: "Ship the thing",
            updatedAt: "2026-08-08T00:00:00.000Z" as never,
            teamId: "team-1",
            projectId: "proj-1",
            workStatus: "in_review" as const,
            otherLabelIds: [],
            relations: [],
            comments: [],
          }),
        );
      },
    };
    let commentBody = "";
    const mutationClient: LinearWorkManagementMutationClient = {
      observeGithubMerge: () => {
        calls.push("observeGithubMerge");
        return Promise.resolve(
          ok({
            id: "linear-issue-1",
            identifier: "SBX-1",
            title: "Ship the thing",
            updatedAt: "2026-08-08T00:05:00.000Z" as never,
            teamId: "team-1",
            projectId: "proj-1",
            workStatus: "completed" as const,
            otherLabelIds: [],
            relations: [],
            comments: [],
          }),
        );
      },
      setAgentCondition: () => Promise.reject(new Error("must never be called: merge path only")),
      appendComment: (_context, _issueId, body) => {
        calls.push("appendComment");
        commentBody = body;
        return Promise.resolve(
          ok({
            id: "comment-1",
            body,
            createdAt: "2026-08-08T00:05:00.000Z" as never,
            reused: false,
          }),
        );
      },
    };
    const agentTeamHome = await temporaryAgentTeamHome();
    const progress = temporaryProgressStore(agentTeamHome);

    const pipeline = buildLifecyclePipeline({
      readModel: readModel as never,
      mutationClient,
      teamId: "team-1",
      linearProjectId: "proj-1",
      progress,
      agentTeamHome,
      leases: new LeaseCoordinator(new InMemoryLeaseRepository()),
      githubTransport,
    });

    // No `mergeAuthorizationHeadSha` -> out-of-process merge -> the only branch that ever calls
    // `pauseAutoMerge`, now the real `NoOpAutoMergePauseAdapter`.
    const outcome = await pipeline.run({
      project: project(),
      externalIssueId: "linear-issue-1",
      changeRequestId: "7",
      idempotencyKeyPrefix: "seam-test-1",
    });

    githubTransport.expectDone();
    expect(outcome).toEqual({
      state: "completed",
      merge: "out_of_process",
      headSha,
      autoMergeDisposition: "not_applicable",
    });
    expect(calls).toEqual(["readIssue", "observeGithubMerge", "appendComment"]);
    expect(commentBody).toContain("該 PR 已合併，無 pending auto-merge 可取消");
    expect(commentBody).not.toContain("已暫停此專案新的 Auto-merge");
  });
});

describe("LifecyclePipeline + real NoOpAutoMergePauseAdapter (hand-assembled ports, narrower than the seam test above)", () => {
  it('completes an out-of-process merge (never a false "completed" before this, never a stuck "failed" after it)', async () => {
    const headSha = "a".repeat(40);
    const calls: string[] = [];
    const pipeline = new LifecyclePipeline({
      sourceControl: {
        getChangeRequest: () =>
          Promise.resolve(
            ok({
              id: "PR_fixture",
              number: 1,
              url: "https://example.test/pull/1",
              state: "merged" as const,
              draft: false,
              baseBranch: "main",
              headBranch: "agent-team/job-1",
              headSha,
              mergeability: "mergeable" as const,
              autoMergeEnabled: false,
              updatedAt: "2026-08-07T00:00:00.000Z" as never,
            }),
          ),
        closeChangeRequest: () => Promise.reject(new Error("must never be called")),
      },
      workManagement: {
        getIssue: () =>
          Promise.resolve(
            ok({
              issue: {
                schemaVersion: 1,
                id: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab" as never,
                projectId: project().id,
                externalId: "linear-issue-1",
                title: "Ship it",
              },
              workStatus: "in_review" as const,
              updatedAt: "2026-08-07T00:00:00.000Z" as never,
              revision: "1",
            }),
          ),
        setWorkStatus: () => {
          calls.push("setWorkStatus");
          return Promise.resolve(
            ok({
              issue: {
                schemaVersion: 1,
                id: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab" as never,
                projectId: project().id,
                externalId: "linear-issue-1",
                title: "Ship it",
              },
              workStatus: "completed" as const,
              updatedAt: "2026-08-07T00:05:00.000Z" as never,
              revision: "2",
            }),
          );
        },
        setAgentCondition: () => Promise.reject(new Error("must never be called")),
        appendComment: (_reference, body: string) => {
          calls.push(`appendComment:${body}`);
          return Promise.resolve(
            ok({ id: "comment-1", body, createdAt: "2026-08-07T00:05:00.000Z" as never }),
          );
        },
      },
      policy: new NoOpAutoMergePauseAdapter(),
      cancellation: {
        prepare: () => Promise.reject(new Error("must never be called")),
      },
      leaseRelease: {
        release: () => Promise.reject(new Error("must never be called: merge path only")),
      },
    });

    const outcome = await pipeline.run({
      project: project(),
      externalIssueId: "linear-issue-1",
      changeRequestId: "1",
      idempotencyKeyPrefix: "test-1",
    });

    expect(outcome).toEqual({
      state: "completed",
      merge: "out_of_process",
      headSha,
      autoMergeDisposition: "not_applicable",
    });
    expect(calls[0]).toBe("setWorkStatus");
    expect(calls[1]).toContain("該 PR 已合併，無 pending auto-merge 可取消");
  });
});
