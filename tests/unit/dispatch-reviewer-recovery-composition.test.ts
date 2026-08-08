import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GitPreflight, LocalGitAdapter } from "../../src/adapters/git/index.js";
import { buildReviewerRecoveryPipeline } from "../../src/cli/dispatch/reviewer-recovery-composition.js";
import { FileJobRepository } from "../../src/infrastructure/jobs/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-reviewer-recovery-composition-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("buildReviewerRecoveryPipeline", () => {
  it("is immediately ready without GitHub authentication and wires all local recovery ports", async () => {
    const agentTeamHome = await temporaryHome();
    const jobs = new FileJobRepository(
      join(agentTeamHome, "jobs.json"),
      join(agentTeamHome, "jobs.lock"),
    );
    const result = await buildReviewerRecoveryPipeline({
      agentTeamHome,
      claudeConfig: { executable: "claude", models: ["opus"], account: "default" },
      jobs,
    });

    expect(result.state).toBe("ready");
    expect(result.value.ports.git).toBeInstanceOf(LocalGitAdapter);
    expect(result.value.ports.preflight).toBeInstanceOf(GitPreflight);
    expect(result.value.ports.jobs).toBeDefined();
    expect(result.value.ports.checkpoint).toBeDefined();
    expect(result.value.ports.toolDecisions).toBeDefined();
    const capabilities = await result.value.ports.provider.inspectCapabilities();
    expect(capabilities.ok).toBe(true);
    if (capabilities.ok) expect(capabilities.value.provider).toBe("claude");
  });
});
