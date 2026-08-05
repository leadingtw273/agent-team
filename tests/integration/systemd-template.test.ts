import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SystemdManager, systemdUnitNames } from "../../src/cli/systemd/index.js";

const roots: string[] = [];
const linuxIt = process.platform === "linux" ? it : it.skip;

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
      expect(preview.service).not.toContain("must-not-render");
      const verification = spawnSync("systemd-analyze", ["verify", servicePath, timerPath], {
        encoding: "utf8",
      });
      expect(verification.error).toBeUndefined();
      expect(verification.status).toBe(0);
    },
  );
});
