/**
 * C015c item 3b unit tests: `buildCiRecoveryPipeline`
 * (src/cli/dispatch/ci-recovery-composition.ts) -- the fail-closed GitHub-authentication-first
 * prerequisite chain and resulting port wiring, mirroring
 * dispatch-implementer-composition.test.ts's own convention.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildCiRecoveryPipeline } from "../../src/cli/dispatch/ci-recovery-composition.js";
import { GitPreflight, LocalGitAdapter } from "../../src/adapters/git/index.js";
import { FileJobRepository } from "../../src/infrastructure/jobs/index.js";
import { ok, err, domainError } from "../../src/domain/foundation/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-ci-recovery-composition-"));
  temporaryDirectories.push(directory);
  return directory;
}

const claudeConfig = { executable: "claude", models: ["opus"], account: "default" };

describe("buildCiRecoveryPipeline", () => {
  it("blocks with github_authentication_unavailable before constructing any port", async () => {
    const agentTeamHome = await temporaryHome();
    const jobs = new FileJobRepository(
      join(agentTeamHome, "jobs.json"),
      join(agentTeamHome, "jobs.lock"),
    );
    const result = await buildCiRecoveryPipeline({
      agentTeamHome,
      claudeConfig,
      jobs,
      githubTransport: {
        requestJson: () => Promise.reject(new Error("must never be called")),
        inspectAuthentication: () => Promise.resolve(err(domainError("permission_denied"))),
      },
    });
    expect(result).toEqual({ state: "blocked", reason: "github_authentication_unavailable" });
  });

  it("reaches state:ready with every CiRecoveryPipelinePorts slot wired once GitHub auth succeeds", async () => {
    const agentTeamHome = await temporaryHome();
    const jobs = new FileJobRepository(
      join(agentTeamHome, "jobs.json"),
      join(agentTeamHome, "jobs.lock"),
    );
    const result = await buildCiRecoveryPipeline({
      agentTeamHome,
      claudeConfig,
      jobs,
      githubTransport: {
        requestJson: () => Promise.reject(new Error("unused in this test")),
        inspectAuthentication: () =>
          Promise.resolve(
            ok({ active: true as const, host: "github.com", accountFingerprint: "a".repeat(64) }),
          ),
      },
    });
    expect(result.state).toBe("ready");
    if (result.state !== "ready") return;
    expect(result.value.ports.git).toBeInstanceOf(LocalGitAdapter);
    expect(result.value.ports.preflight).toBeInstanceOf(GitPreflight);
    const capabilities = await result.value.ports.provider.inspectCapabilities();
    expect(capabilities.ok).toBe(true);
    if (capabilities.ok) expect(capabilities.value.provider).toBe("claude");
    expect(result.value.ports.sourceControl).toBeDefined();
    expect(result.value.ports.ciLog).toBeDefined();
    // C017: `sourceControl` and `ciLog` are the same underlying `GitHubAdapter` instance -- one
    // read-only GitHub Checks/Actions capability set, no reason to construct the adapter twice.
    expect(result.value.ports.ciLog).toBe(result.value.ports.sourceControl);
    expect(result.value.ports.jobs).toBeDefined();
    expect(result.value.ports.checkpoint).toBeDefined();
    expect(result.value.ports.toolDecisions).toBeDefined();
  });
});
