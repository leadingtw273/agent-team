import { describe, expect, it } from "vitest";

import {
  GitHubRegistrationReadOnlyProbeAdapter,
  LinearRegistrationReadOnlyProbeAdapter,
  WebhookRuntimeConfigurationProbeAdapter,
  createRegistrationReadOnlyScanPorts,
  type GitHubRegistrationReadOnlyClient,
  type LinearRegistrationReadOnlyClient,
  type LocalRegistrationReadOnlyProbes,
} from "../../src/adapters/registration/index.js";
import { createRegistrationReadOnlyScanUseCase } from "../../src/application/registration/index.js";
import { ok } from "../../src/domain/foundation/index.js";

const fixedNow = () => "2026-08-05T12:00:00.000Z";

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
        return Promise.resolve(ok({ readable: true }));
      },
      inspectContinuousIntegration: () => {
        calls.push("ci");
        return Promise.resolve(ok({ workflowCount: 1 }));
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
        return Promise.resolve(ok({ readable: true }));
      },
      inspectContinuousIntegration: (repository: string) => {
        calls.push(`ci:${repository}`);
        return Promise.resolve(ok({ workflowCount: 1 }));
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
      "ci:agent-team/example",
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
});
