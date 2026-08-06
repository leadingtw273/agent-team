/**
 * O009f regression test: the production probe composition root must always pass real,
 * finite-but-non-trivial poll options to the O006 coordinator -- never silently fall back to
 * the engine's own `defaultPoll` ({maxAttempts: 1, intervalMs: 0}), which is deliberately kept
 * synchronous-immediate for the engine's own unit tests, not for production use.
 *
 * Root cause (confirmed live, E004 sandbox dry run, PR #2, GitHub Actions run 31100709913): CI
 * genuinely ran and genuinely succeeded, and O006's own cleanup genuinely converged -- but the
 * coordinator had already given up (`ci_check_missing`) after a single, zero-wait check, because
 * `buildRegistrationProbeComposition` only ever forwarded `ciPoll`/`statusPoll`/
 * `providerEventPoll` to the coordinator when a caller (a test) explicitly passed one; the
 * production CLI handler never did.
 *
 * `createRegistrationProbeCoordinator` is mocked here (capturing the exact options it is called
 * with) specifically so this test can assert on the *composition's own wiring* without either
 * waiting out a real multi-minute poll loop or reconstructing ~150 lines of O005's own
 * activation-fixture machinery (see registration-cli-probe.test.ts's own scope note) just to
 * reach a state this fix does not otherwise need. `FileRegistrationSetupActivationRegistry` is
 * mocked to the one thing this composition root actually needs from it -- a resolved
 * `setupSessionId` -- for the same reason.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { domainError, err, ok } from "../../src/domain/foundation/index.js";

const createCoordinatorSpy = vi.hoisted(() => vi.fn());

vi.mock("../../src/application/registration/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/application/registration/index.js")>();
  return {
    ...actual,
    createRegistrationProbeCoordinator: (
      ...args: Parameters<typeof actual.createRegistrationProbeCoordinator>
    ) => {
      createCoordinatorSpy(...args);
      return { start: () => Promise.reject(new Error("must never be called in this test")) };
    },
  };
});

vi.mock("../../src/adapters/registration/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/adapters/registration/index.js")>();
  class FakeActivationRegistry {
    read() {
      return Promise.resolve(ok({ setupSessionId: "setup-o009f-poll-fixture" }));
    }
  }
  return { ...actual, FileRegistrationSetupActivationRegistry: FakeActivationRegistry };
});

// Imported *after* both vi.mock calls above so the module graph they patch is already in place
// (vi.mock's hoisting makes this safe regardless of import order in source, but writing it below
// keeps the intent visible).
const { buildRegistrationProbeComposition } =
  await import("../../src/cli/registration/probe-composition.js");

const roots: string[] = [];
afterEach(async () => {
  createCoordinatorSpy.mockClear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "agent-team-o009f-poll-"));
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

async function writeProbeConfig(
  agentTeamHome: string,
  poll?: Readonly<Record<string, unknown>>,
): Promise<void> {
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
      ...(poll === undefined ? {} : { poll }),
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

async function buildReady(agentTeamHome: string) {
  const result = await buildRegistrationProbeComposition({
    agentTeamHome,
    projectId,
    environment: { LINEAR_API_KEY: "key" },
    githubTransport: fakeGithubTransport(),
    linearFetch: vi.fn(() => Promise.reject(new Error("must never be called in this test"))),
  });
  if (result.state !== "ready") {
    throw new Error(`expected ready composition, got ${JSON.stringify(result)}`);
  }
  return result;
}

describe("buildRegistrationProbeComposition: O009f production poll defaults", () => {
  it("passes real, non-trivial default poll options to the coordinator when the probe config has no override", async () => {
    const agentTeamHome = await root();
    await writeValidDraft(agentTeamHome);
    await writeProbeConfig(agentTeamHome);
    await writeValidSecrets(agentTeamHome);

    await buildReady(agentTeamHome);

    expect(createCoordinatorSpy).toHaveBeenCalledTimes(1);
    const passed = createCoordinatorSpy.mock.calls[0]?.[0] as {
      readonly ciPoll: { readonly maxAttempts: number; readonly intervalMs: number; wait: unknown };
      readonly statusPoll: {
        readonly maxAttempts: number;
        readonly intervalMs: number;
        wait: unknown;
      };
      readonly providerEventPoll: {
        readonly maxAttempts: number;
        readonly intervalMs: number;
        wait: unknown;
      };
    };
    // The exact O009f-locked production defaults -- never the engine's own single-shot,
    // zero-wait `defaultPoll`.
    expect(passed.ciPoll).toMatchObject({ maxAttempts: 40, intervalMs: 15_000 });
    expect(passed.statusPoll).toMatchObject({ maxAttempts: 10, intervalMs: 3_000 });
    expect(passed.providerEventPoll).toMatchObject({ maxAttempts: 36, intervalMs: 5_000 });
    expect(typeof passed.ciPoll.wait).toBe("function");
    expect(typeof passed.statusPoll.wait).toBe("function");
    expect(typeof passed.providerEventPoll.wait).toBe("function");
  });

  it("lets the probe config JSON override any subset of the poll defaults", async () => {
    const agentTeamHome = await root();
    await writeValidDraft(agentTeamHome);
    await writeProbeConfig(agentTeamHome, {
      ciPoll: { maxAttempts: 5, intervalMs: 1_000 },
      // statusPoll and providerEventPoll deliberately omitted: must keep the built-in defaults.
    });
    await writeValidSecrets(agentTeamHome);

    await buildReady(agentTeamHome);

    const passed = createCoordinatorSpy.mock.calls[0]?.[0] as {
      readonly ciPoll: { readonly maxAttempts: number; readonly intervalMs: number };
      readonly statusPoll: { readonly maxAttempts: number; readonly intervalMs: number };
      readonly providerEventPoll: { readonly maxAttempts: number; readonly intervalMs: number };
    };
    expect(passed.ciPoll).toMatchObject({ maxAttempts: 5, intervalMs: 1_000 });
    expect(passed.statusPoll).toMatchObject({ maxAttempts: 10, intervalMs: 3_000 });
    expect(passed.providerEventPoll).toMatchObject({ maxAttempts: 36, intervalMs: 5_000 });
  });

  it("rejects a probe config with an out-of-range poll override (maxAttempts too high) as missing_or_invalid, zero mutation", async () => {
    const agentTeamHome = await root();
    await writeValidDraft(agentTeamHome);
    await writeProbeConfig(agentTeamHome, { ciPoll: { maxAttempts: 201, intervalMs: 1_000 } });
    await writeValidSecrets(agentTeamHome);

    const result = await buildRegistrationProbeComposition({
      agentTeamHome,
      projectId,
      environment: { LINEAR_API_KEY: "key" },
      githubTransport: fakeGithubTransport(),
    });

    expect(result).toEqual({ state: "blocked", reason: "probe_config_unavailable" });
    expect(createCoordinatorSpy).not.toHaveBeenCalled();
  });

  it("rejects a probe config with an out-of-range poll override (intervalMs too high) as missing_or_invalid, zero mutation", async () => {
    const agentTeamHome = await root();
    await writeValidDraft(agentTeamHome);
    await writeProbeConfig(agentTeamHome, { statusPoll: { maxAttempts: 3, intervalMs: 60_001 } });
    await writeValidSecrets(agentTeamHome);

    const result = await buildRegistrationProbeComposition({
      agentTeamHome,
      projectId,
      environment: { LINEAR_API_KEY: "key" },
      githubTransport: fakeGithubTransport(),
    });

    expect(result).toEqual({ state: "blocked", reason: "probe_config_unavailable" });
    expect(createCoordinatorSpy).not.toHaveBeenCalled();
  });

  it("rejects a probe config poll override with an unknown extra field (strict schema), zero mutation", async () => {
    const agentTeamHome = await root();
    await writeValidDraft(agentTeamHome);
    await writeProbeConfig(agentTeamHome, {
      providerEventPoll: { maxAttempts: 3, intervalMs: 1_000, extra: "nope" },
    });
    await writeValidSecrets(agentTeamHome);

    const result = await buildRegistrationProbeComposition({
      agentTeamHome,
      projectId,
      environment: { LINEAR_API_KEY: "key" },
      githubTransport: fakeGithubTransport(),
    });

    expect(result).toEqual({ state: "blocked", reason: "probe_config_unavailable" });
    expect(createCoordinatorSpy).not.toHaveBeenCalled();
  });

  it("an explicit caller-provided poll option (as real tests already inject) still takes priority over both the probe config and the built-in defaults", async () => {
    const agentTeamHome = await root();
    await writeValidDraft(agentTeamHome);
    await writeProbeConfig(agentTeamHome, { ciPoll: { maxAttempts: 5, intervalMs: 1_000 } });
    await writeValidSecrets(agentTeamHome);
    const explicitCiPoll = Object.freeze({
      maxAttempts: 1,
      intervalMs: 0,
      wait: () => Promise.resolve(),
    });

    const result = await buildRegistrationProbeComposition({
      agentTeamHome,
      projectId,
      environment: { LINEAR_API_KEY: "key" },
      githubTransport: fakeGithubTransport(),
      linearFetch: vi.fn(() => Promise.reject(new Error("must never be called in this test"))),
      ciPoll: explicitCiPoll,
    });
    if (result.state !== "ready") throw new Error(`expected ready, got ${JSON.stringify(result)}`);

    const passed = createCoordinatorSpy.mock.calls[0]?.[0] as {
      readonly ciPoll: unknown;
    };
    expect(passed.ciPoll).toBe(explicitCiPoll);
  });
});
