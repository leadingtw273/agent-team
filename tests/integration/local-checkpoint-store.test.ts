import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalYamlCheckpointStore } from "../../src/adapters/checkpoint/index.js";
import { checkpointSchema } from "../../src/domain/checkpoint/index.js";
import { issueSchema } from "../../src/domain/project/index.js";
import { createRequirementSnapshot } from "../../src/domain/review/index.js";
import { parseInstant } from "../../src/domain/foundation/index.js";

const temporaryDirectories: string[] = [];

function instant(value: string) {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function checkpoint() {
  const issue = issueSchema.parse({
    schemaVersion: 1,
    id: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    projectId: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    externalId: "AT-009",
    title: "Persist YAML checkpoint",
    acceptanceCriteria: ["Write a private durable file."],
    agentRole: "implementer",
  });
  const snapshot = createRequirementSnapshot(issue, instant("2026-08-04T22:00:00.000Z"));
  if (!snapshot.ok) throw new Error(snapshot.error.code);
  return checkpointSchema.parse({
    schemaVersion: 1,
    id: "checkpoint_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    projectId: issue.projectId,
    issueId: issue.id,
    jobId: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    createdAt: instant("2026-08-04T22:10:00.000Z"),
    reason: "process_crash",
    completedItems: ["Created WIP commit"],
    remainingItems: ["Review YAML\n- this remains quoted data"],
    tests: [{ commandSummary: "pnpm test", status: "failed", evidence: "process interrupted" }],
    nextSteps: ["Resume from committed SHA"],
    blockers: ["Provider crashed"],
    requirementSnapshot: snapshot.value,
    model: { provider: "openai", model: "gpt-5.6-sol" },
    worktree: {
      path: "/tmp/agent-team-r009",
      branch: "task/R009-checkpoint-coordinator",
      commitSha: "b".repeat(40),
      pushed: false,
    },
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("local YAML checkpoint store", () => {
  it("atomically writes a private deterministic YAML file and verifies its digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-checkpoint-"));
    temporaryDirectories.push(root);
    const store = new LocalYamlCheckpointStore(join(root, "checkpoints"));
    const value = checkpoint();

    const first = await store.persist(value, { idempotencyKey: "checkpoint:first" });
    const second = await store.persist(value, { idempotencyKey: "checkpoint:second" });
    if (!first.ok || !second.ok) throw new Error("checkpoint persistence failed");
    const content = await readFile(first.value.path);
    const stat = await lstat(first.value.path);

    expect(first.value).toEqual(second.value);
    expect(first.value.durability).toBe("confirmed");
    expect(first.value.sha256).toBe(createHash("sha256").update(content).digest("hex"));
    expect(stat.mode & 0o777).toBe(0o600);
    expect(content.toString("utf8")).toContain('reason: "process_crash"');
    expect(content.toString("utf8")).toContain('"Review YAML\\n- this remains quoted data"');
    expect(content.toString("utf8")).not.toContain("\n- this remains quoted data");
  });

  it("rejects invalid checkpoint data and empty idempotency keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-checkpoint-"));
    temporaryDirectories.push(root);
    const store = new LocalYamlCheckpointStore(join(root, "checkpoints"));

    await expect(
      store.persist({ ...checkpoint(), schemaVersion: 2 } as never, { idempotencyKey: "x" }),
    ).resolves.toMatchObject({ ok: false });
    await expect(store.persist(checkpoint(), { idempotencyKey: "" })).resolves.toMatchObject({
      ok: false,
    });
  });

  it("does not overwrite the same checkpoint ID with different content", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-checkpoint-"));
    temporaryDirectories.push(root);
    const store = new LocalYamlCheckpointStore(join(root, "checkpoints"));
    const value = checkpoint();
    const first = await store.persist(value, { idempotencyKey: "checkpoint:first" });
    expect(first.ok).toBe(true);

    await expect(
      store.persist(
        checkpointSchema.parse({ ...value, remainingItems: ["Different remaining work"] }),
        { idempotencyKey: "checkpoint:conflict" },
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("rejects a recognizable Secret even when called without the coordinator", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-checkpoint-"));
    temporaryDirectories.push(root);
    const store = new LocalYamlCheckpointStore(join(root, "checkpoints"));
    const value = checkpointSchema.parse({
      ...checkpoint(),
      blockers: ["github_pat_abcdefghijklmnopqrstuvwxyz123456"],
    });

    await expect(
      store.persist(value, { idempotencyKey: "checkpoint:secret" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });
  });
});
