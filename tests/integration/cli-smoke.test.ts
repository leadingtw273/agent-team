import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function writeProgress(
  agentTeamHome: string,
  jobId: string,
  stage: Readonly<Record<string, unknown>>,
): Promise<void> {
  const directory = join(agentTeamHome, "state", "dispatch", "progress");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(directory, `${jobId}.json`),
    JSON.stringify({
      schemaVersion: 1,
      revision: 0,
      jobId,
      projectId: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
      issueId: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab",
      externalIssueId: "ENG-1",
      model: "test-model",
      stage,
      branch: `agent-team/${jobId}`,
      worktreePath: `/tmp/${jobId}`,
      updatedAt: "2026-08-11T12:00:00.000Z",
    }),
    { encoding: "utf8", mode: 0o600 },
  );
}

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

  it("E010b: runs the real production composition against an empty, isolated state directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-reconcile-cli-"));
    roots.push(root);
    const environment = { ...process.env, AGENT_TEAM_HOME: join(root, ".agent-team") };

    const result = run(["reconcile", "--all"], environment);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      operation: "manual_reconcile",
      state: "completed",
      evidenceCode: "manual_reconcile_completed",
      reclaimedLeaseCount: 0,
      targetCounts: { healthy: 0, resumed: 0, blocked: 0, failed: 0 },
      jobProgressCounts: { resumable: 0, blocked: 0, terminal: 0, total: 0 },
      modelResumeAttempts: 0,
      // T02B: production also has a read-only durable progress inventory. Resume remains T03B.
      scopeDisclosure: {
        wiredCapabilities: ["lease_reclaim", "job_update", "durable_progress_inventory"],
        unwiredCapabilities: [
          "active_job_snapshot",
          "provider_readback",
          "event_repair",
          "process_inspect",
          "process_resume",
          "block_record",
          "lease_recovery_prepare",
          "lease_recovery_release",
        ],
      },
    });
  });

  it("T02B: restart inventory distinguishes resumable, blocked and terminal progress", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-reconcile-inventory-cli-"));
    roots.push(root);
    const agentTeamHome = join(root, ".agent-team");
    await writeProgress(agentTeamHome, "job_018f47d2-77a4-7cc1-8ef2-012345678901", {
      kind: "ci_waiting",
    });
    await writeProgress(agentTeamHome, "job_018f47d2-77a4-7cc1-8ef2-012345678902", {
      kind: "implementing",
    });
    await writeProgress(agentTeamHome, "job_018f47d2-77a4-7cc1-8ef2-012345678903", {
      kind: "completed",
    });

    const result = run(["reconcile", "--all"], { ...process.env, AGENT_TEAM_HOME: agentTeamHome });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(3);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      operation: "manual_reconcile",
      state: "degraded",
      evidenceCode: "manual_reconcile_degraded",
      targetCounts: { healthy: 0, resumed: 0, blocked: 0, failed: 0 },
      jobProgressCounts: { resumable: 1, blocked: 1, terminal: 1, total: 3 },
      modelResumeAttempts: 0,
      scopeDisclosure: {
        wiredCapabilities: ["lease_reclaim", "job_update", "durable_progress_inventory"],
      },
    });
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
    const health = run(["health"], environment);

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
    expect(health.status).toBe(0);
    expect(JSON.parse(health.stdout)).toEqual({
      operation: "reconcile_wakeup_status",
      state: "degraded",
      mode: "manual_reconcile_only",
      capabilities: {
        scheduledReconcile: false,
        eventDrivenIngress: false,
        unattended: false,
      },
      sources: {
        systemd: { state: "unavailable", evidenceCode: "systemd_runtime_unavailable" },
        webhook: { state: "unknown", evidenceCode: "webhook_runtime_unknown" },
      },
      evidenceCodes: [
        "systemd_runtime_unavailable",
        "webhook_runtime_unknown",
        "manual_reconcile_required",
      ],
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
