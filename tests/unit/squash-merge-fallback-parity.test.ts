/**
 * C015c acceptance review (observation 2): behavioral-parity test between the two O009d
 * direct-merge fallback implementations -- `createGitHubSquashMergePort`
 * (src/adapters/registration/setup-composition.ts, O009d) and `buildMergeGateSourceControl`
 * (src/cli/dispatch/status-merge-composition.ts, C015c). Both now delegate the actual "is this
 * state unambiguously safe to merge directly" decision to the same shared predicate,
 * `isSafeToSquashMergeDirectly` (src/adapters/github/squash-merge-fallback.ts) -- but the two
 * outer wrappers still differ (one returns `RegistrationSetupSquashMergePort`'s own state union,
 * the other `SourceControlPort.enableAutoMerge`'s `Result<ChangeRequestSnapshot, DomainError>`),
 * so a shared predicate alone does not *prove* the two observable behaviors stay in lockstep --
 * this test does, by driving both through equivalent GitHub-state fixtures (same underlying
 * facts: PR state before/after the fallback re-read) and asserting they reach the same final
 * decision: merge or don't, and if they don't, preserve the original `enableAutoMerge` error.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createGitHubSquashMergePort } from "../../src/adapters/registration/setup-composition.js";
import { buildMergeGateSourceControl } from "../../src/cli/dispatch/status-merge-composition.js";
import {
  GitHubAdapter,
  isSafeToSquashMergeDirectly,
  type GhJsonTransport,
} from "../../src/adapters/github/index.js";
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

/** Drives `createGitHubSquashMergePort`; returns just enough of its outcome to compare against
 * the other implementation: whether it ended up merged, and if not, the preserved error code. */
async function runRegistrationSideFallback(
  fallbackReRead: Readonly<Record<string, unknown>>,
): Promise<Readonly<{ merged: boolean; errorCode?: DomainError["code"] }>> {
  const transport = new ScriptedTransport([
    { value: pull() }, // squashMerge.enable's own pre-check
    { value: pull() }, // enableAutoMerge's own internal pre-check
    { error: "external_failure" }, // enableAutoMerge's GraphQL call fails (clean-status case)
    { value: fallbackReRead }, // the fallback re-read this test is exercising parity for
    ...(fallbackReRead["state"] === "open" &&
    fallbackReRead["draft"] === false &&
    fallbackReRead["mergeability"] === "mergeable" &&
    // C015y decision D: mirrors `isSafeToSquashMergeDirectly`'s own added condition -- this
    // test's gate for "should the fake transport even expect the squash-merge steps" must track
    // production's real predicate, or a BEHIND fixture would leave scripted steps unconsumed.
    fallbackReRead["mergeStateStatus"] !== "behind" &&
    fallbackReRead["headSha"] === sha
      ? [
          { value: pull() }, // squashMergeChangeRequest's own internal pre-check
          { value: { merged: true } }, // direct PUT merge succeeds
          { value: pull({ state: "merged" }) }, // squashMergeChangeRequest's own readback
        ]
      : []),
  ]);
  const port = createGitHubSquashMergePort(new GitHubAdapter(transport));
  const result = await port.enable(
    Object.freeze({
      project,
      changeRequestId: "42",
      expectedHeadSha: sha,
      mergeMethod: "SQUASH" as const,
      mergeIntentDigest: digest(),
    }),
    Object.freeze({ idempotencyKey: "parity-registration" }),
  );
  transport.expectDone();
  if (!result.ok) return { merged: false, errorCode: result.error.code };
  return { merged: result.value.state === "merged" };
}

/** Drives `buildMergeGateSourceControl(...).enableAutoMerge`; same comparison shape. */
async function runMergeGateSideFallback(
  fallbackReRead: Readonly<Record<string, unknown>>,
): Promise<Readonly<{ merged: boolean; errorCode?: DomainError["code"] }>> {
  const transport = new ScriptedTransport([
    { value: pull() }, // enableAutoMerge's own internal pre-check
    { error: "external_failure" }, // enableAutoMerge's GraphQL call fails (clean-status case)
    { value: fallbackReRead }, // the fallback re-read this test is exercising parity for
    ...(fallbackReRead["state"] === "open" &&
    fallbackReRead["draft"] === false &&
    fallbackReRead["mergeability"] === "mergeable" &&
    // C015y decision D: mirrors `isSafeToSquashMergeDirectly`'s own added condition -- this
    // test's gate for "should the fake transport even expect the squash-merge steps" must track
    // production's real predicate, or a BEHIND fixture would leave scripted steps unconsumed.
    fallbackReRead["mergeStateStatus"] !== "behind" &&
    fallbackReRead["headSha"] === sha
      ? [
          { value: pull() }, // squashMergeChangeRequest's own internal pre-check
          { value: { merged: true } }, // direct PUT merge succeeds
          { value: pull({ state: "merged" }) }, // squashMergeChangeRequest's own readback
        ]
      : []),
  ]);
  const sourceControl = buildMergeGateSourceControl(new GitHubAdapter(transport));
  const result = await sourceControl.enableAutoMerge({ project, changeRequestId: "42" }, sha, {
    idempotencyKey: "parity-merge-gate",
  });
  transport.expectDone();
  if (!result.ok) return { merged: false, errorCode: result.error.code };
  return { merged: result.value.outcome === "merged_directly" };
}

describe("O009d squash-merge fallback: cross-implementation behavioral parity", () => {
  it("both implementations merge directly when the fallback re-read is unambiguously safe", async () => {
    const fixture = pull(); // still open/non-draft/mergeable/same head
    const [registration, mergeGate] = await Promise.all([
      runRegistrationSideFallback(fixture),
      runMergeGateSideFallback(fixture),
    ]);
    expect(registration).toEqual({ merged: true });
    expect(mergeGate).toEqual({ merged: true });
  });

  it("both implementations decline and preserve the original error when the head has moved since the pre-check", async () => {
    const fixture = pull({ headSha: otherSha });
    const [registration, mergeGate] = await Promise.all([
      runRegistrationSideFallback(fixture),
      runMergeGateSideFallback(fixture),
    ]);
    expect(registration).toEqual({ merged: false, errorCode: "external_failure" });
    expect(mergeGate).toEqual({ merged: false, errorCode: "external_failure" });
  });

  it("both implementations decline when the PR is no longer open (e.g. closed out of band)", async () => {
    const fixture = pull({ state: "closed" });
    const [registration, mergeGate] = await Promise.all([
      runRegistrationSideFallback(fixture),
      runMergeGateSideFallback(fixture),
    ]);
    expect(registration).toEqual({ merged: false, errorCode: "external_failure" });
    expect(mergeGate).toEqual({ merged: false, errorCode: "external_failure" });
  });

  it("both implementations decline when the PR is draft", async () => {
    const fixture = pull({ draft: true });
    const [registration, mergeGate] = await Promise.all([
      runRegistrationSideFallback(fixture),
      runMergeGateSideFallback(fixture),
    ]);
    expect(registration).toEqual({ merged: false, errorCode: "external_failure" });
    expect(mergeGate).toEqual({ merged: false, errorCode: "external_failure" });
  });

  it("both implementations decline when mergeability is not mergeable", async () => {
    const fixture = pull({ mergeability: "conflicting" });
    const [registration, mergeGate] = await Promise.all([
      runRegistrationSideFallback(fixture),
      runMergeGateSideFallback(fixture),
    ]);
    expect(registration).toEqual({ merged: false, errorCode: "external_failure" });
    expect(mergeGate).toEqual({ merged: false, errorCode: "external_failure" });
  });

  // C015y decision D (arm-time interception, point 3 of 3): the shared predicate itself
  // (`isSafeToSquashMergeDirectly`) must decline a BEHIND re-read even though every other field
  // (`state`/`draft`/`mergeability`/`headSha`) is otherwise unambiguously safe -- `mergeability`
  // says nothing about O004's `strictRequiredStatusChecksPolicy` ruleset. Both implementations
  // share the exact same predicate, so proving it here proves it for both call sites at once.
  it("both implementations decline when the fallback re-read is BEHIND, even though every other field looks safe", async () => {
    const fixture = pull({ mergeStateStatus: "behind" });
    const [registration, mergeGate] = await Promise.all([
      runRegistrationSideFallback(fixture),
      runMergeGateSideFallback(fixture),
    ]);
    expect(registration).toEqual({ merged: false, errorCode: "external_failure" });
    expect(mergeGate).toEqual({ merged: false, errorCode: "external_failure" });
  });

  /** Direct, non-integration coverage of the shared predicate itself -- the two
   * `run*SideFallback` helpers above both preserve the *original* `enableAutoMerge` error whether
   * `isSafeToSquashMergeDirectly` correctly declines early or (hypothetically) incorrectly
   * proceeds and then fails for an unrelated reason, so they cannot alone distinguish those two
   * cases from each other. This calls the predicate directly, with every other field
   * unambiguously safe, so only the `mergeStateStatus` check can be responsible for the result. */
  it("isSafeToSquashMergeDirectly itself returns false for a BEHIND snapshot with every other field otherwise safe, and true once mergeStateStatus is anything else", () => {
    const safeExceptBehind = ok(pull({ mergeStateStatus: "behind" }) as never);
    expect(isSafeToSquashMergeDirectly(safeExceptBehind, sha)).toBe(false);

    const safe = ok(pull({ mergeStateStatus: "clean" }) as never);
    expect(isSafeToSquashMergeDirectly(safe, sha)).toBe(true);
  });
});
