#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { EventEmitter } from "node:events";
import readline from "node:readline";

const mode = process.argv[2];
const probeCwd = process.argv[3];

class AppServerClient {
  constructor() {
    this.child = spawn("codex", ["app-server", "--stdio"], {
      cwd: "/tmp",
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.events = new EventEmitter();
    this.nextId = 1;
    this.pending = new Map();
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.#handleLine(line));
    this.child.on("exit", (code, signal) => {
      if (this.pending.size === 0) return;
      const error = new Error(`codex app-server exited with code=${code} signal=${signal}`);
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(error);
      }
      this.pending.clear();
    });
  }

  async initialize() {
    await this.request("initialize", {
      clientInfo: {
        name: "agent_team_spike",
        title: "Agent Team Codex Spike",
        version: "0.1.0",
      },
    });
    this.notify("initialized", {});
  }

  request(method, params = {}, timeoutMs = 30_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out waiting for response to ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.#send({ method, id, params });
    });
  }

  respond(id, result) {
    this.#send({ id, result });
  }

  notify(method, params = {}) {
    this.#send({ method, params });
  }

  close() {
    this.lines.close();
    this.child.stdin.end();
    this.child.kill("SIGTERM");
  }

  #send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line) {
    const message = JSON.parse(line);
    if (message.method) {
      this.events.emit(message.method, message);
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
    else pending.resolve(message.result);
  }
}

function requireProbeCwd() {
  if (!probeCwd?.startsWith("/tmp/agent-team-codex-probe.")) {
    throw new Error(
      "approval/interrupt probes require an isolated /tmp/agent-team-codex-probe.* cwd",
    );
  }
  return probeCwd;
}

function waitForTurn(client, threadId, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.events.removeListener("turn/completed", onComplete);
      reject(new Error(`timed out waiting for turn completion on ${threadId}`));
    }, timeoutMs);
    const onComplete = (message) => {
      if (message.params?.threadId && message.params.threadId !== threadId) return;
      clearTimeout(timer);
      client.events.removeListener("turn/completed", onComplete);
      resolve(message.params?.turn);
    };
    client.events.on("turn/completed", onComplete);
  });
}

async function runAccountProbe(client) {
  const [accountResult, rateLimitResult] = await Promise.all([
    client.request("account/read", { refreshToken: false }),
    client.request("account/rateLimits/read"),
  ]);
  const account = accountResult.account;
  const buckets = Object.values(rateLimitResult.rateLimitsByLimitId ?? {}).map((bucket) => ({
    limitId: bucket.limitId,
    limitName: bucket.limitName,
    primary: bucket.primary,
    secondary: bucket.secondary,
    rateLimitReachedType: bucket.rateLimitReachedType,
  }));

  return {
    auth: {
      authMode: account?.type ?? null,
      planType: account?.planType ?? null,
      requiresOpenaiAuth: accountResult.requiresOpenaiAuth,
    },
    rateLimits: {
      current: rateLimitResult.rateLimits
        ? {
            limitId: rateLimitResult.rateLimits.limitId,
            limitName: rateLimitResult.rateLimits.limitName,
            primary: rateLimitResult.rateLimits.primary,
            secondary: rateLimitResult.rateLimits.secondary,
            rateLimitReachedType: rateLimitResult.rateLimits.rateLimitReachedType,
          }
        : null,
      buckets,
    },
  };
}

async function runApprovalProbe(client) {
  const cwd = requireProbeCwd();
  const marker = `${cwd}/approval-must-not-exist`;
  const threadResult = await client.request("thread/start", {
    model: "gpt-5.6-terra",
    cwd,
    approvalPolicy: "untrusted",
    sandbox: "workspace-write",
    ephemeral: true,
    serviceName: "agent_team_spike",
  });
  const threadId = threadResult.thread.id;
  let approval;

  client.events.on("item/commandExecution/requestApproval", (message) => {
    approval = {
      method: message.method,
      hasCommand: Boolean(message.params?.command),
      cwdMatches: message.params?.cwd === cwd,
      availableDecisions: message.params?.availableDecisions ?? null,
      decision: "decline",
    };
    client.respond(message.id, { decision: "decline" });
  });

  const completed = waitForTurn(client, threadId);
  await client.request("turn/start", {
    threadId,
    input: [
      {
        type: "text",
        text: "Use the shell tool exactly once to run `touch approval-must-not-exist`, then report the result. Do not use another tool.",
      },
    ],
  });
  const turn = await completed;
  const markerExists = await access(marker).then(
    () => true,
    () => false,
  );

  return {
    approvalRequested: Boolean(approval),
    approval,
    markerExists,
    turnStatus: turn?.status ?? null,
  };
}

async function runInterruptProbe(client) {
  const cwd = requireProbeCwd();
  const threadResult = await client.request("thread/start", {
    model: "gpt-5.6-terra",
    cwd,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    ephemeral: true,
    serviceName: "agent_team_spike",
  });
  const threadId = threadResult.thread.id;
  const firstCompleted = waitForTurn(client, threadId);
  const commandStarted = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.events.removeListener("item/started", onItemStarted);
      reject(new Error("timed out waiting for commandExecution item"));
    }, 45_000);
    const onItemStarted = (message) => {
      if (message.params?.item?.type !== "commandExecution") return;
      clearTimeout(timer);
      client.events.removeListener("item/started", onItemStarted);
      resolve(message);
    };
    client.events.on("item/started", onItemStarted);
  });
  const firstStart = await client.request("turn/start", {
    threadId,
    input: [
      {
        type: "text",
        text: "Use the shell tool exactly once to run `sleep 30`, then return INTERRUPT_TOO_LATE.",
      },
    ],
  });
  const turnId = firstStart.turn.id;

  await commandStarted;
  await client.request("turn/interrupt", { threadId, turnId });
  const interruptedTurn = await firstCompleted;

  let resumedMessage = null;
  client.events.on("item/completed", (message) => {
    if (message.params?.item?.type === "agentMessage") {
      resumedMessage = message.params.item.text;
    }
  });
  const secondCompleted = waitForTurn(client, threadId);
  await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "Do not call tools. Return exactly: INTERRUPT_RESUME_OK" }],
  });
  const resumedTurn = await secondCompleted;

  return {
    interruptedStatus: interruptedTurn?.status ?? null,
    resumedStatus: resumedTurn?.status ?? null,
    resumedMessage,
  };
}

async function main() {
  if (!new Set(["account", "approval", "interrupt"]).has(mode)) {
    throw new Error("usage: app-server-probe.mjs <account|approval|interrupt> [probe-cwd]");
  }

  const client = new AppServerClient();
  try {
    await client.initialize();
    const result =
      mode === "account"
        ? await runAccountProbe(client)
        : mode === "approval"
          ? await runApprovalProbe(client)
          : await runInterruptProbe(client);

    if (
      mode === "account" &&
      (result.auth.authMode === null || result.rateLimits.buckets.length === 0)
    ) {
      throw new Error("account probe did not return auth and rate-limit buckets");
    }
    if (mode === "approval" && (!result.approvalRequested || result.markerExists)) {
      throw new Error("approval probe did not block the marker command");
    }
    if (
      mode === "interrupt" &&
      (result.interruptedStatus !== "interrupted" ||
        result.resumedStatus !== "completed" ||
        result.resumedMessage !== "INTERRUPT_RESUME_OK")
    ) {
      throw new Error("interrupt probe did not interrupt and resume the same thread");
    }
    console.log(JSON.stringify({ schemaVersion: 1, probe: mode, result }, null, 2));
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
