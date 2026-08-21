import { describe, expect, it } from "vitest";

import { trustedProjectConfigSchema } from "../../src/application/projects/index.js";
import { selectVerificationPolicy } from "../../src/application/verification/index.js";

const command = (name: string) => ({ executable: "pnpm", arguments: [name] });

function config() {
  return trustedProjectConfigSchema.parse({
    schemaVersion: 1,
    projectId: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    defaultBranch: "main",
    platforms: {
      workManagement: { provider: "linear", containerId: "team", projectId: "project" },
      sourceControl: { provider: "github", repository: "owner/repository" },
    },
    projectRules: [],
    roleInstructions: {},
    commands: {
      quality: [command("quality")],
      visualReview: [],
      verification: {
        static: [command("static")],
        smoke: [command("smoke")],
        targeted: [command("targeted")],
        full: [command("full")],
        negative: [command("negative")],
        readback: [command("readback")],
      },
    },
  });
}

describe("verification policy", () => {
  it.each([
    { level: "light", commands: ["static", "smoke"] },
    { level: "standard", commands: ["static", "targeted", "quality", "smoke"] },
    {
      level: "strict",
      commands: ["static", "targeted", "quality", "full", "negative", "smoke", "readback"],
    },
  ] as const)("selects the closed $level command set", ({ level, commands }) => {
    const selected = selectVerificationPolicy({ approvedLevel: level, trustedConfig: config() });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(selected.value.commands.map((entry) => entry.arguments[0])).toEqual(commands);
    expect(selected.value.effectiveLevel).toBe(level);
    expect(selected.value.obligations).toContain("auto_merge_gate");
  });

  it("allows one reason-bound reviewer upgrade and preserves the approved level", () => {
    const selected = selectVerificationPolicy({
      approvedLevel: "light",
      trustedConfig: config(),
      reviewerUpgrade: { level: "strict", reason: "core_lifecycle_invariant" },
    });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(selected.value.approvedLevel).toBe("light");
    expect(selected.value.effectiveLevel).toBe("strict");
    expect(selected.value.reviewerUpgrade).toEqual({
      level: "strict",
      reason: "core_lifecycle_invariant",
    });
  });

  it.each([
    { approvedLevel: "standard", requestedLevel: "light" },
    { approvedLevel: "standard", requestedLevel: "standard" },
    { approvedLevel: "strict", requestedLevel: "light" },
  ] as const)("rejects reviewer downgrade or no-op requests", (entry) => {
    expect(
      selectVerificationPolicy({
        approvedLevel: entry.approvedLevel,
        trustedConfig: config(),
        reviewerUpgrade: {
          level: entry.requestedLevel,
          reason: "direct_regression_risk",
        },
      }),
    ).toMatchObject({ ok: false, error: { code: "invariant_violation" } });
  });

  it("keeps legacy configs readable but fails closed when new policy selection lacks its catalog", () => {
    const legacy = trustedProjectConfigSchema.parse({
      ...config(),
      commands: { quality: [command("quality")], visualReview: [] },
    });
    expect(legacy.commands.verification).toBeUndefined();
    expect(
      selectVerificationPolicy({ approvedLevel: "light", trustedConfig: legacy }),
    ).toMatchObject({ ok: false, error: { code: "invariant_violation" } });
  });

  it("de-duplicates identical commands without changing first-seen order", () => {
    const duplicate = trustedProjectConfigSchema.parse({
      ...config(),
      commands: {
        ...config().commands,
        quality: [command("targeted"), command("quality")],
      },
    });
    const selected = selectVerificationPolicy({
      approvedLevel: "standard",
      trustedConfig: duplicate,
    });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(selected.value.commands.map((entry) => entry.arguments[0])).toEqual([
      "static",
      "targeted",
      "quality",
      "smoke",
    ]);
  });
});
