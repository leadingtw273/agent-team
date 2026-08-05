import type { GitHubRegistrationPreview } from "../../../application/registration/index.js";

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
