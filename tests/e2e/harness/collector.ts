/**
 * E005: the core "collect from four sources, missing any one means not_green" logic. This file
 * knows nothing about Linear/GitHub/filesystem specifics -- it only calls the four ports it is
 * given and assembles the fixed-schema bundle. `ports.ts` wires the real, already-existing,
 * read-only adapters for production/integration/smoke use; unit tests inject fakes directly
 * satisfying `EvidenceCollectorPorts` below.
 */
import { createClock, type Clock } from "../../../src/domain/foundation/index.js";
import type { EvidenceCaseDescription } from "./case.js";
import {
  evidenceBundleSchema,
  finalizeEvidenceCollection,
  type CheckpointsEvidenceData,
  type EvidenceCollectionOutcome,
  type GithubEvidenceData,
  type LinearEvidenceData,
  type LocalEventsEvidenceData,
} from "./schema.js";

export type EvidenceSourceRead<Data> =
  | Readonly<{ ok: true; data: Data }>
  | Readonly<{ ok: false; reason: "read_error" | "not_found" | "empty_result" }>;

/**
 * One port per named source, each a plain read call over the case description. Every port here
 * must be read-only over Linear/GitHub -- see ports.ts's own doc comment for the exact adapters
 * this collector wraps in production, and the explicit "no create/update/delete" invariant.
 */
export interface EvidenceCollectorPorts {
  readonly linear: {
    read(
      linear: EvidenceCaseDescription["linear"],
    ): Promise<EvidenceSourceRead<LinearEvidenceData>>;
  };
  readonly github: {
    read(
      github: EvidenceCaseDescription["github"],
    ): Promise<EvidenceSourceRead<GithubEvidenceData>>;
  };
  readonly localEvents: {
    read(
      runId: string,
      timeWindow: EvidenceCaseDescription["timeWindow"],
    ): Promise<EvidenceSourceRead<LocalEventsEvidenceData>>;
  };
  readonly checkpoints: {
    read(
      linear: EvidenceCaseDescription["linear"],
      timeWindow: EvidenceCaseDescription["timeWindow"],
    ): Promise<EvidenceSourceRead<CheckpointsEvidenceData>>;
  };
}

async function collectSource<Data>(clock: Clock, read: () => Promise<EvidenceSourceRead<Data>>) {
  let result: EvidenceSourceRead<Data>;
  try {
    result = await read();
  } catch {
    // A port that throws instead of returning its own `{ok:false}` is still just "the read
    // failed" -- never let an unexpected exception escape as a crash and never fabricate
    // success. This mirrors the rest of the codebase's own "safely()" convention (see
    // proactive-probe.ts) applied at this harness's own boundary.
    result = { ok: false, reason: "read_error" };
  }
  const collectedAt = clock.now();
  return result.ok
    ? Object.freeze({ status: "present" as const, collectedAt, data: result.data })
    : Object.freeze({ status: "missing" as const, collectedAt, reason: result.reason });
}

export interface CollectEvidenceOptions {
  readonly clock?: Clock;
}

/**
 * Collects all four sources -- always all four, always independently, never short-circuiting on
 * an early miss -- and returns the fixed-schema bundle plus the green/not_green verdict.
 */
export async function collectEvidence(
  caseDescription: EvidenceCaseDescription,
  ports: EvidenceCollectorPorts,
  options: CollectEvidenceOptions = {},
): Promise<EvidenceCollectionOutcome> {
  const clock = options.clock ?? createClock();
  const [linear, github, localEvents, checkpoints] = await Promise.all([
    collectSource(clock, () => ports.linear.read(caseDescription.linear)),
    collectSource(clock, () => ports.github.read(caseDescription.github)),
    collectSource(clock, () =>
      ports.localEvents.read(caseDescription.runId, caseDescription.timeWindow),
    ),
    collectSource(clock, () =>
      ports.checkpoints.read(caseDescription.linear, caseDescription.timeWindow),
    ),
  ]);

  const bundle = evidenceBundleSchema.parse({
    schemaVersion: 1,
    caseId: caseDescription.caseId,
    runId: caseDescription.runId,
    assembledAt: clock.now(),
    linear,
    github,
    localEvents,
    checkpoints,
  });
  return finalizeEvidenceCollection(bundle);
}
