#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";

const mode = process.argv[2];
const probeCwd = process.argv[3];
const allowedModes = new Set(["auth", "exec", "review-resume", "permission", "status"]);

function requireProbeCwd() {
  if (!probeCwd?.startsWith("/tmp/agent-team-claude-probe.")) {
    throw new Error("probe requires an isolated /tmp/agent-team-claude-probe.* cwd");
  }
  return probeCwd;
}

function claudeVersion() {
  const result = spawnSync("claude", ["--version"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("claude --version failed");
  return result.stdout.trim();
}

function commonArgs({ model = true, persistence = false, tools = "" } = {}) {
  const args = [
    "-p",
    "--safe-mode",
    "--verbose",
    "--output-format",
    "stream-json",
    "--permission-mode",
    "dontAsk",
    "--tools",
    tools,
    "--max-budget-usd",
    "0.10",
  ];
  if (model) args.push("--model", "haiku");
  if (!persistence) args.push("--no-session-persistence");
  return args;
}

async function runClaude(args, cwd, timeoutMs = 90_000) {
  const child = spawn("claude", args, {
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

  const events = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { exit, events, stderrPresent: stderr.trim().length > 0, timedOut };
}

function summarizeStream(run) {
  const eventTypes = [];
  const contentBlockTypes = [];
  const toolNames = [];
  const permissionDenialTools = [];
  const rateLimitEvents = [];
  let finalResult = null;
  let isError = null;
  let sessionId = null;

  for (const event of run.events) {
    eventTypes.push(event.type);
    if (event.type === "rate_limit_event") {
      const info = event.rate_limit_info ?? event.rateLimitInfo ?? {};
      rateLimitEvents.push({
        status: typeof info.status === "string" ? info.status : null,
        rateLimitType:
          typeof info.rate_limit_type === "string"
            ? info.rate_limit_type
            : typeof info.rateLimitType === "string"
              ? info.rateLimitType
              : null,
        utilization: typeof info.utilization === "number" ? info.utilization : null,
        resetsAt:
          typeof info.resets_at === "number"
            ? info.resets_at
            : typeof info.resetsAt === "number"
              ? info.resetsAt
              : null,
      });
    }
    if (typeof event.session_id === "string") sessionId = event.session_id;
    const content = Array.isArray(event.message?.content) ? event.message.content : [];
    for (const block of content) {
      if (typeof block.type === "string") contentBlockTypes.push(block.type);
      if (block.type === "tool_use" && typeof block.name === "string") toolNames.push(block.name);
    }
    if (event.type === "result") {
      finalResult = typeof event.result === "string" ? event.result : null;
      isError = typeof event.is_error === "boolean" ? event.is_error : null;
      const denials = Array.isArray(event.permission_denials) ? event.permission_denials : [];
      for (const denial of denials) {
        const name = denial?.tool_name ?? denial?.toolName ?? denial?.name;
        permissionDenialTools.push(typeof name === "string" ? name : "unknown");
      }
    }
  }

  return {
    exit: run.exit,
    timedOut: run.timedOut,
    stderrPresent: run.stderrPresent,
    eventTypes,
    contentBlockTypes,
    toolNames,
    permissionDenialTools,
    rateLimitEvents,
    finalResult,
    isError,
    sessionId,
  };
}

async function exists(path) {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function gitStatus(cwd) {
  const result = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error("git status failed in probe cwd");
  return result.stdout.trim();
}

function publicSummary(summary) {
  const { sessionId: _sessionId, ...allowlisted } = summary;
  return allowlisted;
}

async function runAuthProbe() {
  const result = spawnSync("claude", ["auth", "status", "--json"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("claude auth status failed");
  const raw = JSON.parse(result.stdout);
  return {
    exitCode: result.status,
    loggedIn: raw.loggedIn === true,
    authMethod: typeof raw.authMethod === "string" ? raw.authMethod : null,
    apiProvider: typeof raw.apiProvider === "string" ? raw.apiProvider : null,
    subscriptionType: typeof raw.subscriptionType === "string" ? raw.subscriptionType : null,
  };
}

async function runExecProbe() {
  const cwd = requireProbeCwd();
  const run = await runClaude(
    [...commonArgs(), "Return exactly CLAUDE_PROBE_OK. Do not call tools."],
    cwd,
  );
  const summary = summarizeStream(run);
  if (summary.exit.code !== 0 || summary.isError || summary.finalResult !== "CLAUDE_PROBE_OK") {
    throw new Error("Claude exec probe did not produce the expected structured result");
  }
  return publicSummary(summary);
}

async function runReviewResumeProbe() {
  const cwd = requireProbeCwd();
  const target = `${cwd}/review-target.txt`;
  if (!(await exists(target))) throw new Error("review-target.txt is required");
  const beforeHash = await sha256(target);
  const beforeStatus = gitStatus(cwd);
  const sessionId = randomUUID();
  const first = await runClaude(
    [
      ...commonArgs({ persistence: true, tools: "Read" }),
      "--session-id",
      sessionId,
      "Use the Read tool exactly once to read review-target.txt. If its only line is CLAUDE_REVIEW_TARGET_V1, return exactly CLAUDE_REVIEW_OK. Do not modify anything.",
    ],
    cwd,
  );
  const firstSummary = summarizeStream(first);
  const afterHash = await sha256(target);
  const afterStatus = gitStatus(cwd);
  if (
    firstSummary.exit.code !== 0 ||
    firstSummary.isError ||
    firstSummary.finalResult !== "CLAUDE_REVIEW_OK" ||
    !firstSummary.toolNames.includes("Read") ||
    beforeHash !== afterHash ||
    beforeStatus !== afterStatus
  ) {
    throw new Error("Claude read-only review probe failed its evidence checks");
  }

  const resumed = await runClaude(
    [
      ...commonArgs({ persistence: true }),
      "--resume",
      firstSummary.sessionId ?? sessionId,
      "Return exactly CLAUDE_RESUME_OK. Do not call tools.",
    ],
    cwd,
  );
  const resumedSummary = summarizeStream(resumed);
  if (
    resumedSummary.exit.code !== 0 ||
    resumedSummary.isError ||
    resumedSummary.finalResult !== "CLAUDE_RESUME_OK"
  ) {
    throw new Error("Claude resume probe failed");
  }

  return {
    review: publicSummary(firstSummary),
    targetUnchanged: beforeHash === afterHash,
    gitStatusUnchanged: beforeStatus === afterStatus,
    resume: publicSummary(resumedSummary),
  };
}

async function runPermissionProbe() {
  const cwd = requireProbeCwd();
  const marker = `${cwd}/permission-must-not-exist`;
  if (await exists(marker)) throw new Error("permission marker already exists");
  const run = await runClaude(
    [
      ...commonArgs({ tools: "Bash" }),
      "--disallowedTools=Write,Edit",
      "Use the Bash tool exactly once to run: touch permission-must-not-exist. Do not simulate the command. Then report the actual result.",
    ],
    cwd,
  );
  const summary = summarizeStream(run);
  const markerExists = await exists(marker);
  if (summary.exit.code !== 0 || summary.permissionDenialTools.length === 0 || markerExists) {
    console.error(
      JSON.stringify({
        exit: summary.exit,
        eventTypes: summary.eventTypes,
        toolNames: summary.toolNames,
        permissionDenialTools: summary.permissionDenialTools,
        finalResult: summary.finalResult,
        isError: summary.isError,
        markerExists,
      }),
    );
    throw new Error("Claude permission probe was not mechanically denied");
  }
  return { ...publicSummary(summary), markerExists };
}

async function runStatusProbe() {
  const cwd = requireProbeCwd();
  const run = await runClaude([...commonArgs({ model: false }), "/status"], cwd, 30_000);
  const summary = summarizeStream(run);
  return publicSummary(summary);
}

async function main() {
  if (!allowedModes.has(mode)) {
    throw new Error("usage: cli-probe.mjs <auth|exec|review-resume|permission|status> [probe-cwd]");
  }
  const result =
    mode === "auth"
      ? await runAuthProbe()
      : mode === "exec"
        ? await runExecProbe()
        : mode === "review-resume"
          ? await runReviewResumeProbe()
          : mode === "permission"
            ? await runPermissionProbe()
            : await runStatusProbe();
  console.log(
    JSON.stringify({ schemaVersion: 1, probe: mode, cliVersion: claudeVersion(), result }, null, 2),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
