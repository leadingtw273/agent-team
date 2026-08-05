import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const cli = resolve("dist/cli/index.js");
const roots: string[] = [];

function run(arguments_: readonly string[], environment: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [cli, ...arguments_], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 10_000,
    env: environment,
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("compiled CLI smoke", () => {
  it("executes version and help from the built ESM entrypoint", () => {
    const version = run(["--version"]);
    const help = run(["--help"]);
    const reconcileHelp = run(["reconcile", "--help"]);

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
    const result = run(["reconcile", "--all"]);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("尚未接上 Runtime composition");
  });

  it("previews safely and reports the unwired Runtime without touching a user unit directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-systemd-cli-"));
    roots.push(root);
    const environment = {
      ...process.env,
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "xdg-config"),
    };
    const unitDirectory = join(environment.XDG_CONFIG_HOME, "systemd", "user");
    const preview = run(["systemd", "install", "--dry-run"], environment);
    const uninstallPreview = run(["systemd", "uninstall", "--dry-run"], environment);
    const install = run(["systemd", "install"], environment);
    const status = run(["systemd", "status"], environment);

    expect(preview.status).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({ operation: "install", dryRun: true });
    expect(uninstallPreview.status).toBe(0);
    expect(JSON.parse(uninstallPreview.stdout)).toMatchObject({
      operation: "uninstall",
      dryRun: true,
      state: "not_installed",
    });
    expect(install.status).toBe(3);
    expect(JSON.parse(install.stderr)).toMatchObject({ state: "runtime_unavailable" });
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      installation: "not_installed",
      runtime: "runtime_unavailable",
    });
    await expect(
      readFile(join(unitDirectory, "agent-team-reconcile.service"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(join(unitDirectory, "agent-team-reconcile.timer"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
