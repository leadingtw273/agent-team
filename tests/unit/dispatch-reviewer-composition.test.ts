/**
 * C015c item 3 unit tests: `buildReviewerPipeline` (src/cli/dispatch/reviewer-composition.ts) --
 * the fail-closed GitHub-authentication-first prerequisite chain, mirroring
 * dispatch-implementer-composition.test.ts's own convention.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildReviewerPipeline } from "../../src/cli/dispatch/reviewer-composition.js";
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
  const directory = await mkdtemp(join(tmpdir(), "agent-team-reviewer-composition-"));
  temporaryDirectories.push(directory);
  return directory;
}

const claudeConfig = { executable: "claude", models: ["opus"], account: "default" };

describe("buildReviewerPipeline", () => {
  it("blocks with github_authentication_unavailable before constructing any port", async () => {
    const agentTeamHome = await temporaryHome();
    const jobs = new FileJobRepository(
      join(agentTeamHome, "jobs.json"),
      join(agentTeamHome, "jobs.lock"),
    );
    const result = await buildReviewerPipeline({
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

  it("reaches state:ready with every ReviewerPipelinePorts slot wired once GitHub auth succeeds", async () => {
    const agentTeamHome = await temporaryHome();
    const jobs = new FileJobRepository(
      join(agentTeamHome, "jobs.json"),
      join(agentTeamHome, "jobs.lock"),
    );
    const result = await buildReviewerPipeline({
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
    expect(result.value.ports.git).toBeDefined();
    expect(result.value.ports.sourceControl).toBeDefined();
    expect(result.value.ports.codeReviewer).toBeDefined();
    expect(result.value.ports.visualReviewer).toBeDefined();
    expect(result.value.ports.codeReviewer).toBe(result.value.ports.visualReviewer);
    expect(result.value.ports.toolDecisions).toBeDefined();
    expect(result.value.ports.evidenceIntegrity).toBeDefined();
    expect(result.value.ports.jobs).toBeDefined();
    expect(result.value.ports.checkpoint).toBeDefined();
  });
});
