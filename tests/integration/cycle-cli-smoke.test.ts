import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseInstant } from "../../src/domain/foundation/index.js";
import { DurableInbox, readEventLog } from "../../src/infrastructure/events/index.js";

const cli = resolve("dist/cli/index.js");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function isolatedEnvironment(): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), "agent-team-cycle-smoke-"));
  roots.push(root);
  return { ...process.env, AGENT_TEAM_HOME: join(root, ".agent-team") };
}

function run(arguments_: readonly string[], environment: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [cli, ...arguments_], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 10_000,
    env: environment,
  });
}

function instant(value: string) {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const emptyCyclePayload = {
  operation: "controller_cycle",
  state: "completed",
  stageCounts: { completed: 4, degraded: 0, failed: 0 },
  stageOutcomes: [
    { stage: "webhook_health", state: "completed" },
    {
      stage: "inbox",
      state: "completed",
      counts: { discovered: 0, processed: 0, alreadyCompleted: 0, failed: 0 },
      failures: [],
    },
    { stage: "reconcile", state: "completed" },
    { stage: "projects", state: "completed" },
  ],
};

describe("C01/C02 compiled cycle CLI smoke", () => {
  it("runs the compiled exact cycle contract against an empty isolated home and is reentrant", async () => {
    const environment = await isolatedEnvironment();
    const first = run(["cycle", "--all"], environment);
    const replay = run(["cycle", "--all"], environment);

    for (const result of [first, replay]) {
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual(emptyCyclePayload);
    }
  });

  it("uses the fixed production Inbox/Event/Completion stores in a compiled isolated home", async () => {
    const environment = await isolatedEnvironment();
    const agentTeamHome = environment["AGENT_TEAM_HOME"];
    if (agentTeamHome === undefined) throw new Error("missing isolated home");
    const deliveryId = "compiled-delivery-not-public";
    const inbox = new DurableInbox(join(agentTeamHome, "state", "inbox"));
    await inbox.store({
      provider: "github",
      deliveryId,
      eventType: "unknown_event",
      streamKey: "compiled-subject",
      sourceTimestampMs: Date.parse("2026-08-12T05:00:00.000Z") - 1_000,
      receivedAt: instant("2026-08-12T05:00:00.000Z"),
      mediaType: "application/json",
      rawBody: Buffer.from("{}", "utf8"),
    });

    const first = run(["cycle", "--all"], environment);
    const replay = run(["cycle", "--all"], environment);
    const events = await readEventLog(join(agentTeamHome, "state", "events", "events.jsonl"));

    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual({
      operation: "controller_cycle",
      state: "completed",
      stageCounts: { completed: 4, degraded: 0, failed: 0 },
      stageOutcomes: [
        { stage: "webhook_health", state: "completed" },
        {
          stage: "inbox",
          state: "completed",
          counts: { discovered: 1, processed: 1, alreadyCompleted: 0, failed: 0 },
          failures: [],
        },
        { stage: "reconcile", state: "completed" },
        { stage: "projects", state: "completed" },
      ],
    });
    expect(replay.status).toBe(0);
    expect(JSON.parse(replay.stdout)).toEqual({
      operation: "controller_cycle",
      state: "completed",
      stageCounts: { completed: 4, degraded: 0, failed: 0 },
      stageOutcomes: [
        { stage: "webhook_health", state: "completed" },
        {
          stage: "inbox",
          state: "completed",
          counts: { discovered: 1, processed: 0, alreadyCompleted: 1, failed: 0 },
          failures: [],
        },
        { stage: "reconcile", state: "completed" },
        { stage: "projects", state: "completed" },
      ],
    });
    if (!events.ok) throw new Error(events.error.code);
    expect(events.value.events).toHaveLength(1);
    expect(first.stdout).not.toContain(deliveryId);
  });

  it.each([
    ["missing --all", ["cycle"]],
    ["extra argv", ["cycle", "--all", "https://sensitive.example/path?pid=1234"]],
  ] as const)("returns a zero-write usage error for %s", async (_name, argv) => {
    const environment = await isolatedEnvironment();
    const result = run(argv, environment);
    const agentTeamHome = environment["AGENT_TEAM_HOME"];

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      operation: "controller_cycle",
      state: "rejected",
      reason: "invalid_command_input",
    });
    expect(agentTeamHome).toBeDefined();
    expect(existsSync(agentTeamHome ?? "")).toBe(false);
    expect(result.stderr).not.toContain("https://sensitive.example");
    expect(result.stderr).not.toContain("pid=1234");
  });
});
