import {
  createGitHubRegistrationPolicy,
  type GitHubRegistrationInventory,
  type GitHubRegistrationPolicyPort,
  type GitHubRegistrationPolicyUseCase,
  type GitHubRegistrationPreview,
  type LinearProvisionConfirmationContext,
} from "../../../application/registration/index.js";
import { ok } from "../../../domain/foundation/index.js";

import type { GitHubRegistrationUiController } from "./github-policy.js";

export const fixtureGitHubRegistrationPolicyPreview: Extract<
  GitHubRegistrationPreview,
  { readonly state: "ready" }
> = Object.freeze({
  state: "ready",
  setupState: "configuration_incomplete",
  expectedRevision: "a".repeat(64),
  confirmationToken: "b".repeat(43),
  changes: Object.freeze(["ensure_required_checks", "enable_auto_merge"] as const),
});

/** Synthetic browser-only controller; it never calls GitHub or mutates host state. */
export const fixtureGitHubRegistrationUiController: GitHubRegistrationUiController = Object.freeze({
  preview: () => Promise.resolve(fixtureGitHubRegistrationPolicyPreview),
  apply: (command: Parameters<GitHubRegistrationUiController["apply"]>[0]) =>
    Promise.resolve(
      command.expectedRevision === fixtureGitHubRegistrationPolicyPreview.expectedRevision &&
        command.confirmationToken === fixtureGitHubRegistrationPolicyPreview.confirmationToken
        ? Object.freeze({
            state: "configured" as const,
            setupState: "configuration_incomplete" as const,
            changed: true,
            gates: Object.freeze({
              github_review_status: "passed" as const,
              github_auto_merge: "passed" as const,
            }),
          })
        : Object.freeze({
            state: "blocked" as const,
            setupState: "configuration_incomplete" as const,
            reason: "confirmation_invalid" as const,
          }),
    ),
});

const initialInventory: GitHubRegistrationInventory = Object.freeze({
  revision: "a".repeat(64),
  permission: "admin",
  rulesets: "supported",
  autoMerge: "supported",
  autoMergeEnabled: false,
  activeRequiredChecks: Object.freeze([]),
  managedRulesetCollision: false,
});

/** Per-trusted-session synthetic factory for the combined Registration page. */
export function createFixtureGitHubRegistrationPolicyUseCaseFactory(): (
  context: LinearProvisionConfirmationContext,
) => GitHubRegistrationPolicyUseCase {
  return (context) => {
    let inventory = initialInventory;
    const port: GitHubRegistrationPolicyPort = Object.freeze({
      inspect: () => Promise.resolve(ok(inventory)),
      provision: () => {
        inventory = Object.freeze({
          ...initialInventory,
          revision: "c".repeat(64),
          autoMergeEnabled: true,
          activeRequiredChecks: Object.freeze(["CI", "agent-team/review"]),
        });
        return Promise.resolve(ok(Object.freeze({ changed: true })));
      },
    });
    return createGitHubRegistrationPolicy({
      port,
      confirmationKey: Buffer.from(context.digest, "hex"),
    });
  };
}
