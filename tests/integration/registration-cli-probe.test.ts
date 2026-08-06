/**
 * O009 integration test for `agent-team registration probe run` -> `status`.
 *
 * Scope note (transparently disclosed, not silently narrowed): reaching the O006 coordinator's
 * "verified" outcome for a *genuine* project requires a fully cross-verified O005 activation
 * record (session + consumed approval-ledger receipt + published registry index -- see
 * `createActivatedFixture` in tests/integration/registration-setup-local.test.ts, ~150 lines of
 * already-tested O005 fixture machinery). Reproducing that here would just re-test O005's own
 * activation flow, not this task's CLI wiring. Coverage is instead split two ways:
 *   1. This file: exercises the CLI's *real* composition root end-to-end with real file I/O
 *      (draft/probe-config/secret files) and real stdin confirmation reading, through the
 *      already-existing, already-tested O005 activation registry -- proving every piece up to
 *      (but not including) a genuine activation record integrates correctly, and fails closed
 *      with zero external calls when no activation exists yet (the only state reachable without
 *      the full O005 fixture).
 *   2. tests/unit/registration-cli-probe-handlers.test.ts: proves the CLI's own outcome-mapping
 *      logic (coordinator "verified"/"incomplete"/"cleanup_required"/"failed" ->
 *      success/blocked/failed) is correct, via a mocked coordinator.
 *   3. tests/integration/registration-proactive-probe.test.ts (pre-existing, unmodified O006
 *      test, still green): proves the real coordinator + real adapters this composition wires up
 *      genuinely work end to end against fake GitHub/Linear/loopback-webhook transports.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { domainError, err, ok } from "../../src/domain/foundation/index.js";
import { createRegistrationProbeHandlers } from "../../src/cli/registration/probe-handlers.js";
import { buildRegistrationProbeComposition } from "../../src/cli/registration/probe-composition.js";
import { registrationProbeRunConfirmationPhrase } from "../../src/cli/registration/confirmation.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

const projectId = "project_018f47d2-77a4-7cc1-8ef2-0123456789ab";

async function writeDraft(agentTeamHome: string, localRepositoryPath: string): Promise<void> {
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
        localRepositoryPath,
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

async function writeProbeConfig(agentTeamHome: string): Promise<void> {
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

async function writeSecrets(agentTeamHome: string): Promise<void> {
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

async function* stream(chunk: string): AsyncIterable<string> {
  await Promise.resolve();
  yield chunk;
}

describe("O009 registration probe CLI: real composition, fail-closed on no activation yet", () => {
  it("confirms the exact phrase, assembles every real dependency, and blocks cleanly with zero PR/comment mutations when this project has no Setup activation yet", async () => {
    const agentTeamHome = await temporaryRoot("agent-team-o009-probe-home-");
    const localRepositoryPath = await temporaryRoot("agent-team-o009-probe-repo-");
    await writeDraft(agentTeamHome, localRepositoryPath);
    await writeProbeConfig(agentTeamHome);
    await writeSecrets(agentTeamHome);
    const github = fakeGithubTransport();
    const linearFetch = vi.fn(() =>
      Promise.reject(new Error("must never be called: activation lookup fails first")),
    );

    const handlers = createRegistrationProbeHandlers({
      agentTeamHome,
      environment: { LINEAR_API_KEY: "unused-in-this-scenario" },
      stdin: stream(`${registrationProbeRunConfirmationPhrase}\n`),
      buildComposition: (options) =>
        buildRegistrationProbeComposition({ ...options, githubTransport: github, linearFetch }),
    });

    const result = await handlers.probeRun({ projectId });

    expect(result.state).toBe("blocked");
    expect(JSON.parse(result.message ?? "")).toMatchObject({ reason: "activation_not_found" });
    // Every real dependency up through the activation lookup was genuinely assembled and
    // reached (gh auth was checked for real, against the fake transport) -- but zero PR/comment
    // mutation calls were ever attempted, and Linear was never touched at all.
    expect(github.inspectAuthentication).toHaveBeenCalledTimes(1);
    expect(github.requestJson).not.toHaveBeenCalled();
    expect(github.requestVoid).not.toHaveBeenCalled();
    expect(linearFetch).not.toHaveBeenCalled();
  });

  it("rejects a wrong confirmation phrase before even reading the draft file (zero filesystem-derived composition)", async () => {
    const agentTeamHome = await temporaryRoot("agent-team-o009-probe-home-rejected-");
    // Deliberately no draft/probe-config/secrets written: if the handler tried to build the
    // composition despite the wrong phrase, it would surface as `blocked`, not `rejected`.
    const github = fakeGithubTransport();

    const handlers = createRegistrationProbeHandlers({
      agentTeamHome,
      environment: { LINEAR_API_KEY: "unused" },
      stdin: stream("run full revalidation\n"), // wrong case
      buildComposition: (options) =>
        buildRegistrationProbeComposition({ ...options, githubTransport: github }),
    });

    const result = await handlers.probeRun({ projectId });

    expect(result.state).toBe("rejected");
    expect(github.inspectAuthentication).not.toHaveBeenCalled();
  });
});
