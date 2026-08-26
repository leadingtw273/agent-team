import { symlink, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  computeSkillTreeIntegrity,
  jobSkillSnapshotSchema,
  projectSkillPolicySchema,
  resolveSkillSelection,
  skillCatalogSchema,
  skillPublicReasonSchema,
  skillScanDecisionSchema,
  tankSkirmishGodotSkillPolicy,
  verifySkillReferences,
} from "../../src/application/skills/index.js";

const digest = (character: string): string => character.repeat(64);

function catalog() {
  return {
    schemaVersion: 1,
    digestAlgorithm: "sha256-v1-posix-path-nul-size-nul-bytes",
    skills: [
      {
        name: "godot-testing-patterns",
        displayName: "Godot 測試模式",
        mode: "knowledge_only",
        source: {
          repository: "https://github.com/example/skills",
          commit: "a".repeat(40),
          path: "skills/godot-testing-patterns",
          treeDigest: digest("1"),
        },
        installedTreeDigest: digest("2"),
        fileDigests: {
          "SKILL.md": digest("3"),
          "references/testing.md": digest("4"),
        },
        allowedReferences: ["references/testing.md"],
      },
      {
        name: "godot-camera-systems",
        displayName: "Godot 相機系統",
        mode: "knowledge_only",
        source: {
          repository: "https://github.com/example/skills",
          commit: "a".repeat(40),
          path: "skills/godot-camera-systems",
          treeDigest: digest("5"),
        },
        installedTreeDigest: digest("6"),
        fileDigests: { "SKILL.md": digest("7") },
        allowedReferences: [],
      },
    ],
  } as const;
}

describe("LEA-130 Skill routing contract", () => {
  it("keeps the scan and public reason taxonomies closed", () => {
    expect(skillScanDecisionSchema.options).toEqual([
      "allow_knowledge_only",
      "allow_rubric_only",
      "blocked",
    ]);
    expect(skillPublicReasonSchema.options).toEqual(["missing", "not_allowed", "content_changed"]);
  });

  it("locks the first Tank Skirmish role defaults without giving Team Lead implementation knowledge", () => {
    expect(tankSkirmishGodotSkillPolicy.allowlist).toHaveLength(9);
    expect(tankSkirmishGodotSkillPolicy.roleDefaults?.team_lead).toEqual([]);
    expect(tankSkirmishGodotSkillPolicy.roleDefaults?.implementer).toEqual([
      "godot-project-foundations",
      "godot-gdscript-mastery",
      "godot-testing-patterns",
    ]);
    expect(tankSkirmishGodotSkillPolicy.roleDefaults?.visual_reviewer).toEqual([
      "godot-agent-vision",
    ]);
  });

  it("requires strict catalog entries and contained manifest references", () => {
    expect(skillCatalogSchema.safeParse(catalog()).success).toBe(true);
    expect(
      skillCatalogSchema.safeParse({
        ...catalog(),
        skills: [catalog().skills[0], catalog().skills[0]],
      }).success,
    ).toBe(false);
    expect(
      skillCatalogSchema.safeParse({
        ...catalog(),
        skills: [
          {
            ...catalog().skills[0],
            allowedReferences: ["../outside.md"],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("treats the project allowlist as a hard upper bound for role defaults and Job selections", () => {
    const policy = projectSkillPolicySchema.parse({
      allowlist: ["godot-testing-patterns"],
      roleDefaults: {
        implementer: ["godot-testing-patterns", "godot-camera-systems"],
      },
    });
    const resolved = resolveSkillSelection({
      catalog: skillCatalogSchema.parse(catalog()),
      policy,
      role: "implementer",
      explicit: [
        { name: "godot-testing-patterns", requirement: "required" },
        { name: "godot-camera-systems", requirement: "optional" },
      ],
    });
    expect(resolved).toEqual({
      state: "admitted",
      selected: [
        expect.objectContaining({ name: "godot-testing-patterns", requirement: "required" }),
      ],
      omitted: [{ name: "godot-camera-systems", reason: "not_allowed" }],
    });
  });

  it("fails closed for a required missing or disallowed Skill", () => {
    const parsedCatalog = skillCatalogSchema.parse(catalog());
    const policy = projectSkillPolicySchema.parse({ allowlist: ["godot-testing-patterns"] });
    expect(
      resolveSkillSelection({
        catalog: parsedCatalog,
        policy,
        role: "implementer",
        explicit: [{ name: "unknown-skill", requirement: "required" }],
      }),
    ).toEqual({ state: "blocked", skillName: "unknown-skill", reason: "not_allowed" });
    expect(
      resolveSkillSelection({
        catalog: parsedCatalog,
        policy: projectSkillPolicySchema.parse({ allowlist: ["unknown-skill"] }),
        role: "implementer",
        explicit: [{ name: "unknown-skill", requirement: "required" }],
      }),
    ).toEqual({ state: "blocked", skillName: "unknown-skill", reason: "missing" });
  });

  it("keeps the immutable Job snapshot free of requirement and gate fields", () => {
    const snapshot = jobSkillSnapshotSchema.parse({
      schemaVersion: 1,
      jobId: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
      projectId: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
      skills: [],
      omitted: [],
    });
    expect(snapshot).not.toHaveProperty("requirementSnapshot");
    expect(snapshot).not.toHaveProperty("acceptanceCriteria");
    expect(snapshot).not.toHaveProperty("mergeGate");
    expect(snapshot).not.toHaveProperty("lifecycle");
    expect(
      jobSkillSnapshotSchema.safeParse({
        ...snapshot,
        omitted: [{ name: "godot-testing-patterns", reason: "missing" }],
        skills: [
          {
            ...catalog().skills[0],
            requirement: "required",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("computes deterministic tree integrity and rejects symlinks or reference escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-skill-contract-"));
    await mkdir(join(root, "references"));
    await writeFile(join(root, "SKILL.md"), "skill\n", "utf8");
    await writeFile(join(root, "references", "one.md"), "one\n", "utf8");

    const integrity = await computeSkillTreeIntegrity(root);
    expect(integrity.ok).toBe(true);
    if (!integrity.ok) return;
    expect(integrity.value.treeDigest).toBe(
      "a91c3cccabc81744f6f066b932f0adbe97938bffe7ee6afe1fb620812904917f",
    );
    expect(
      await verifySkillReferences({
        root,
        expectedFileDigests: integrity.value.fileDigests,
        allowedReferences: ["references/one.md"],
      }),
    ).toEqual({ ok: true, value: undefined });
    expect(
      await verifySkillReferences({
        root,
        expectedFileDigests: integrity.value.fileDigests,
        allowedReferences: ["../outside.md"],
      }),
    ).toMatchObject({ ok: false, error: { code: "invariant_violation" } });

    await symlink(join(root, "SKILL.md"), join(root, "references", "linked.md"));
    expect(await computeSkillTreeIntegrity(root)).toMatchObject({
      ok: false,
      error: { code: "invariant_violation" },
    });
  });
});
