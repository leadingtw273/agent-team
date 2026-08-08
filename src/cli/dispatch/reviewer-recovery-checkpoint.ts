/**
 * Reviewer recovery 沒有 CI checks 可轉成測試結果，因此不論 checkpoint 原因為何，
 * `tests` 均留空；其餘 checkpoint 語意沿用 CI recovery 的對應規則。
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
import type { ReviewerRecoveryCheckpointPort } from "../../application/pipelines/index.js";
import type { CheckpointPersistencePort } from "../../application/checkpoint/index.js";

export interface ReviewerRecoveryCheckpointAdapterOptions {
  readonly store: CheckpointPersistencePort;
  readonly clock?: Clock;
}

const attemptLimitNextSteps = Object.freeze([
  "Reviewer 修復回合或可用審查次數已達上限，請人工檢視 findings 與目前分支。",
]);
const scopeOverrunNextSteps = Object.freeze([
  "偵測到 reviewer 修復變更超出宣告範圍，請人工檢視 findings 後決定下一步。",
]);

export class ReviewerRecoveryCheckpointAdapter implements ReviewerRecoveryCheckpointPort {
  readonly #store: CheckpointPersistencePort;
  readonly #clock: Clock;

  constructor(options: ReviewerRecoveryCheckpointAdapterOptions) {
    this.#store = options.store;
    this.#clock = options.clock ?? createClock();
  }

  async preserve(
    request: Parameters<ReviewerRecoveryCheckpointPort["preserve"]>[0],
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
      tests: [],
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
