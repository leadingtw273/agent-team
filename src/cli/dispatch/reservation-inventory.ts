import type {
  JobProgressRecord,
  JobProgressRecordMutation,
} from "../../adapters/dispatch/job-progress-store.js";
import type { RepositoryReservation } from "../../application/dispatch/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import type { ChangeRegion } from "../../domain/project/index.js";

export interface ReservationProgressPort {
  listForProject(projectId: string): Promise<Result<readonly JobProgressRecord[], DomainError>>;
  compareAndSwap(
    jobId: string,
    expectedRevision: number,
    next: JobProgressRecordMutation,
  ): Promise<Result<JobProgressRecord, DomainError>>;
}

export interface BuildRepositoryReservationInventoryOptions {
  readonly projectId: string;
  readonly repositoryId: string;
  readonly progress: ReservationProgressPort;
  readonly readDeclaredRegions: (
    externalIssueId: string,
  ) => Promise<Result<readonly ChangeRegion[] | undefined, DomainError>>;
  /** A dry-run derives the same conservative inventory but never freezes a legacy snapshot. */
  readonly persistLegacySnapshots: boolean;
}

const terminalStages = new Set(["completed", "superseded", "cancelled"]);

function reservationStage(record: JobProgressRecord): RepositoryReservation["stage"] {
  switch (record.stage.kind) {
    case "merging":
      return "merge";
    case "ci_waiting":
    case "ci_pending_retry":
      return "ci";
    case "awaiting_review":
    case "reviewer_waiting":
    case "review_pending_retry":
    case "review_report_pending_retry":
      return "review";
    default:
      return "implementation";
  }
}

function mutation(record: JobProgressRecord): JobProgressRecordMutation {
  const {
    schemaVersion: _schemaVersion,
    revision: _revision,
    updatedAt: _updatedAt,
    ...next
  } = record;
  void _schemaVersion;
  void _revision;
  void _updatedAt;
  return next;
}

export async function buildRepositoryReservationInventory(
  options: BuildRepositoryReservationInventoryOptions,
): Promise<Result<readonly RepositoryReservation[], DomainError>> {
  const listed = await options.progress.listForProject(options.projectId);
  if (!listed.ok) return listed;

  const reservations: RepositoryReservation[] = [];
  for (const record of listed.value) {
    if (terminalStages.has(record.stage.kind)) continue;

    let snapshot = record.admissionReservation;
    if (snapshot === undefined) {
      const readBack = await options.readDeclaredRegions(record.externalIssueId);
      snapshot = {
        repositoryId: options.repositoryId,
        ...(readBack.ok && readBack.value !== undefined && readBack.value.length > 0
          ? { declaredRegions: [...readBack.value] }
          : {}),
      };

      if (
        options.persistLegacySnapshots &&
        readBack.ok &&
        readBack.value !== undefined &&
        readBack.value.length > 0
      ) {
        const persisted = await options.progress.compareAndSwap(record.jobId, record.revision, {
          ...mutation(record),
          admissionReservation: snapshot,
        });
        if (!persisted.ok) return err(persisted.error);
        snapshot = persisted.value.admissionReservation;
        if (snapshot === undefined) return err(domainError("invariant_violation"));
      }
    }

    reservations.push(
      Object.freeze({
        jobId: record.jobId,
        projectId: record.projectId,
        repositoryId: snapshot.repositoryId,
        stage: reservationStage(record),
        ...(snapshot.declaredRegions === undefined
          ? {}
          : { declaredRegions: snapshot.declaredRegions }),
      }),
    );
  }

  return ok(Object.freeze(reservations));
}
