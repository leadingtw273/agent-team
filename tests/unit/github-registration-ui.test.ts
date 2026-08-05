import { describe, expect, it, vi } from "vitest";

import type { GitHubRegistrationPolicyUseCase } from "../../src/application/registration/index.js";
import {
  createGitHubRegistrationUiContribution,
  createGitHubRegistrationUiController,
  fixtureGitHubRegistrationPolicyPreview,
  fixtureGitHubRegistrationUiController,
  githubRegistrationPolicyApiPath,
  githubRegistrationPolicyScriptPath,
  renderGitHubRegistrationPolicyPanel,
} from "../../src/ui/features/registration/index.js";

describe("O004 GitHub registration UI component", () => {
  it("renders only fixed preview labels and a two-step explicit confirmation", () => {
    const html = renderGitHubRegistrationPolicyPanel(fixtureGitHubRegistrationPolicyPreview);

    expect(html).toContain("以下是純預覽；尚未變更 GitHub");
    expect(html).toContain("CI、agent-team/review");
    expect(html).toContain("套用前：GitHub 現況");
    expect(html).toContain("套用後：目標政策");
    expect(html).toContain("security-scan");
    expect(html).toContain("refs/heads/__agent_team_never__");
    expect(html).toContain("Require branches to be up to date");
    expect(html).toContain("不會刪除、停用、改名或降低現有保護");
    expect(html).toContain("data-github-policy-review");
    expect(html).toContain("data-github-policy-confirm hidden");
    expect(html).toContain("data-github-policy-apply");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("owner/repository");
  });

  it("maps every blocked reason to fixed Chinese text without rendering arbitrary fields", () => {
    const html = renderGitHubRegistrationPolicyPanel({
      state: "blocked",
      setupState: "configuration_incomplete",
      reason: "managed_ruleset_collision",
      changes: [],
      arbitraryProviderText: "<script>external instruction</script>",
    } as never);

    expect(html).toContain("系統不會接管或覆寫");
    expect(html).not.toContain("external instruction");
    expect(html).not.toContain("<script>");
  });

  it("escapes provider-owned inventory detail in the before/after audit view", () => {
    const untrustedCheck = "<script>external instruction</script>";
    const preview = {
      ...fixtureGitHubRegistrationPolicyPreview,
      policyDiff: {
        ...fixtureGitHubRegistrationPolicyPreview.policyDiff,
        before: {
          ...fixtureGitHubRegistrationPolicyPreview.policyDiff.before,
          activeRequiredChecks: [untrustedCheck],
        },
        after: {
          ...fixtureGitHubRegistrationPolicyPreview.policyDiff.after,
          preservedActiveRequiredChecks: [untrustedCheck],
        },
      },
    };

    const html = renderGitHubRegistrationPolicyPanel(preview);

    expect(html).toContain("&lt;script&gt;external instruction&lt;/script&gt;");
    expect(html).not.toContain("<script>external instruction</script>");
  });

  it("binds the target server-side and contributes only one script plus one PUT API", async () => {
    const preview = vi.fn(() => Promise.resolve(fixtureGitHubRegistrationPolicyPreview));
    const apply = vi.fn(() =>
      Promise.resolve({
        state: "configured" as const,
        setupState: "configuration_incomplete" as const,
        changed: false,
        gates: {
          github_review_status: "passed" as const,
          github_auto_merge: "passed" as const,
        },
      }),
    );
    const policy: GitHubRegistrationPolicyUseCase = { preview, apply };
    const controller = createGitHubRegistrationUiController(policy, {
      projectId: "project-o004-ui",
      repository: "owner/repository",
      defaultBranch: "main",
    });
    const contribution = createGitHubRegistrationUiContribution(controller);

    await contribution.render();
    await controller.apply({
      expectedRevision: "a".repeat(64),
      confirmationToken: `${"a".repeat(20)}.${"b".repeat(43)}`,
    });
    expect(preview).toHaveBeenCalledWith({
      projectId: "project-o004-ui",
      repository: "owner/repository",
      defaultBranch: "main",
    });
    expect(apply).toHaveBeenCalledWith({
      projectId: "project-o004-ui",
      repository: "owner/repository",
      defaultBranch: "main",
      operation: "apply_github_policy",
      confirmationText: "套用 GitHub 合併保護",
      expectedRevision: "a".repeat(64),
      confirmationToken: `${"a".repeat(20)}.${"b".repeat(43)}`,
    });
    expect(contribution.scripts).toEqual([githubRegistrationPolicyScriptPath]);
    expect(contribution.routes.map((route) => route.contract.path)).toEqual([
      githubRegistrationPolicyScriptPath,
      githubRegistrationPolicyApiPath,
    ]);
    expect(contribution.routes[1]?.contract).toMatchObject({
      allowedMethods: ["PUT"],
      mutationBody: "bounded-json",
    });
  });

  it("renders a configured read-back and a fail-closed permission block", () => {
    expect(
      renderGitHubRegistrationPolicyPanel({
        state: "configured",
        setupState: "configuration_incomplete",
        changes: [],
        gates: { github_review_status: "passed", github_auto_merge: "passed" },
      }),
    ).toContain("已由 Read-back 確認");
    expect(
      renderGitHubRegistrationPolicyPanel({
        state: "blocked",
        setupState: "configuration_incomplete",
        reason: "permission_required",
        changes: [],
      }),
    ).toContain("缺少管理權限");
  });

  it("keeps the synthetic controller detached from real GitHub", async () => {
    expect(await fixtureGitHubRegistrationUiController.preview()).toBe(
      fixtureGitHubRegistrationPolicyPreview,
    );
  });
});
