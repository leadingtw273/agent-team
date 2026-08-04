import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  agentRoleSchema,
  issueJsonSchema,
  issueSchema,
  projectJsonSchema,
  projectSchema,
  reviewRequirementSchema,
} from "../../src/domain/project/index.js";

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(
    await readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8"),
  ) as unknown;
}

describe("project domain schemas", () => {
  it("accepts the versioned project and issue fixtures", async () => {
    const project = await readJson("fixtures/domain/project-v1.valid.json");
    const issue = await readJson("fixtures/domain/issue-v1.valid.json");

    expect(projectSchema.parse(project)).toEqual(project);
    expect(issueSchema.parse(issue)).toEqual(issue);
  });

  it("keeps the SCM reference provider-neutral for nested GitLab groups", async () => {
    const project = (await readJson("fixtures/domain/project-v1.valid.json")) as Record<
      string,
      unknown
    >;
    const candidate = {
      ...project,
      sourceControl: { provider: "gitlab", repository: "group/subgroup/repository" },
    };

    expect(projectSchema.safeParse(candidate).success).toBe(true);
  });

  it("keeps roles and review requirements closed to the v1 values", () => {
    expect(agentRoleSchema.options).toEqual([
      "team_lead",
      "implementer",
      "code_reviewer",
      "visual_reviewer",
      "integration_engineer",
    ]);
    expect(reviewRequirementSchema.options).toEqual([
      "code_review",
      "visual_review",
      "dual_review",
    ]);
    expect(agentRoleSchema.safeParse("producer").success).toBe(false);
  });

  it("rejects every negative fixture without throwing raw input", async () => {
    const cases = (await readJson("fixtures/domain/project-issue-v1.invalid.json")) as {
      name: string;
      schema: "project" | "issue";
      input: unknown;
    }[];

    expect(cases).toHaveLength(6);
    for (const fixture of cases) {
      const schema = fixture.schema === "project" ? projectSchema : issueSchema;
      expect(schema.safeParse(fixture.input).success, fixture.name).toBe(false);
    }
  });

  it("keeps incomplete Ready fields parseable for the F003 gate", () => {
    const result = issueSchema.safeParse({
      schemaVersion: 1,
      id: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab",
      projectId: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
      externalId: "ENG-124",
      title: "Needs clarification",
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected issue draft to parse");
    expect(result.data.agentRole).toBeUndefined();
    expect(result.data.reviewRequirement).toBeUndefined();
  });

  it("keeps committed JSON Schemas synchronized with Zod", async () => {
    await expect(readJson("schemas/project-v1.json")).resolves.toEqual(projectJsonSchema);
    await expect(readJson("schemas/issue-v1.json")).resolves.toEqual(issueJsonSchema);
  });
});
