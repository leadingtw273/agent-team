/**
 * C015x decision 1: resolves the *authoritative* base revision a fresh dispatch pins its worktree
 * `startPoint`/diff-digest `baseRevision` to. The coordinator's own root-cause finding (this
 * ticket): the real BEHIND incident was never caused by "main advances between dispatches" -- it
 * was caused by `handlers.ts` pinning that base to whatever the *local* clone's checked-out `HEAD`
 * happened to be (`LocalGitAdapter.inspectRepository(...).headSha`), and this project's own local
 * clone never re-syncs that on its own. Five explicit steps, each fail-closed (never guesses, never
 * silently falls back to a stale local ref):
 *
 * ① read GitHub's own live `default_branch` for this repository (`GitHubAdapter.getRepositoryMetadata`,
 *    adapter-only -- this port has no GitHub access) and verify it matches what the project's own
 *    local config (`Project.defaultBranch`) claims -- a live cross-check, never assumed;
 * ② confirm the local `remote` (`"origin"`) genuinely resolves to the same repository
 *    (`GitPort.resolveAuthoritativeBranch`'s own step ②) -- never assumed either;
 * ③ force-fetch that branch's ref into `refs/remotes/<remote>/<branch>` (a real `git fetch`, not
 *    `ls-remote` -- the commit must be physically present locally, not merely known by SHA, because
 *    `createWorktree`'s `startPoint` and `getEffectiveTreeDiff`'s `baseRevision` both need the real
 *    object);
 * ④ resolve that ref's SHA;
 * ⑤ confirm the object is genuinely present as a commit in the local object store.
 *
 * Steps ②-⑤ all happen inside the one `GitPort.resolveAuthoritativeBranch` call; step ① happens
 * here, before it, since only this CLI layer has both a `GitHubAdapter` and the trusted
 * `Project.defaultBranch` to compare against.
 */
import type { GitHubAdapter } from "../../adapters/github/index.js";
import type { GitPort } from "../../application/ports/git.js";
import { err, ok, type DomainError, type Result } from "../../domain/foundation/index.js";
import type { Project } from "../../domain/project/index.js";

export interface AuthoritativeBaseRevision {
  readonly baseRevision: string;
  readonly defaultBranch: string;
}

export type AuthoritativeBaseFailure =
  | Readonly<{ reason: "default_branch_metadata_unavailable"; error: DomainError }>
  | Readonly<{
      reason: "default_branch_mismatch";
      githubDefaultBranch: string;
      configuredDefaultBranch: string;
    }>
  | Readonly<{ reason: "authoritative_branch_unavailable"; error: DomainError }>;

export interface ResolveAuthoritativeBaseRevisionOptions {
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
}

/** Injectable seam for tests -- production always passes a real `GitHubAdapter`/`LocalGitAdapter`
 * (see handlers.ts's own precedent comment on why constructing a fresh, stateless adapter instance
 * per call is cheap and deliberate, not a hack). */
export interface ResolveAuthoritativeBaseRevisionPorts {
  readonly git: Pick<GitPort, "resolveAuthoritativeBranch">;
  readonly sourceControl: Pick<GitHubAdapter, "getRepositoryMetadata">;
}

export async function resolveAuthoritativeBaseRevision(
  project: Project,
  ports: ResolveAuthoritativeBaseRevisionPorts,
  options: ResolveAuthoritativeBaseRevisionOptions,
): Promise<Result<AuthoritativeBaseRevision, AuthoritativeBaseFailure>> {
  // Step ①.
  const metadata = await ports.sourceControl.getRepositoryMetadata(
    { project },
    options.signal === undefined ? {} : { signal: options.signal },
  );
  if (!metadata.ok) {
    return err({ reason: "default_branch_metadata_unavailable", error: metadata.error });
  }
  if (metadata.value.defaultBranch !== project.defaultBranch) {
    return err({
      reason: "default_branch_mismatch",
      githubDefaultBranch: metadata.value.defaultBranch,
      configuredDefaultBranch: project.defaultBranch,
    });
  }

  // Steps ②-⑤.
  const resolved = await ports.git.resolveAuthoritativeBranch(
    {
      rootPath: project.localRepositoryPath,
      remote: "origin",
      branch: project.defaultBranch,
      expectedRepository: project.sourceControl.repository,
    },
    { idempotencyKey: options.idempotencyKey, ...(options.signal === undefined ? {} : { signal: options.signal }) },
  );
  if (!resolved.ok) {
    return err({ reason: "authoritative_branch_unavailable", error: resolved.error });
  }

  return ok({ baseRevision: resolved.value.sha, defaultBranch: project.defaultBranch });
}
