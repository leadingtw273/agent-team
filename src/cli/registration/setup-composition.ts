import { join } from "node:path";

import {
  createProductionRegistrationSetupComposition,
  GitHubPullRequestAuditCommentWriter,
  LinearIssueAuditCommentWriter,
  type ProductionRegistrationSetupComposition,
} from "../../adapters/registration/index.js";
import { GitHubAdapter, GhTransport, type GhJsonTransport } from "../../adapters/github/index.js";
import {
  LinearGraphqlTransport,
  LinearMutationClient,
  LinearReadModel,
} from "../../adapters/linear/index.js";
import { defaultRegistrationDraftPath, loadHostRegistrationSetupDraft } from "./draft-store.js";
import { readLinearApiKey } from "./secrets.js";

export type RegistrationSetupCompositionBlockedReason =
  | "draft_unavailable"
  | "linear_api_key_missing"
  | "github_authentication_unavailable"
  | "configuration_incomplete";

export type BuildRegistrationSetupCompositionResult =
  | Readonly<{ state: "ready"; composition: ProductionRegistrationSetupComposition }>
  | Readonly<{ state: "blocked"; reason: RegistrationSetupCompositionBlockedReason }>;

export interface BuildRegistrationSetupCompositionOptions {
  readonly agentTeamHome: string;
  readonly projectId: string;
  readonly draftPath?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Injectable for tests; production defaults to a real `gh`-shelling GhTransport. */
  readonly githubTransport?: GhJsonTransport & Pick<GhTransport, "inspectAuthentication">;
  /** Injectable for tests; production defaults to real fetch against the Linear GraphQL API. */
  readonly linearFetch?: typeof fetch;
}

/**
 * Production composition root for `registration setup *`. Assembles nothing new: every adapter
 * here is either the O005 `createProductionRegistrationSetupComposition` itself, or one of the
 * two O009 thin audit-writer adapters (setup-audit-linear.ts / setup-audit-pull-request.ts).
 * Every failure to reach a "ready" composition is reported as a distinct, non-overlapping
 * `blocked` reason -- and crucially, each check below short-circuits *before* constructing the
 * next dependency, so a missing draft file never even touches the network, and a missing
 * LINEAR_API_KEY never calls `gh`.
 */
export async function buildRegistrationSetupComposition(
  options: BuildRegistrationSetupCompositionOptions,
): Promise<BuildRegistrationSetupCompositionResult> {
  const draftPath =
    options.draftPath ?? defaultRegistrationDraftPath(options.agentTeamHome, options.projectId);
  const draft = await loadHostRegistrationSetupDraft(draftPath, options.projectId);
  if (!draft.ok) {
    return Object.freeze({ state: "blocked", reason: "draft_unavailable" });
  }

  const linearApiKey = readLinearApiKey(options.environment);
  if (!linearApiKey.ok) {
    return Object.freeze({ state: "blocked", reason: "linear_api_key_missing" });
  }

  const githubTransport = options.githubTransport ?? new GhTransport();
  const authentication = await githubTransport.inspectAuthentication();
  if (!authentication.ok) {
    return Object.freeze({ state: "blocked", reason: "github_authentication_unavailable" });
  }

  const linearTransport = new LinearGraphqlTransport({
    apiKey: linearApiKey.value,
    ...(options.linearFetch === undefined ? {} : { fetch: options.linearFetch }),
  });
  const linearReadModel = new LinearReadModel(linearTransport);
  const linearMutationClient = new LinearMutationClient(linearTransport, linearReadModel);
  const linearAuditWriter = new LinearIssueAuditCommentWriter(
    linearReadModel,
    linearMutationClient,
    {
      teamId: draft.value.project.workManagement.containerId,
      projectId: draft.value.project.workManagement.projectId,
    },
  );
  const pullRequestAuditWriter = new GitHubPullRequestAuditCommentWriter(
    new GitHubAdapter(githubTransport),
  );

  const composition = createProductionRegistrationSetupComposition({
    stateRoot: join(options.agentTeamHome, "state"),
    draft: draft.value,
    githubTransport,
    linearAuditWriter,
    pullRequestAuditWriter,
  });
  if (composition.wiring.state !== "ready") {
    return Object.freeze({ state: "blocked", reason: "configuration_incomplete" });
  }
  return Object.freeze({ state: "ready", composition });
}
