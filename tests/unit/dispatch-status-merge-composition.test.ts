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
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../src/domain/foundation/index.js";

const sha = "0123456789abcdef0123456789abcdef01234567";
const otherSha = "fedcba9876543210fedcba9876543210fedcba98";
const timestamp = "2026-08-07T00:00:00Z";
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
    autoMergeEnabled: false,
    updatedAt: timestamp,
    ...overrides,
  };
}

describe("buildStatusMergePipelines", () => {
  it("blocks with github_authentication_unavailable before constructing any port", async () => {
    const result = await buildStatusMergePipelines({
      githubTransport: {
        requestJson: () => Promise.reject(new Error("must never be called")),
        inspectAuthentication: () => Promise.resolve(err(domainError("permission_denied"))),
      },
    });
    expect(result).toEqual({ state: "blocked", reason: "github_authentication_unavailable" });
  });

  it("reaches state:ready with both coordinators constructed once GitHub auth succeeds", async () => {
    const result = await buildStatusMergePipelines({
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
  it("leaves the auto-merge-enabled success path unaffected -- fallback never triggered", async () => {
    const transport = new ScriptedTransport([
      { value: pull() }, // enableAutoMerge's own internal pre-check
      {
        value: { data: { enablePullRequestAutoMerge: { pullRequest: { id: "PR_node_fixture" } } } },
      },
      { value: pull({ autoMergeEnabled: true }) }, // enableAutoMerge's own readback
    ]);
    const sourceControl = buildMergeGateSourceControl(new GitHubAdapter(transport));

    const result = await sourceControl.enableAutoMerge(reference, sha, mutation);

    expect(result).toMatchObject({ ok: true, value: { autoMergeEnabled: true } });
    transport.expectDone();
  });

  it("falls back to a direct squash merge when enableAutoMerge fails and the PR is genuinely safe to merge directly", async () => {
    const transport = new ScriptedTransport([
      { value: pull() }, // enableAutoMerge's own internal pre-check
      { error: "external_failure" }, // enableAutoMerge's GraphQL call fails (clean-status case)
      { value: pull() }, // our fallback re-read: still open/mergeable/matching head
      { value: pull() }, // squashMergeChangeRequest's own internal pre-check
      { value: { merged: true } }, // direct PUT merge succeeds
      { value: pull({ state: "merged" }) }, // squashMergeChangeRequest's own readback
    ]);
    const sourceControl = buildMergeGateSourceControl(new GitHubAdapter(transport));

    const result = await sourceControl.enableAutoMerge(reference, sha, mutation);

    expect(result).toMatchObject({ ok: true, value: { state: "merged" } });
    transport.expectDone();
  });

  it("returns the original enableAutoMerge error, without attempting a direct merge, when the fallback re-read shows the head moved", async () => {
    const transport = new ScriptedTransport([
      { value: pull() },
      { error: "external_failure" },
      { value: pull({ headSha: otherSha }) },
    ]);
    const sourceControl = buildMergeGateSourceControl(new GitHubAdapter(transport));

    const result = await sourceControl.enableAutoMerge(reference, sha, mutation);

    expect(result).toMatchObject({ ok: false, error: { code: "external_failure" } });
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
    const sourceControl = buildMergeGateSourceControl(new GitHubAdapter(transport));

    const result = await sourceControl.enableAutoMerge(reference, sha, mutation);

    expect(result).toMatchObject({ ok: false, error: { code: "external_failure" } });
    transport.expectDone();
  });
});
