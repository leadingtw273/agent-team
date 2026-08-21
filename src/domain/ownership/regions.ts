import type { ChangeRegion } from "../project/index.js";

function segments(path: string): readonly string[] {
  return path.split("/");
}

function isPrefix(prefix: readonly string[], value: readonly string[]): boolean {
  return prefix.length <= value.length && prefix.every((part, index) => value[index] === part);
}

export function changeRegionsOverlap(left: ChangeRegion, right: ChangeRegion): boolean {
  const leftPath = segments(left.path);
  const rightPath = segments(right.path);
  if (left.coverage === "exact" && right.coverage === "exact") return left.path === right.path;
  if (left.coverage === "subtree" && isPrefix(leftPath, rightPath)) return true;
  if (right.coverage === "subtree" && isPrefix(rightPath, leftPath)) return true;
  return false;
}

export function canonicalChangeRegions(
  regions: readonly ChangeRegion[],
): readonly ChangeRegion[] | undefined {
  const sorted = [...regions]
    .map((region) => Object.freeze({ ...region }))
    .sort((left, right) =>
      left.path === right.path
        ? left.coverage.localeCompare(right.coverage)
        : left.path.localeCompare(right.path),
    );
  if (
    sorted.length === 0 ||
    sorted.some((region, index) =>
      sorted.slice(index + 1).some((other) => changeRegionsOverlap(region, other)),
    )
  ) {
    return undefined;
  }
  return Object.freeze(sorted);
}
