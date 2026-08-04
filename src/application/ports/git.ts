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

export interface CreateWorktreeCommand extends GitRepositoryRef {
  readonly path: string;
  readonly branch: string;
  readonly startPoint: string;
}

export interface GitCommitReceipt {
  readonly sha: string;
  readonly branch: string;
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
  commit(command: GitCommitCommand, options: MutationOptions): AsyncPortResult<GitCommitReceipt>;
  push(
    worktree: GitWorktree,
    remote: string,
    options: MutationOptions,
  ): AsyncPortResult<GitPushReceipt>;
  removeWorktree(worktree: GitWorktree, options: MutationOptions): AsyncPortResult<void>;
}
