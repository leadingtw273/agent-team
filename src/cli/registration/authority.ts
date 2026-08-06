import { createHash, randomUUID } from "node:crypto";

import type { RegistrationProbeAuthority } from "../../application/registration/index.js";
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
 * A stable runId lets a repeated `probe run` for the same project naturally resume the same
 * journal entry (the coordinator's own resume path keys off `journal.load(runId)`) instead of
 * colliding with a still-active prior run's `concurrent_run_exists` guard.
 */
export function deterministicRegistrationProbeRunId(
  projectId: string,
  registrationRevision: number,
): string {
  const digest = createHash("sha256")
    .update(`${projectId}:${String(registrationRevision)}`, "utf8")
    .digest("hex");
  return `probe-${digest.slice(0, 32)}`;
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
