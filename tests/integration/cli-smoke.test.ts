import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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

function runGit(cwd: string, arguments_: readonly string[]): void {
  const result = spawnSync("git", arguments_, { cwd, encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0 || result.error !== undefined) {
    throw new Error(
      `git fixture setup failed: ${
        result.stderr.length > 0 ? result.stderr : (result.error?.message ?? "unknown")
      }`,
    );
  }
}

async function treeFingerprint(root: string): Promise<readonly string[]> {
  const entries: string[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    const children = await readdir(directory);
    for (const name of children.sort()) {
      const path = join(directory, name);
      const relative = prefix.length === 0 ? name : `${prefix}/${name}`;
      const metadata = await stat(path);
      if (metadata.isDirectory()) {
        entries.push(`${relative}/`);
        await visit(path, relative);
      } else if (metadata.isFile()) {
        const content = await readFile(path);
        entries.push(`${relative}:${createHash("sha256").update(content).digest("hex")}`);
      } else {
        entries.push(`${relative}:non-file`);
      }
    }
  }
  await visit(root, "");
  return entries;
}

function projectDraft(
  projectId: string,
  localRepositoryPath: string,
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    project: {
      schemaVersion: 1,
      id: projectId,
      displayName: "CLI Smoke Project",
      localRepositoryPath,
      defaultBranch: "main",
      workManagement: {
        provider: "linear",
        containerId: "linear-container-sentinel",
        projectId: "linear-project-sentinel",
      },
      sourceControl: { provider: "github", repository: "owner/private-repository-sentinel" },
    },
    config: {
      schemaVersion: 1,
      projectId,
      defaultBranch: "main",
      platforms: {
        workManagement: {
          provider: "linear",
          containerId: "linear-container-sentinel",
          projectId: "linear-project-sentinel",
        },
        sourceControl: { provider: "github", repository: "owner/private-repository-sentinel" },
      },
      projectRules: ["github_pat_abcdefghijklmnopqrstuvwxyz123456"],
      roleInstructions: { implementer: ["No secret output."] },
      commands: { quality: [{ executable: "pnpm", arguments: ["test"] }], visualReview: [] },
    },
    linearAuditIssueId: "AUDIT-SENTINEL",
  };
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
      jobProgressResume: { outcomes: [], blocked: [] },
      jobProgressBlocked: [],
      modelResumeAttempts: 0,
      scopeDisclosure: {
        wiredCapabilities: [
          "lease_reclaim",
          "job_update",
          "durable_progress_inventory",
          "durable_progress_resume",
        ],
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
        wiredCapabilities: [
          "lease_reclaim",
          "job_update",
          "durable_progress_inventory",
          "durable_progress_resume",
        ],
      },
    });
  });

  it("previews safely and reports an absent timer without depending on runner D-Bus", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-systemd-cli-"));
    roots.push(root);
    const environment = {
      ...process.env,
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "xdg-config"),
      AGENT_TEAM_HOME: join(root, ".agent-team"),
    };
    const unitDirectory = join(environment.XDG_CONFIG_HOME, "systemd", "user");
    await mkdir(environment.AGENT_TEAM_HOME, { recursive: true, mode: 0o700 });
    const beforeHealth = await treeFingerprint(environment.AGENT_TEAM_HOME);
    const preview = run(["systemd", "install", "--dry-run"], environment);
    const uninstallPreview = run(["systemd", "uninstall", "--dry-run"], environment);
    const health = run(["health"], environment);
    const afterHealth = await treeFingerprint(environment.AGENT_TEAM_HOME);

    expect(preview.status).toBe(0);
    const renderedInstall = JSON.parse(preview.stdout) as Readonly<Record<string, unknown>>;
    expect(renderedInstall).toMatchObject({ operation: "install", dryRun: true });
    expect(renderedInstall["service"]).toContain('"cycle" "--all"');
    expect(renderedInstall["service"]).not.toContain('"reconcile" "--all"');
    expect(uninstallPreview.status).toBe(0);
    expect(JSON.parse(uninstallPreview.stdout)).toMatchObject({
      operation: "uninstall",
      dryRun: true,
      state: "not_installed",
    });
    expect(health.status).toBe(0);
    expect(JSON.parse(health.stdout)).toEqual({
      operation: "reconcile_wakeup_status",
      webhookVerificationScope: "transport_runtime_ingest_inbox_only_not_provider_subscription",
      state: "degraded",
      mode: "manual_reconcile_only",
      capabilities: {
        scheduledReconcile: false,
        eventDrivenIngress: false,
        unattended: false,
      },
      sources: {
        systemd: { state: "unavailable", evidenceCode: "systemd_timer_not_installed" },
        webhook: { state: "unavailable", evidenceCode: "webhook_runtime_unconfigured" },
      },
      evidenceCodes: [
        "systemd_timer_not_installed",
        "webhook_runtime_unconfigured",
        "manual_reconcile_required",
      ],
    });
    expect(afterHealth).toEqual(beforeHealth);
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

  it("projects a fake active canonical timer through compiled health and project without spawning reconcile", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-systemd-active-cli-"));
    roots.push(root);
    const repository = join(root, "repository");
    const agentTeamHome = join(root, ".agent-team");
    const fakeBin = join(root, "home", ".local", "bin");
    const counter = join(root, "systemctl-counter");
    const projectId = "project_018f47d2-77a4-7cc1-8ef2-0123456789ab";
    const environment = {
      ...process.env,
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "xdg-config"),
      AGENT_TEAM_HOME: agentTeamHome,
      PATH: join(root, "caller-path-that-must-not-render"),
    };
    const unitDirectory = join(environment.XDG_CONFIG_HOME, "systemd", "user");
    await mkdir(fakeBin, { recursive: true, mode: 0o700 });
    await writeFile(
      join(fakeBin, "systemctl"),
      `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(counter)}
case "$1:$2:$3" in
  "--user:is-enabled:agent-team-reconcile.timer") printf 'enabled\\n'; exit 0 ;;
  "--user:is-active:agent-team-reconcile.timer") printf 'active\\n'; exit 0 ;;
  "--user:is-failed:agent-team-reconcile.timer") printf 'inactive\\n'; exit 1 ;;
esac
exit 64
`,
      { encoding: "utf8", mode: 0o755 },
    );
    await mkdir(repository, { recursive: true });
    runGit(repository, ["init", "--initial-branch=main"]);
    runGit(repository, ["config", "user.email", "smoke@example.invalid"]);
    runGit(repository, ["config", "user.name", "CLI Smoke"]);
    await writeFile(join(repository, "README.md"), "fixture\n");
    runGit(repository, ["add", "README.md"]);
    runGit(repository, ["commit", "-m", "fixture"]);
    await mkdir(join(agentTeamHome, "config", "registration"), { recursive: true, mode: 0o700 });
    await writeFile(
      join(agentTeamHome, "config", "registration", `${projectId}.draft.json`),
      JSON.stringify(projectDraft(projectId, repository)),
      { encoding: "utf8", mode: 0o600 },
    );

    const preview = run(["systemd", "install", "--dry-run"], environment);
    expect(preview.status).toBe(0);
    const rendered = JSON.parse(preview.stdout) as Record<string, unknown>;
    const service = rendered["service"];
    const timer = rendered["timer"];
    if (typeof service !== "string" || typeof timer !== "string") {
      throw new Error("compiled_systemd_preview_missing_canonical_units");
    }
    await mkdir(unitDirectory, { recursive: true, mode: 0o700 });
    await Promise.all([
      writeFile(join(unitDirectory, "agent-team-reconcile.service"), service, {
        encoding: "utf8",
        mode: 0o644,
      }),
      writeFile(join(unitDirectory, "agent-team-reconcile.timer"), timer, {
        encoding: "utf8",
        mode: 0o644,
      }),
    ]);
    const before = await treeFingerprint(agentTeamHome);

    const health = run(["health"], environment);
    const detail = run(["project", projectId], environment);
    const after = await treeFingerprint(agentTeamHome);

    const expectedWakeup = {
      state: "degraded",
      mode: "scheduled_reconcile_only",
      capabilities: { scheduledReconcile: true, eventDrivenIngress: false, unattended: false },
      sources: {
        systemd: { state: "available", evidenceCode: "systemd_timer_active" },
        webhook: { state: "unknown", evidenceCode: "webhook_runtime_unknown" },
      },
      evidenceCodes: [
        "systemd_timer_active",
        "webhook_runtime_unknown",
        "manual_reconcile_required",
      ],
    };
    const expectedDetailWakeup = {
      ...expectedWakeup,
      sources: {
        systemd: { state: "available", evidenceCode: "systemd_timer_active" },
        webhook: { state: "unavailable", evidenceCode: "webhook_runtime_unconfigured" },
      },
      evidenceCodes: [
        "systemd_timer_active",
        "webhook_runtime_unconfigured",
        "manual_reconcile_required",
      ],
    };
    expect(health).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(health.stdout)).toEqual({
      operation: "reconcile_wakeup_status",
      webhookVerificationScope: "transport_runtime_ingest_inbox_only_not_provider_subscription",
      ...expectedWakeup,
    });
    expect(detail).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(detail.stdout)).toMatchObject({
      operation: "project_detail",
      state: "degraded",
      project: { wakeup: expectedDetailWakeup },
    });
    expect(after).toEqual(before);

    const calls = (await readFile(counter, "utf8")).trim().split("\n").sort();
    expect(calls).toEqual(
      [
        "--user is-active agent-team-reconcile.timer",
        "--user is-active agent-team-reconcile.timer",
        "--user is-enabled agent-team-reconcile.timer",
        "--user is-enabled agent-team-reconcile.timer",
        "--user is-failed agent-team-reconcile.timer",
        "--user is-failed agent-team-reconcile.timer",
      ].sort(),
    );
  });

  it("T05: compiled project list/detail/not-found are read-only and do not leak host or provider data", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-project-cli-"));
    roots.push(root);
    const repository = join(root, "repository");
    const agentTeamHome = join(root, ".agent-team");
    const projectId = "project_018f47d2-77a4-7cc1-8ef2-0123456789ab";
    await mkdir(repository, { recursive: true });
    runGit(repository, ["init", "--initial-branch=main"]);
    runGit(repository, ["config", "user.email", "smoke@example.invalid"]);
    runGit(repository, ["config", "user.name", "CLI Smoke"]);
    await writeFile(join(repository, "README.md"), "fixture\n");
    runGit(repository, ["add", "README.md"]);
    runGit(repository, ["commit", "-m", "fixture"]);
    const registrationDirectory = join(agentTeamHome, "config", "registration");
    await mkdir(registrationDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(registrationDirectory, `${projectId}.draft.json`),
      JSON.stringify(projectDraft(projectId, repository)),
      { encoding: "utf8", mode: 0o600 },
    );
    await mkdir(join(agentTeamHome, "secrets"), { recursive: true, mode: 0o700 });
    await writeFile(join(agentTeamHome, "secrets", "must-not-be-read"), "secret-sentinel", {
      encoding: "utf8",
      mode: 0o600,
    });
    const before = await Promise.all([treeFingerprint(repository), treeFingerprint(agentTeamHome)]);
    const environment = { ...process.env, AGENT_TEAM_HOME: agentTeamHome };

    const list = run(["project"], environment);
    const detail = run(["project", projectId], environment);
    const missing = run(["project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ac"], environment);
    const after = await Promise.all([treeFingerprint(repository), treeFingerprint(agentTeamHome)]);

    expect(list).toMatchObject({ status: 0, stderr: "" });
    expect(detail).toMatchObject({ status: 0, stderr: "" });
    expect(missing).toMatchObject({ status: 1, stdout: "" });
    expect(JSON.parse(list.stdout)).toMatchObject({
      operation: "project_list",
      schemaVersion: 1,
      state: "degraded",
      inventory: { state: "available", rejectedDraftCount: 0 },
      projects: [
        {
          id: projectId,
          registration: { state: "configuration_incomplete", reason: "trusted_config_missing" },
        },
      ],
    });
    expect(JSON.parse(detail.stdout)).toMatchObject({
      operation: "project_detail",
      schemaVersion: 1,
      state: "degraded",
      project: {
        id: projectId,
        quota: { state: "unknown", reason: "collector_unavailable" },
        wakeup: { state: "degraded", mode: "manual_reconcile_only" },
      },
    });
    expect(JSON.parse(missing.stderr)).toEqual({
      operation: "project_detail",
      schemaVersion: 1,
      state: "failed",
      reason: "project_not_found",
    });
    for (const text of [
      list.stdout,
      list.stderr,
      detail.stdout,
      detail.stderr,
      missing.stdout,
      missing.stderr,
    ]) {
      for (const sentinel of [
        "private-repository-sentinel",
        "linear-container-sentinel",
        "github_pat_abcdefghijklmnopqrstuvwxyz123456",
        "AUDIT-SENTINEL",
        "secret-sentinel",
      ]) {
        expect(text).not.toContain(sentinel);
      }
    }
    expect(after).toEqual(before);
  });
});
