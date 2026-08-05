import { describe, expect, it, vi } from "vitest";

import {
  GitHubRegistrationReadOnlyProbeAdapter,
  GhRegistrationReadOnlyClient,
  LinearRegistrationReadOnlyProbeAdapter,
  WebhookRuntimeConfigurationProbeAdapter,
  createRegistrationReadOnlyScanPorts,
  asLinearRegistrationReadOnlyClient,
  type GitHubRegistrationReadOnlyClient,
  type LinearRegistrationReadOnlyClient,
  type LocalRegistrationReadOnlyProbes,
} from "../../src/adapters/registration/index.js";
import {
  LinearGraphqlTransport,
  LinearReadModel,
  type LinearFetch,
} from "../../src/adapters/linear/index.js";
import type { GhTransport } from "../../src/adapters/github/index.js";
import { createRegistrationReadOnlyScanUseCase } from "../../src/application/registration/index.js";
import { domainError, err, ok } from "../../src/domain/foundation/index.js";

const fixedNow = () => "2026-08-05T12:00:00.000Z";
const successfulCiSnapshot = Object.freeze({
  actualDefaultBranch: "main",
  activeWorkflowCount: 1,
  latest: Object.freeze({
    headBranch: "main",
    status: "completed" as const,
    conclusion: "success" as const,
  }),
});

function unavailableLocalProbes(): LocalRegistrationReadOnlyProbes {
  const unknown = (provenance: "local_git" | "node_runtime" | "compiled_cli") =>
    Promise.resolve(
      ok({
        state: "unknown" as const,
        evidence: Object.freeze(["本機 Probe 未設定；這是整合測試的合成資料。"]),
        provenance,
        observedAt: fixedNow(),
      }),
    );
  return Object.freeze({
    localRepository: Object.freeze({ inspect: () => unknown("local_git") }),
    nodeRuntime: Object.freeze({ inspect: () => unknown("node_runtime") }),
    compiledCli: Object.freeze({ inspect: () => unknown("compiled_cli") }),
  });
}

describe("O002 concrete external read-only probes", () => {
  it("does not invoke GitHub or Linear when their targets are not configured", async () => {
    const calls: string[] = [];
    const githubClient: GitHubRegistrationReadOnlyClient = Object.freeze({
      inspectRepository: () => {
        calls.push("github");
        return Promise.resolve(ok({ readable: true, actualDefaultBranch: "main" }));
      },
      inspectContinuousIntegration: () => {
        calls.push("ci");
        return Promise.resolve(ok(successfulCiSnapshot));
      },
    });
    const linearClient: LinearRegistrationReadOnlyClient = Object.freeze({
      readContext: () => {
        calls.push("linear");
        return Promise.resolve(ok({}));
      },
    });
    const github = new GitHubRegistrationReadOnlyProbeAdapter({
      client: githubClient,
      now: fixedNow,
    });
    const linear = new LinearRegistrationReadOnlyProbeAdapter({
      client: linearClient,
      now: fixedNow,
    });

    const [githubResult, ciResult, linearResult] = await Promise.all([
      github.github.inspect(),
      github.continuousIntegration.inspect(),
      linear.inspect(),
    ]);

    expect(calls).toEqual([]);
    expect(githubResult).toMatchObject({ ok: true, value: { state: "unknown" } });
    expect(ciResult).toMatchObject({ ok: true, value: { state: "unknown" } });
    expect(linearResult).toMatchObject({ ok: true, value: { state: "unknown" } });
  });

  it("assembles all seven typed ports while keeping GitHub, Linear, CI, and Webhook observational", async () => {
    const calls: string[] = [];
    const githubClient: GitHubRegistrationReadOnlyClient = Object.freeze({
      inspectRepository: (repository: string, branch: string) => {
        calls.push(`github:${repository}:${branch}`);
        return Promise.resolve(ok({ readable: true, actualDefaultBranch: "main" }));
      },
      inspectContinuousIntegration: (repository: string, branch: string) => {
        calls.push(`ci:${repository}:${branch}`);
        return Promise.resolve(ok(successfulCiSnapshot));
      },
    });
    const linearClient: LinearRegistrationReadOnlyClient = Object.freeze({
      readContext: (teamId: string, projectId: string) => {
        calls.push(`linear:${teamId}:${projectId}`);
        return Promise.resolve(ok({}));
      },
    });
    const webhookCalls: string[] = [];
    const github = new GitHubRegistrationReadOnlyProbeAdapter({
      repository: "agent-team/example",
      defaultBranch: "main",
      client: githubClient,
      now: fixedNow,
    });
    const linear = new LinearRegistrationReadOnlyProbeAdapter({
      teamId: "team_example",
      projectId: "project_example",
      client: linearClient,
      now: fixedNow,
    });
    const webhook = new WebhookRuntimeConfigurationProbeAdapter({
      reader: Object.freeze({
        readRuntimeBaseUrl: () => {
          webhookCalls.push("configuration");
          return Promise.resolve(ok("https://hooks.example.test/"));
        },
      }),
      now: fixedNow,
    });
    const ports = createRegistrationReadOnlyScanPorts({
      local: unavailableLocalProbes(),
      github,
      linear,
      webhook,
    });

    const scan = await createRegistrationReadOnlyScanUseCase({ ports, source: "read_only" }).scan();

    expect(Object.keys(ports)).toEqual([
      "localRepository",
      "nodeRuntime",
      "compiledCli",
      "github",
      "linear",
      "continuousIntegration",
      "webhookRuntime",
    ]);
    expect(calls).toEqual([
      "github:agent-team/example:main",
      "linear:team_example:project_example",
      "ci:agent-team/example:main",
    ]);
    expect(webhookCalls).toEqual(["configuration"]);
    expect(scan.gates.find((gate) => gate.id === "github_access")).toMatchObject({
      state: "passed",
      provenance: "github_read_only",
    });
    expect(scan.gates.find((gate) => gate.id === "linear_access")).toMatchObject({
      state: "passed",
      provenance: "linear_read_only",
    });
    expect(scan.gates.find((gate) => gate.id === "continuous_integration")).toMatchObject({
      state: "passed",
      provenance: "ci_read_only",
    });
    expect(scan.gates.find((gate) => gate.id === "webhook_runtime")).toMatchObject({
      state: "unknown",
      provenance: "webhook_configuration",
      evidence: [expect.stringContaining("未送出 delivery")],
    });
    expect(scan.complete).toBe(false);
  });

  it("fails GitHub access when the API default branch differs from configuration", async () => {
    const client: GitHubRegistrationReadOnlyClient = Object.freeze({
      inspectRepository: () =>
        Promise.resolve(ok({ readable: true, actualDefaultBranch: "trunk" })),
      inspectContinuousIntegration: () => Promise.resolve(ok(successfulCiSnapshot)),
    });
    const adapter = new GitHubRegistrationReadOnlyProbeAdapter({
      repository: "agent-team/example",
      defaultBranch: "main",
      client,
      now: fixedNow,
    });

    const result = await adapter.github.inspect();

    expect(result).toMatchObject({
      ok: true,
      value: { state: "failed", provenance: "github_read_only" },
    });
  });

  it("uses only explicit GET GitHub API reads and rejects partial CI projections", async () => {
    const calls: string[][] = [];
    let returnPartialWorkflow = false;
    const requestJson: GhTransport["requestJson"] = (arguments_, schema) => {
      calls.push([...arguments_]);
      let payload: unknown;
      const endpoint = arguments_[1] ?? "";
      if (endpoint.endsWith("/actions/workflows")) {
        payload = returnPartialWorkflow
          ? { activeWorkflowCount: 1, unexpected: true }
          : { activeWorkflowCount: 1 };
      } else if (endpoint.endsWith("/actions/runs")) {
        payload = {
          runCount: 1,
          latest: { headBranch: "main", status: "completed", conclusion: "success" },
        };
      } else {
        payload = { defaultBranch: "main" };
      }
      const parsed = schema.safeParse(payload);
      return Promise.resolve(
        parsed.success ? ok(parsed.data) : err(domainError("external_failure")),
      );
    };
    const transport: Pick<
      GhTransport,
      "inspectAuthentication" | "inspectRepositoryCapabilities" | "requestJson"
    > = {
      inspectAuthentication: vi.fn(),
      inspectRepositoryCapabilities: vi.fn(),
      requestJson,
    };
    const client = new GhRegistrationReadOnlyClient(transport);

    const result = await client.inspectContinuousIntegration("agent-team/example", "main");

    expect(result).toMatchObject({
      ok: true,
      value: {
        actualDefaultBranch: "main",
        activeWorkflowCount: 1,
        latest: { headBranch: "main", status: "completed", conclusion: "success" },
      },
    });
    expect(calls).toHaveLength(3);
    expect(calls.every((arguments_) => arguments_.includes("GET"))).toBe(true);
    expect(calls.find((arguments_) => arguments_[1]?.endsWith("/actions/runs"))).toEqual(
      expect.arrayContaining(["branch=main", "status=completed", "per_page=1"]),
    );
    expect(calls.flat()).not.toEqual(expect.arrayContaining(["POST", "PUT", "PATCH", "DELETE"]));

    returnPartialWorkflow = true;
    const partial = await client.inspectContinuousIntegration("agent-team/example", "main");
    expect(partial).toMatchObject({ ok: false, error: { code: "external_failure" } });
  });

  it.each([
    {
      name: "API default branch drift",
      snapshot: { ...successfulCiSnapshot, actualDefaultBranch: "trunk" },
      expected: "failed",
    },
    {
      name: "no active workflow",
      snapshot: { ...successfulCiSnapshot, activeWorkflowCount: 0 },
      expected: "failed",
    },
    {
      name: "no completed run",
      snapshot: { ...successfulCiSnapshot, latest: null },
      expected: "unknown",
    },
    {
      name: "run belongs to another branch",
      snapshot: {
        ...successfulCiSnapshot,
        latest: { ...successfulCiSnapshot.latest, headBranch: "feature" },
      },
      expected: "unknown",
    },
    {
      name: "completed run failed",
      snapshot: {
        ...successfulCiSnapshot,
        latest: { ...successfulCiSnapshot.latest, conclusion: "failure" as const },
      },
      expected: "failed",
    },
    {
      name: "completed run has no conclusion",
      snapshot: {
        ...successfulCiSnapshot,
        latest: { ...successfulCiSnapshot.latest, conclusion: null },
      },
      expected: "unknown",
    },
  ])("does not pass CI for $name", async ({ snapshot, expected }) => {
    const client: GitHubRegistrationReadOnlyClient = Object.freeze({
      inspectRepository: () => Promise.resolve(ok({ readable: true, actualDefaultBranch: "main" })),
      inspectContinuousIntegration: () => Promise.resolve(ok(snapshot)),
    });
    const adapter = new GitHubRegistrationReadOnlyProbeAdapter({
      repository: "agent-team/example",
      defaultBranch: "main",
      client,
      now: fixedNow,
    });

    const result = await adapter.continuousIntegration.inspect();

    expect(result).toMatchObject({ ok: true, value: { state: expected } });
  });

  it("fails a malformed Webhook configuration without ever sending a delivery", async () => {
    let reads = 0;
    const adapter = new WebhookRuntimeConfigurationProbeAdapter({
      reader: Object.freeze({
        readRuntimeBaseUrl: () => {
          reads += 1;
          return Promise.resolve(ok("https://user:password@hooks.example.test/?key=value"));
        },
      }),
      now: fixedNow,
    });

    const result = await adapter.inspect();

    expect(reads).toBe(1);
    expect(result).toMatchObject({ ok: true, value: { state: "failed" } });
    expect(JSON.stringify(result)).not.toContain("password");
    expect(JSON.stringify(result)).not.toContain("key=value");
  });

  it.each([
    { name: "coordinator timeout", abortByCaller: false, expectedError: "timeout" },
    { name: "caller abort", abortByCaller: true, expectedError: "interrupted" },
  ])(
    "settles the actual Linear transport after $name without background work",
    async ({ abortByCaller, expectedError }) => {
      let activeRequests = 0;
      let settledRequests = 0;
      let resolveStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        resolveStarted = resolve;
      });
      const linearFetch: LinearFetch = (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          activeRequests += 1;
          resolveStarted?.();
          const signal = init.signal;
          if (!(signal instanceof AbortSignal)) {
            reject(new Error("missing_abort_signal"));
            return;
          }
          const settle = () => {
            activeRequests -= 1;
            settledRequests += 1;
            reject(new DOMException("aborted", "AbortError"));
          };
          if (signal.aborted) settle();
          else signal.addEventListener("abort", settle, { once: true });
        });
      const readModel = new LinearReadModel(
        new LinearGraphqlTransport({
          apiKey: "linear-test-key",
          timeoutMs: 10_000,
          fetch: linearFetch,
        }),
      );
      const linear = new LinearRegistrationReadOnlyProbeAdapter({
        teamId: "team_example",
        projectId: "project_example",
        client: asLinearRegistrationReadOnlyClient(readModel),
        now: fixedNow,
      });
      const ports = createRegistrationReadOnlyScanPorts({
        local: unavailableLocalProbes(),
        github: new GitHubRegistrationReadOnlyProbeAdapter({ now: fixedNow }),
        linear,
        webhook: new WebhookRuntimeConfigurationProbeAdapter({ now: fixedNow }),
      });
      const useCase = createRegistrationReadOnlyScanUseCase({
        ports,
        source: "read_only",
        timeoutMs: 100,
      });
      const controller = new AbortController();

      const pending = useCase.scan({ signal: controller.signal });
      await started;
      if (abortByCaller) controller.abort();
      const scan = await pending;

      expect(scan.gates.find((gate) => gate.id === "linear_access")).toMatchObject({
        state: "unknown",
        error: expectedError,
      });
      expect(activeRequests).toBe(0);
      expect(settledRequests).toBe(1);
    },
  );
});
