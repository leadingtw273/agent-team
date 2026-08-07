/**
 * C015e: the real `LocalGitAdapter.createWorktree` (src/adapters/git/local.ts) requires the
 * worktree target's *parent* directory to already exist -- `canonicalFuturePath` returns
 * `undefined` for a non-existent parent, which `createWorktree` maps to `failure("conflict")`.
 * Nothing in the dispatch composition ever created `${agentTeamHome}/state/dispatch/worktrees`
 * (E101's second real run died here, `stage:"worktree"`, on a genuinely fresh
 * `${AGENT_TEAM_HOME}` -- `grep -rn mkdir src/cli/dispatch` found zero hits before this fix).
 * This is the exact same gap `ensureWorktreeDirectories` (src/cli/registration/
 * setup-composition.ts) already exists to close for the registration-setup worktree tree, never
 * ported over to dispatch.
 *
 * Every segment is created (and `chmod`'d) explicitly at 0700, mirroring that same file's own
 * reasoning: an already-existing ancestor directory with looser permissions would leave the
 * shared `state` parent non-0700 and break every later secure-directory read/write under it, so
 * relying on `mkdir`'s own `mode` option alone (which the umask can weaken, and which does
 * nothing for a directory that already exists) is not enough -- each segment's mode is forced
 * with a follow-up `chmod`.
 *
 * Only ever called from mutation paths that are about to hand a worktree to a real pipeline (a
 * genuine, non-`--dry-run` dispatch about to run `ImplementerPipeline`; a resume cycle about to
 * hand a worktree to `CiRecoveryPipeline`/`ReviewerPipeline`) -- never from `--dry-run` or any
 * read-only path, matching this codebase's existing "read-only commands never write to disk"
 * discipline.
 */
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";

/** Must stay in exact sync with `buildImplementerPipelineRequest`'s own `worktreePath`
 * derivation (src/cli/dispatch/implementer-request.ts) -- both compute
 * `${agentTeamHome}/state/dispatch/worktrees/<jobId>`; this function only needs the parent. */
export function dispatchWorktreesDirectory(agentTeamHome: string): string {
  return join(agentTeamHome, "state", "dispatch", "worktrees");
}

export async function ensureDispatchWorktreesDirectory(
  agentTeamHome: string,
): Promise<Result<void, DomainError>> {
  const stateRoot = join(agentTeamHome, "state");
  const directories = [
    stateRoot,
    join(stateRoot, "dispatch"),
    dispatchWorktreesDirectory(agentTeamHome),
  ];
  try {
    for (const directory of directories) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }
    return ok(undefined);
  } catch {
    return err(domainError("external_failure"));
  }
}
