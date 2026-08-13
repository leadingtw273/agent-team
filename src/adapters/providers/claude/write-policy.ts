import type { ChangeRegion } from "../../../domain/project/index.js";

/**
 * The only top-level directories Claude implementer roles may mutate. The runner and dispatch
 * admission classifier intentionally share this exact export: a new writable directory is one
 * policy change, never two lists that can drift independently.
 */
export const claudeWritableDirectories = Object.freeze([
  "docs",
  "fixtures",
  "roles",
  "schemas",
  "scripts",
  "spikes",
  "src",
  "systemd",
  "tests",
] as const);

export function claudeAllowedToolsForRole(
  role: "team_lead" | "implementer" | "code_reviewer" | "visual_reviewer" | "integration_engineer",
): readonly string[] {
  const scopedRead = Object.freeze(["Read(./*)", "Read(./**)"]);
  if (role !== "implementer" && role !== "integration_engineer") return scopedRead;
  return Object.freeze([
    ...scopedRead,
    ...claudeWritableDirectories.flatMap((directory) => [
      `Write(./${directory}/*)`,
      `Write(./${directory}/**)`,
      `Edit(./${directory}/*)`,
      `Edit(./${directory}/**)`,
    ]),
  ]);
}

export function isClaudeChangeRegionWritable(region: ChangeRegion): boolean {
  return claudeWritableDirectories.some(
    (directory) =>
      region.path.startsWith(`${directory}/`) ||
      (region.coverage === "subtree" && region.path === directory),
  );
}

export type ClaudeChangeRegionClassification =
  Readonly<{ state: "allowed" }> | Readonly<{ state: "blocked"; protectedRegionCount: number }>;

export function classifyClaudeChangeRegions(
  regions: readonly ChangeRegion[],
): ClaudeChangeRegionClassification {
  const protectedRegionCount = regions.filter(
    (region) => !isClaudeChangeRegionWritable(region),
  ).length;
  return protectedRegionCount === 0
    ? Object.freeze({ state: "allowed" })
    : Object.freeze({ state: "blocked", protectedRegionCount });
}
