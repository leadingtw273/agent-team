import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SystemdManager,
  systemdOwnershipMarkers,
  systemdUnitNames,
  type CommandRunRequest,
  type CommandRunner,
} from "../../src/cli/systemd/index.js";

const roots: string[] = [];

interface Fixture {
  readonly root: string;
  readonly unitDirectory: string;
  readonly manager: SystemdManager;
  readonly calls: CommandRunRequest[];
}

function payload(message: string | undefined): Readonly<Record<string, unknown>> {
  expect(message).toBeDefined();
  return JSON.parse(message ?? "") as Readonly<Record<string, unknown>>;
}

async function setup(
  exitCodeFor: (request: CommandRunRequest) => number | null = () => 0,
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "agent-team-systemd-unit-"));
  roots.push(root);
  const environment = {
    ...process.env,
    AGENT_TEAM_HOME: join(root, "agent-team-home"),
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
  };
  const calls: CommandRunRequest[] = [];
  const commandRunner: CommandRunner = {
    run: async (request) => {
      calls.push(request);
      if (request.executable === "systemd-analyze") {
        const service = await readFile(request.arguments[1] ?? "", "utf8");
        const timer = await readFile(request.arguments[2] ?? "", "utf8");
        expect(service).toContain("ExecStart=");
        expect(timer).toContain("OnUnitInactiveSec=5min");
      }
      return { exitCode: exitCodeFor(request) };
    },
  };
  return {
    root,
    unitDirectory: join(environment.XDG_CONFIG_HOME, "systemd", "user"),
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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("systemd installer", () => {
  it("renders a five-minute preview without writing units or invoking commands", async () => {
    const fixture = await setup();
    const result = await fixture.manager.handle({ action: "install", dryRun: true });

    expect(result.state).toBe("success");
    expect(fixture.calls).toEqual([]);
    expect(payload(result.message)).toMatchObject({
      operation: "install",
      dryRun: true,
      unitDirectory: fixture.unitDirectory,
    });
    const preview = await fixture.manager.preview();
    expect(preview.service).toContain("# agent-team-managed: agent-team-reconcile.service v1");
    expect(preview.timer).toContain("OnBootSec=5min");
    expect(preview.timer).toContain("OnUnitInactiveSec=5min");
    await expect(readFile(preview.servicePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preflights, verifies, safely writes, reloads, and enables a new timer", async () => {
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
    expect(fixture.calls[1]).toMatchObject({
      executable: "systemd-analyze",
      arguments: ["verify", expect.any(String), expect.any(String)],
    });
    expect(fixture.calls.slice(2)).toMatchObject([
      { executable: "systemctl", arguments: ["--user", "daemon-reload"] },
      {
        executable: "systemctl",
        arguments: ["--user", "enable", "--now", systemdUnitNames.timer],
      },
    ]);
  });

  it("is idempotent for byte-identical marker-owned units", async () => {
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

  it("fails closed on an unavailable Runtime before writing or calling systemd", async () => {
    const fixture = await setup((request) => (request.executable === "/tmp/fake-node" ? 3 : 0));
    const preview = await fixture.manager.preview();
    const result = await fixture.manager.handle({ action: "install", dryRun: false });

    expect(result.state).toBe("blocked");
    expect(payload(result.message)).toMatchObject({
      state: "runtime_unavailable",
      preflightExitCode: 3,
    });
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]?.executable).toBe("/tmp/fake-node");
    await expect(readFile(preview.servicePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(preview.timerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not overwrite a same-name foreign unit", async () => {
    const fixture = await setup();
    const preview = await fixture.manager.preview();
    await mkdir(fixture.unitDirectory, { recursive: true });
    await writeFile(preview.servicePath, "[Service]\nExecStart=/usr/bin/foreign\n", "utf8");

    const result = await fixture.manager.handle({ action: "install", dryRun: false });

    expect(result.state).toBe("blocked");
    expect(payload(result.message)).toMatchObject({ state: "foreign_units" });
    await expect(readFile(preview.servicePath, "utf8")).resolves.toBe(
      "[Service]\nExecStart=/usr/bin/foreign\n",
    );
    await expect(readFile(preview.timerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(fixture.calls.map((call) => call.executable)).toEqual(["/tmp/fake-node"]);
  });

  it("refuses marker-owned drift instead of silently replacing it", async () => {
    const fixture = await setup();
    const preview = await fixture.manager.preview();
    await mkdir(fixture.unitDirectory, { recursive: true });
    await writeFile(preview.servicePath, preview.service, "utf8");
    await writeFile(preview.timerPath, `${preview.timer}# manually changed\n`, "utf8");

    const result = await fixture.manager.handle({ action: "install", dryRun: false });

    expect(result.state).toBe("blocked");
    expect(payload(result.message)).toMatchObject({ state: "managed_drifted" });
    await expect(readFile(preview.timerPath, "utf8")).resolves.toContain("# manually changed");
    expect(fixture.calls.map((call) => call.executable)).toEqual(["/tmp/fake-node"]);
  });

  it("restores newly written units when daemon-reload fails", async () => {
    const fixture = await setup((request) =>
      request.executable === "systemctl" && request.arguments[1] === "daemon-reload" ? 1 : 0,
    );
    const preview = await fixture.manager.preview();
    const result = await fixture.manager.handle({ action: "install", dryRun: false });

    expect(result.state).toBe("failed");
    expect(payload(result.message)).toMatchObject({ state: "daemon_reload_failed" });
    await expect(readFile(preview.servicePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(preview.timerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves mixed ownership untouched during uninstall", async () => {
    const fixture = await setup();
    const preview = await fixture.manager.preview();
    await mkdir(fixture.unitDirectory, { recursive: true });
    await writeFile(preview.servicePath, preview.service, "utf8");
    await writeFile(preview.timerPath, "[Timer]\nOnBootSec=1min\n", "utf8");

    const result = await fixture.manager.handle({ action: "uninstall", dryRun: false });

    expect(result.state).toBe("blocked");
    expect(payload(result.message)).toMatchObject({ state: "mixed_or_foreign_ownership" });
    await expect(readFile(preview.servicePath, "utf8")).resolves.toContain(
      systemdOwnershipMarkers.service,
    );
    await expect(readFile(preview.timerPath, "utf8")).resolves.toContain("OnBootSec=1min");
    expect(fixture.calls).toEqual([]);
  });

  it("uninstalls both marker-owned units only after disabling the timer", async () => {
    const fixture = await setup();
    const preview = await fixture.manager.preview();
    await mkdir(fixture.unitDirectory, { recursive: true });
    await writeFile(preview.servicePath, preview.service, "utf8");
    await writeFile(preview.timerPath, `${preview.timer}# allowed owned drift\n`, "utf8");

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

  it("reports runtime_unavailable clearly from status without calling systemctl", async () => {
    const fixture = await setup((request) => (request.executable === "/tmp/fake-node" ? 3 : 0));

    const result = await fixture.manager.handle({ action: "status" });

    expect(result.state).toBe("success");
    expect(payload(result.message)).toMatchObject({
      operation: "status",
      installation: "not_installed",
      runtime: "runtime_unavailable",
      preflightExitCode: 3,
    });
    expect(fixture.calls.map((call) => call.executable)).toEqual(["/tmp/fake-node"]);
  });
});
