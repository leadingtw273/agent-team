import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

let root: string | undefined;
let child: ChildProcess | undefined;

async function launch(): Promise<{
  readonly process: ChildProcess;
  readonly stderr: () => string;
  readonly stdout: () => string;
  readonly url: string;
}> {
  root = await mkdtemp(join(tmpdir(), "agent-team-ui-cli-"));
  const childProcess = spawn(process.execPath, [resolve("dist/cli/index.js"), "ui"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_TEAM_HOME: join(root, ".agent-team"),
      GITHUB_TOKEN: undefined,
      LINEAR_API_KEY: undefined,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = childProcess;
  let stdout = "";
  let stderr = "";
  childProcess.stdout.setEncoding("utf8");
  childProcess.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  childProcess.stderr.setEncoding("utf8");
  childProcess.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const url = await new Promise<string>((resolveUrl, rejectUrl) => {
    let settled = false;
    const complete = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      complete(() => {
        rejectUrl(new Error("UI CLI did not announce a localhost URL."));
      });
    }, 10_000);
    childProcess.stdout.on("data", () => {
      const match = /Agent Team UI：http:\/\/127\.0\.0\.1:\d+\/#([A-Za-z0-9_-]{43})/u.exec(stdout);
      if (match === null) return;
      complete(() => {
        resolveUrl(match[0].slice("Agent Team UI：".length));
      });
    });
    childProcess.once("error", () => {
      complete(() => {
        rejectUrl(new Error("UI CLI process could not start."));
      });
    });
    childProcess.once("exit", () => {
      complete(() => {
        rejectUrl(new Error("UI CLI exited before readiness."));
      });
    });
  });
  return Object.freeze({ process: childProcess, stderr: () => stderr, stdout: () => stdout, url });
}

async function waitForExit(target: ChildProcess): Promise<number | null> {
  return await new Promise((resolveExit) => {
    if (target.exitCode !== null) {
      resolveExit(target.exitCode);
      return;
    }
    target.once("exit", (code) => {
      resolveExit(code);
    });
  });
}

async function interrupt(target = child): Promise<number | null> {
  if (target === undefined) return null;
  if (target.exitCode !== null) return target.exitCode;
  const pid = target.pid;
  if (pid === undefined) throw new Error("UI CLI process has no PID.");
  process.kill(pid, "SIGINT");
  return await waitForExit(target);
}

afterEach(async () => {
  await interrupt();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
  child = undefined;
});

describe("T06 compiled UI CLI lifecycle", () => {
  it("announces exactly one loopback fragment URL, serves a session shell, and exits 130 after SIGINT", async () => {
    const launched = await launch();
    const token = launched.url.slice(launched.url.indexOf("/#") + 2);
    const baseUrl = launched.url.slice(0, launched.url.indexOf("/#"));

    const anonymous = await fetch(`${baseUrl}/`);
    const exchange = await fetch(`${baseUrl}/__session/exchange`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
    const shell = await fetch(`${baseUrl}/`, { headers: cookie === undefined ? {} : { cookie } });
    const shellBody = await shell.text();

    expect(anonymous.status).toBe(200);
    expect(await anonymous.text()).toContain('src="/__bootstrap.js"');
    expect(exchange.status).toBe(204);
    expect(shell.status).toBe(200);
    expect(shellBody).toContain("尚無可讀取專案");
    expect(shellBody).not.toContain(token);

    expect(await interrupt(launched.process)).toBe(130);
    expect(launched.stdout()).toBe(`Agent Team UI：${launched.url}\n`);
    expect(launched.stderr()).toBe("Agent Team UI 已中斷。\n");
    await expect(fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
  });
});
