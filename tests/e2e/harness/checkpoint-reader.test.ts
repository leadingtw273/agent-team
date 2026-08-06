import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseCheckpointTopLevelScalars, readCheckpointsForIssue } from "./checkpoint-reader.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "agent-team-e005-checkpoint-reader-"));
  roots.push(value);
  return value;
}

/** A real checkpoint YAML document, in the exact shape `serializeCheckpointYaml`
 * (src/adapters/checkpoint/local-yaml.ts) produces -- including a nested object (worktree) and
 * a nested array (nextSteps) this extractor must skip over without choking on. */
function checkpointYamlFixture(overrides: Readonly<Record<string, string>> = {}): string {
  const fields = {
    schemaVersion: "1",
    id: "checkpoint_018f47d2-0000-4000-8000-000000000001",
    projectId: "project_018f47d2-0000-4000-8000-000000000002",
    issueId: "issue_018f47d2-0000-4000-8000-000000000003",
    jobId: "job_018f47d2-0000-4000-8000-000000000004",
    createdAt: "2026-08-06T12:00:00.000Z",
    reason: "manual",
    ...overrides,
  };
  return [
    `schemaVersion: ${fields.schemaVersion}`,
    `id: ${fields.id}`,
    `projectId: ${fields.projectId}`,
    `issueId: ${fields.issueId}`,
    `jobId: ${fields.jobId}`,
    `createdAt: ${fields.createdAt}`,
    `reason: ${fields.reason}`,
    "completedItems:",
    '  - "Did a thing"',
    "remainingItems: []",
    "tests: []",
    "nextSteps:",
    '  - "Do the next thing"',
    "blockers: []",
    "worktree:",
    '  path: "/tmp/some/worktree"',
    '  branch: "task/example"',
    `  commitSha: ${"a".repeat(40)}`,
    "  pushed: true",
    "",
  ].join("\n");
}

describe("parseCheckpointTopLevelScalars", () => {
  it("extracts exactly the six top-level scalar fields, skipping nested object/array content", () => {
    const parsed = parseCheckpointTopLevelScalars(checkpointYamlFixture());
    expect(parsed).toEqual({
      id: "checkpoint_018f47d2-0000-4000-8000-000000000001",
      projectId: "project_018f47d2-0000-4000-8000-000000000002",
      issueId: "issue_018f47d2-0000-4000-8000-000000000003",
      jobId: "job_018f47d2-0000-4000-8000-000000000004",
      createdAt: "2026-08-06T12:00:00.000Z",
      reason: "manual",
    });
  });

  it("returns undefined when the document is missing a required scalar (not a checkpoint at all)", () => {
    const parsed = parseCheckpointTopLevelScalars("schemaVersion: 1\ntitle: Not a checkpoint\n");
    expect(parsed).toBeUndefined();
  });

  it("decodes a JSON-quoted scalar value (e.g. a reason containing a colon)", () => {
    const parsed = parseCheckpointTopLevelScalars(
      checkpointYamlFixture({ reason: '"manual: because reasons"' }),
    );
    expect(parsed?.reason).toBe("manual: because reasons");
  });
});

describe("readCheckpointsForIssue", () => {
  it("returns an empty list (not an error) when the checkpoint directory does not exist yet", async () => {
    const directory = join(await root(), "never-created");
    const result = await readCheckpointsForIssue(directory, "issue_1", {
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-31T00:00:00.000Z",
    });
    expect(result).toEqual({ ok: true, value: [] });
  });

  it("finds a checkpoint matching the issue id inside the time window", async () => {
    const directory = await root();
    await writeFile(
      join(directory, "checkpoint_018f47d2-0000-4000-8000-000000000001.yaml"),
      checkpointYamlFixture(),
      "utf8",
    );

    const result = await readCheckpointsForIssue(
      directory,
      "issue_018f47d2-0000-4000-8000-000000000003",
      { from: "2026-08-06T00:00:00.000Z", to: "2026-08-06T23:59:59.999Z" },
    );

    expect(result.ok && result.value).toHaveLength(1);
    expect(result.ok && result.value[0]?.reason).toBe("manual");
  });

  it("excludes a checkpoint for a different issue id", async () => {
    const directory = await root();
    await writeFile(
      join(directory, "checkpoint_018f47d2-0000-4000-8000-000000000001.yaml"),
      checkpointYamlFixture(),
      "utf8",
    );

    const result = await readCheckpointsForIssue(directory, "issue_some_other_issue", {
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-31T00:00:00.000Z",
    });

    expect(result).toEqual({ ok: true, value: [] });
  });

  it("excludes a checkpoint outside the time window", async () => {
    const directory = await root();
    await writeFile(
      join(directory, "checkpoint_018f47d2-0000-4000-8000-000000000001.yaml"),
      checkpointYamlFixture({ createdAt: "2026-01-01T00:00:00.000Z" }),
      "utf8",
    );

    const result = await readCheckpointsForIssue(
      directory,
      "issue_018f47d2-0000-4000-8000-000000000003",
      { from: "2026-08-01T00:00:00.000Z", to: "2026-08-31T00:00:00.000Z" },
    );

    expect(result).toEqual({ ok: true, value: [] });
  });

  it("skips a non-checkpoint .yaml file in the same directory without failing the whole read", async () => {
    const directory = await root();
    await writeFile(join(directory, "not-a-checkpoint.yaml"), "title: Unrelated\n", "utf8");
    await writeFile(
      join(directory, "checkpoint_018f47d2-0000-4000-8000-000000000001.yaml"),
      checkpointYamlFixture(),
      "utf8",
    );

    const result = await readCheckpointsForIssue(
      directory,
      "issue_018f47d2-0000-4000-8000-000000000003",
      { from: "2026-08-01T00:00:00.000Z", to: "2026-08-31T00:00:00.000Z" },
    );

    expect(result.ok && result.value).toHaveLength(1);
  });

  it("ignores non-.yaml files in the checkpoint directory", async () => {
    const directory = await root();
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "README.txt"), "not a checkpoint", "utf8");

    const result = await readCheckpointsForIssue(directory, "issue_1", {
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-31T00:00:00.000Z",
    });

    expect(result).toEqual({ ok: true, value: [] });
  });
});
