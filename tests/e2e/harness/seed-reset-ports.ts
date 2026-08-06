/**
 * E006: the port surface `seed-reset.ts`'s core logic depends on. Every method here is either an
 * existing O006 (registration probe) port re-exported for reuse, or (for `sourceControl`) the
 * exact narrow slice of the existing `SourceControlPort` this module needs. This file defines no
 * new mutation semantics of its own -- seeding/reset only ever calls a method some other, already
 * -reviewed part of `src/**` already exposes; see `seed-reset-adapters.ts` for how these are
 * wired to real adapters in production, and each unit test's fakes for how they are wired in
 * tests.
 */
import type {
  RegistrationProbeBranchCleanupPort,
  RegistrationProbeGitHubCapabilityPort,
  RegistrationProbeGitPort,
  RegistrationProbeLinearPort,
  RegistrationProbeLinearTarget,
} from "../../../src/application/ports/index.js";
import type {
  AsyncPortResult,
  MutationOptions,
  ReadOptions,
} from "../../../src/application/ports/common.js";
import type { GitRepositoryRef, GitWorktree } from "../../../src/application/ports/git.js";
import type { ChangeRequestSnapshot } from "../../../src/application/ports/source-control.js";

export type SeedResetLinearPort = RegistrationProbeLinearPort;
export type SeedResetGitPort = RegistrationProbeGitPort;

/** Only the two draft-PR lifecycle operations E006 needs, narrowed from `SourceControlPort`. */
export interface SeedResetSourceControlPort {
  createDraftChangeRequest(
    command: Readonly<{
      repository: string;
      title: string;
      body: string;
      baseBranch: string;
      headBranch: string;
    }>,
    options: MutationOptions,
  ): AsyncPortResult<ChangeRequestSnapshot>;
  closeChangeRequest(
    reference: Readonly<{ repository: string; changeRequestId: string }>,
    options: MutationOptions,
  ): AsyncPortResult<ChangeRequestSnapshot>;
}

export type SeedResetGithubReadPort = Pick<
  RegistrationProbeGitHubCapabilityPort,
  "findDraftPullRequestByHead"
>;

/** E006b: the exact same port O006 uses for its own probe-branch delete, injected here with an
 * independent instance scoped to E006's own `agent-team/e2e/` namespace (see
 * seed-reset-adapters.ts) -- never the O006 production instance, never able to touch a branch in
 * O006's `agent-team/probe/` namespace. */
export type SeedResetBranchCleanupPort = RegistrationProbeBranchCleanupPort;

export interface SeedResetPorts {
  readonly linear: SeedResetLinearPort;
  readonly git: SeedResetGitPort;
  readonly sourceControl: SeedResetSourceControlPort;
  readonly github: SeedResetGithubReadPort;
  readonly branchCleanup: SeedResetBranchCleanupPort;
}

export type {
  GitRepositoryRef,
  GitWorktree,
  MutationOptions,
  ReadOptions,
  RegistrationProbeLinearTarget,
};
