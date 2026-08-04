import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const traceabilityUrl = new URL("../../docs/traceability.md", import.meta.url);
const planUrl = new URL("../../docs/plan.md", import.meta.url);

function sequence(prefix: string, count: number, width = 2): string[] {
  return Array.from(
    { length: count },
    (_, index) => `${prefix}-${String(index + 1).padStart(width, "0")}`,
  );
}

describe("requirements traceability contract", () => {
  it("maps every specification section exactly once", async () => {
    const traceability = await readFile(traceabilityUrl, "utf8");

    for (const id of sequence("SPEC", 24)) {
      expect(traceability.match(new RegExp(`\\| ${id} \\|`, "gu"))).toHaveLength(1);
    }
  });

  it("maps all eight first-version exits to an E2E task", async () => {
    const traceability = await readFile(traceabilityUrl, "utf8");

    for (const id of sequence("EXIT", 8)) {
      const row = traceability.split("\n").find((line) => line.startsWith(`| ${id} |`));

      expect(row, `${id} row`).toBeDefined();
      expect(row).toMatch(/\bE\d{3}\b/u);
    }
  });

  it("indexes all eight approved ADRs", async () => {
    const traceability = await readFile(traceabilityUrl, "utf8");

    for (const id of sequence("ADR", 8, 3)) {
      expect(traceability.match(new RegExp(`\\| ${id} \\|`, "gu"))).toHaveLength(1);
    }
  });

  it("only references task identifiers that exist in the approved plan", async () => {
    const [plan, traceability] = await Promise.all([
      readFile(planUrl, "utf8"),
      readFile(traceabilityUrl, "utf8"),
    ]);
    const planTaskIds = new Set(
      [...plan.matchAll(/^\| ([A-Z]\d{3}) \|/gmu)].map((match) => match[1]),
    );
    const referencedTaskIds = new Set(
      [...traceability.matchAll(/\b([A-Z]\d{3})\b/gu)].map((match) => match[1]),
    );

    expect(planTaskIds.size).toBeGreaterThan(0);
    expect([...referencedTaskIds].filter((id) => !planTaskIds.has(id))).toEqual([]);
  });

  it("contains no unresolved placeholder", async () => {
    const traceability = await readFile(traceabilityUrl, "utf8");

    expect(traceability).not.toMatch(/\b(?:FIXME|TBD|TODO)\b/iu);
  });
});
