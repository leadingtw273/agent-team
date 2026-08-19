import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LocalYamlCheckpointReader,
  LocalYamlCheckpointStore,
  parseSerializedCheckpointYaml,
  serializeCheckpointYaml,
} from "../../src/adapters/checkpoint/index.js";
import { checkpointSchema } from "../../src/domain/checkpoint/index.js";
import { parseInstant } from "../../src/domain/foundation/index.js";
import { issueSchema } from "../../src/domain/project/index.js";
import { createRequirementSnapshot } from "../../src/domain/review/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function checkpoint() {
  const at = parseInstant("2026-08-19T10:00:00.000Z");
  if (!at.ok) throw new Error(at.error.code);
  const issue = issueSchema.parse({
    schemaVersion: 1,
    id: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    projectId: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    externalId: "LEA-80",
    title: "Final review",
    acceptanceCriteria: ["Review passes"],
    agentRole: "implementer",
    reviewRequirement: "code_review",
  });
  const snapshot = createRequirementSnapshot(issue, at.value);
  if (!snapshot.ok) throw new Error(snapshot.error.code);
  return checkpointSchema.parse({
    schemaVersion: 1,
    id: "checkpoint_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    projectId: issue.projectId,
    issueId: issue.id,
    jobId: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    createdAt: at.value,
    reason: "retry_exhausted",
    completedItems: [],
    remainingItems: [],
    tests: [{ commandSummary: "quality", status: "passed" }],
    nextSteps: ["審查回合已達上限，請人工檢視 Reviewer 意見與變更請求 diff 後決定下一步。"],
    blockers: [],
    requirementSnapshot: snapshot.value,
    model: { provider: "dispatch-cli", model: "unassigned" },
    worktree: {
      path: "/tmp/worktree",
      branch: "agent-team/job",
      commitSha: "a".repeat(40),
      pushed: true,
    },
  });
}

describe("LocalYamlCheckpointReader", () => {
  it("round-trips the exact restricted YAML emitted by the checkpoint store", async () => {
    const root = await mkdtemp(join(tmpdir(), "checkpoint-reader-"));
    roots.push(root);
    const directory = join(root, "checkpoints");
    const written = await new LocalYamlCheckpointStore(directory).persist(checkpoint(), {
      idempotencyKey: "checkpoint-reader:test",
    });
    expect(written.ok).toBe(true);
    const loaded = await new LocalYamlCheckpointReader(directory).load(checkpoint().id);
    expect(loaded).toMatchObject({ ok: true, value: { checkpoint: checkpoint() } });
    if (written.ok && loaded.ok) expect(loaded.value.sha256).toBe(written.value.sha256);
  });

  it("rejects non-canonical YAML syntax, duplicate keys, and schema-invalid content", () => {
    const canonical = serializeCheckpointYaml(checkpoint());
    expect(parseSerializedCheckpointYaml(canonical).ok).toBe(true);
    expect(
      parseSerializedCheckpointYaml(
        canonical.replace("schemaVersion: 1", "schemaVersion: 1\nschemaVersion: 1"),
      ),
    ).toMatchObject({ ok: false });
    expect(
      parseSerializedCheckpointYaml(
        canonical.replace('reason: "retry_exhausted"', "reason: retry_exhausted"),
      ),
    ).toMatchObject({ ok: false });
    expect(
      parseSerializedCheckpointYaml(
        canonical.replace('reason: "retry_exhausted"', 'reason: "manual"'),
      ).ok,
    ).toBe(true);
  });
});
