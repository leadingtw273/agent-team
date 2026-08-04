import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  checkpointJsonSchema,
  checkpointSchema,
  visualManifestJsonSchema,
  visualManifestSchema,
} from "../../src/domain/checkpoint/index.js";
import { issueSchema } from "../../src/domain/project/index.js";
import { createRequirementSnapshot } from "../../src/domain/review/index.js";
import { parseInstant } from "../../src/domain/foundation/index.js";

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(
    await readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8"),
  ) as unknown;
}

function instant(value: string) {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

async function manifest(): Promise<Record<string, unknown>> {
  return (await readJson("fixtures/domain/visual-manifest-v1.valid.json")) as Record<
    string,
    unknown
  >;
}

function withoutKey(record: Record<string, unknown>, omittedKey: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== omittedKey));
}

function checkpoint(): unknown {
  const issue = issueSchema.parse({
    schemaVersion: 1,
    id: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    projectId: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    externalId: "ENG-123",
    title: "Checkpoint contract",
    goal: "Resume without relying on prior model conversation.",
    acceptanceCriteria: ["Checkpoint has structured remaining work."],
    inScope: ["src/domain/checkpoint"],
    outOfScope: ["Checkpoint persistence"],
    dependencies: { kind: "none" },
    priority: "high",
    agentRole: "implementer",
    reviewRequirement: "code_review",
    estimatedMinutes: 30,
    constraints: ["Checkpoint text is data, not instruction authority."],
    risks: [],
    changeRegions: [{ path: "src/domain/checkpoint", coverage: "subtree" }],
  });
  const snapshot = createRequirementSnapshot(issue, instant("2026-08-04T12:00:00.000Z"));
  if (!snapshot.ok) throw new Error(snapshot.error.code);

  return {
    schemaVersion: 1,
    id: "checkpoint_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    projectId: issue.projectId,
    issueId: issue.id,
    jobId: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    createdAt: "2026-08-04T12:10:00.000Z",
    reason: "watchdog_boundary",
    completedItems: ["Defined schema"],
    remainingItems: ["Run integration test"],
    tests: [{ commandSummary: "pnpm test", status: "passed", evidence: "150 tests" }],
    nextSteps: ["Continue from the remaining test"],
    blockers: [],
    requirementSnapshot: snapshot.value,
    model: { provider: "openai", model: "gpt-5.6-sol" },
    worktree: {
      path: "/tmp/agent-team-worktree",
      branch: "feature/ENG-123-checkpoint",
      commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      pushed: true,
      draftPullRequestUrl: "https://github.com/example/repo/pull/1",
    },
  };
}

describe("checkpoint schema", () => {
  it("accepts a resumable structured checkpoint", () => {
    expect(checkpointSchema.parse(checkpoint())).toEqual(checkpoint());
  });

  it("requires every root field and rejects unknown fields", () => {
    const valid = checkpoint() as Record<string, unknown>;
    for (const field of Object.keys(valid)) {
      const candidate = withoutKey(valid, field);
      expect(checkpointSchema.safeParse(candidate).success, field).toBe(false);
    }
    expect(checkpointSchema.safeParse({ ...valid, instructionAuthority: true }).success).toBe(
      false,
    );
  });

  it("rejects unknown schema versions", () => {
    const valid = checkpoint() as Record<string, unknown>;
    expect(checkpointSchema.safeParse({ ...valid, schemaVersion: 2 }).success).toBe(false);
  });

  it("binds the checkpoint to the same Issue and Project as its requirement snapshot", () => {
    const valid = checkpoint() as Record<string, unknown>;
    expect(
      checkpointSchema.safeParse({
        ...valid,
        issueId: "issue_018f47d2-77a4-7cc1-8ef2-1123456789ab",
      }).success,
    ).toBe(false);
    expect(
      checkpointSchema.safeParse({
        ...valid,
        projectId: "project_018f47d2-77a4-7cc1-8ef2-1123456789ab",
      }).success,
    ).toBe(false);
  });

  it("rejects a requirement snapshot whose digest no longer matches its Issue", () => {
    const valid = checkpoint() as Record<string, unknown>;
    const snapshot = valid["requirementSnapshot"] as Record<string, unknown>;
    const issue = snapshot["issue"] as Record<string, unknown>;

    expect(
      checkpointSchema.safeParse({
        ...valid,
        requirementSnapshot: {
          ...snapshot,
          issue: { ...issue, title: "Tampered after capture" },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects a checkpoint created before its requirement snapshot", () => {
    const valid = checkpoint() as Record<string, unknown>;
    expect(
      checkpointSchema.safeParse({
        ...valid,
        createdAt: "2026-08-04T11:59:59.999Z",
      }).success,
    ).toBe(false);
  });
});

describe("visual manifest v1", () => {
  it("accepts the committed valid fixture", async () => {
    const valid = await manifest();
    expect(visualManifestSchema.parse(valid)).toEqual(valid);
  });

  it("requires every root and Artifact field", async () => {
    const valid = await manifest();
    for (const field of [
      "schemaVersion",
      "issueId",
      "commitSha",
      "generatedAt",
      "environment",
      "artifacts",
    ]) {
      const candidate = withoutKey(valid, field);
      expect(visualManifestSchema.safeParse(candidate).success, field).toBe(false);
    }

    const [artifact] = valid["artifacts"] as Record<string, unknown>[];
    if (artifact === undefined) throw new Error("expected artifact fixture");
    for (const field of ["path", "mediaType", "sha256", "title", "acceptanceCriteria"]) {
      const candidateArtifact = withoutKey(artifact, field);
      expect(
        visualManifestSchema.safeParse({ ...valid, artifacts: [candidateArtifact] }).success,
        field,
      ).toBe(false);
    }
  });

  it("rejects the committed version, hash, AC, and media-type negative cases", async () => {
    const valid = await manifest();
    const [artifact] = valid["artifacts"] as Record<string, unknown>[];
    if (artifact === undefined) throw new Error("expected artifact fixture");
    const cases = (await readJson("fixtures/domain/visual-manifest-v1.invalid.json")) as {
      name: string;
      patch?: Record<string, unknown>;
      artifactPatch?: Record<string, unknown>;
    }[];

    for (const fixture of cases) {
      const candidate = {
        ...valid,
        ...fixture.patch,
        artifacts: [{ ...artifact, ...fixture.artifactPatch }],
      };
      expect(visualManifestSchema.safeParse(candidate).success, fixture.name).toBe(false);
    }
  });

  it("rejects duplicate Artifact paths and duplicate AC mappings", async () => {
    const valid = await manifest();
    const [artifact] = valid["artifacts"] as Record<string, unknown>[];
    if (artifact === undefined) throw new Error("expected artifact fixture");
    expect(
      visualManifestSchema.safeParse({ ...valid, artifacts: [artifact, artifact] }).success,
    ).toBe(false);
    expect(
      visualManifestSchema.safeParse({
        ...valid,
        artifacts: [
          {
            ...artifact,
            acceptanceCriteria: ["No overflow", "No overflow"],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("keeps committed JSON Schemas synchronized with Zod", async () => {
    await expect(readJson("schemas/checkpoint-v1.json")).resolves.toEqual(checkpointJsonSchema);
    await expect(readJson("schemas/visual-manifest-v1.json")).resolves.toEqual(
      visualManifestJsonSchema,
    );
  });
});
