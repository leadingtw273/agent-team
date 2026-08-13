import { describe, expect, it } from "vitest";

import {
  claudeAllowedToolsForRole,
  claudeWritableDirectories,
  classifyClaudeChangeRegions,
} from "../../src/adapters/providers/claude/index.js";

describe("Claude protected change-region policy", () => {
  it.each([".github/workflows/ci.yml", ".agent-team/project.json", "README.md", "package.json"])(
    "blocks protected exact path %s",
    (path) => {
      expect(classifyClaudeChangeRegions([{ path, coverage: "exact" }])).toEqual({
        state: "blocked",
        protectedRegionCount: 1,
      });
    },
  );

  it("allows only declared directory subtrees and blocks the whole mixed request", () => {
    expect(
      classifyClaudeChangeRegions([
        { path: "src/feature.ts", coverage: "exact" },
        { path: "tests", coverage: "subtree" },
      ]),
    ).toEqual({ state: "allowed" });
    expect(
      classifyClaudeChangeRegions([
        { path: "src/feature.ts", coverage: "exact" },
        { path: ".github/workflows/ci.yml", coverage: "exact" },
      ]),
    ).toEqual({ state: "blocked", protectedRegionCount: 1 });
  });

  it("derives the actual implementer grants from the same exported directory set", () => {
    const grants = claudeAllowedToolsForRole("implementer");
    const grantedDirectories = grants
      .filter((grant) => grant.startsWith("Write(./") && grant.endsWith("/*)"))
      .map((grant) => grant.slice("Write(./".length, -"/*)".length));
    expect(grantedDirectories).toEqual(claudeWritableDirectories);
    expect(grantedDirectories).not.toContain(".github");
  });
});
