import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const cli = resolve("dist/cli/index.js");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function isolatedEnvironment(): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), "agent-team-cycle-smoke-"));
  roots.push(root);
  return { ...process.env, AGENT_TEAM_HOME: join(root, ".agent-team") };
}

function run(arguments_: readonly string[], environment: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [cli, ...arguments_], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 10_000,
    env: environment,
  });
}

describe("C01 compiled cycle CLI smoke", () => {
  it("runs the compiled exact cycle contract against an empty isolated home", async () => {
    const environment = await isolatedEnvironment();
    const result = run(["cycle", "--all"], environment);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      operation: "controller_cycle",
      state: "completed",
      stageCounts: { completed: 4, degraded: 0, failed: 0 },
    });
  });

  it.each([
    ["missing --all", ["cycle"]],
    ["extra argv", ["cycle", "--all", "https://sensitive.example/path?pid=1234"]],
  ] as const)("returns a zero-write usage error for %s", async (_name, argv) => {
    const environment = await isolatedEnvironment();
    const result = run(argv, environment);
    const agentTeamHome = environment["AGENT_TEAM_HOME"];

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      operation: "controller_cycle",
      state: "rejected",
      reason: "invalid_command_input",
    });
    expect(agentTeamHome).toBeDefined();
    expect(existsSync(agentTeamHome ?? "")).toBe(false);
    expect(result.stderr).not.toContain("https://sensitive.example");
    expect(result.stderr).not.toContain("pid=1234");
  });
});
