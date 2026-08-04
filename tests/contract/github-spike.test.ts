import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const fixtureDirectory = new URL("../../fixtures/providers/github/", import.meta.url);

async function readFixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL(name, fixtureDirectory), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("GitHub spike evidence contract", () => {
  it("keeps fixtures versioned and free of account or token identifiers", async () => {
    const names = await readdir(fixtureDirectory);
    expect(names.length).toBeGreaterThanOrEqual(1);

    for (const name of names) {
      const text = await readFile(new URL(name, fixtureDirectory), "utf8");
      const fixture = JSON.parse(text) as {
        schemaVersion?: number;
        fixtureType?: string;
        provenance?: { source?: string; redactionMethod?: string; removedFields?: string[] };
      };
      expect(fixture.schemaVersion, name).toBe(1);
      expect(fixture.fixtureType, name).toBe("observed-redacted");
      expect(fixture.provenance?.source, name).toBeTruthy();
      expect(fixture.provenance?.redactionMethod, name).toBeTruthy();
      expect(fixture.provenance?.removedFields, name).toBeInstanceOf(Array);
      expect(text, name).not.toMatch(
        /"(?:login|token|node_id|nodeId|repositoryId|accountId)"\s*:/iu,
      );
      expect(text, name).not.toMatch(/gh[opurs]_[A-Za-z0-9_]+/u);
    }
  });

  it("does not claim a required merge gate on the current private plan", async () => {
    const fixture = await readFixture("repository-capabilities.json");
    const observed = fixture["observed"] as {
      visibility: string;
      allowAutoMerge: boolean;
      viewerPermissions: { admin: boolean };
      rulesets: { available: boolean; failure: string };
      branchProtection: { available: boolean; failure: string };
    };
    const expected = fixture["expected"] as {
      classification: string;
      mustNotClaimEnforcedRequiredStatus: boolean;
    };

    expect(observed.visibility).toBe("private");
    expect(observed.viewerPermissions.admin).toBe(true);
    expect(observed.allowAutoMerge).toBe(false);
    expect(observed.rulesets).toEqual({
      available: false,
      failure: "requires_paid_plan_or_public_repo",
    });
    expect(observed.branchProtection).toEqual(observed.rulesets);
    expect(expected.classification).toBe("setup_incomplete_for_required_merge_gate");
    expect(expected.mustNotClaimEnforcedRequiredStatus).toBe(true);
  });
});
