import type {
  WorkStatusLifecycleCheckpoint,
  WorkStatusLifecycleLedgerPort,
  WorkStatusLifecycleLedgerSnapshot,
} from "../../application/pipelines/work-status-lifecycle-model.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import { FileJobProgressStore } from "./job-progress-store.js";

/** Projects the optional lifecycle checkpoint through the existing per-Job CAS record. */
export class JobProgressWorkStatusLifecycleLedger implements WorkStatusLifecycleLedgerPort {
  constructor(readonly progress: FileJobProgressStore) {}

  async load(
    jobId: string,
  ): Promise<Result<WorkStatusLifecycleLedgerSnapshot | undefined, DomainError>> {
    const loaded = await this.progress.load(jobId);
    if (!loaded.ok) return loaded;
    if (loaded.value?.workStatusLifecycle === undefined) return ok(undefined);
    return ok({ revision: loaded.value.revision, checkpoint: loaded.value.workStatusLifecycle });
  }

  async compareAndSwap(
    jobId: string,
    expectedRevision: number,
    checkpoint: WorkStatusLifecycleCheckpoint,
  ): Promise<Result<WorkStatusLifecycleLedgerSnapshot, DomainError>> {
    const loaded = await this.progress.load(jobId);
    if (!loaded.ok) return loaded;
    if (loaded.value?.revision !== expectedRevision) {
      return err(domainError("conflict"));
    }
    const {
      schemaVersion: _schemaVersion,
      revision: _revision,
      updatedAt: _updatedAt,
      ...mutation
    } = loaded.value;
    void _schemaVersion;
    void _revision;
    void _updatedAt;
    const written = await this.progress.compareAndSwap(jobId, expectedRevision, {
      ...mutation,
      workStatusLifecycle: checkpoint,
    });
    if (!written.ok) return written;
    if (written.value.workStatusLifecycle === undefined) {
      return err(domainError("invariant_violation"));
    }
    return ok({ revision: written.value.revision, checkpoint: written.value.workStatusLifecycle });
  }
}
