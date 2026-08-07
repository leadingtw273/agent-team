/**
 * O009d unit tests: `createGitHubSquashMergePort`'s direct-merge fallback decision logic.
 *
 * Root cause: on real GitHub, `GitHubAdapter.enableAutoMerge` (GraphQL
 * `enablePullRequestAutoMerge`) structurally fails with "Pull request is in clean status"
 * (UNPROCESSABLE) once a PR is already fully mergeable -- and the O005 setup flow only ever
 * calls this once CI and review are both green, so the PR is *always* already clean by the time
 * this call happens. `setup approve` was therefore guaranteed to fail at `stage=merge` on real
 * GitHub, even with the repository's own `allow_auto_merge` setting enabled.
 *
 * These tests exercise only the *fallback decision* (does the port correctly re-check state and
 * attempt a direct squash merge, and does it correctly refuse to when unsafe) against a scripted
 * `GhJsonTransport`, deliberately without a real git repository or the full O005 session state
 * machine -- `GitHubAdapter.enableAutoMerge`/`squashMergeChangeRequest`'s own correctness is
 * already covered by tests/contract/github-adapter.test.ts. An integration-level test proving the
 * fallback also works end to end through the real CLI (start -> refresh -> approve, reaching
 * `merged`/`activated`) lives in tests/integration/registration-cli-setup-refresh.test.ts.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createGitHubSquashMergePort } from "../../src/adapters/registration/setup-composition.js";
import { GitHubAdapter, type GhJsonTransport } from "../../src/adapters/github/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../src/domain/foundation/index.js";
import { projectSchema, type Project } from "../../src/domain/project/index.js";
import type { Sha256Digest } from "../../src/domain/review/index.js";

const sha = "0123456789abcdef0123456789abcdef01234567";
const otherSha = "fedcba9876543210fedcba9876543210fedcba98";
const timestamp = "2026-08-06T12:00:00Z";

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
    baseSha: "2".repeat(40),
    autoMergeEnabled: false,
    updatedAt: timestamp,
    ...overrides,
  };
}

function digest(): Sha256Digest {
  return "a".repeat(64) as Sha256Digest;
}

const command = Object.freeze({
  project,
  changeRequestId: "42",
  expectedHeadSha: sha,
  mergeMethod: "SQUASH" as const,
  mergeIntentDigest: digest(),
});
const mutation = Object.freeze({ idempotencyKey: "attempt-1" });

describe("O009d createGitHubSquashMergePort: direct-merge fallback", () => {
  it("leaves the auto-merge-enabled success path completely unaffected -- fallback never triggered", async () => {
    const transport = new ScriptedTransport([
      { value: pull() }, // squashMerge.enable's own pre-check
      { value: pull() }, // enableAutoMerge's own internal pre-check
      {
        value: { data: { enablePullRequestAutoMerge: { pullRequest: { id: "PR_node_fixture" } } } },
      },
      { value: pull({ autoMergeEnabled: true }) }, // enableAutoMerge's own readback
    ]);
    const port = createGitHubSquashMergePort(new GitHubAdapter(transport));

    const result = await port.enable(command, mutation);

    expect(result).toMatchObject({ ok: true, value: { state: "auto_merge_enabled" } });
    transport.expectDone();
  });

  it("falls back to a direct squash merge when enableAutoMerge fails and the PR is genuinely safe to merge directly (the real GitHub 'clean status' case)", async () => {
    const transport = new ScriptedTransport([
      { value: pull() }, // squashMerge.enable's own pre-check
      { value: pull() }, // enableAutoMerge's own internal pre-check
      { error: "external_failure" }, // enableAutoMerge's GraphQL call fails (opaque failure)
      { value: pull() }, // squashMerge.enable's fallback re-read: still open/mergeable/matching head
      { value: pull() }, // squashMergeChangeRequest's own internal pre-check
      { value: { merged: true } }, // direct PUT merge succeeds
      { value: pull({ state: "merged" }) }, // squashMergeChangeRequest's own readback
    ]);
    const port = createGitHubSquashMergePort(new GitHubAdapter(transport));

    const result = await port.enable(command, mutation);

    expect(result).toMatchObject({ ok: true, value: { state: "merged" } });
    transport.expectDone();
  });

  it("does not attempt a direct merge -- and returns the original enableAutoMerge error -- when the fallback re-read shows the head moved", async () => {
    const transport = new ScriptedTransport([
      { value: pull() },
      { value: pull() },
      { error: "external_failure" },
      { value: pull({ headSha: otherSha }) }, // fallback re-read: head moved since the pre-check
    ]);
    const port = createGitHubSquashMergePort(new GitHubAdapter(transport));

    const result = await port.enable(command, mutation);

    expect(result).toMatchObject({ ok: false, error: { code: "external_failure" } });
    // No PUT merge attempted, and no retry of enableAutoMerge either -- exactly the 4 scripted calls.
    transport.expectDone();
  });

  it("does not attempt a direct merge when the fallback re-read shows the PR is no longer open (e.g. closed out of band)", async () => {
    const transport = new ScriptedTransport([
      { value: pull() },
      { value: pull() },
      { error: "external_failure" },
      { value: pull({ state: "closed" }) },
    ]);
    const port = createGitHubSquashMergePort(new GitHubAdapter(transport));

    const result = await port.enable(command, mutation);

    expect(result).toMatchObject({ ok: false, error: { code: "external_failure" } });
    transport.expectDone();
  });

  it("returns the original enableAutoMerge error -- not a new fallback error -- when the direct-merge attempt itself also fails", async () => {
    const transport = new ScriptedTransport([
      { value: pull() },
      { value: pull() },
      { error: "external_failure" },
      { value: pull() }, // fallback re-read: safe to attempt
      { value: pull() }, // squashMergeChangeRequest's own internal pre-check
      { error: "conflict" }, // the direct PUT merge call itself fails
    ]);
    const port = createGitHubSquashMergePort(new GitHubAdapter(transport));

    const result = await port.enable(command, mutation);

    // Must surface the *original* enableAutoMerge failure, not "conflict" -- per the locked fix
    // spec, "兩段都失敗才回原錯誤".
    expect(result).toMatchObject({ ok: false, error: { code: "external_failure" } });
    transport.expectDone();
  });

  it("is idempotent when the PR is already merged before the fallback is ever reached -- unrelated to, and unaffected by, this fix", async () => {
    const transport = new ScriptedTransport([{ value: pull({ state: "merged" }) }]);
    const port = createGitHubSquashMergePort(new GitHubAdapter(transport));

    const result = await port.enable(command, mutation);

    expect(result).toMatchObject({ ok: true, value: { state: "merged" } });
    transport.expectDone();
  });
});
