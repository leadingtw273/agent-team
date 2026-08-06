import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { createProductionRegistrationSetupComposition } from "../../src/adapters/registration/index.js";
import type { GhJsonTransport } from "../../src/adapters/github/adapter.js";
import { trustedProjectConfigSchema } from "../../src/application/projects/index.js";
import { domainError, err } from "../../src/domain/foundation/index.js";
import { projectSchema } from "../../src/domain/project/index.js";
import {
  createUiApplication,
  createFixtureGitHubRegistrationPolicyUseCaseFactory,
  createFixtureLinearProvisionUseCaseFactory,
  createProductionRegistrationWizardUiComposition,
  fixtureRegistrationReadOnlyScanUseCase,
  startLocalUiServer,
} from "../../src/ui/index.js";

const run = promisify(execFile);
const authorityDigest = "a".repeat(64);

async function git(root: string, args: readonly string[]) {
  return run("git", [...args], { cwd: root, encoding: "utf8" });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agent-team-setup-composition-"));
  const repository = join(root, "repository");
  await run("git", ["init", "--initial-branch=main", repository]);
  await git(repository, ["config", "user.name", "Agent Team Test"]);
  await git(repository, ["config", "user.email", "agent-team@example.test"]);
  await writeFile(join(repository, "README.md"), "fixture\n", "utf8");
  await git(repository, ["add", "README.md"]);
  await git(repository, ["commit", "-m", "fixture"]);
  const project = projectSchema.parse({
    schemaVersion: 1 as const,
    id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    displayName: "Sandbox",
    localRepositoryPath: repository,
    defaultBranch: "main",
    workManagement: { provider: "linear", containerId: "workspace-1", projectId: "team-1" },
    sourceControl: { provider: "github", repository: "owner/sandbox" },
  });
  const config = trustedProjectConfigSchema.parse({
    schemaVersion: 1 as const,
    projectId: project.id,
    defaultBranch: "main",
    platforms: {
      workManagement: project.workManagement,
      sourceControl: project.sourceControl,
    },
    projectRules: ["Run tests."],
    roleInstructions: { implementer: ["Stay in scope."] },
    commands: { quality: [{ executable: "pnpm", arguments: ["test"] }], visualReview: [] },
  });
  const transportCalls: string[][] = [];
  const transport: GhJsonTransport = {
    requestJson: <Output>(arguments_: readonly string[], _schema: z.ZodType<Output>) => {
      void _schema;
      transportCalls.push([...arguments_]);
      return Promise.resolve(err(domainError("unavailable")));
    },
  };
  return {
    root,
    draft: Object.freeze({ project, config, linearAuditIssueId: "LINEAR-AUDIT-1" }),
    transport,
    transportCalls,
  };
}

describe("W3A production Registration Setup composition", () => {
  it("fails closed instead of installing fixture defaults when required dependencies are absent", async () => {
    const composition = createProductionRegistrationSetupComposition({
      stateRoot: "/tmp/agent-team-state",
    });
    expect(composition.wiring).toMatchObject({
      state: "configuration_incomplete",
      durableState: "unwired",
      mergedConfigReadBack: "unwired",
    });
    const model = await composition.controller.read({ authorityDigest });
    expect(model.state).toBe("configuration_incomplete");
    expect(model.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "production_dependencies_unwired" }),
      ]),
    );
    const wizard = createProductionRegistrationWizardUiComposition({
      readOnlyScan: fixtureRegistrationReadOnlyScanUseCase,
      linearUseCaseFactory: createFixtureLinearProvisionUseCaseFactory(),
      githubUseCaseFactory: createFixtureGitHubRegistrationPolicyUseCaseFactory(),
      githubTarget: Object.freeze({
        projectId: "sandbox-project",
        repository: "owner/sandbox",
        defaultBranch: "main",
      }),
      setup: { stateRoot: "/tmp/agent-team-state" },
    });
    expect(wizard.setupWiring.state).toBe("configuration_incomplete");
    const html = await wizard.feature.page.render({ session: { authorityDigest } });
    expect(html).toContain("production_dependencies_unwired");
  });

  it("constructs B1 durable trust gates without merge or merged-config capabilities", async () => {
    const setup = await fixture();
    const missingAuditTransport = createProductionRegistrationSetupComposition({
      stateRoot: join(setup.root, "missing-audit-state"),
      draft: setup.draft,
      githubTransport: setup.transport,
    });
    expect(missingAuditTransport.wiring).toMatchObject({
      state: "configuration_incomplete",
      audit: "unwired",
      conversationApproval: "unwired",
    });
    expect(await missingAuditTransport.controller.read({ authorityDigest })).toMatchObject({
      state: "configuration_incomplete",
    });
    expect(setup.transportCalls).toEqual([]);
    const options = {
      stateRoot: join(setup.root, "state"),
      draft: setup.draft,
      githubTransport: setup.transport,
      linearAuditWriter: {
        appendComment: () => Promise.resolve(err(domainError("unavailable"))),
      },
      pullRequestAuditWriter: {
        appendChangeRequestComment: () => Promise.resolve(err(domainError("unavailable"))),
      },
      conversationApprovalBridge: {
        issue: () => Promise.resolve(err(domainError("unavailable"))),
        resolveAuthority: () => Promise.resolve(err(domainError("permission_denied"))),
      },
    };
    const composition = createProductionRegistrationSetupComposition(options);
    expect(composition.wiring).toEqual({
      state: "ready",
      durableState: "w1_file_stores",
      mergedConfigReadBack: "w2_github_authoritative",
      merge: "w3b2_controller_squash",
      audit: "w3b1_receipts",
      conversationApproval: "w3b1_host_capability",
      activation: "w3b2_project_index",
    });
    expect(composition.controller).toHaveProperty("approveAndMergeLocalUi");
    expect(composition).not.toHaveProperty("coordinator");
    expect(composition).not.toHaveProperty("sourceControl");
    expect(composition).not.toHaveProperty("mergePort");
    const model = await composition.controller.read({ authorityDigest });
    expect(model).toMatchObject({ state: "preview_ready" });
    if (model.preview === undefined) throw new Error("missing preview");
    const command = {
      setupSessionId: model.preview.setupSessionId,
      previewDigest: model.preview.previewDigest,
      confirmation: "CREATE SETUP DRAFT PR" as const,
      idempotencyKey: "composition:preview:issue",
    };
    const first = await composition.controller.confirmPreview(command, { authorityDigest });
    const restarted = createProductionRegistrationSetupComposition(options);
    const second = await restarted.controller.confirmPreview(command, { authorityDigest });
    expect(second).toEqual(first);
    expect(first).toMatchObject({ state: "preview_confirmation_issued" });
    expect(setup.transportCalls).toEqual([]);

    const { conversationApprovalBridge: _bridge, ...localUiOnlyOptions } = options;
    void _bridge;
    const localUiOnly = createProductionRegistrationSetupComposition({
      ...localUiOnlyOptions,
      stateRoot: join(setup.root, "local-ui-only-state"),
    });
    expect(localUiOnly.wiring).toMatchObject({
      state: "ready",
      merge: "w3b2_controller_squash",
      activation: "w3b2_project_index",
      conversationApproval: "unwired",
    });
    expect(localUiOnly.conversationApproval).toBeUndefined();
    expect(await localUiOnly.controller.read({ authorityDigest })).toMatchObject({
      state: "preview_ready",
    });
    expect(localUiOnly.controller).toHaveProperty("approveAndMergeLocalUi");
    expect(setup.transportCalls).toEqual([]);

    const wizard = createProductionRegistrationWizardUiComposition({
      readOnlyScan: fixtureRegistrationReadOnlyScanUseCase,
      linearUseCaseFactory: createFixtureLinearProvisionUseCaseFactory(),
      githubUseCaseFactory: createFixtureGitHubRegistrationPolicyUseCaseFactory(),
      githubTarget: Object.freeze({
        projectId: "sandbox-project",
        repository: "owner/sandbox",
        defaultBranch: "main",
      }),
      setup: options,
    });
    expect(wizard.setupWiring.state).toBe("ready");
    expect(wizard.feature).toMatchObject({ id: "registration-wizard", slot: "registration" });
    const html = await wizard.feature.page.render({ session: { authorityDigest } });
    expect(html).toContain("可信設定 Setup");
    expect(html).toContain("preview_ready");
    expect(html).not.toContain("production_dependencies_unwired");
    expect(setup.transportCalls).toEqual([]);

    const application = createUiApplication({
      productionRegistrationWizard: {
        readOnlyScan: fixtureRegistrationReadOnlyScanUseCase,
        linearUseCaseFactory: createFixtureLinearProvisionUseCaseFactory(),
        githubUseCaseFactory: createFixtureGitHubRegistrationPolicyUseCaseFactory(),
        githubTarget: Object.freeze({
          projectId: "sandbox-project",
          repository: "owner/sandbox",
          defaultBranch: "main",
        }),
        setup: options,
      },
    });
    expect(application.routeContracts.map((route) => route.path)).toContain(
      "/api/registration/setup",
    );
    const handle = await startLocalUiServer({
      securityPolicy: application.securityPolicy,
      handler: application.handler,
    });
    try {
      const exchange = await fetch(`${handle.baseUrl}/__session/exchange`, {
        method: "POST",
        headers: { authorization: `Bearer ${handle.sessionToken}` },
      });
      const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
      if (cookie === undefined) throw new Error("production UI session exchange failed");
      const page = await fetch(`${handle.baseUrl}/registration`, { headers: { cookie } });
      expect(page.status).toBe(200);
      const pageBody = await page.text();
      expect(pageBody).toContain("可信設定 Setup");
      expect(pageBody).toContain("preview_ready");
      expect(pageBody).not.toContain("production_dependencies_unwired");
    } finally {
      await handle.close();
    }
  });
});
