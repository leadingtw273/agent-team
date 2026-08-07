/**
 * C015c item 3b: `CiRecoveryCheckpointPort` adapter over `LocalYamlCheckpointStore`, mirroring
 * `ScopeOverrunCheckpointAdapter` (scope-checkpoint.ts, C015b) and `ReviewerCheckpointAdapter`
 * (reviewer-checkpoint.ts, C015c item 3) exactly in spirit -- this port carries *two* reasons
 * (`CiRecoveryCheckpointReason = "attempt_limit_reached" | "scope_overrun"`, confirmed by reading
 * ci-recovery.ts's own `#checkpoint`), so this adapter branches on which one fired:
 *
 * - `"attempt_limit_reached"` maps to the domain enum's `"retry_exhausted"` (same mapping
 *   `ReviewerCheckpointAdapter` uses) -- `ci-recovery.ts` only ever reaches it *before* attempting
 *   a new commit this round, so the worktree's last pushed state is still exactly what is on the
 *   remote: `worktree.pushed: true`. `findings`/`changedPaths` are never supplied for this reason
 *   (confirmed by reading the call site), so `completedItems`/`remainingItems` stay empty and
 *   `tests` is derived from `checks` instead (same technique as `ReviewerCheckpointAdapter`) --
 *   the only genuinely available evidence at this site.
 * - `"scope_overrun"` maps to `"human_handoff"` (the exact same mapping C005/C015b's own
 *   `ScopeOverrunCheckpointAdapter` established for the identical situation in the implementer
 *   pipeline) and *does* carry `findings`/`changedPaths`, derived the same way that adapter
 *   derives them: one `remainingItems` entry per finding (`code: path`), one `completedItems`
 *   entry per changed path. This fires strictly before this round's own `stagePaths`/`commit`/
 *   `push` (confirmed by reading the call site), so *this round's* produced changes are not yet
 *   pushed -- `worktree.pushed: false`, matching the implementer pipeline's own established rule
 *   for the identical "detected before staging" situation, even though the branch as a whole may
 *   carry earlier, already-pushed rounds.
 */
import {
  createClock,
  domainError,
  err,
  generateIdentifier,
  ok,
  type Clock,
} from "../../domain/foundation/index.js";
import { checkpointSchema } from "../../domain/checkpoint/index.js";
import type { AsyncPortResult, MutationOptions } from "../../application/ports/index.js";
import type { CiRecoveryCheckpointPort } from "../../application/pipelines/index.js";
import type { CheckpointPersistencePort } from "../../application/checkpoint/index.js";

export interface CiRecoveryCheckpointAdapterOptions {
  readonly store: CheckpointPersistencePort;
  readonly clock?: Clock;
}

const attemptLimitNextSteps = Object.freeze([
  "CI 修復回合已達上限，請人工檢視最新 CI 結果與修復嘗試後決定下一步。",
]);
const scopeOverrunNextSteps = Object.freeze([
  "偵測到實際變更超出宣告範圍，請人工檢視 findings 後決定是否放行或改派工。",
]);

function testStatus(conclusion: string | null): "passed" | "failed" | "not_run" {
  if (conclusion === "success") return "passed";
  if (conclusion === "failure" || conclusion === "cancelled") return "failed";
  return "not_run";
}

export class CiRecoveryCheckpointAdapter implements CiRecoveryCheckpointPort {
  readonly #store: CheckpointPersistencePort;
  readonly #clock: Clock;

  constructor(options: CiRecoveryCheckpointAdapterOptions) {
    this.#store = options.store;
    this.#clock = options.clock ?? createClock();
  }

  async preserve(
    request: Parameters<CiRecoveryCheckpointPort["preserve"]>[0],
    options: MutationOptions,
  ): AsyncPortResult<Readonly<{ checkpointId: string }>> {
    const id = generateIdentifier("checkpoint");
    if (!id.ok) return id;

    const isScopeOverrun = request.reason === "scope_overrun";
    const checkpoint = checkpointSchema.safeParse({
      schemaVersion: 1,
      id: id.value,
      projectId: request.job.projectId,
      issueId: request.job.issueId,
      jobId: request.job.id,
      createdAt: this.#clock.now(),
      reason: isScopeOverrun ? ("human_handoff" as const) : ("retry_exhausted" as const),
      completedItems: isScopeOverrun ? (request.changedPaths ?? []) : [],
      remainingItems: isScopeOverrun
        ? (request.findings ?? []).map((finding) => `${finding.code}: ${finding.path}`)
        : [],
      tests: isScopeOverrun
        ? []
        : request.checks.checks.map((check) => ({
            commandSummary: check.name,
            status: testStatus(check.conclusion),
          })),
      nextSteps: isScopeOverrun ? scopeOverrunNextSteps : attemptLimitNextSteps,
      blockers: [],
      requirementSnapshot: request.requirementSnapshot,
      model: { provider: "dispatch-cli", model: "unassigned" },
      worktree: {
        path: request.worktree.path,
        branch: request.worktree.branch,
        commitSha: request.worktree.headSha,
        pushed: !isScopeOverrun,
      },
    });
    if (!checkpoint.success) return err(domainError("invariant_violation"));

    const persisted = await this.#store.persist(checkpoint.data, options);
    if (!persisted.ok) return persisted;
    return ok(Object.freeze({ checkpointId: checkpoint.data.id }));
  }
}
