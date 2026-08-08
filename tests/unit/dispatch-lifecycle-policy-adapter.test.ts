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

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  FileAutoMergePauseAdapter,
  NoOpAutoMergePauseAdapter,
} from "../../src/cli/dispatch/lifecycle-policy-adapter.js";
import { buildLifecyclePipeline } from "../../src/cli/dispatch/lifecycle-composition.js";
import type { LinearWorkManagementReadModel } from "../../src/cli/dispatch/work-management-adapter.js";
import type { LinearWorkManagementMutationClient } from "../../src/cli/dispatch/work-management-adapter.js";
import { FileJobProgressStore } from "../../src/adapters/dispatch/job-progress-store.js";
import { FileAutoMergePauseStore } from "../../src/adapters/dispatch/auto-merge-pause-store.js";
import type { GhJsonTransport } from "../../src/adapters/github/index.js";
import { LifecyclePipeline } from "../../src/application/pipelines/index.js";
import { LeaseCoordinator } from "../../src/application/leases/index.js";
import { InMemoryLeaseRepository } from "../../src/cli/dispatch/ephemeral-ports.js";
import {
  createFixedClock,
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

const pausedAtFixture = "2026-08-08T00:05:00.000Z" as never;

function temporaryAutoMergePauseStore(agentTeamHome: string): FileAutoMergePauseStore {
  return new FileAutoMergePauseStore(
    join(agentTeamHome, "state", "dispatch", "auto-merge-pause"),
    undefined,
    createFixedClock(pausedAtFixture),
  );
}

describe("buildLifecyclePipeline production-composition seam (E116cap: now FileAutoMergePauseAdapter, superseding C015v decision 4's NoOp wiring)", () => {
  it("an out-of-process merge converges to completed end to end through the real production wiring -- GitHubAdapter + LinearWorkManagementAdapter + the real FileAutoMergePauseAdapter, not a mocked LifecyclePolicyPort -- and durably pauses the project", async () => {
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
    const autoMergePause = temporaryAutoMergePauseStore(agentTeamHome);

    const pipeline = buildLifecyclePipeline({
      readModel: readModel as never,
      mutationClient,
      teamId: "team-1",
      linearProjectId: "proj-1",
      progress,
      agentTeamHome,
      leases: new LeaseCoordinator(new InMemoryLeaseRepository()),
      autoMergePause,
      githubTransport,
    });

    // No `mergeAuthorizationHeadSha` -> out-of-process merge -> the only branch that ever calls
    // `pauseAutoMerge`, now the real `FileAutoMergePauseAdapter`.
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
      autoMergeDisposition: "paused",
    });
    expect(calls).toEqual(["readIssue", "observeGithubMerge", "appendComment"]);
    expect(commentBody).toContain("已暫停此專案新的 Auto-merge");
    expect(commentBody).not.toContain("該 PR 已合併，無 pending auto-merge 可取消");

    // E116cap acceptance ①/②: the project-level pause flag is now durably persisted -- not just an
    // in-memory outcome -- with the exact PR/SHA evidence that triggered it.
    const persisted = await autoMergePause.load(project().id);
    expect(persisted).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        revision: 0,
        projectId: project().id,
        status: {
          state: "paused",
          reason: "out_of_process_merge",
          pausedAt: pausedAtFixture,
          evidence: { changeRequestId: "7", mergedHeadSha: headSha },
        },
        updatedAt: pausedAtFixture,
      },
    });
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

/**
 * E116cap: `FileAutoMergePauseAdapter` (lifecycle-policy-adapter.ts) is the real backing capability
 * `NoOpAutoMergePauseAdapter`'s own header always disclosed as missing. Unit-level tests against a
 * fake `Pick<FileAutoMergePauseStore, "pause">` -- the store's own round-trip persistence
 * (CAS/atomic/0600/read-back) is covered directly in
 * tests/unit/dispatch-auto-merge-pause-store.test.ts; this file only needs to prove the adapter
 * translates the store's outcomes into `PauseAutoMergeOutcome` honestly.
 */
describe("FileAutoMergePauseAdapter", () => {
  const request = Object.freeze({
    project: project(),
    reason: "out_of_process_merge" as const,
    changeRequestId: "9",
    mergedHeadSha: "b".repeat(40),
  });
  const mutation = Object.freeze({ idempotencyKey: "pause-9" });

  it('reports state:"paused"/durability:"confirmed" when the store durably confirms the write', async () => {
    const pause = vi.fn(() =>
      Promise.resolve(
        ok({
          schemaVersion: 1 as const,
          revision: 0,
          projectId: request.project.id,
          status: {
            state: "paused" as const,
            reason: "out_of_process_merge" as const,
            pausedAt: "2026-08-08T00:00:00.000Z" as never,
            evidence: { changeRequestId: "9", mergedHeadSha: request.mergedHeadSha },
          },
          updatedAt: "2026-08-08T00:00:00.000Z" as never,
        }),
      ),
    );
    const adapter = new FileAutoMergePauseAdapter({ store: { pause } });

    const result = await adapter.pauseAutoMerge(request, mutation);

    expect(result).toEqual({ ok: true, value: { state: "paused", durability: "confirmed" } });
    expect(pause).toHaveBeenCalledWith(
      request.project.id,
      { changeRequestId: "9", mergedHeadSha: request.mergedHeadSha },
      {},
    );
  });

  it('reports state:"paused" (never "not_applicable") even when the project was already paused -- a real project-wide action was still honestly confirmed', async () => {
    const pause = vi.fn(() =>
      Promise.resolve(
        ok({
          schemaVersion: 1 as const,
          revision: 0,
          projectId: request.project.id,
          status: {
            state: "paused" as const,
            reason: "out_of_process_merge" as const,
            pausedAt: "2026-08-07T00:00:00.000Z" as never,
            evidence: { changeRequestId: "1", mergedHeadSha: "a".repeat(40) },
          },
          updatedAt: "2026-08-07T00:00:00.000Z" as never,
        }),
      ),
    );
    const adapter = new FileAutoMergePauseAdapter({ store: { pause } });

    const result = await adapter.pauseAutoMerge(request, mutation);

    expect(result).toEqual({ ok: true, value: { state: "paused", durability: "confirmed" } });
  });

  it('fails closed to state:"unknown" when the store write itself fails -- never a false "paused"', async () => {
    const pause = vi.fn(() => Promise.resolve(err(domainError("external_failure"))));
    const adapter = new FileAutoMergePauseAdapter({ store: { pause } });

    const result = await adapter.pauseAutoMerge(request, mutation);

    expect(result).toEqual({ ok: true, value: { state: "unknown", durability: "unknown" } });
  });

  it("forwards the caller's abort signal to the store", async () => {
    const pause = vi.fn(() => Promise.resolve(err(domainError("external_failure"))));
    const adapter = new FileAutoMergePauseAdapter({ store: { pause } });
    const controller = new AbortController();

    await adapter.pauseAutoMerge(request, { ...mutation, signal: controller.signal });

    expect(pause).toHaveBeenCalledWith(request.project.id, expect.anything(), {
      signal: controller.signal,
    });
  });
});

/**
 * E116cap: same "hand-assembled ports" narrowing the NoOp block above uses, but with the real
 * `FileAutoMergePauseAdapter` over a real, disk-backed `FileAutoMergePauseStore` -- proves the full
 * `LifecyclePipeline` -> adapter -> store round trip converges to `completed`/`"paused"` with the
 * production `mergeComment` wording, and that the pause survives as a durable file a second,
 * independent process could read.
 */
describe("LifecyclePipeline + real FileAutoMergePauseAdapter over a real FileAutoMergePauseStore", () => {
  it('completes an out-of-process merge with autoMergeDisposition:"paused" and durably persists the project-level pause flag', async () => {
    const headSha = "c".repeat(40);
    const agentTeamHome = await temporaryAgentTeamHome();
    const store = temporaryAutoMergePauseStore(agentTeamHome);
    const calls: string[] = [];
    const pipeline = new LifecyclePipeline({
      sourceControl: {
        getChangeRequest: () =>
          Promise.resolve(
            ok({
              id: "PR_fixture",
              number: 2,
              url: "https://example.test/pull/2",
              state: "merged" as const,
              draft: false,
              baseBranch: "main",
              headBranch: "agent-team/job-2",
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
                externalId: "linear-issue-2",
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
                externalId: "linear-issue-2",
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
            ok({ id: "comment-2", body, createdAt: "2026-08-07T00:05:00.000Z" as never }),
          );
        },
      },
      policy: new FileAutoMergePauseAdapter({ store }),
      cancellation: {
        prepare: () => Promise.reject(new Error("must never be called")),
      },
      leaseRelease: {
        release: () => Promise.reject(new Error("must never be called: merge path only")),
      },
    });

    const outcome = await pipeline.run({
      project: project(),
      externalIssueId: "linear-issue-2",
      changeRequestId: "2",
      idempotencyKeyPrefix: "test-2",
    });

    expect(outcome).toEqual({
      state: "completed",
      merge: "out_of_process",
      headSha,
      autoMergeDisposition: "paused",
    });
    expect(calls[0]).toBe("setWorkStatus");
    expect(calls[1]).toContain("已暫停此專案新的 Auto-merge");

    const persisted = await store.load(project().id);
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) return;
    expect(persisted.value?.status).toEqual({
      state: "paused",
      reason: "out_of_process_merge",
      pausedAt: pausedAtFixture,
      evidence: { changeRequestId: "2", mergedHeadSha: headSha },
    });
  });
});
