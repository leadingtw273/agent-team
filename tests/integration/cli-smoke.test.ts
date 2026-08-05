import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const cli = resolve("dist/cli/index.js");

function run(...arguments_: string[]) {
  return spawnSync(process.execPath, [cli, ...arguments_], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 10_000,
  });
}

describe("compiled CLI smoke", () => {
  it("executes version and help from the built ESM entrypoint", () => {
    const version = run("--version");
    const help = run("--help");
    const reconcileHelp = run("reconcile", "--help");

    expect(version.error).toBeUndefined();
    expect(help.error).toBeUndefined();
    expect(reconcileHelp.error).toBeUndefined();
    expect(version).toMatchObject({ status: 0, stdout: "0.1.0\n", stderr: "" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("ingest [options] <provider>");
    expect(reconcileHelp.status).toBe(0);
    expect(reconcileHelp.stdout).toContain("--all");
  });

  it("returns the blocked contract instead of pretending an unwired command succeeded", () => {
    const result = run("reconcile", "--all");

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("尚未接上 Runtime composition");
  });
});
