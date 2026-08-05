import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SystemdManager,
  runtimeEnvironmentNames,
  systemdUnitNames,
  type CommandRunRequest,
  type CommandRunResult,
  type CommandRunner,
  type RenderedSystemdUnits,
} from "../../src/cli/systemd/index.js";

const roots: string[] = [];

interface Fixture {
  readonly root: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly unitDirectory: string;
  readonly manager: SystemdManager;
  readonly calls: CommandRunRequest[];
}

type Responder = (request: CommandRunRequest) => CommandRunResult | Promise<CommandRunResult>;
type EnvironmentOverrides = (root: string) => NodeJS.ProcessEnv;

function exited(exitCode = 0, stdout = ""): CommandRunResult {
  return {
    classification: "exited",
    exitCode,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function spawnError(): CommandRunResult {
  return {
    classification: "spawn_error",
    exitCode: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    spawnErrorCode: "ECONNREFUSED",
  };
}

function payload(message: string | undefined): Readonly<Record<string, unknown>> {
  expect(message).toBeDefined();
  return JSON.parse(message ?? "") as Readonly<Record<string, unknown>>;
}

async function setup(
  responder: Responder = () => exited(),
  overrides: EnvironmentOverrides = () => ({}),
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "agent-team-systemd-unit-"));
  roots.push(root);
  const environment: NodeJS.ProcessEnv = {
    PATH: "/test/bin",
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
    AGENT_TEAM_HOME: join(root, "agent-team-home"),
    SECRET_ACCESS_TOKEN: "never-render-or-run-with-this",
    ...overrides(root),
  };
  const calls: CommandRunRequest[] = [];
  const commandRunner: CommandRunner = {
    run: async (request) => {
      calls.push({
        executable: request.executable,
        arguments: [...request.arguments],
        environment: { ...request.environment },
      });
      if (request.executable === "systemd-analyze") {
        const service = await readFile(request.arguments[1] ?? "", "utf8");
        const timer = await readFile(request.arguments[2] ?? "", "utf8");
        expect(service).toContain("ExecStart=");
        expect(service).not.toContain("never-render-or-run-with-this");
        expect(timer).toContain("OnUnitInactiveSec=5min");
      }
      return responder(request);
    },
  };
  return {
    root,
    environment,
    unitDirectory: join(environment["XDG_CONFIG_HOME"] ?? "", "systemd", "user"),
    manager: new SystemdManager({
      runtimeCommand: {
        executable: "/tmp/fake-node",
        arguments: ["/tmp/fake-agent-team", "reconcile", "--all"],
        environment,
      },
      commandRunner,
    }),
    calls,
  };
}

async function writeCanonical(fixture: Fixture, preview: RenderedSystemdUnits): Promise<void> {
  await mkdir(fixture.unitDirectory, { recursive: true });
  await Promise.all([
    writeFile(preview.servicePath, preview.service, "utf8"),
    writeFile(preview.timerPath, preview.timer, "utf8"),
  ]);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("systemd installer security boundary", () => {
  it("renders a five-minute dry run from the allowlisted Runtime environment only", async () => {
    const fixture = await setup(undefined, (root) => ({
      PATH: "/test/$path",
      AGENT_TEAM_HOME: join(root, "agent-$home"),
    }));
    const result = await fixture.manager.handle({ action: "install", dryRun: true });
    const preview = await fixture.manager.preview();

    expect(result.state).toBe("success");
    expect(fixture.calls).toEqual([]);
    expect(payload(result.message)).toMatchObject({
      operation: "install",
      dryRun: true,
      unitDirectory: fixture.unitDirectory,
    });
    expect(preview.timer).toContain("OnBootSec=5min");
    expect(preview.timer).toContain("OnUnitInactiveSec=5min");
    expect(preview.service).toContain('Environment="PATH=/test/$$path"');
    expect(preview.service).toContain('Environment="AGENT_TEAM_HOME=');
    expect(preview.service).toContain("agent-$$home");
    expect(preview.service).not.toContain("never-render-or-run-with-this");
    expect(Object.keys(preview.runtimeEnvironment).sort()).toEqual(
      [...runtimeEnvironmentNames].sort(),
    );
    await expect(readFile(preview.servicePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preflights the exact compiled command, verifies, writes canonical bytes, reloads, and enables", async () => {
    const fixture = await setup();
    const preview = await fixture.manager.preview();
    const result = await fixture.manager.handle({ action: "install", dryRun: false });

    expect(result.state).toBe("success");
    expect(payload(result.message)).toMatchObject({ operation: "install", state: "installed" });
    await expect(readFile(preview.servicePath, "utf8")).resolves.toBe(preview.service);
    await expect(readFile(preview.timerPath, "utf8")).resolves.toBe(preview.timer);
    expect(fixture.calls[0]).toMatchObject({
      executable: "/tmp/fake-node",
      arguments: ["/tmp/fake-agent-team", "reconcile", "--all"],
    });
    expect(Object.keys(fixture.calls[0]?.environment ?? {}).sort()).toEqual(
      [...runtimeEnvironmentNames].sort(),
    );
    expect(fixture.calls[0]?.environment).not.toHaveProperty("SECRET_ACCESS_TOKEN");
    expect(
      fixture.calls.every((call) =>
        Object.keys(call.environment).every((name) =>
          runtimeEnvironmentNames.includes(name as never),
        ),
      ),
    ).toBe(true);
    expect(fixture.calls.slice(1)).toMatchObject([
      {
        executable: "systemd-analyze",
        arguments: ["verify", expect.any(String), expect.any(String)],
      },
      { executable: "systemctl", arguments: ["--user", "daemon-reload"] },
      {
        executable: "systemctl",
        arguments: ["--user", "enable", "--now", systemdUnitNames.timer],
      },
    ]);
  });

  it("is idempotent only for byte-identical canonical units", async () => {
    const fixture = await setup();
    const preview = await fixture.manager.preview();
    await fixture.manager.handle({ action: "install", dryRun: false });
    const initialService = await stat(preview.servicePath);
    const initialTimer = await stat(preview.timerPath);
    fixture.calls.splice(0);

    const result = await fixture.manager.handle({ action: "install", dryRun: false });

    expect(result.state).toBe("success");
    expect(payload(result.message)).toMatchObject({ state: "already_installed" });
    expect((await stat(preview.servicePath)).ino).toBe(initialService.ino);
    expect((await stat(preview.timerPath)).ino).toBe(initialTimer.ino);
    expect(fixture.calls.map((call) => call.executable)).toEqual([
      "/tmp/fake-node",
      "systemd-analyze",
      "systemctl",
      "systemctl",
    ]);
  });

  it("fails closed before directory writes or systemctl when Runtime preflight is unavailable", async () => {
    const fixture = await setup((request) =>
      request.executable === "/tmp/fake-node" ? exited(3) : exited(),
    );
    const preview = await fixture.manager.preview();
    const result = await fixture.manager.handle({ action: "install", dryRun: false });

    expect(result.state).toBe("blocked");
    expect(payload(result.message)).toMatchObject({
      state: "runtime_unavailable",
      preflight: { classification: "exited", exitCode: 3 },
    });
    expect(fixture.calls).toHaveLength(1);
    await expect(readFile(preview.servicePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(preview.timerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats marker spoofing and canonical-byte drift as untrusted without overwrite", async () => {
    const fixture = await setup();
    const preview = await fixture.manager.preview();
    await mkdir(fixture.unitDirectory, { recursive: true });
    await writeFile(
      preview.servicePath,
      "# agent-team-managed: agent-team-reconcile.service v1\n[Service]\nExecStart=/usr/bin/foreign\n",
      "utf8",
    );
    await writeFile(preview.timerPath, `${preview.timer}# drift\n`, "utf8");

    const result = await fixture.manager.handle({ action: "install", dryRun: false });

    expect(result.state).toBe("blocked");
    expect(payload(result.message)).toMatchObject({
      state: "untrusted_units",
      units: { service: "untrusted", timer: "untrusted" },
    });
    await expect(readFile(preview.servicePath, "utf8")).resolves.toContain("/usr/bin/foreign");
    expect(fixture.calls.map((call) => call.executable)).toEqual(["/tmp/fake-node"]);
  });

  it("rejects hardlinked canonical-looking units during install and uninstall", async () => {
    const fixture = await setup();
    const preview = await fixture.manager.preview();
    const decoy = join(fixture.root, "canonical-service-decoy");
    await mkdir(fixture.unitDirectory, { recursive: true });
    await writeFile(decoy, preview.service, "utf8");
    await link(decoy, preview.servicePath);
    await writeFile(preview.timerPath, preview.timer, "utf8");

    const install = await fixture.manager.handle({ action: "install", dryRun: false });
    const uninstall = await fixture.manager.handle({ action: "uninstall", dryRun: false });

    expect(payload(install.message)).toMatchObject({ state: "untrusted_units" });
    expect(uninstall.state).toBe("blocked");
    expect(payload(uninstall.message)).toMatchObject({ state: "untrusted_units" });
    expect((await stat(preview.servicePath)).nlink).toBe(2);
    await expect(readFile(preview.timerPath, "utf8")).resolves.toBe(preview.timer);
    expect(fixture.calls.map((call) => call.executable)).toEqual(["/tmp/fake-node"]);
  });

  it("never disables or deletes a mixed canonical and drifted pair during uninstall", async () => {
    const fixture = await setup();
    const preview = await fixture.manager.preview();
    await writeCanonical(fixture, preview);
    await writeFile(preview.timerPath, `${preview.timer}# drift\n`, "utf8");

    const result = await fixture.manager.handle({ action: "uninstall", dryRun: false });

    expect(result.state).toBe("blocked");
    expect(payload(result.message)).toMatchObject({
      state: "untrusted_units",
      units: { service: "canonical", timer: "untrusted" },
    });
    expect(fixture.calls).toEqual([]);
    await expect(readFile(preview.servicePath, "utf8")).resolves.toBe(preview.service);
    await expect(readFile(preview.timerPath, "utf8")).resolves.toContain("# drift");
  });

  it.each([
    [
      "XDG_CONFIG_HOME",
      async (fixture: Fixture) => {
        const target = join(fixture.root, "real-xdg");
        await mkdir(target, { recursive: true });
        await symlink(target, fixture.environment["XDG_CONFIG_HOME"] ?? "");
      },
    ],
    [
      "systemd",
      async (fixture: Fixture) => {
        const xdg = fixture.environment["XDG_CONFIG_HOME"] ?? "";
        const target = join(fixture.root, "real-systemd");
        await mkdir(xdg, { recursive: true });
        await mkdir(target, { recursive: true });
        await symlink(target, join(xdg, "systemd"));
      },
    ],
    [
      "user",
      async (fixture: Fixture) => {
        const xdg = fixture.environment["XDG_CONFIG_HOME"] ?? "";
        const target = join(fixture.root, "real-user");
        await mkdir(join(xdg, "systemd"), { recursive: true });
        await mkdir(target, { recursive: true });
        await symlink(target, join(xdg, "systemd", "user"));
      },
    ],
    [
      "non-directory systemd",
      async (fixture: Fixture) => {
        const xdg = fixture.environment["XDG_CONFIG_HOME"] ?? "";
        await mkdir(xdg, { recursive: true });
        await writeFile(join(xdg, "systemd"), "not a directory", "utf8");
      },
    ],
  ])("rejects an unsafe %s parent before running any command", async (_name, arrange) => {
    const fixture = await setup();
    await arrange(fixture);

    const result = await fixture.manager.handle({ action: "install", dryRun: false });

    expect(result.state).toBe("failed");
    expect(payload(result.message)).toMatchObject({ state: "systemd_configuration_error" });
    expect(fixture.calls).toEqual([]);
  });

  it("never follows an unsafe parent during uninstall", async () => {
    const fixture = await setup();
    const target = join(fixture.root, "real-user");
    const xdg = fixture.environment["XDG_CONFIG_HOME"] ?? "";
    await mkdir(join(xdg, "systemd"), { recursive: true });
    await mkdir(target, { recursive: true });
    await symlink(target, join(xdg, "systemd", "user"));

    const result = await fixture.manager.handle({ action: "uninstall", dryRun: false });

    expect(result.state).toBe("failed");
    expect(payload(result.message)).toMatchObject({ state: "systemd_configuration_error" });
    expect(fixture.calls).toEqual([]);
  });

  it("does not delete units if enable fails and its mandatory disable rollback fails", async () => {
    const fixture = await setup((request) => {
      if (request.executable === "systemctl" && request.arguments[1] === "enable") return exited(1);
      if (request.executable === "systemctl" && request.arguments[1] === "disable")
        return exited(1);
      return exited();
    });
    const preview = await fixture.manager.preview();

    const result = await fixture.manager.handle({ action: "install", dryRun: false });

    expect(result.state).toBe("failed");
    expect(payload(result.message)).toMatchObject({
      state: "rollback_failed",
      rollbackReason: "disable_failed",
    });
    await expect(readFile(preview.servicePath, "utf8")).resolves.toBe(preview.service);
    await expect(readFile(preview.timerPath, "utf8")).resolves.toBe(preview.timer);
  });

  it("removes newly created units only after a successful enable rollback disable", async () => {
    const fixture = await setup((request) =>
      request.executable === "systemctl" && request.arguments[1] === "enable"
        ? exited(1)
        : exited(),
    );
    const preview = await fixture.manager.preview();

    const result = await fixture.manager.handle({ action: "install", dryRun: false });

    expect(result.state).toBe("failed");
    expect(payload(result.message)).toMatchObject({ state: "timer_enable_failed" });
    await expect(readFile(preview.servicePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(preview.timerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores newly created units when enable rollback cannot reload the removal", async () => {
    let reloads = 0;
    const fixture = await setup((request) => {
      if (request.executable === "systemctl" && request.arguments[1] === "enable") return exited(1);
      if (request.executable === "systemctl" && request.arguments[1] === "daemon-reload") {
        reloads += 1;
        return exited(reloads === 2 ? 1 : 0);
      }
      return exited();
    });
    const preview = await fixture.manager.preview();

    const result = await fixture.manager.handle({ action: "install", dryRun: false });

    expect(result.state).toBe("failed");
    expect(payload(result.message)).toMatchObject({
      state: "rollback_failed",
      rollbackReason: "reload_failed",
    });
    expect(reloads).toBe(3);
    await expect(readFile(preview.servicePath, "utf8")).resolves.toBe(preview.service);
    await expect(readFile(preview.timerPath, "utf8")).resolves.toBe(preview.timer);
  });

  it("refuses uninstall when disable fails and retains both canonical units", async () => {
    const fixture = await setup((request) =>
      request.executable === "systemctl" && request.arguments[1] === "disable"
        ? exited(1)
        : exited(),
    );
    const preview = await fixture.manager.preview();
    await writeCanonical(fixture, preview);

    const result = await fixture.manager.handle({ action: "uninstall", dryRun: false });

    expect(result.state).toBe("failed");
    expect(payload(result.message)).toMatchObject({ state: "timer_disable_failed" });
    await expect(readFile(preview.servicePath, "utf8")).resolves.toBe(preview.service);
    await expect(readFile(preview.timerPath, "utf8")).resolves.toBe(preview.timer);
    expect(fixture.calls).toHaveLength(1);
  });

  it("detects a TOCTOU mutation after disable and never enters quarantine removal", async () => {
    let unitDirectory = "";
    const fixture = await setup(async (request) => {
      if (request.executable === "systemctl" && request.arguments[1] === "disable") {
        await writeFile(
          join(unitDirectory, systemdUnitNames.timer),
          "[Timer]\nOnBootSec=1min\n",
          "utf8",
        );
      }
      return exited();
    });
    unitDirectory = fixture.unitDirectory;
    const preview = await fixture.manager.preview();
    await writeCanonical(fixture, preview);

    const result = await fixture.manager.handle({ action: "uninstall", dryRun: false });

    expect(result.state).toBe("blocked");
    expect(payload(result.message)).toMatchObject({
      state: "unit_changed_after_disable",
      units: { service: "canonical", timer: "untrusted" },
    });
    await expect(readFile(preview.servicePath, "utf8")).resolves.toBe(preview.service);
    await expect(readFile(preview.timerPath, "utf8")).resolves.toContain("OnBootSec=1min");
    expect(fixture.calls).toHaveLength(1);
  });

  it("quarantines and removes both canonical units only after disable succeeds", async () => {
    const fixture = await setup();
    const preview = await fixture.manager.preview();
    await writeCanonical(fixture, preview);

    const result = await fixture.manager.handle({ action: "uninstall", dryRun: false });

    expect(result.state).toBe("success");
    expect(payload(result.message)).toMatchObject({ state: "uninstalled" });
    expect(fixture.calls).toMatchObject([
      {
        executable: "systemctl",
        arguments: ["--user", "disable", "--now", systemdUnitNames.timer],
      },
      { executable: "systemctl", arguments: ["--user", "daemon-reload"] },
    ]);
    await expect(readFile(preview.servicePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(preview.timerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains canonical units and reports recovery when quarantine cannot begin", async () => {
    let unitDirectory = "";
    const fixture = await setup(async (request) => {
      if (request.executable === "systemctl" && request.arguments[1] === "disable") {
        await chmod(unitDirectory, 0o500);
      }
      return exited();
    });
    unitDirectory = fixture.unitDirectory;
    const preview = await fixture.manager.preview();
    await writeCanonical(fixture, preview);

    const result = await fixture.manager.handle({ action: "uninstall", dryRun: false });

    await chmod(fixture.unitDirectory, 0o700);
    expect(result.state).toBe("failed");
    expect(payload(result.message)).toMatchObject({ state: "unit_remove_failed_recovered" });
    await expect(readFile(preview.servicePath, "utf8")).resolves.toBe(preview.service);
    await expect(readFile(preview.timerPath, "utf8")).resolves.toBe(preview.timer);
  });

  it("restores both canonical units when post-removal daemon-reload fails", async () => {
    let reloads = 0;
    const fixture = await setup((request) => {
      if (request.executable === "systemctl" && request.arguments[1] === "daemon-reload") {
        reloads += 1;
        return exited(reloads === 1 ? 1 : 0);
      }
      return exited();
    });
    const preview = await fixture.manager.preview();
    await writeCanonical(fixture, preview);

    const result = await fixture.manager.handle({ action: "uninstall", dryRun: false });

    expect(result.state).toBe("failed");
    expect(payload(result.message)).toMatchObject({ state: "daemon_reload_failed_recovered" });
    await expect(readFile(preview.servicePath, "utf8")).resolves.toBe(preview.service);
    await expect(readFile(preview.timerPath, "utf8")).resolves.toBe(preview.timer);
  });

  it("does not claim uninstall recovery when the restoration reload also fails", async () => {
    const fixture = await setup((request) =>
      request.executable === "systemctl" && request.arguments[1] === "daemon-reload"
        ? exited(1)
        : exited(),
    );
    const preview = await fixture.manager.preview();
    await writeCanonical(fixture, preview);

    const result = await fixture.manager.handle({ action: "uninstall", dryRun: false });

    expect(result.state).toBe("failed");
    expect(payload(result.message)).toMatchObject({ state: "rollback_failed" });
    await expect(readFile(preview.servicePath, "utf8")).resolves.toBe(preview.service);
    await expect(readFile(preview.timerPath, "utf8")).resolves.toBe(preview.timer);
  });

  it("reports disabled, inactive, and failed states separately from systemd query errors", async () => {
    const fixture = await setup((request) => {
      if (request.executable === "/tmp/fake-node") return exited();
      if (request.arguments[1] === "is-enabled") return exited(1, "disabled\n");
      if (request.arguments[1] === "is-active") return exited(3, "inactive\n");
      if (request.arguments[1] === "is-failed") return exited(1, "inactive\n");
      return exited();
    });
    const preview = await fixture.manager.preview();
    await writeCanonical(fixture, preview);

    const result = await fixture.manager.handle({ action: "status" });

    expect(result.state).toBe("success");
    expect(payload(result.message)).toMatchObject({
      runtime: "available",
      timer: { state: "queried", enabled: "disabled", activity: "inactive" },
    });
  });

  it("reports unavailable Runtime status without treating it as a systemd state", async () => {
    const fixture = await setup((request) =>
      request.executable === "/tmp/fake-node" ? exited(3) : exited(),
    );

    const result = await fixture.manager.handle({ action: "status" });

    expect(result.state).toBe("success");
    expect(payload(result.message)).toMatchObject({
      installation: "not_installed",
      runtime: "runtime_unavailable",
      preflight: { classification: "exited", exitCode: 3 },
    });
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]?.environment).not.toHaveProperty("SECRET_ACCESS_TOKEN");
  });

  it("does not collapse a DBus/spawn error into disabled", async () => {
    const fixture = await setup((request) => {
      if (request.executable === "/tmp/fake-node") return exited();
      if (request.arguments[1] === "is-enabled") return spawnError();
      return exited();
    });
    const preview = await fixture.manager.preview();
    await writeCanonical(fixture, preview);

    const result = await fixture.manager.handle({ action: "status" });

    expect(payload(result.message)).toMatchObject({
      timer: { state: "query_error", enabled: { classification: "spawn_error" } },
    });
  });

  it("reports an unexpected nonzero is-enabled result as unknown rather than disabled", async () => {
    const fixture = await setup((request) => {
      if (request.executable === "/tmp/fake-node") return exited();
      if (request.arguments[1] === "is-enabled") return exited(5);
      if (request.arguments[1] === "is-active") return exited(3, "inactive\n");
      if (request.arguments[1] === "is-failed") return exited(1, "inactive\n");
      return exited();
    });
    const preview = await fixture.manager.preview();
    await writeCanonical(fixture, preview);

    const result = await fixture.manager.handle({ action: "status" });

    expect(payload(result.message)).toMatchObject({
      timer: { state: "queried", enabled: "unknown", activity: "inactive" },
    });
  });

  it("does not treat a nonzero D-Bus diagnostic as disabled without an explicit state", async () => {
    const fixture = await setup((request) => {
      if (request.executable === "/tmp/fake-node") return exited();
      if (request.arguments[1] === "is-enabled") return exited(1, "Failed to connect to bus\n");
      return exited();
    });
    const preview = await fixture.manager.preview();
    await writeCanonical(fixture, preview);

    const result = await fixture.manager.handle({ action: "status" });

    expect(payload(result.message)).toMatchObject({
      timer: { state: "queried", enabled: "unknown" },
    });
  });
});
