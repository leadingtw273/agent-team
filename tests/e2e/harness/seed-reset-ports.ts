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

export interface SeedResetPorts {
  readonly linear: SeedResetLinearPort;
  readonly git: SeedResetGitPort;
  readonly sourceControl: SeedResetSourceControlPort;
  readonly github: SeedResetGithubReadPort;
}

export type {
  GitRepositoryRef,
  GitWorktree,
  MutationOptions,
  ReadOptions,
  RegistrationProbeLinearTarget,
};
