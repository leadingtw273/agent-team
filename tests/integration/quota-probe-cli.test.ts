import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli, defaultCliHandlers } from "../../src/cli/program.js";

const metadata = { description: "test", version: "0.1.0" };
const roots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tree(root: string): Promise<readonly string[]> {
  const output: string[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const relative = prefix.length === 0 ? name : `${prefix}/${name}`;
      const metadata = await stat(path);
      if (metadata.isDirectory()) {
        output.push(`${relative}/`);
        await visit(path, relative);
      } else {
        output.push(`${relative}:${String(metadata.size)}`);
      }
    }
  }
  await visit(root, "");
  return output;
}

describe("quota probe-status CLI", () => {
  it.each(["claude", "codex", "all"] as const)(
    "dispatches the fixed %s provider",
    async (provider) => {
      const probeStatus = vi.fn(() =>
        Promise.resolve({ state: "success" as const, message: "{}" }),
      );
      let stdout = "";
      let stderr = "";
      const code = await runCli(
        metadata,
        ["quota", "probe-status", "--provider", provider],
        { ...defaultCliHandlers, quota: { ...defaultCliHandlers.quota, probeStatus } },
        {
          writeOut: (message) => {
            stdout += message;
          },
          writeErr: (message) => {
            stderr += message;
          },
        },
      );
      expect(code).toBe(0);
      expect(probeStatus).toHaveBeenCalledWith({ provider });
      expect(stdout).toBe("{}\n");
      expect(stderr).toBe("");
    },
  );

  it("rejects any provider outside the fixed allowlist before invoking the handler", async () => {
    const probeStatus = vi.fn(() => Promise.resolve({ state: "success" as const }));
    let stderr = "";
    const code = await runCli(
      metadata,
      ["quota", "probe-status", "--provider", "private-secret"],
      { ...defaultCliHandlers, quota: { ...defaultCliHandlers.quota, probeStatus } },
      { writeOut: () => undefined, writeErr: (message) => (stderr += message) },
    );
    expect(code).toBe(2);
    expect(probeStatus).not.toHaveBeenCalled();
    expect(stderr).not.toContain("private-secret");
  });

  it("runs the compiled all-provider probe with fake official sources and zero state mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "quota-probe-cli-"));
    // Registered after the fixture proves its executables; failures before then preserve evidence.
    const home = join(root, "home");
    const bin = join(root, "bin");
    const snapshotPath = join(root, "latest.json");
    const rpcLog = join(root, "rpc.log");
    await mkdir(join(home, "config"), { recursive: true, mode: 0o700 });
    await mkdir(bin, { mode: 0o700 });
    const nowSeconds = Math.floor(Date.now() / 1_000);
    await writeFile(
      snapshotPath,
      JSON.stringify({
        schema: 1,
        probe_ts: nowSeconds,
        session_id: "secret-session-id",
        rate_limits: {
          five_hour: { used_percentage: 4, resets_at: nowSeconds + 3_600 },
          seven_day: { used_percentage: 10, resets_at: nowSeconds + 86_400 },
        },
      }),
      { mode: 0o600 },
    );
    await utimes(snapshotPath, nowSeconds, nowSeconds);
    await writeFile(
      join(home, "config", "quota.json"),
      JSON.stringify({
        schemaVersion: 1,
        claude: {
          enabled: true,
          statusSnapshotPath: snapshotPath,
          expectedCliVersion: "2.1.229",
          weeklyUsageLimitPercent: 80,
          terminalRemainingPercent: 3,
          maxSampleAgeMs: 300_000,
        },
        codex: { diagnosticEnabled: true, expectedCliVersion: "0.147.0" },
      }),
      { mode: 0o600 },
    );
    const claude = join(bin, "claude");
    await writeFile(
      claude,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.join(" ") === "--version") process.stdout.write("2.1.229 (Claude Code)\\n");
else if (args.join(" ") === "auth status --json") process.stdout.write(JSON.stringify({loggedIn:true,authMethod:"claude.ai",apiProvider:"firstParty",email:"secret@example.invalid",orgId:"secret-org",orgName:"secret-name",subscriptionType:"team"}));
else process.exitCode = 2;
`,
      { mode: 0o700 },
    );
    const codex = join(bin, "codex");
    const codexServer = join(bin, "codex-server.cjs");
    await writeFile(
      codexServer,
      `
const { appendFileSync } = require("node:fs");
const readline = require("node:readline");
const args = process.argv.slice(2);
if (args.join(" ") === "app-server --stdio") {
  const lines = readline.createInterface({input:process.stdin});
  lines.on("line", (line) => {
    const request = JSON.parse(line);
    appendFileSync(process.env.FAKE_CODEX_LOG, request.method + "\\n");
    if (request.id === undefined) return;
    let result = {};
    if (request.method === "account/read") result = {account:{type:"chatgpt",email:"secret@example.invalid",planType:"pro"}};
    if (request.method === "account/rateLimits/read") result = {rateLimits:{limitId:"codex",planType:"pro",primary:{usedPercent:8,windowDurationMins:10080,resetsAt:${String(nowSeconds + 86_400)}},secondary:null}};
    process.stdout.write(JSON.stringify({id:request.id,result}) + "\\n");
  });
} else process.exitCode = 2;
`,
      { mode: 0o600 },
    );
    await writeFile(
      codex,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'codex-cli 0.147.0\\n'
else
  exec '${process.execPath}' '${codexServer}' "$@"
fi
`,
      { mode: 0o700 },
    );
    await chmod(claude, 0o700);
    await chmod(codex, 0o700);
    roots.push(root);
    const before = await tree(home);
    const result = await execFileAsync(
      process.execPath,
      [resolve("dist/cli/index.js"), "quota", "probe-status", "--provider", "all"],
      {
        cwd: process.cwd(),
        timeout: 20_000,
        maxBuffer: 64 * 1024,
        env: {
          ...process.env,
          AGENT_TEAM_HOME: home,
          FAKE_CODEX_LOG: rpcLog,
          PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        },
      },
    );
    expect(await readFile(rpcLog, "utf8").catch(() => "missing")).toBe(
      "initialize\ninitialized\naccount/read\naccount/rateLimits/read\naccount/read\n",
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("{");
    const payload: unknown = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      results: [
        { provider: "claude", state: "full" },
        { provider: "codex", state: "partial" },
      ],
    });
    expect(result.stdout).not.toMatch(/secret-session-id|secret@example|secret-org|secret-name/u);
    expect(await tree(home)).toEqual(before);
  }, 25_000);
});
