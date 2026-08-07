/**
 * C015c item 3: `ReviewerCheckpointPort` adapter over `LocalYamlCheckpointStore`
 * (src/adapters/checkpoint/local-yaml.ts), mirroring `ScopeOverrunCheckpointAdapter`
 * (scope-checkpoint.ts, C015b) exactly in spirit: this is the one place that synthesizes a full
 * domain `Checkpoint` from the raw pipeline state `ReviewerPipeline` actually hands this port.
 * Judgment calls made here (disclosed, not hidden):
 *
 * - `reason` is always the domain enum's `"retry_exhausted"`. `ReviewerCheckpointPort`'s own
 *   `reason` field is the string literal `"attempt_limit_reached"` (confirmed by reading
 *   reviewer.ts's `#checkpoint` -- it is the only reason ever requested through this port) --
 *   `checkpointReasonSchema` (src/domain/checkpoint/schema.ts) has no such literal, but
 *   `"retry_exhausted"` says exactly the same thing in the domain's own vocabulary.
 * - `tests` is derived from `checks` (the `CommitChecksSnapshot` already at hand): one
 *   `testEvidence` entry per named check, `status` mapped `success`->`passed`,
 *   `failure`/`cancelled`->`failed`, everything else (`queued`/`in_progress`/`skipped`/null
 *   conclusion)->`not_run`. This is the only genuinely available evidence at this checkpoint
 *   site -- `ReviewerCheckpointPort`'s request never carries the reviewer's own findings text, so
 *   `completedItems`/`remainingItems` stay empty rather than inventing content the pipeline never
 *   supplied.
 * - `worktree.pushed: true` always -- `ReviewerPipeline` only reaches this checkpoint after the
 *   change request is already open and past `markChangeRequestReady`, so the branch has
 *   necessarily already been pushed by the implementer stage, not by omission here.
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
import type { ReviewerCheckpointPort } from "../../application/pipelines/index.js";
import type { CheckpointPersistencePort } from "../../application/checkpoint/index.js";

export interface ReviewerCheckpointAdapterOptions {
  readonly store: CheckpointPersistencePort;
  readonly clock?: Clock;
}

const attemptLimitNextSteps = Object.freeze([
  "審查回合已達上限，請人工檢視 Reviewer 意見與變更請求 diff 後決定下一步。",
]);

function testStatus(conclusion: string | null): "passed" | "failed" | "not_run" {
  if (conclusion === "success") return "passed";
  if (conclusion === "failure" || conclusion === "cancelled") return "failed";
  return "not_run";
}

export class ReviewerCheckpointAdapter implements ReviewerCheckpointPort {
  readonly #store: CheckpointPersistencePort;
  readonly #clock: Clock;

  constructor(options: ReviewerCheckpointAdapterOptions) {
    this.#store = options.store;
    this.#clock = options.clock ?? createClock();
  }

  async preserve(
    request: Parameters<ReviewerCheckpointPort["preserve"]>[0],
    options: MutationOptions,
  ): AsyncPortResult<Readonly<{ checkpointId: string }>> {
    const id = generateIdentifier("checkpoint");
    if (!id.ok) return id;

    const checkpoint = checkpointSchema.safeParse({
      schemaVersion: 1,
      id: id.value,
      projectId: request.job.projectId,
      issueId: request.job.issueId,
      jobId: request.job.id,
      createdAt: this.#clock.now(),
      reason: "retry_exhausted" as const,
      completedItems: [],
      remainingItems: [],
      tests: request.checks.checks.map((check) => ({
        commandSummary: check.name,
        status: testStatus(check.conclusion),
      })),
      nextSteps: attemptLimitNextSteps,
      blockers: [],
      requirementSnapshot: request.requirementSnapshot,
      model: { provider: "dispatch-cli", model: "unassigned" },
      worktree: {
        path: request.worktree.path,
        branch: request.worktree.branch,
        commitSha: request.worktree.headSha,
        pushed: true,
      },
    });
    if (!checkpoint.success) return err(domainError("invariant_violation"));

    const persisted = await this.#store.persist(checkpoint.data, options);
    if (!persisted.ok) return persisted;
    return ok(Object.freeze({ checkpointId: checkpoint.data.id }));
  }
}
