import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  SystemdManager,
  runtimeEnvironmentNames,
  systemdUnitNames,
  type CommandRunRequest,
  type CommandRunResult,
  type CommandRunner,
  type RenderedSystemdUnits,
  type SystemdUnitNames,
} from "../../src/cli/systemd/index.js";

const roots: string[] = [];
const canaryUnitNames = Object.freeze({
  service: "agent-team-reconcile-canary.service",
  timer: "agent-team-reconcile-canary.timer",
} satisfies SystemdUnitNames);

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

function isRuntimePreflight(request: CommandRunRequest): boolean {
  return (
    request.executable === "/usr/bin/env" &&
    request.arguments.includes("/tmp/fake-node") &&
    request.arguments.at(-2) === "reconcile" &&
    request.arguments.at(-1) === "--all"
  );
}

function hasCommandCall(
  calls: readonly CommandRunRequest[],
  executable: string,
  arguments_: readonly string[],
): boolean {
  return calls.some(
    (call) =>
      call.executable === executable &&
      call.arguments.length === arguments_.length &&
      call.arguments.every((value, index) => value === arguments_[index]),
  );
}

function payload(message: string | undefined): Readonly<Record<string, unknown>> {
  expect(message).toBeDefined();
  return JSON.parse(message ?? "") as Readonly<Record<string, unknown>>;
}

async function setup(
  responder: Responder = () => exited(),
  overrides: EnvironmentOverrides = () => ({}),
  unitNames?: SystemdUnitNames,
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
      ...(unitNames === undefined ? {} : { unitNames }),
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
    expect(preview.service).not.toContain("\nEnvironment=");
    expect(preview.service).toContain('ExecStart="/usr/bin/env" "-i" "PATH=/test/$$path"');
    expect(preview.service).toContain("agent-$$home");
    expect(preview.service).not.toContain("never-render-or-run-with-this");
    expect(preview.runtimeCommand).toContain("PATH=/test/$path");
    expect(preview.runtimeCommand).toContain(
      `AGENT_TEAM_HOME=${join(fixture.root, "agent-$home")}`,
    );
    expect(Object.keys(preview.runtimeEnvironment).sort()).toEqual(
      [...runtimeEnvironmentNames].sort(),
    );
    await expect(readFile(preview.servicePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps injected unit names isolated across render, query, enable, and uninstall", async () => {
    const fixture = await setup(
      (request) => {
        if (request.arguments[1] === "is-enabled") return exited(0, "enabled\n");
        if (request.arguments[1] === "is-active") return exited(0, "active\n");
        if (request.arguments[1] === "is-failed") return exited(1, "inactive\n");
        return exited();
      },
      () => ({}),
      canaryUnitNames,
    );
    const preview = await fixture.manager.preview();
    const canonicalServicePath = join(fixture.unitDirectory, systemdUnitNames.service);
    const canonicalTimerPath = join(fixture.unitDirectory, systemdUnitNames.timer);

    expect(preview.servicePath).toBe(join(fixture.unitDirectory, canaryUnitNames.service));
    expect(preview.timerPath).toBe(join(fixture.unitDirectory, canaryUnitNames.timer));
    expect(preview.timer).toContain(`Unit=${canaryUnitNames.service}`);
    expect(preview.timer).not.toContain(`Unit=${systemdUnitNames.service}`);

    const installed = await fixture.manager.handle({ action: "install", dryRun: false });

    expect(installed.state).toBe("success");
    expect(payload(installed.message)).toMatchObject({
      state: "installed",
      timer: canaryUnitNames.timer,
    });
    expect(
      fixture.calls.some(
        (call) =>
          call.executable === "systemd-analyze" &&
          call.arguments[0] === "verify" &&
          call.arguments[1]?.includes(canaryUnitNames.service) === true &&
          call.arguments[2]?.includes(canaryUnitNames.timer) === true,
      ),
    ).toBe(true);
    expect(
      hasCommandCall(fixture.calls, "systemctl", [
        "--user",
        "enable",
        "--now",
        canaryUnitNames.timer,
      ]),
    ).toBe(true);
    expect(fixture.calls.flatMap((call) => call.arguments)).not.toContain(systemdUnitNames.service);
    expect(fixture.calls.flatMap((call) => call.arguments)).not.toContain(systemdUnitNames.timer);
    await expect(readFile(canonicalServicePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(canonicalTimerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    fixture.calls.splice(0);
    const status = await fixture.manager.handle({ action: "status" });

    expect(status.state).toBe("success");
    expect(payload(status.message)).toMatchObject({
      installation: "installed",
      timer: { state: "queried", enabled: "enabled", activity: "active" },
    });
    const timerQueries = fixture.calls.filter(
      (call) =>
        call.executable === "systemctl" &&
        ["is-enabled", "is-active", "is-failed"].includes(call.arguments[1] ?? ""),
    );
    expect(timerQueries).toHaveLength(3);
    expect(timerQueries.every((call) => call.arguments.at(-1) === canaryUnitNames.timer)).toBe(
      true,
    );

    fixture.calls.splice(0);
    const uninstalled = await fixture.manager.handle({ action: "uninstall", dryRun: false });

    expect(uninstalled.state).toBe("success");
    expect(payload(uninstalled.message)).toMatchObject({ state: "uninstalled" });
    expect(
      hasCommandCall(fixture.calls, "systemctl", [
        "--user",
        "disable",
        "--now",
        canaryUnitNames.timer,
      ]),
    ).toBe(true);
    expect(fixture.calls.flatMap((call) => call.arguments)).not.toContain(systemdUnitNames.service);
    expect(fixture.calls.flatMap((call) => call.arguments)).not.toContain(systemdUnitNames.timer);
    await expect(readFile(preview.servicePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(preview.timerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses the injected timer name during failed-enable rollback", async () => {
    const fixture = await setup(
      (request) =>
        request.executable === "systemctl" && request.arguments[1] === "enable"
          ? exited(1)
          : exited(),
      () => ({}),
      canaryUnitNames,
    );
    const preview = await fixture.manager.preview();

    const result = await fixture.manager.handle({ action: "install", dryRun: false });

    expect(result.state).toBe("failed");
    expect(payload(result.message)).toMatchObject({ state: "timer_enable_failed" });
    expect(
      hasCommandCall(fixture.calls, "systemctl", [
        "--user",
        "enable",
        "--now",
        canaryUnitNames.timer,
      ]),
    ).toBe(true);
    expect(
      hasCommandCall(fixture.calls, "systemctl", [
        "--user",
        "disable",
        "--now",
        canaryUnitNames.timer,
      ]),
    ).toBe(true);
    expect(fixture.calls.flatMap((call) => call.arguments)).not.toContain(systemdUnitNames.service);
    expect(fixture.calls.flatMap((call) => call.arguments)).not.toContain(systemdUnitNames.timer);
    await expect(readFile(preview.servicePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(preview.timerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    {
      service: ".service",
      timer: canaryUnitNames.timer,
    },
    {
      service: canaryUnitNames.service,
      timer: ".timer",
    },
    {
      service: ".hidden.service",
      timer: canaryUnitNames.timer,
    },
    {
      service: canaryUnitNames.service,
      timer: "foo..bar.timer",
    },
    {
      service: "../agent-team-reconcile-canary.service",
      timer: canaryUnitNames.timer,
    },
    {
      service: "agent-team\\reconcile-canary.service",
      timer: canaryUnitNames.timer,
    },
    {
      service: "agent team-reconcile-canary.service",
      timer: canaryUnitNames.timer,
    },
    {
      service: "agent{{team}}-reconcile-canary.service",
      timer: canaryUnitNames.timer,
    },
    {
      service: "agent-team\u0000reconcile-canary.service",
      timer: canaryUnitNames.timer,
    },
    {
      service: "agent-team@reconcile-canary.service",
      timer: canaryUnitNames.timer,
    },
    {
      service: canaryUnitNames.service,
      timer: "agent-team-reconcile-canary.service",
    },
    {
      service: `${"a".repeat(248)}.service`,
      timer: canaryUnitNames.timer,
    },
  ])("rejects unsafe injected unit names before writes or commands", async (unitNames) => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-systemd-invalid-name-"));
    roots.push(root);
    const environment: NodeJS.ProcessEnv = {
      PATH: "/test/bin",
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "xdg-config"),
    };
    const calls: CommandRunRequest[] = [];
    const commandRunner: CommandRunner = {
      run: (request) => {
        calls.push(request);
        return Promise.resolve(exited());
      },
    };

    expect(
      () =>
        new SystemdManager({
          runtimeCommand: {
            executable: "/tmp/fake-node",
            arguments: ["/tmp/fake-agent-team", "reconcile", "--all"],
            environment,
          },
          commandRunner,
          unitNames,
        }),
    ).toThrow(/Systemd/);
    expect(calls).toEqual([]);
    await expect(
      lstat(join(environment["XDG_CONFIG_HOME"] ?? "", "systemd", "user")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preflights the exact compiled command, verifies, writes canonical bytes, reloads, and enables", async () => {
    const fixture = await setup();
    const preview = await fixture.manager.preview();
    const result = await fixture.manager.handle({ action: "install", dryRun: false });

    expect(result.state).toBe("success");
    expect(payload(result.message)).toMatchObject({ operation: "install", state: "installed" });
    await expect(readFile(preview.servicePath, "utf8")).resolves.toBe(preview.service);
    await expect(readFile(preview.timerPath, "utf8")).resolves.toBe(preview.timer);
    expect(fixture.calls[0]).toMatchObject({ executable: "/usr/bin/env" });
    expect([fixture.calls[0]?.executable, ...(fixture.calls[0]?.arguments ?? [])]).toEqual(
      preview.runtimeCommand,
    );
    expect(fixture.calls[0]?.arguments).toContain("PATH=/test/bin");
    expect(fixture.calls[0]?.arguments).not.toContain(
      "SECRET_ACCESS_TOKEN=never-render-or-run-with-this",
    );
    expect(fixture.calls[0]?.environment).toHaveProperty(
      "SECRET_ACCESS_TOKEN",
      "never-render-or-run-with-this",
    );
    expect(
      fixture.calls
        .slice(1)
        .every((call) =>
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
    const fixture = await setup((request) => {
      if (request.arguments[1] === "is-enabled") return exited(0, "enabled\n");
      if (request.arguments[1] === "is-active") return exited(0, "active\n");
      if (request.arguments[1] === "is-failed") return exited(1, "active\n");
      return exited();
    });
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
      "/usr/bin/env",
      "systemctl",
      "systemctl",
      "systemctl",
    ]);
    expect(fixture.calls.map((call) => call.arguments[1])).toEqual([
      "PATH=/test/bin",
      "is-enabled",
      "is-active",
      "is-failed",
    ]);
  });

  it("enables an existing canonical timer only from explicit disabled and inactive state", async () => {
    const fixture = await setup((request) => {
      if (request.arguments[1] === "is-enabled") return exited(1, "disabled\n");
      if (request.arguments[1] === "is-active") return exited(3, "inactive\n");
      if (request.arguments[1] === "is-failed") return exited(1, "inactive\n");
      return exited();
    });
    const preview = await fixture.manager.preview();
    await writeCanonical(fixture, preview);

    const result = await fixture.manager.handle({ action: "install", dryRun: false });

    expect(result.state).toBe("success");
    expect(payload(result.message)).toMatchObject({ state: "enabled_existing_installation" });
    expect(
      fixture.calls.map((call) =>
        call.executable === "systemctl"
          ? `systemctl:${call.arguments[1] ?? "missing"}`
          : call.executable,
      ),
    ).toEqual([
      "/usr/bin/env",
      "systemctl:is-enabled",
      "systemctl:is-active",
      "systemctl:is-failed",
      "systemd-analyze",
      "systemctl:daemon-reload",
      "systemctl:enable",
    ]);
    expect(fixture.calls.some((call) => call.arguments[1] === "disable")).toBe(false);
  });

  it("disables an existing canonical timer back to its original state when enable fails", async () => {
    const fixture = await setup((request) => {
      if (request.arguments[1] === "is-enabled") return exited(1, "disabled\n");
      if (request.arguments[1] === "is-active") return exited(3, "inactive\n");
      if (request.arguments[1] === "is-failed") return exited(1, "inactive\n");
      if (request.arguments[1] === "enable") return exited(1);
      return exited();
    });
    const preview = await fixture.manager.preview();
    await writeCanonical(fixture, preview);
    const originalService = await stat(preview.servicePath, { bigint: true });
    const originalTimer = await stat(preview.timerPath, { bigint: true });

    const result = await fixture.manager.handle({ action: "install", dryRun: false });

    expect(result.state).toBe("failed");
    expect(payload(result.message)).toMatchObject({ state: "timer_enable_failed" });
    expect(
      fixture.calls.map((call) =>
        call.executable === "systemctl"
          ? `systemctl:${call.arguments[1] ?? "missing"}`
          : call.executable,
      ),
    ).toEqual([
      "/usr/bin/env",
      "systemctl:is-enabled",
      "systemctl:is-active",
      "systemctl:is-failed",
      "systemd-analyze",
      "systemctl:daemon-reload",
      "systemctl:enable",
      "systemctl:disable",
    ]);
    expect((await stat(preview.servicePath, { bigint: true })).ino).toBe(originalService.ino);
    expect((await stat(preview.timerPath, { bigint: true })).ino).toBe(originalTimer.ino);
  });

  it("blocks an existing canonical timer when its state query is unknown", async () => {
    const fixture = await setup((request) => {
      if (request.arguments[1] === "is-enabled") return exited(5, "Failed to connect\n");
      if (request.arguments[1] === "is-active") return exited(3, "inactive\n");
      if (request.arguments[1] === "is-failed") return exited(1, "inactive\n");
      return exited();
    });
    const preview = await fixture.manager.preview();
    await writeCanonical(fixture, preview);

    const result = await fixture.manager.handle({ action: "install", dryRun: false });

    expect(result.state).toBe("blocked");
    expect(payload(result.message)).toMatchObject({ state: "timer_state_unknown" });
    expect(fixture.calls).toHaveLength(4);
    expect(fixture.calls.some((call) => call.executable === "systemd-analyze")).toBe(false);
    expect(fixture.calls.some((call) => call.arguments[1] === "enable")).toBe(false);
    expect(fixture.calls.some((call) => call.arguments[1] === "disable")).toBe(false);
  });

  it("blocks an inconsistent enabled but inactive canonical timer", async () => {
    const fixture = await setup((request) => {
      if (request.arguments[1] === "is-enabled") return exited(0, "enabled\n");
      if (request.arguments[1] === "is-active") return exited(3, "inactive\n");
      if (request.arguments[1] === "is-failed") return exited(1, "inactive\n");
      return exited();
    });
    const preview = await fixture.manager.preview();
    await writeCanonical(fixture, preview);

    const result = await fixture.manager.handle({ action: "install", dryRun: false });

    expect(result.state).toBe("blocked");
    expect(payload(result.message)).toMatchObject({ state: "timer_state_inconsistent" });
    expect(fixture.calls).toHaveLength(4);
    expect(fixture.calls.some((call) => call.arguments[1] === "enable")).toBe(false);
    expect(fixture.calls.some((call) => call.arguments[1] === "disable")).toBe(false);
  });

  it("blocks before enable when daemon-reload replaces a newly written canonical unit", async () => {
    let timerPath = "";
    let timerContent = "";
    const fixture = await setup(async (request) => {
      if (request.executable === "systemctl" && request.arguments[1] === "daemon-reload") {
        await delay(10);
        await unlink(timerPath);
        await writeFile(timerPath, timerContent, "utf8");
      }
      return exited();
    });
    const preview = await fixture.manager.preview();
    timerPath = preview.timerPath;
    timerContent = preview.timer;

    const result = await fixture.manager.handle({ action: "install", dryRun: false });

    expect(result.state).toBe("blocked");
    expect(payload(result.message)).toMatchObject({
      state: "unit_changed_after_reload",
      enableAttempted: false,
      rollback: { action: "preserve_conflicting_units", successful: true },
    });
    expect(fixture.calls.some((call) => call.arguments[1] === "enable")).toBe(false);
    await expect(readFile(preview.servicePath, "utf8")).resolves.toBe(preview.service);
    await expect(readFile(preview.timerPath, "utf8")).resolves.toBe(preview.timer);
  });

  it("disables but never deletes a replacement created during enable", async () => {
    let timerPath = "";
    let timerContent = "";
    const fixture = await setup(async (request) => {
      if (request.executable === "systemctl" && request.arguments[1] === "enable") {
        await delay(10);
        await unlink(timerPath);
        await writeFile(timerPath, timerContent, "utf8");
      }
      return exited();
    });
    const preview = await fixture.manager.preview();
    timerPath = preview.timerPath;
    timerContent = preview.timer;

    const result = await fixture.manager.handle({ action: "install", dryRun: false });

    expect(result.state).toBe("failed");
    expect(payload(result.message)).toMatchObject({
      state: "unit_changed_after_enable",
      conflict: "unit_changed_after_enable",
      rollback: {
        action: "disable_known_timer",
        successful: true,
        foreignUnitsPreserved: true,
      },
    });
    expect(fixture.calls.map((call) => call.arguments[1])).toContain("enable");
    expect(fixture.calls.at(-1)?.arguments).toEqual([
      "--user",
      "disable",
      "--now",
      systemdUnitNames.timer,
    ]);
    await expect(readFile(preview.servicePath, "utf8")).resolves.toBe(preview.service);
    await expect(readFile(preview.timerPath, "utf8")).resolves.toBe(preview.timer);
  });

  it("fails closed before directory writes or systemctl when Runtime preflight is unavailable", async () => {
    const fixture = await setup((request) => (isRuntimePreflight(request) ? exited(3) : exited()));
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
    expect(fixture.calls.map((call) => call.executable)).toEqual(["/usr/bin/env"]);
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
    expect(fixture.calls.map((call) => call.executable)).toEqual(["/usr/bin/env"]);
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

  it("preserves a canonical-byte replacement whose file generation changed after disable", async () => {
    let servicePath = "";
    let serviceContent = "";
    let initialCtimeNs: bigint | undefined;
    let replacementCtimeNs: bigint | undefined;
    const fixture = await setup(async (request) => {
      if (request.executable === "systemctl" && request.arguments[1] === "disable") {
        const initial = await lstat(servicePath, { bigint: true });
        initialCtimeNs = initial.ctimeNs;
        await delay(10);
        await unlink(servicePath);
        await writeFile(servicePath, serviceContent, "utf8");
        await chmod(servicePath, 0o600);
        await chmod(servicePath, 0o644);
        replacementCtimeNs = (await lstat(servicePath, { bigint: true })).ctimeNs;
      }
      return exited();
    });
    const preview = await fixture.manager.preview();
    servicePath = preview.servicePath;
    serviceContent = preview.service;
    await writeCanonical(fixture, preview);

    const result = await fixture.manager.handle({ action: "uninstall", dryRun: false });

    expect(initialCtimeNs).toBeDefined();
    expect(replacementCtimeNs).toBeDefined();
    expect(replacementCtimeNs).not.toBe(initialCtimeNs);
    expect(result.state).toBe("blocked");
    expect(payload(result.message)).toMatchObject({
      state: "unit_changed_after_disable",
      units: { service: "canonical", timer: "canonical" },
    });
    await expect(readFile(preview.servicePath, "utf8")).resolves.toBe(preview.service);
    await expect(readFile(preview.timerPath, "utf8")).resolves.toBe(preview.timer);
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

  it("preserves a foreign unit recreated during uninstall daemon-reload and reports conflict", async () => {
    let servicePath = "";
    const fixture = await setup(async (request) => {
      if (request.executable === "systemctl" && request.arguments[1] === "daemon-reload") {
        await writeFile(servicePath, "[Service]\nExecStart=/usr/bin/foreign\n", "utf8");
      }
      return exited();
    });
    const preview = await fixture.manager.preview();
    servicePath = preview.servicePath;
    await writeCanonical(fixture, preview);

    const result = await fixture.manager.handle({ action: "uninstall", dryRun: false });

    expect(result.state).toBe("failed");
    expect(payload(result.message)).toMatchObject({
      state: "unit_reappeared_after_reload",
      conflict: "unit_paths_not_absent",
      units: { service: "untrusted", timer: "missing" },
      foreignUnitsPreserved: true,
    });
    await expect(readFile(preview.servicePath, "utf8")).resolves.toContain("/usr/bin/foreign");
    await expect(readFile(preview.timerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(fixture.calls).toHaveLength(2);
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
      if (isRuntimePreflight(request)) return exited();
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
    const fixture = await setup((request) => (isRuntimePreflight(request) ? exited(3) : exited()));

    const result = await fixture.manager.handle({ action: "status" });

    expect(result.state).toBe("success");
    expect(payload(result.message)).toMatchObject({
      installation: "not_installed",
      runtime: "runtime_unavailable",
      preflight: { classification: "exited", exitCode: 3 },
    });
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]?.environment).toHaveProperty(
      "SECRET_ACCESS_TOKEN",
      "never-render-or-run-with-this",
    );
    expect(fixture.calls[0]?.arguments).not.toContain(
      "SECRET_ACCESS_TOKEN=never-render-or-run-with-this",
    );
  });

  it("does not collapse a DBus/spawn error into disabled", async () => {
    const fixture = await setup((request) => {
      if (isRuntimePreflight(request)) return exited();
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
      if (isRuntimePreflight(request)) return exited();
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
      if (isRuntimePreflight(request)) return exited();
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
