import { createHash, randomUUID } from "node:crypto";

import type {
  RegistrationProbeAuthority,
  RegistrationProbeJournalPort,
} from "../../application/registration/index.js";
import { ok, type DomainError, type Result } from "../../domain/foundation/index.js";
import type { Project } from "../../domain/project/index.js";

/**
 * Setup's controller context (`RegistrationSetupControllerContext.authorityDigest`) only needs
 * `digestPattern.test(...)` format validity *and*, within a single `setup approve` flow, the
 * exact same value across its issue-intent and merge calls (both durable writes compare a later
 * call's `authorityDigest` against what an earlier call in the same flow already persisted --
 * see setup.ts:526/710 and setup-durable.ts:1474/1662/1674). A fresh, opaque digest generated
 * once per CLI invocation and reused for the whole invocation satisfies both.
 */
export function freshAuthorityDigest(): string {
  return createHash("sha256").update(randomUUID(), "utf8").digest("hex");
}

/**
 * O005/O006 leave `registrationRevision` entirely caller-defined -- it exists only to bind an
 * authority and a journal run to "the same registration attempt", never derived from anything
 * the engine itself tracks. This CLI does not yet persist a per-project revision counter across
 * separate re-registrations of the *same* project, so it fixes the value at 1 for every probe
 * run. Documented CLI-level simplification, not an engine constraint: a host that re-runs Setup
 * for an already-activated project and needs a fresh probe "generation" is out of this task's
 * scope.
 */
export const fixedRegistrationRevision = 1;

/**
 * F-1 (2026-08-06 fresh-context acceptance review): a runId *deterministic* in projectId+revision
 * alone -- as this function used to be -- means every `probe run` for the same project computes
 * the exact same runId forever. The O006 coordinator persists `verified` (and would persist
 * `incomplete`) under that runId and, on any later `start()` call for the *same* runId, short-
 * circuits via `isTerminalCleanPhase` straight to `finalize(existing)` -- touching only
 * `journal.load`, invoking zero other ports -- before any preflight or revalidation step ever
 * runs (proactive-probe.ts's own `start()`: `if (... isTerminalCleanPhase(existing.value.phase))
 * return finalize(existing.value);`). That silently turned every `probe run` after the first into
 * a zero-mutation replay of a stale result -- exactly the failure mode `RUN FULL REVALIDATION` is
 * supposed to prevent. `freshRegistrationProbeRunId` must never be memoized/derived from stable
 * inputs; `resolveRegistrationProbeRunId` below is the only place a runId should come from.
 */
export function freshRegistrationProbeRunId(): string {
  return `probe-${randomUUID().replace(/-/gu, "")}`;
}

export interface ResolveRegistrationProbeRunIdResult {
  readonly runId: string;
  readonly resumed: boolean;
}

/**
 * F-1 fix: decides, from the journal's own `listActiveForProject` (already excludes terminal
 * `verified`/`incomplete` phases -- see `isTerminalCleanPhase` in proactive-probe-model.ts), which
 * runId this `probe run` invocation must use:
 *   - a non-terminal (still active, or `failed` with pending cleanup) run already exists for this
 *     project -> resume its *exact* runId (`resumed: true`), so the coordinator's own resume path
 *     picks it back up instead of colliding with `concurrent_run_exists`.
 *   - otherwise (including "the only prior run for this project is terminal") -> mint a genuinely
 *     fresh runId (`resumed: false`), guaranteeing the coordinator runs a full revalidation from
 *     scratch rather than replaying anything.
 */
export async function resolveRegistrationProbeRunId(
  journal: Pick<RegistrationProbeJournalPort, "listActiveForProject">,
  projectId: Project["id"],
): Promise<Result<ResolveRegistrationProbeRunIdResult, DomainError>> {
  const active = await journal.listActiveForProject(projectId);
  if (!active.ok) return active;
  const existing = active.value[0];
  return ok(
    existing === undefined
      ? { runId: freshRegistrationProbeRunId(), resumed: false }
      : { runId: existing.runId, resumed: true },
  );
}

/** Decision #2: the probe's human-trigger authority is always `user_conversation` for this CLI. */
export function buildRegistrationProbeAuthority(
  projectId: Project["id"],
  setupSessionId: string,
  registrationRevision: number,
): RegistrationProbeAuthority {
  return Object.freeze({
    schemaVersion: 1,
    source: "user_conversation",
    projectId,
    setupSessionId,
    registrationRevision,
  });
}
