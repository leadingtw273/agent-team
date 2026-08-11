import {
  type FileJobProgressStore,
  type JobProgressRecord,
} from "../../adapters/dispatch/job-progress-store.js";
import { ok, type DomainError, type Result } from "../../domain/foundation/index.js";
import { isResumeCandidate } from "../dispatch/resume-composition.js";

export type JobProgressDisposition = "resumable" | "blocked" | "terminal";

export interface JobProgressInventory {
  readonly resumable: readonly JobProgressRecord[];
  readonly blocked: readonly JobProgressRecord[];
  readonly terminal: readonly JobProgressRecord[];
}

export interface JobProgressInventoryCounts {
  readonly resumable: number;
  readonly blocked: number;
  readonly terminal: number;
  readonly total: number;
}

const terminalStageKinds: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "superseded",
  "cancelled",
]);

/**
 * Classifies a durable progress record without mutating it or consulting live providers.
 * Unknown future stages fail closed to `blocked`; a new stage can never become auto-resumable by
 * accident. The narrow merge read-back cases share dispatch's canonical eligibility predicate.
 */
export function classifyJobProgressRecord(record: JobProgressRecord): JobProgressDisposition {
  if (isResumeCandidate(record)) return "resumable";
  if (terminalStageKinds.has(record.stage.kind)) return "terminal";
  return "blocked";
}

/** Reads the progress directory once and returns three exhaustive, mutually-exclusive buckets. */
export async function readJobProgressInventory(
  store: Pick<FileJobProgressStore, "listAll">,
): Promise<Result<JobProgressInventory, DomainError>> {
  const loaded = await store.listAll();
  if (!loaded.ok) return loaded;

  const resumable: JobProgressRecord[] = [];
  const blocked: JobProgressRecord[] = [];
  const terminal: JobProgressRecord[] = [];
  for (const record of loaded.value) {
    switch (classifyJobProgressRecord(record)) {
      case "resumable":
        resumable.push(record);
        break;
      case "blocked":
        blocked.push(record);
        break;
      case "terminal":
        terminal.push(record);
        break;
    }
  }

  return ok(
    Object.freeze({
      resumable: Object.freeze(resumable),
      blocked: Object.freeze(blocked),
      terminal: Object.freeze(terminal),
    }),
  );
}

export function countJobProgressInventory(
  inventory: JobProgressInventory,
): JobProgressInventoryCounts {
  return Object.freeze({
    resumable: inventory.resumable.length,
    blocked: inventory.blocked.length,
    terminal: inventory.terminal.length,
    total: inventory.resumable.length + inventory.blocked.length + inventory.terminal.length,
  });
}
