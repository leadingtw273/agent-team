/**
 * C015c item 5: `LifecycleCancellationPort.prepare()` -- fires when a human cancels a Linear issue
 * whose change request isn't merged yet. The request shape this port receives (`{project,
 * externalIssueId, changeRequest, preserveBranchAndWorktree:true}`) carries no job or
 * `requirementSnapshot` context, so a real domain `Checkpoint`
 * (src/domain/checkpoint/schema.ts -- strictly requires `jobId`/`requirementSnapshot`/`model`/
 * `worktree` and more) cannot be honestly synthesized here without inventing fields this port was
 * never given. A plausible-looking-but-partly-invented Checkpoint would be worse than none, so
 * this adapter never returns `checkpoint:"preserved"` -- always `"not_required"`.
 *
 * "Stopping active work" is instead achieved through the CLI's own job-progress index (C015c item
 * 1, `FileJobProgressStore`): this looks up every progress record for the issue's project (there
 * is no per-issue index, so filtering is client-side) and, for any record belonging to this issue
 * that is not already in a terminal stage (`completed`/`failed`/`requires_manual`), CAS-transitions
 * it to `requires_manual`. That is what `activeWorkStopped` honestly means here: a future
 * `agent-team run` will refuse to resume that job rather than silently continuing to act on an
 * issue the user has cancelled. Branch/worktree are never touched, matching
 * `preserveBranchAndWorktree: true` on every request this port receives.
 *
 * DISCLOSED LIMITATION: no formal Checkpoint is ever preserved by this path; `checkpoint:"preserved"`
 * is unreachable from this adapter. Recorded as a residual risk in the completion report.
 */
import {
  domainError,
  err,
  generateDeterministicIdentifier,
  ok,
} from "../../domain/foundation/index.js";
import type { LifecycleCancellationPort } from "../../application/pipelines/index.js";
import type { FileJobProgressStore } from "../../adapters/dispatch/index.js";

export interface JobProgressLifecycleCancellationAdapterOptions {
  readonly progress: FileJobProgressStore;
}

const terminalStages = new Set(["completed", "failed", "requires_manual"]);

export class JobProgressLifecycleCancellationAdapter implements LifecycleCancellationPort {
  readonly #progress: FileJobProgressStore;

  constructor(options: JobProgressLifecycleCancellationAdapterOptions) {
    this.#progress = options.progress;
  }

  async prepare(
    request: Parameters<LifecycleCancellationPort["prepare"]>[0],
    _options: Parameters<LifecycleCancellationPort["prepare"]>[1],
  ): ReturnType<LifecycleCancellationPort["prepare"]> {
    void _options;
    const issueId = generateDeterministicIdentifier("issue", request.externalIssueId);
    if (!issueId.ok) return err(domainError("invariant_violation"));

    const records = await this.#progress.listForProject(request.project.id);
    if (!records.ok) return records;
    const mine = records.value.filter(
      (record) => record.issueId === issueId.value && !terminalStages.has(record.stage.kind),
    );
    for (const record of mine) {
      // Spread the existing record rather than re-listing every field by hand: this store's
      // schema has already grown once since it was first written (C015c item 2 added
      // `externalIssueId`/`model`), and a hand-copied field list would silently stop forwarding
      // whatever is added next. Only `stage` actually changes here.
      const {
        schemaVersion: _schemaVersion,
        revision: _revision,
        updatedAt: _updatedAt,
        ...rest
      } = record;
      void _schemaVersion;
      void _revision;
      void _updatedAt;
      const transitioned = await this.#progress.compareAndSwap(record.jobId, record.revision, {
        ...rest,
        stage: { kind: "requires_manual" },
      });
      if (!transitioned.ok) return transitioned;
    }
    return ok(Object.freeze({ activeWorkStopped: true, checkpoint: "not_required" as const }));
  }
}
