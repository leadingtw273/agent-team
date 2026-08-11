import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SystemdManager,
  runtimeEnvironmentNames,
  systemdUnitNames,
} from "../../src/cli/systemd/index.js";

const roots: string[] = [];
const linuxIt = process.platform === "linux" ? it : it.skip;
const canaryUnitNames = Object.freeze({
  service: "agent-team-reconcile-canary.service",
  timer: "agent-team-reconcile-canary.timer",
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("rendered systemd templates", () => {
  linuxIt(
    "requires systemd-analyze verify to pass for temporary rendered units on Linux",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "agent-team-systemd-verify-"));
      roots.push(root);
      const manager = new SystemdManager({
        runtimeCommand: {
          executable: process.execPath,
          arguments: [resolve("dist/cli/index.js"), "reconcile", "--all"],
          environment: {
            PATH: process.env["PATH"] ?? "/usr/bin:/bin",
            HOME: join(root, "home"),
            XDG_CONFIG_HOME: join(root, "xdg-config"),
            AGENT_TEAM_HOME: join(root, "agent-$home"),
            SECRET_ACCESS_TOKEN: "must-not-render",
          },
        },
      });
      const preview = await manager.preview();
      const renderedDirectory = join(root, "rendered");
      const servicePath = join(renderedDirectory, systemdUnitNames.service);
      const timerPath = join(renderedDirectory, systemdUnitNames.timer);
      await mkdir(renderedDirectory, { recursive: true });
      await Promise.all([
        writeFile(servicePath, preview.service, { encoding: "utf8", mode: 0o644 }),
        writeFile(timerPath, preview.timer, { encoding: "utf8", mode: 0o644 }),
      ]);

      expect(preview.timer).toContain("OnUnitInactiveSec=5min");
      expect(preview.service).toContain("AGENT_TEAM_HOME=");
      expect(preview.service).toContain("agent-$$home");
      expect(preview.service).not.toContain("\nEnvironment=");
      expect(preview.service).not.toContain("must-not-render");
      const verification = spawnSync("systemd-analyze", ["verify", servicePath, timerPath], {
        encoding: "utf8",
      });
      expect(verification.error).toBeUndefined();
      expect(verification.status).toBe(0);
    },
  );

  linuxIt(
    "renders an injected timer target and unit paths without canonical output names",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "agent-team-systemd-canary-"));
      roots.push(root);
      const manager = new SystemdManager({
        runtimeCommand: {
          executable: process.execPath,
          arguments: [resolve("dist/cli/index.js"), "reconcile", "--all"],
          environment: {
            PATH: process.env["PATH"] ?? "/usr/bin:/bin",
            HOME: join(root, "home"),
            XDG_CONFIG_HOME: join(root, "xdg-config"),
          },
        },
        unitNames: canaryUnitNames,
      });
      const preview = await manager.preview();
      const renderedDirectory = join(root, "rendered");
      const servicePath = join(renderedDirectory, canaryUnitNames.service);
      const timerPath = join(renderedDirectory, canaryUnitNames.timer);
      await mkdir(renderedDirectory, { recursive: true });
      await Promise.all([
        writeFile(servicePath, preview.service, { encoding: "utf8", mode: 0o644 }),
        writeFile(timerPath, preview.timer, { encoding: "utf8", mode: 0o644 }),
      ]);

      expect(preview.servicePath).toContain(canaryUnitNames.service);
      expect(preview.timerPath).toContain(canaryUnitNames.timer);
      expect(preview.timer).toContain(`Unit=${canaryUnitNames.service}`);
      expect(preview.timer).not.toContain(`Unit=${systemdUnitNames.service}`);
      const verification = spawnSync("systemd-analyze", ["verify", servicePath, timerPath], {
        encoding: "utf8",
      });
      expect(verification.error).toBeUndefined();
      expect(verification.status).toBe(0);
    },
  );

  linuxIt("runs the exact env -i wrapper with only allowlisted Runtime keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-systemd-env-probe-"));
    roots.push(root);
    const probePath = join(root, "environment-probe.mjs");
    await writeFile(
      probePath,
      "console.log(JSON.stringify({ keys: Object.keys(process.env).sort(), agentTeamHome: process.env.AGENT_TEAM_HOME }));\n",
      "utf8",
    );
    const environment = {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "xdg-config"),
      XDG_RUNTIME_DIR: join(root, "runtime"),
      AGENT_TEAM_HOME: join(root, "agent-$home"),
      SECRET_ACCESS_TOKEN: "must-be-cleared-by-env-i",
    };
    const manager = new SystemdManager({
      runtimeCommand: {
        executable: process.execPath,
        arguments: [probePath, "reconcile", "--all"],
        environment,
      },
    });
    const preview = await manager.preview();
    const wrapperExecutable = preview.runtimeCommand[0];
    if (wrapperExecutable === undefined) throw new Error("Runtime wrapper is missing.");

    const result = spawnSync(wrapperExecutable, preview.runtimeCommand.slice(1), {
      encoding: "utf8",
      env: environment,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      keys: [...runtimeEnvironmentNames].sort(),
      agentTeamHome: environment.AGENT_TEAM_HOME,
    });
    expect(preview.runtimeCommand).not.toContain("SECRET_ACCESS_TOKEN=must-be-cleared-by-env-i");
  });
});
