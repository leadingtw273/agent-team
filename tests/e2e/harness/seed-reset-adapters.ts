/**
 * E006: wires `SeedResetPorts` (seed-reset-ports.ts) to the real, already-existing production
 * adapters -- the exact same classes O006's own composition root
 * (src/cli/registration/probe-composition.ts) wires up for the registration probe, reused here
 * unmodified. This is the only file in the E006 harness family that touches Linear/GitHub/git for
 * real; every unit/integration test for seed-reset.ts injects a fake `SeedResetPorts` instead.
 */
import {
  RegistrationProbeBranchCleanupAdapter,
  RegistrationProbeGitAdapter,
  RegistrationProbeGitHubCapabilityAdapter,
  RegistrationProbeLinearAdapter,
} from "../../../src/adapters/registration/index.js";
import {
  GhTransport,
  GitHubAdapter,
  type GhJsonTransport,
} from "../../../src/adapters/github/index.js";
import {
  LinearGraphqlTransport,
  LinearMutationClient,
  LinearReadModel,
} from "../../../src/adapters/linear/index.js";
import type { MutationOptions } from "../../../src/application/ports/common.js";
import { placeholderProjectFor } from "./placeholder-project.js";
import { e2eBranchPrefix } from "./seed-reset.js";
import type { SeedResetPorts, SeedResetSourceControlPort } from "./seed-reset-ports.js";

function buildSourceControlPort(github: GitHubAdapter): SeedResetSourceControlPort {
  return {
    async createDraftChangeRequest(command, options: MutationOptions) {
      const created = await github.createDraftChangeRequest(
        {
          project: placeholderProjectFor(command.repository),
          title: command.title,
          body: command.body,
          baseBranch: command.baseBranch,
          headBranch: command.headBranch,
        },
        options,
      );
      return created;
    },
    async closeChangeRequest(reference, options: MutationOptions) {
      return github.closeChangeRequest(
        {
          project: placeholderProjectFor(reference.repository),
          changeRequestId: reference.changeRequestId,
        },
        options,
      );
    },
  };
}

/** Same shape as O006's own `probe-composition.ts` -- `RegistrationProbeGitHubCapabilityAdapter`
 * needs strictly more of `GhTransport` than the plain `requestJson`-only `GhJsonTransport`
 * `GitHubAdapter` is satisfied with. */
type SeedResetGithubTransport = GhJsonTransport &
  Pick<GhTransport, "inspectAuthentication" | "inspectRepositoryCapabilities" | "requestVoid">;

export interface BuildProductionSeedResetPortsOptions {
  readonly linearApiKey: string;
  readonly githubTransport?: SeedResetGithubTransport;
  readonly linearFetch?: typeof fetch;
}

/**
 * Assembles `SeedResetPorts` from the real O006-era adapters this codebase already has:
 * `RegistrationProbeLinearAdapter` over a real `LinearGraphqlTransport`+`LinearMutationClient`,
 * `RegistrationProbeGitAdapter` over the real local `git` binary, `RegistrationProbeGitHubCapabilityAdapter`
 * for the marker-verified draft-PR readback, and `GitHubAdapter` (narrowed) for the draft-PR
 * create/close mutations themselves.
 */
export function buildProductionSeedResetPorts(
  options: BuildProductionSeedResetPortsOptions,
): SeedResetPorts {
  const linearTransport = new LinearGraphqlTransport({
    apiKey: options.linearApiKey,
    ...(options.linearFetch === undefined ? {} : { fetch: options.linearFetch }),
  });
  const linearReadModel = new LinearReadModel(linearTransport);
  const linearMutationClient = new LinearMutationClient(linearTransport, linearReadModel);
  const githubTransport = options.githubTransport ?? new GhTransport();
  const github = new GitHubAdapter(githubTransport);
  return Object.freeze({
    linear: new RegistrationProbeLinearAdapter(
      linearReadModel,
      linearMutationClient,
      linearTransport,
    ),
    git: new RegistrationProbeGitAdapter(),
    github: new RegistrationProbeGitHubCapabilityAdapter(githubTransport),
    sourceControl: buildSourceControlPort(github),
    // E006b: an independent instance, scoped to E006's own namespace -- never the O006
    // production instance (probe-composition.ts constructs its own, unparameterized, default-
    // scoped instance separately) and structurally unable to touch a branch outside
    // `agent-team/e2e/`.
    branchCleanup: new RegistrationProbeBranchCleanupAdapter(githubTransport, e2eBranchPrefix),
  });
}
