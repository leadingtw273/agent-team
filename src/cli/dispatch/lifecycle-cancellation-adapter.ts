/**
 * E115cap: closes the two gaps a read-only survey found in the Linear-cancellation lifecycle path
 * (`LifecyclePipeline.#handleCancellation`, src/application/pipelines/lifecycle.ts):
 *
 * 1. `JobProgressLifecycleCancellationAdapter.prepare()` used to *always* report
 *    `checkpoint:"not_required"` -- correct at the time (C015c item 5's own header explained why:
 *    the request it received then carried no `jobId`/`requirementSnapshot`/`worktree` context to
 *    honestly build a real F008 `Checkpoint` from), but that context gap is now closed:
 *    `LifecycleCancellationPort.prepare()`'s request carries the full `issue: Issue`
 *    `LifecyclePipeline.run()` already fetched and matched (lifecycle-model.ts's own header), and
 *    the single non-terminal `FileJobProgressStore` record this adapter finds for the cancelled
 *    issue supplies `jobId`/`worktreePath` -- everything `checkpointSchema`
 *    (src/domain/checkpoint/schema.ts) requires. This adapter now really persists a `Checkpoint`
 *    via a `CheckpointPersistencePort` (the same port `ScopeOverrunCheckpointAdapter`/
 *    `ReviewerCheckpointAdapter`/`CiRecoveryCheckpointAdapter` already use) and reports
 *    `checkpoint:"preserved"` with a real `checkpointId` -- never fabricated, and never claimed on
 *    a persistence failure (every `checkpointSchema.safeParse`/`persist()` failure fails this whole
 *    `prepare()` call closed via `err(...)`, exactly like every other checkpoint adapter in this
 *    codebase).
 * 2. Neither this port nor the CLI's own `dispatch resolve --as cancelled` path ever released a
 *    `Lease` (only the admission claim, a different concept). `LeaseCoordinatorLifecycleLeaseReleaseAdapter`
 *    below implements the new, separate `LifecycleLeaseReleasePort` -- `#handleCancellation` calls
 *    it strictly *after* closing the PR (see that method's own comment for why the ordering
 *    matters), so this file deliberately keeps it a distinct class from the cancellation-prepare
 *    adapter above rather than folding it into `prepare()`.
 *
 * Judgment calls made here (disclosed, not hidden):
 * - `worktree.branch`/`worktree.commitSha` are taken from `request.changeRequest.headBranch`/
 *   `.headSha` (the authoritative GitHub readback `LifecyclePipeline.run()` already performed just
 *   before dispatching here), never from the job-progress record's own optional `headSha` --
 *   `ChangeRequestSnapshot.headSha` is guaranteed present and, by construction, already pushed to
 *   the remote, which is also the honest basis for `worktree.pushed: true`.
 * - `worktree.path` comes from the job-progress record's own `worktreePath` -- nothing else in this
 *   adapter's reach knows the local checkout path.
 * - `model` is the same fixed `{provider:"dispatch-cli", model:"unassigned"}` placeholder every
 *   other checkpoint adapter in this codebase uses (scope-checkpoint.ts, reviewer-checkpoint.ts,
 *   ci-recovery-checkpoint.ts), not the job-progress record's own `model` string -- that field has
 *   no `provider` half at all, and inventing one would itself be exactly the kind of fabrication
 *   this ticket's own spec forbids ("不得塞假... 湊 schema").
 * - `reason: "manual"` -- an explicit human cancellation, not a system-detected safety/quota/crash
 *   condition, so this is the one existing `checkpointReasonSchema` member that says that honestly.
 * - Exactly one non-terminal job-progress record for the cancelled issue is the expected, normal
 *   case (the lease-acquisition invariant elsewhere in this codebase, `canAcquireLease`, already
 *   keys "one active holder" off `issueId`). Zero such records is handled as before (nothing active
 *   to checkpoint -> `checkpoint:"not_required"`, still honest). More than one is treated as a
 *   genuine invariant violation and fails this call closed *before* touching any record -- picking
 *   one arbitrarily to checkpoint while silently stopping the other(s) with no checkpoint at all
 *   would itself be a silent, undisclosed data loss.
 */
import {
  createClock,
  domainError,
  err,
  generateDeterministicIdentifier,
  generateIdentifier,
  ok,
  type Clock,
} from "../../domain/foundation/index.js";
import { checkpointSchema } from "../../domain/checkpoint/index.js";
import { createRequirementSnapshot } from "../../domain/review/index.js";
import type { CheckpointPersistencePort } from "../../application/checkpoint/index.js";
import type { LeaseCoordinator } from "../../application/leases/index.js";
import type {
  LifecycleCancellationPort,
  LifecycleLeaseReleasePort,
} from "../../application/pipelines/index.js";
import type { FileJobProgressStore } from "../../adapters/dispatch/index.js";

export interface JobProgressLifecycleCancellationAdapterOptions {
  readonly progress: FileJobProgressStore;
  readonly store: CheckpointPersistencePort;
  readonly clock?: Clock;
}

const terminalStages = new Set(["completed", "failed", "requires_manual"]);

const cancellationCheckpointNextSteps = Object.freeze([
  "使用者已於 Linear 明確取消此工單，如需復航請人工檢視 branch/worktree 後決定是否重新指派。",
]);

export class JobProgressLifecycleCancellationAdapter implements LifecycleCancellationPort {
  readonly #progress: FileJobProgressStore;
  readonly #store: CheckpointPersistencePort;
  readonly #clock: Clock;

  constructor(options: JobProgressLifecycleCancellationAdapterOptions) {
    this.#progress = options.progress;
    this.#store = options.store;
    this.#clock = options.clock ?? createClock();
  }

  async prepare(
    request: Parameters<LifecycleCancellationPort["prepare"]>[0],
    options: Parameters<LifecycleCancellationPort["prepare"]>[1],
  ): ReturnType<LifecycleCancellationPort["prepare"]> {
    const issueId = generateDeterministicIdentifier("issue", request.externalIssueId);
    if (!issueId.ok) return err(domainError("invariant_violation"));
    if (request.issue.id !== issueId.value || request.issue.projectId !== request.project.id) {
      return err(domainError("invariant_violation"));
    }

    const records = await this.#progress.listForProject(request.project.id);
    if (!records.ok) return records;
    const mine = records.value.filter(
      (record) => record.issueId === issueId.value && !terminalStages.has(record.stage.kind),
    );
    // See this file's own header: more than one active job for the same issue is an invariant
    // violation this adapter refuses to resolve by guessing -- fail closed before mutating anything.
    if (mine.length > 1) return err(domainError("invariant_violation"));

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
        stage: {
          kind: "requires_manual",
          cause: {
            stage: "merge",
            reasonCode:
              request.changeRequest.state === "merged"
                ? "cancellation_after_merge"
                : "work_item_canceled",
            attempts: { count: 1 },
          },
        },
      });
      if (!transitioned.ok) return transitioned;
    }

    const [activeJob] = mine;
    if (activeJob === undefined) {
      return ok(Object.freeze({ activeWorkStopped: true, checkpoint: "not_required" as const }));
    }

    const checkpointId = generateIdentifier("checkpoint");
    if (!checkpointId.ok) return err(domainError("invariant_violation"));
    const now = this.#clock.now();
    const requirementSnapshot = createRequirementSnapshot(request.issue, now);
    if (!requirementSnapshot.ok) return err(domainError("invariant_violation"));

    const checkpoint = checkpointSchema.safeParse({
      schemaVersion: 1,
      id: checkpointId.value,
      projectId: activeJob.projectId,
      issueId: activeJob.issueId,
      jobId: activeJob.jobId,
      createdAt: now,
      reason: "manual" as const,
      completedItems: [],
      remainingItems: [],
      tests: [],
      nextSteps: cancellationCheckpointNextSteps,
      blockers: [],
      requirementSnapshot: requirementSnapshot.value,
      model: { provider: "dispatch-cli", model: "unassigned" },
      worktree: {
        path: activeJob.worktreePath,
        branch: request.changeRequest.headBranch,
        commitSha: request.changeRequest.headSha,
        pushed: true,
      },
    });
    if (!checkpoint.success) return err(domainError("invariant_violation"));

    const persisted = await this.#store.persist(checkpoint.data, {
      idempotencyKey: `${options.idempotencyKey}:checkpoint`,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!persisted.ok) return persisted;

    return ok(
      Object.freeze({
        activeWorkStopped: true,
        checkpoint: "preserved" as const,
        checkpointId: checkpoint.data.id,
      }),
    );
  }
}

export interface LeaseCoordinatorLifecycleLeaseReleaseAdapterOptions {
  readonly leases: LeaseCoordinator;
}

/**
 * See this file's own header (point 2). Finds the still-un-released lease for the cancelled
 * issue (if any) directly off `LeaseCoordinator.repository` -- `leaseId`/`holderId` are read from
 * that lease's own record, never guessed or threaded through from elsewhere, so this never needs
 * (and never invents) a `holderId` of its own.
 */
export class LeaseCoordinatorLifecycleLeaseReleaseAdapter implements LifecycleLeaseReleasePort {
  readonly #leases: LeaseCoordinator;

  constructor(options: LeaseCoordinatorLifecycleLeaseReleaseAdapterOptions) {
    this.#leases = options.leases;
  }

  async release(
    request: Parameters<LifecycleLeaseReleasePort["release"]>[0],
    _options: Parameters<LifecycleLeaseReleasePort["release"]>[1],
  ): ReturnType<LifecycleLeaseReleasePort["release"]> {
    void _options;
    const issueId = generateDeterministicIdentifier("issue", request.externalIssueId);
    if (!issueId.ok) return err(domainError("invariant_violation"));

    const leases = await this.#leases.repository.readAll();
    if (!leases.ok) return leases;
    const unreleased = leases.value.filter(
      (lease) => lease.issueId === issueId.value && lease.releasedAt === undefined,
    );
    if (unreleased.length === 0) return ok(Object.freeze({ released: false }));
    // Same fail-closed discipline as `prepare()` above: `canAcquireLease` keys "one active holder"
    // off `issueId`, so more than one still-un-released lease for the same issue is an invariant
    // violation this adapter refuses to resolve by guessing which one to release.
    if (unreleased.length > 1) return err(domainError("invariant_violation"));

    const lease = unreleased[0];
    if (lease === undefined) return err(domainError("invariant_violation"));
    const released = await this.#leases.release({ leaseId: lease.id, holderId: lease.holderId });
    if (!released.ok) return released;
    // `LeaseTransactionReceipt.persistence` is `"unchanged"` exactly when `LeaseCoordinator`'s own
    // `release()` found the lease already released (a genuine idempotent no-op, not a failure) --
    // see `FileLeaseRepository.transact` (src/infrastructure/leases/file-repository.ts).
    return ok(Object.freeze({ released: released.value.persistence !== "unchanged" }));
  }
}
