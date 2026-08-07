/**
 * C015b item 4: a narrow adapter implementing `ScopeOverrunCheckpointPort`
 * (src/application/pipelines/implementer-model.ts) on top of `LocalYamlCheckpointStore`
 * (src/adapters/checkpoint/local-yaml.ts, C015b-approved -- this composition-root-level shaping
 * work was confirmed feasible, not "不可行", during C015b's own investigation).
 *
 * These two shapes are not a straight method rename: `preserve()` receives raw pipeline state
 * (`job`, `worktree`, `requirementSnapshot`, `findings`, `changedPaths`); `persist()` requires a
 * fully-formed domain `Checkpoint` record. This adapter is the one place that synthesizes that
 * record, making two narrow judgment calls (both disclosed here, not hidden):
 *
 * - `reason: "human_handoff"`. `checkpointReasonSchema` has no dedicated "scope overrun" value.
 *   C005's own plan-doc wording for this exact situation is "先 Checkpoint 並交團隊管理者處理"
 *   (checkpoint first, then hand off to the team manager) -- `"human_handoff"` is the existing
 *   enum member that says exactly that, more precisely than the alternative candidates
 *   (`"safety_pause"` is about dangerous *operations*, not scope; `"manual"` is a generic
 *   catch-all with no such textual backing).
 * - `completedItems`/`remainingItems`/`tests`/`nextSteps` are derived, not invented, from what
 *   the pipeline already told this adapter: `findings` (one `remainingItems` entry per finding,
 *   verbatim `code: path`) and `changedPaths` (one `completedItems` entry each, since the
 *   provider did touch these paths -- "completed" here means "produced," not "verified clean").
 *   `nextSteps` (schema-required, min 1) is a single fixed Traditional-Chinese instruction asking
 *   a human to review the findings -- this adapter has no other content to offer for it.
 *   `tests` is always empty: this checkpoint fires before the pipeline ever runs project quality
 *   commands, so there is genuinely no test evidence to report, not evidence being hidden.
 * - `worktree.pushed: false` always -- a scope-overrun checkpoint fires strictly before
 *   `git.stagePaths`/`commit`/`push` in `ImplementerPipeline.run()`, so nothing has been pushed
 *   by construction, not by omission.
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
import type { ScopeOverrunCheckpointPort } from "../../application/pipelines/index.js";
import type { CheckpointPersistencePort } from "../../application/checkpoint/index.js";

export interface ScopeOverrunCheckpointAdapterOptions {
  readonly store: CheckpointPersistencePort;
  readonly clock?: Clock;
}

const scopeOverrunNextSteps = Object.freeze([
  "偵測到實際變更超出宣告範圍，請人工檢視 findings 後決定是否放行或改派工。",
]);

export class ScopeOverrunCheckpointAdapter implements ScopeOverrunCheckpointPort {
  readonly #store: CheckpointPersistencePort;
  readonly #clock: Clock;

  constructor(options: ScopeOverrunCheckpointAdapterOptions) {
    this.#store = options.store;
    this.#clock = options.clock ?? createClock();
  }

  async preserve(
    request: Parameters<ScopeOverrunCheckpointPort["preserve"]>[0],
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
      reason: "human_handoff" as const,
      completedItems: request.changedPaths,
      remainingItems: request.findings.map((finding) => `${finding.code}: ${finding.path}`),
      tests: [],
      nextSteps: scopeOverrunNextSteps,
      blockers: [],
      requirementSnapshot: request.requirementSnapshot,
      model: { provider: "dispatch-cli", model: "unassigned" },
      worktree: {
        path: request.worktree.path,
        branch: request.worktree.branch,
        commitSha: request.worktree.headSha,
        pushed: false,
      },
    });
    if (!checkpoint.success) return err(domainError("invariant_violation"));

    const persisted = await this.#store.persist(checkpoint.data, options);
    if (!persisted.ok) return persisted;
    return ok(Object.freeze({ checkpointId: checkpoint.data.id }));
  }
}
