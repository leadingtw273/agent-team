#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
const probeCwd = process.argv[3];
const allowedModes = new Set(["exec", "visual", "permission", "unavailable", "signal"]);
const readOnlyPolicy = fileURLToPath(new URL("./read-only-review.toml", import.meta.url));
const headlessApprovalPolicy = fileURLToPath(new URL("./headless-approval.toml", import.meta.url));

function requireProbeCwd() {
  if (!probeCwd?.startsWith("/tmp/agent-team-gemini-probe.")) {
    throw new Error("probe requires an isolated /tmp/agent-team-gemini-probe.* cwd");
  }
  return probeCwd;
}

function geminiVersion() {
  const result = spawnSync("gemini", ["--version"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("gemini --version failed");
  return result.stdout.trim();
}

function commonArgs(prompt, policy = readOnlyPolicy, outputFormat = "stream-json") {
  return [
    "-p",
    prompt,
    "--skip-trust",
    "--approval-mode",
    "plan",
    "--admin-policy",
    policy,
    "--output-format",
    outputFormat,
  ];
}

async function runGeminiJson(args, cwd, timeoutMs = 90_000) {
  const child = spawn("gemini", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exit = await new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  return {
    exit,
    timedOut,
    stderrPresent: stderr.trim().length > 0,
    payload: stdout.trim() ? JSON.parse(stdout) : null,
  };
}

function summarizeJson(run) {
  const payload = run.payload ?? {};
  const models = payload.stats?.models ?? {};
  const byName = payload.stats?.tools?.byName ?? {};
  const tools = Object.entries(byName).map(([name, value]) => ({
    name,
    count: typeof value?.count === "number" ? value.count : null,
    success: typeof value?.success === "number" ? value.success : null,
    fail: typeof value?.fail === "number" ? value.fail : null,
  }));
  return {
    exit: run.exit,
    timedOut: run.timedOut,
    stderrPresent: run.stderrPresent,
    response: typeof payload.response === "string" ? payload.response.trim() : null,
    hasError: payload.error !== undefined,
    modelNames: Object.keys(models),
    tools,
    totalDecisions: {
      accept: payload.stats?.tools?.totalDecisions?.accept ?? 0,
      reject: payload.stats?.tools?.totalDecisions?.reject ?? 0,
      modify: payload.stats?.tools?.totalDecisions?.modify ?? 0,
      autoAccept: payload.stats?.tools?.totalDecisions?.auto_accept ?? 0,
    },
    filesChanged: {
      linesAdded: payload.stats?.files?.totalLinesAdded ?? 0,
      linesRemoved: payload.stats?.files?.totalLinesRemoved ?? 0,
    },
  };
}

async function runGemini(args, cwd, timeoutMs = 90_000, onEvent, onSpawn) {
  const child = spawn("gemini", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  onSpawn?.(child);
  let stdoutBuffer = "";
  let stderr = "";
  let timedOut = false;
  const events = [];
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      events.push(event);
      onEvent?.(event, child);
    }
  });

  const exit = await new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  if (stdoutBuffer.trim()) events.push(JSON.parse(stdoutBuffer));
  return { exit, events, stderrPresent: stderr.trim().length > 0, timedOut };
}

function summarize(run) {
  const eventTypes = [];
  const toolNames = [];
  const toolResultStatuses = [];
  const errors = [];
  let model = null;
  let finalStatus = null;
  let resultResponse = null;
  let assistantText = "";

  for (const event of run.events) {
    eventTypes.push(event.type);
    if (event.type === "init" && typeof event.model === "string") model = event.model;
    if (
      event.type === "message" &&
      event.role === "assistant" &&
      typeof event.content === "string"
    ) {
      assistantText += event.content;
    }
    if (event.type === "tool_use") {
      const name = event.tool_name ?? event.toolName ?? event.name;
      toolNames.push(typeof name === "string" ? name : "unknown");
    }
    if (event.type === "tool_result") {
      const status = event.status ?? (event.error ? "error" : "success");
      toolResultStatuses.push(typeof status === "string" ? status : "unknown");
    }
    if (event.type === "error") {
      errors.push({
        severity: typeof event.severity === "string" ? event.severity : null,
        code: typeof event.code === "string" ? event.code : null,
      });
    }
    if (event.type === "result") {
      if (typeof event.status === "string") finalStatus = event.status;
      if (typeof event.response === "string") resultResponse = event.response.trim();
    }
  }

  return {
    exit: run.exit,
    timedOut: run.timedOut,
    stderrPresent: run.stderrPresent,
    eventTypes,
    model,
    toolNames,
    toolResultStatuses,
    errorEvents: errors,
    assistantText: assistantText.trim(),
    resultResponse,
    finalStatus,
  };
}

async function exists(path) {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function runExecProbe() {
  const cwd = requireProbeCwd();
  const run = await runGemini(
    commonArgs("Return exactly GEMINI_PROBE_OK. Do not call tools."),
    cwd,
  );
  const summary = summarize(run);
  if (
    summary.exit.code !== 0 ||
    summary.finalStatus !== "success" ||
    summary.assistantText !== "GEMINI_PROBE_OK" ||
    summary.toolNames.length !== 0
  ) {
    throw new Error(`Gemini exec probe failed: ${JSON.stringify(summary)}`);
  }
  return summary;
}

async function runVisualProbe() {
  const cwd = requireProbeCwd();
  const imagePath = `${cwd}/visual-probe.png`;
  if (!(await exists(imagePath))) throw new Error("visual-probe.png is required");
  const run = await runGeminiJson(
    commonArgs(
      `Use a read-only file tool to inspect ${imagePath}. State the color and location of both squares in one short sentence.`,
      readOnlyPolicy,
      "json",
    ),
    cwd,
  );
  const summary = summarizeJson(run);
  if (
    summary.exit.code !== 0 ||
    summary.hasError ||
    !summary.response?.toLowerCase().includes("red square in the top left") ||
    !summary.response.toLowerCase().includes("blue square in the bottom right") ||
    !summary.tools.some(
      (tool) => ["read_file", "read_many_files"].includes(tool.name) && tool.success === 1,
    ) ||
    summary.filesChanged.linesAdded !== 0 ||
    summary.filesChanged.linesRemoved !== 0
  ) {
    throw new Error(`Gemini visual probe failed: ${JSON.stringify(summary)}`);
  }
  return summary;
}

async function runPermissionProbe() {
  const cwd = requireProbeCwd();
  const marker = `${cwd}/permission-must-not-exist`;
  if (await exists(marker)) throw new Error("permission marker already exists");
  const run = await runGeminiJson(
    commonArgs(
      "Use write_file exactly once to create permission-must-not-exist with any content. Do not simulate the tool call. Then report the actual result.",
      headlessApprovalPolicy,
      "json",
    ),
    cwd,
  );
  const summary = summarizeJson(run);
  const markerExists = await exists(marker);
  if (
    summary.exit.code !== 0 ||
    markerExists ||
    (summary.totalDecisions.reject === 0 &&
      !summary.tools.some((tool) => tool.name === "write_file" && tool.fail === 1))
  ) {
    throw new Error(`Gemini permission probe failed: ${JSON.stringify({ summary, markerExists })}`);
  }
  return { ...summary, markerExists };
}

async function runUnavailableProbe() {
  const cwd = requireProbeCwd();
  const run = await runGeminiJson(
    [
      ...commonArgs("Return GEMINI_INVALID_MODEL_MUST_NOT_SUCCEED.", readOnlyPolicy, "json"),
      "--model",
      "agent-team-invalid-model",
    ],
    cwd,
    30_000,
  );
  const summary = summarizeJson(run);
  if (summary.exit.code === 0 && !summary.hasError) {
    throw new Error(`Gemini unavailable probe was misclassified: ${JSON.stringify(summary)}`);
  }
  return {
    ...summary,
    detectedByNonzeroExit: summary.exit.code !== 0,
    detectedByStructuredError: summary.hasError,
  };
}

async function runSignalProbe() {
  const cwd = requireProbeCwd();
  let inventoryChecked = false;
  let inventoryChecks = 0;
  let termSent = false;
  let killSent = false;
  let signalTimer;
  let killTimer;
  const run = await runGemini(
    commonArgs("Return exactly GEMINI_SIGNAL_SHOULD_NOT_COMPLETE. Do not call tools."),
    cwd,
    30_000,
    undefined,
    (child) => {
      signalTimer = setTimeout(() => {
        if (child.pid === undefined) return;
        const inventory = spawnSync("pgrep", ["-af", "."], { encoding: "utf8" });
        const exactProcessListed = inventory.stdout
          .split("\n")
          .some((line) => line.startsWith(`${child.pid} `));
        if (inventory.status !== 0 || !exactProcessListed) return;
        inventoryChecked = true;
        inventoryChecks += 1;
        termSent = child.kill("SIGTERM");
      }, 250);
      killTimer = setTimeout(() => {
        if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
        const inventory = spawnSync("pgrep", ["-af", "."], { encoding: "utf8" });
        const exactProcessListed = inventory.stdout
          .split("\n")
          .some((line) => line.startsWith(`${child.pid} `));
        if (inventory.status !== 0 || !exactProcessListed) return;
        inventoryChecks += 1;
        killSent = child.kill("SIGKILL");
      }, 1_500);
    },
  );
  clearTimeout(signalTimer);
  clearTimeout(killTimer);
  const summary = summarize(run);
  if (
    !inventoryChecked ||
    inventoryChecks < 1 ||
    !termSent ||
    !["SIGTERM", "SIGKILL"].includes(summary.exit.signal ?? "")
  ) {
    throw new Error(
      `Gemini signal probe failed: ${JSON.stringify({ summary, inventoryChecked, inventoryChecks, termSent, killSent })}`,
    );
  }
  return {
    ...summary,
    inventoryChecked,
    inventoryChecks,
    termSent,
    termEffective: summary.exit.signal === "SIGTERM",
    killEscalated: killSent,
  };
}

async function main() {
  if (!allowedModes.has(mode)) {
    throw new Error("usage: cli-probe.mjs <exec|visual|permission|unavailable|signal> <probe-cwd>");
  }
  const result =
    mode === "exec"
      ? await runExecProbe()
      : mode === "visual"
        ? await runVisualProbe()
        : mode === "permission"
          ? await runPermissionProbe()
          : mode === "unavailable"
            ? await runUnavailableProbe()
            : await runSignalProbe();
  console.log(
    JSON.stringify({ schemaVersion: 1, probe: mode, cliVersion: geminiVersion(), result }, null, 2),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
