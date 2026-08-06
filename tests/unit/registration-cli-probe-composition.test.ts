/**
 * O009: fail-closed ordering for the Probe CLI production composition root, mirroring
 * registration-cli-setup-composition.test.ts. The "ready" happy path (which needs a genuinely
 * cross-verified O005 activation marker) is covered by the integration test instead -- hand
 * -crafting one here would just re-implement a large slice of the real Setup activation flow.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { domainError, err, ok } from "../../src/domain/foundation/index.js";
import { buildRegistrationProbeComposition } from "../../src/cli/registration/probe-composition.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "agent-team-o009-probe-composition-"));
  roots.push(value);
  return value;
}

const projectId = "project_018f47d2-77a4-7cc1-8ef2-0123456789ab";

async function writeValidDraft(agentTeamHome: string): Promise<void> {
  const directory = join(agentTeamHome, "config", "registration");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${projectId}.draft.json`),
    JSON.stringify({
      schemaVersion: 1,
      project: {
        schemaVersion: 1,
        id: projectId,
        displayName: "Sandbox",
        localRepositoryPath: "/tmp/sandbox-repo",
        defaultBranch: "main",
        workManagement: {
          provider: "linear",
          containerId: "team-1",
          projectId: "linear-project-1",
        },
        sourceControl: { provider: "github", repository: "owner/sandbox" },
      },
      config: {
        schemaVersion: 1,
        projectId,
        defaultBranch: "main",
        platforms: {
          workManagement: {
            provider: "linear",
            containerId: "team-1",
            projectId: "linear-project-1",
          },
          sourceControl: { provider: "github", repository: "owner/sandbox" },
        },
        projectRules: ["Run quality checks."],
        roleInstructions: { implementer: ["Stay in scope."] },
        commands: { quality: [{ executable: "pnpm", arguments: ["test"] }], visualReview: [] },
      },
      linearAuditIssueId: "LINEAR-AUDIT-1",
    }),
    "utf8",
  );
}

async function writeValidProbeConfig(agentTeamHome: string): Promise<void> {
  const directory = join(agentTeamHome, "config", "registration");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${projectId}.probe.json`),
    JSON.stringify({
      schemaVersion: 1,
      linearWorkflowStateId: "state-backlog-1",
      gitRemote: "origin",
      webhookBaseUrls: {
        github: "https://runtime.example.test",
        linear: "https://runtime.example.test",
      },
    }),
    "utf8",
  );
}

async function writeValidSecrets(agentTeamHome: string): Promise<void> {
  const directory = join(agentTeamHome, "secrets");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "github-webhook-secret"), "gh-secret-0123456789", {
    mode: 0o600,
  });
  await writeFile(join(directory, "linear-webhook-secret"), "linear-secret-0123456789", {
    mode: 0o600,
  });
}

function fakeGithubTransport() {
  return {
    inspectAuthentication: vi.fn(() =>
      Promise.resolve(ok({ active: true as const, host: "github.com", accountFingerprint: "fp" })),
    ),
    inspectRepositoryCapabilities: vi.fn(() => Promise.resolve(err(domainError("unavailable")))),
    requestJson: vi.fn(() => Promise.resolve(err(domainError("unavailable")))),
    requestVoid: vi.fn(() => Promise.resolve(err(domainError("unavailable")))),
  };
}

describe("buildRegistrationProbeComposition (fail-closed ordering)", () => {
  it("blocks on a missing draft before touching anything else", async () => {
    const agentTeamHome = await root();
    const github = fakeGithubTransport();
    const linearFetch = vi.fn();

    const result = await buildRegistrationProbeComposition({
      agentTeamHome,
      projectId,
      environment: { LINEAR_API_KEY: "key" },
      githubTransport: github,
      linearFetch,
    });

    expect(result).toEqual({ state: "blocked", reason: "draft_unavailable" });
    expect(github.inspectAuthentication).not.toHaveBeenCalled();
    expect(linearFetch).not.toHaveBeenCalled();
  });

  it("blocks on a missing probe config before touching Linear/GitHub", async () => {
    const agentTeamHome = await root();
    await writeValidDraft(agentTeamHome);
    const github = fakeGithubTransport();
    const linearFetch = vi.fn();

    const result = await buildRegistrationProbeComposition({
      agentTeamHome,
      projectId,
      environment: { LINEAR_API_KEY: "key" },
      githubTransport: github,
      linearFetch,
    });

    expect(result).toEqual({ state: "blocked", reason: "probe_config_unavailable" });
    expect(github.inspectAuthentication).not.toHaveBeenCalled();
    expect(linearFetch).not.toHaveBeenCalled();
  });

  it("blocks on a missing LINEAR_API_KEY before touching GitHub", async () => {
    const agentTeamHome = await root();
    await writeValidDraft(agentTeamHome);
    await writeValidProbeConfig(agentTeamHome);
    const github = fakeGithubTransport();

    const result = await buildRegistrationProbeComposition({
      agentTeamHome,
      projectId,
      environment: {},
      githubTransport: github,
    });

    expect(result).toEqual({ state: "blocked", reason: "linear_api_key_missing" });
    expect(github.inspectAuthentication).not.toHaveBeenCalled();
  });

  it("blocks on unavailable GitHub authentication before checking webhook secrets", async () => {
    const agentTeamHome = await root();
    await writeValidDraft(agentTeamHome);
    await writeValidProbeConfig(agentTeamHome);
    const github = {
      ...fakeGithubTransport(),
      inspectAuthentication: vi.fn(() => Promise.resolve(err(domainError("permission_denied")))),
    };

    const result = await buildRegistrationProbeComposition({
      agentTeamHome,
      projectId,
      environment: { LINEAR_API_KEY: "key" },
      githubTransport: github,
    });

    expect(result).toEqual({ state: "blocked", reason: "github_authentication_unavailable" });
  });

  it("blocks on missing webhook secret files before ever resolving activation", async () => {
    const agentTeamHome = await root();
    await writeValidDraft(agentTeamHome);
    await writeValidProbeConfig(agentTeamHome);
    const github = fakeGithubTransport();

    const result = await buildRegistrationProbeComposition({
      agentTeamHome,
      projectId,
      environment: { LINEAR_API_KEY: "key" },
      githubTransport: github,
    });

    expect(result).toEqual({ state: "blocked", reason: "webhook_secret_unavailable" });
  });

  it("blocks with activation_not_found when no Setup activation exists yet for this project", async () => {
    const agentTeamHome = await root();
    await writeValidDraft(agentTeamHome);
    await writeValidProbeConfig(agentTeamHome);
    await writeValidSecrets(agentTeamHome);
    const github = fakeGithubTransport();

    const result = await buildRegistrationProbeComposition({
      agentTeamHome,
      projectId,
      environment: { LINEAR_API_KEY: "key" },
      githubTransport: github,
      linearFetch: vi.fn(() => Promise.reject(new Error("must never be called"))),
    });

    expect(result).toEqual({ state: "blocked", reason: "activation_not_found" });
  });
});
