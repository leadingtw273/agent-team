/**
 * O009d: the "is this change request unambiguously safe to squash-merge right now" predicate
 * both fallback implementations that wrap `GitHubAdapter.enableAutoMerge` share when it fails on
 * an already-clean PR (GitHub's own "Pull request is in clean status" rejection):
 * `createGitHubSquashMergePort` (src/adapters/registration/setup-composition.ts) and
 * `buildMergeGateSourceControl` (src/cli/dispatch/status-merge-composition.ts).
 *
 * Extracted here (C015c acceptance review, observation 2) because the two call sites cannot
 * share the *whole* fallback function -- one returns a `RegistrationSetupSquashMergePort`-shaped
 * state union, the other `SourceControlPort.enableAutoMerge`'s own `Result<ChangeRequestSnapshot,
 * DomainError>` -- but both must agree, forever, on exactly when a direct squash-merge attempt is
 * safe. Before this extraction that agreement existed only as two independently maintained
 * copies of the same five-way boolean expression; this is the one place either implementation
 * can drift from without a test catching it (see
 * tests/unit/squash-merge-fallback-parity.test.ts, which drives both implementations through
 * equivalent fixtures and asserts they reach the same decision).
 */
import type { ChangeRequestSnapshot } from "../../application/ports/source-control.js";
import type { DomainError, Result } from "../../domain/foundation/index.js";

/**
 * A type predicate so callers get `current.value` narrowed to a definite `ChangeRequestSnapshot`
 * after checking, without a separate cast.
 */
export function isSafeToSquashMergeDirectly(
  current: Result<ChangeRequestSnapshot, DomainError>,
  expectedHeadSha: string,
): current is Readonly<{ ok: true; value: ChangeRequestSnapshot }> {
  return (
    current.ok &&
    current.value.state === "open" &&
    !current.value.draft &&
    current.value.mergeability === "mergeable" &&
    current.value.headSha.toLowerCase() === expectedHeadSha.toLowerCase()
  );
}
