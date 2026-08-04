#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import readline from "node:readline";

const mode = process.argv[2];
const probeCwd = process.argv[3];

function requireProbeCwd() {
  if (!probeCwd?.startsWith("/tmp/agent-team-codex-probe.")) {
    throw new Error("probe requires an isolated /tmp/agent-team-codex-probe.* cwd");
  }
  return probeCwd;
}

async function runExecProbe() {
  const cwd = requireProbeCwd();
  const child = spawn(
    "codex",
    [
      "-a",
      "never",
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "read-only",
      "--json",
      "--model",
      "gpt-5.6-terra",
      "-C",
      cwd,
      "Do not call tools. Return exactly: CODEX_PROBE_OK",
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const lines = readline.createInterface({ input: child.stdout });
  const eventTypes = [];
  let finalMessage = null;
  let turnCompleted = false;

  for await (const line of lines) {
    const event = JSON.parse(line);
    eventTypes.push(event.type);
    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      finalMessage = event.item.text;
    }
    if (event.type === "turn.completed") turnCompleted = true;
  }

  const exit = await new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { exit, eventTypes, finalMessage, turnCompleted };
}

async function runSandboxProbe() {
  const cwd = requireProbeCwd();
  const marker = `${cwd}/sandbox-must-not-exist`;
  const result = spawnSync(
    "codex",
    ["sandbox", "-P", ":read-only", "-C", cwd, "--", "touch", "sandbox-must-not-exist"],
    { cwd, encoding: "utf8" },
  );
  const markerExists = await access(marker).then(
    () => true,
    () => false,
  );

  return {
    exit: { code: result.status, signal: result.signal },
    stderrIncludesReadOnly: result.stderr.includes("Read-only file system"),
    markerExists,
  };
}

async function main() {
  if (!new Set(["exec", "sandbox"]).has(mode)) {
    throw new Error("usage: cli-probe.mjs <exec|sandbox> <probe-cwd>");
  }
  const result = mode === "exec" ? await runExecProbe() : await runSandboxProbe();
  if (
    mode === "exec" &&
    (result.exit.code !== 0 || !result.turnCompleted || result.finalMessage !== "CODEX_PROBE_OK")
  ) {
    throw new Error("exec probe did not produce a completed structured turn");
  }
  if (
    mode === "sandbox" &&
    (result.exit.code === 0 || !result.stderrIncludesReadOnly || result.markerExists)
  ) {
    throw new Error("sandbox probe did not mechanically reject the marker command");
  }
  console.log(JSON.stringify({ schemaVersion: 1, probe: mode, result }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
