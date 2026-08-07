/**
 * C015b unit tests: `buildImplementerPipeline` (src/cli/dispatch/implementer-composition.ts) --
 * the fail-closed prerequisite chain (GitHub auth verified before any port is constructed) and
 * the resulting `ImplementerPipeline`'s port wiring (its `ports` property is public, so this can
 * be checked directly rather than by proxy).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildImplementerPipeline } from "../../src/cli/dispatch/implementer-composition.js";
import { GitPreflight, LocalGitAdapter } from "../../src/adapters/git/index.js";
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
  const directory = await mkdtemp(join(tmpdir(), "agent-team-implementer-composition-"));
  temporaryDirectories.push(directory);
  return directory;
}

const claudeConfig = { executable: "claude", models: ["opus"], account: "default" };

describe("buildImplementerPipeline", () => {
  it("blocks with github_authentication_unavailable before constructing any port", async () => {
    const agentTeamHome = await temporaryHome();
    const result = await buildImplementerPipeline({
      agentTeamHome,
      claudeConfig,
      githubTransport: {
        requestJson: () => Promise.reject(new Error("must never be called")),
        inspectAuthentication: () => Promise.resolve(err(domainError("permission_denied"))),
      },
    });
    expect(result).toEqual({ state: "blocked", reason: "github_authentication_unavailable" });
  });

  it("reaches state:ready with every ImplementerPipelinePorts slot wired once GitHub auth succeeds", async () => {
    const agentTeamHome = await temporaryHome();
    const result = await buildImplementerPipeline({
      agentTeamHome,
      claudeConfig,
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
    if (capabilities.ok) {
      expect(capabilities.value.provider).toBe("claude");
      expect(capabilities.value.models).toEqual(["opus"]);
    }
    // scopeCheckpoint/toolDecisions/sourceControl are private-adapter instances with no public
    // discriminator beyond their behavior, which scope-checkpoint.test.ts/tool-decision.test.ts
    // already cover directly -- this test's job is only to prove they are *present* and the
    // pipeline was actually constructed with all six ports, not to re-test their behavior.
    expect(result.value.ports.scopeCheckpoint).toBeDefined();
    expect(result.value.ports.toolDecisions).toBeDefined();
    expect(result.value.ports.sourceControl).toBeDefined();
  });
});
