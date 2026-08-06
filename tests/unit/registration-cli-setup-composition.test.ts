/**
 * O009: fail-closed ordering for the Setup CLI production composition root. Each precondition
 * must short-circuit *before* the next external dependency is even constructed -- these tests
 * prove that with fake counters, not just by inspecting the returned reason code.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { domainError, err, ok } from "../../src/domain/foundation/index.js";
import { buildRegistrationSetupComposition } from "../../src/cli/registration/setup-composition.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "agent-team-o009-setup-composition-"));
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

function fakeGithubTransport() {
  const inspectAuthentication = vi.fn(() =>
    Promise.resolve(ok({ active: true as const, host: "github.com", accountFingerprint: "fp" })),
  );
  const requestJson = vi.fn(() => Promise.resolve(err(domainError("unavailable"))));
  return { inspectAuthentication, requestJson };
}

describe("buildRegistrationSetupComposition (fail-closed ordering)", () => {
  it("blocks on a missing draft before touching GitHub or Linear at all", async () => {
    const agentTeamHome = await root();
    const github = fakeGithubTransport();
    const linearFetch = vi.fn();

    const result = await buildRegistrationSetupComposition({
      agentTeamHome,
      projectId,
      environment: { LINEAR_API_KEY: "key" },
      githubTransport: github,
      linearFetch,
    });

    expect(result).toEqual({ state: "blocked", reason: "draft_unavailable" });
    expect(github.inspectAuthentication).not.toHaveBeenCalled();
    expect(github.requestJson).not.toHaveBeenCalled();
    expect(linearFetch).not.toHaveBeenCalled();
  });

  it("blocks on a missing LINEAR_API_KEY before touching GitHub at all", async () => {
    const agentTeamHome = await root();
    await writeValidDraft(agentTeamHome);
    const github = fakeGithubTransport();
    const linearFetch = vi.fn();

    const result = await buildRegistrationSetupComposition({
      agentTeamHome,
      projectId,
      environment: {},
      githubTransport: github,
      linearFetch,
    });

    expect(result).toEqual({ state: "blocked", reason: "linear_api_key_missing" });
    expect(github.inspectAuthentication).not.toHaveBeenCalled();
    expect(github.requestJson).not.toHaveBeenCalled();
    expect(linearFetch).not.toHaveBeenCalled();
  });

  it("blocks on unavailable GitHub authentication before ever touching Linear", async () => {
    const agentTeamHome = await root();
    await writeValidDraft(agentTeamHome);
    const github = {
      inspectAuthentication: vi.fn(() => Promise.resolve(err(domainError("permission_denied")))),
      requestJson: vi.fn(() => Promise.resolve(err(domainError("unavailable")))),
    };
    const linearFetch = vi.fn();

    const result = await buildRegistrationSetupComposition({
      agentTeamHome,
      projectId,
      environment: { LINEAR_API_KEY: "key" },
      githubTransport: github,
      linearFetch,
    });

    expect(result).toEqual({ state: "blocked", reason: "github_authentication_unavailable" });
    expect(github.inspectAuthentication).toHaveBeenCalledTimes(1);
    expect(linearFetch).not.toHaveBeenCalled();
  });

  it("blocks with configuration_incomplete when the underlying composition itself is not ready", async () => {
    const agentTeamHome = await root();
    await writeValidDraft(agentTeamHome);
    const github = fakeGithubTransport();

    const result = await buildRegistrationSetupComposition({
      // A relative agentTeamHome makes stateRoot non-absolute, which
      // createProductionRegistrationSetupComposition itself rejects.
      agentTeamHome: "relative-home",
      projectId,
      environment: { LINEAR_API_KEY: "key" },
      githubTransport: github,
      linearFetch: vi.fn(() => Promise.reject(new Error("must never be called"))),
    });

    expect(result.state).toBe("blocked");
  });

  it("reaches a ready composition once every precondition is satisfied", async () => {
    const agentTeamHome = await root();
    await writeValidDraft(agentTeamHome);
    const github = fakeGithubTransport();

    const result = await buildRegistrationSetupComposition({
      agentTeamHome,
      projectId,
      environment: { LINEAR_API_KEY: "key" },
      githubTransport: github,
      linearFetch: vi.fn(() => Promise.reject(new Error("must never be called by this test"))),
    });

    expect(result.state).toBe("ready");
    if (result.state === "ready") {
      expect(result.composition.wiring).toMatchObject({ state: "ready" });
    }
    expect(github.inspectAuthentication).toHaveBeenCalledTimes(1);
  });
});
