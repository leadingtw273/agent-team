import type { EffectiveTreeChange } from "../../domain/review/index.js";
import type { AsyncPortResult, MutationOptions, ReadOptions } from "./common.js";

export interface GitRepositoryRef {
  readonly rootPath: string;
}

export interface GitRepositorySnapshot extends GitRepositoryRef {
  readonly headSha: string;
  readonly branch: string;
  readonly clean: boolean;
}

export interface GitWorktree {
  readonly repositoryRoot: string;
  readonly path: string;
  readonly branch: string;
  readonly headSha: string;
}

export interface GitWorkingTreeChange {
  readonly path: string;
  readonly previousPath?: string;
  readonly kind: "added" | "modified" | "deleted" | "renamed" | "untracked";
  readonly mode: "file" | "executable" | "symlink" | "submodule";
  readonly staged: boolean;
}

export interface GitWorkingTreeSnapshot {
  readonly headSha: string;
  readonly changes: readonly GitWorkingTreeChange[];
}

export interface ReadGitTextFileCommand extends GitRepositoryRef {
  readonly revision: string;
  readonly path: string;
  readonly maxBytes: number;
}

export interface GitTextFileAtRevision {
  readonly revisionSha: string;
  readonly path: string;
  readonly content: string;
  readonly byteLength: number;
}

export interface CreateWorktreeCommand extends GitRepositoryRef {
  readonly path: string;
  readonly branch: string;
  readonly startPoint: string;
}

/**
 * C015x decision 1: request shape for resolving a branch's *authoritative* head -- the coordinator's
 * own root-cause finding was that `handlers.ts` previously pinned a fresh dispatch's worktree
 * `startPoint`/diff-digest `baseRevision` to whatever the *local* clone's checked-out `HEAD`
 * happened to be (`inspectRepository(...).headSha`), which this project's own local clone never
 * re-syncs on its own -- not to the remote's actual current state. `expectedRepository` ("owner/repo")
 * is never assumed to match the local `origin` remote; `LocalGitAdapter.resolveAuthoritativeBranch`
 * must verify it against the remote's own URL before ever fetching, and fail closed (`"conflict"`)
 * if it does not.
 */
export interface AuthoritativeBranchRequest extends GitRepositoryRef {
  readonly remote: string;
  readonly branch: string;
  readonly expectedRepository: string;
}

export interface AuthoritativeBranchHead {
  readonly remote: string;
  readonly branch: string;
  readonly sha: string;
}

export interface GitCommitReceipt {
  readonly sha: string;
  readonly branch: string;
}

export interface GitCommitSnapshot {
  readonly sha: string;
  readonly treeSha: string;
  readonly parentShas: readonly string[];
  readonly message: string;
}

export interface GitCommitCommand {
  readonly worktree: GitWorktree;
  readonly message: string;
  readonly expectedStagedPaths: readonly string[];
}

export interface GitPushReceipt {
  readonly remote: string;
  readonly branch: string;
  readonly sha: string;
}

export interface GitPort {
  inspectRepository(
    repository: GitRepositoryRef,
    options?: ReadOptions,
  ): AsyncPortResult<GitRepositorySnapshot>;
  /**
   * C015x decision 1: steps ②-⑤ of the coordinator's authoritative-base-resolution design --
   * confirm the local `remote`'s URL genuinely resolves to `expectedRepository`, force-fetch
   * `branch` into `refs/remotes/<remote>/<branch>` (a real `git fetch`, never `ls-remote` --
   * `createWorktree`'s `startPoint` and `getEffectiveTreeDiff`'s `baseRevision` both need the
   * commit object physically present locally, not merely known by SHA), then resolve and confirm
   * that ref as a real, locally-present commit. Step ① (verifying GitHub's own `default_branch`
   * against `expectedRepository`/`branch`) is the *caller's* job (this port has no GitHub access) --
   * see `resolveAuthoritativeBaseRevision` (src/cli/dispatch/authoritative-base.ts).
   */
  resolveAuthoritativeBranch(
    request: AuthoritativeBranchRequest,
    options: MutationOptions,
  ): AsyncPortResult<AuthoritativeBranchHead>;
  createWorktree(
    command: CreateWorktreeCommand,
    options: MutationOptions,
  ): AsyncPortResult<GitWorktree>;
  inspectWorktree(
    worktree: GitWorktree,
    options?: ReadOptions,
  ): AsyncPortResult<GitRepositorySnapshot>;
  inspectWorkingTree(
    worktree: GitWorktree,
    options?: ReadOptions,
  ): AsyncPortResult<GitWorkingTreeSnapshot>;
  readTextFileAtRevision(
    command: ReadGitTextFileCommand,
    options?: ReadOptions,
  ): AsyncPortResult<GitTextFileAtRevision>;
  stagePaths(
    worktree: GitWorktree,
    paths: readonly string[],
    options: MutationOptions,
  ): AsyncPortResult<GitWorkingTreeSnapshot>;
  getEffectiveTreeDiff(
    repository: GitRepositoryRef,
    baseRevision: string,
    headRevision: string,
    options?: ReadOptions,
  ): AsyncPortResult<readonly EffectiveTreeChange[]>;
  getStagedTreeDiff(
    worktree: GitWorktree,
    baseRevision: string,
    options?: ReadOptions,
  ): AsyncPortResult<readonly EffectiveTreeChange[]>;
  inspectCommit(
    repository: GitRepositoryRef,
    revision: string,
    options?: ReadOptions,
  ): AsyncPortResult<GitCommitSnapshot>;
  commit(command: GitCommitCommand, options: MutationOptions): AsyncPortResult<GitCommitReceipt>;
  push(
    worktree: GitWorktree,
    remote: string,
    options: MutationOptions,
  ): AsyncPortResult<GitPushReceipt>;
  removeWorktree(worktree: GitWorktree, options: MutationOptions): AsyncPortResult<void>;
}
