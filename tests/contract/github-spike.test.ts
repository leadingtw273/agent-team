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
    expect(names.sort()).toEqual([
      "auto-merge-enabled.json",
      "commit-status.json",
      "draft-pr-checks.json",
      "repository-capabilities.json",
      "self-approval-denied.json",
    ]);

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

  it("separates public repository capability from pending merge-gate configuration", async () => {
    const fixture = await readFixture("repository-capabilities.json");
    const observed = fixture["observed"] as {
      visibility: string;
      allowAutoMerge: boolean;
      viewerPermissions: { admin: boolean };
      rulesets: { available: boolean; count: number; failure: null };
      branchProtection: { available: boolean; failure: string };
    };
    const expected = fixture["expected"] as {
      classification: string;
      canProvisionRuleset: boolean;
      requiredMergeGateConfigured: boolean;
      mustNotClaimEnforcedRequiredStatus: boolean;
    };

    expect(observed.visibility).toBe("public");
    expect(observed.viewerPermissions.admin).toBe(true);
    expect(observed.allowAutoMerge).toBe(true);
    expect(observed.rulesets).toEqual({
      available: true,
      count: 0,
      failure: null,
    });
    expect(observed.branchProtection).toEqual({
      available: false,
      failure: "not_found_or_not_configured",
    });
    expect(expected.classification).toBe("capability_available_configuration_pending");
    expect(expected.canProvisionRuleset).toBe(true);
    expect(expected.requiredMergeGateConfigured).toBe(false);
    expect(expected.mustNotClaimEnforcedRequiredStatus).toBe(true);
  });

  it("proves Draft, Ready, Actions Check, and Commit Status transitions", async () => {
    const pull = await readFixture("draft-pr-checks.json");
    const status = await readFixture("commit-status.json");
    const observedPull = pull["observed"] as {
      initial: { isDraft: boolean; qualityGate: string; commitStatus: string };
      afterChecks: { isDraft: boolean; qualityGate: string; mergeStateStatus: string };
      afterReady: { isDraft: boolean; qualityGate: string; commitStatus: string };
    };
    const observedStatus = status["observed"] as {
      postResponse: { shaFieldPresent: boolean };
      readBack: { matchingContextFound: boolean; state: string; headShaMatches: boolean };
      afterHeadChange: { oldStatusPresentOnNewHead: boolean; qualityGate: string };
    };

    expect(observedPull.initial).toEqual(
      expect.objectContaining({ isDraft: true, qualityGate: "IN_PROGRESS" }),
    );
    expect(observedPull.afterChecks).toEqual(
      expect.objectContaining({ isDraft: true, qualityGate: "SUCCESS", mergeStateStatus: "CLEAN" }),
    );
    expect(observedPull.afterReady).toEqual(
      expect.objectContaining({ isDraft: false, qualityGate: "SUCCESS", commitStatus: "SUCCESS" }),
    );
    expect(observedStatus.postResponse.shaFieldPresent).toBe(false);
    expect(observedStatus.readBack).toEqual({
      combinedState: "success",
      matchingContextFound: true,
      state: "success",
      headShaMatches: true,
    });
    expect(observedStatus.afterHeadChange).toEqual({
      oldStatusPresentOnNewHead: false,
      qualityGate: "IN_PROGRESS",
    });
  });

  it("records the single-account review limitation without fabricating approval", async () => {
    const fixture = await readFixture("self-approval-denied.json");
    const observed = fixture["observed"] as {
      exitCode: number;
      normalizedError: string;
      reviewsAfterAttempt: string[];
    };
    const expected = fixture["expected"] as {
      useStructuredReviewCommentAndCommitStatus: boolean;
    };

    expect(observed.exitCode).toBe(1);
    expect(observed.normalizedError).toBe("cannot_approve_own_pull_request");
    expect(observed.reviewsAfterAttempt).toEqual([]);
    expect(expected.useStructuredReviewCommentAndCommitStatus).toBe(true);
  });

  it("proves auto-merge is enabled with an idempotent PATCH and read-back", async () => {
    const fixture = await readFixture("auto-merge-enabled.json");
    const observed = fixture["observed"] as {
      before: boolean;
      first: { patchExitCode: number; patchResponse: boolean; readBack: boolean };
      second: { patchExitCode: number; patchResponse: boolean; readBack: boolean };
      idempotent: boolean;
      configurationDrift: boolean;
    };
    const expected = fixture["expected"] as {
      classification: string;
      mustNotClaimRulesetConfigured: boolean;
    };

    expect(observed.before).toBe(true);
    expect(observed.first).toEqual(
      expect.objectContaining({ patchExitCode: 0, patchResponse: true, readBack: true }),
    );
    expect(observed.second).toEqual(
      expect.objectContaining({ patchExitCode: 0, patchResponse: true, readBack: true }),
    );
    expect(observed.idempotent).toBe(true);
    expect(observed.configurationDrift).toBe(false);
    expect(expected.classification).toBe("auto_merge_enabled_with_readback");
    expect(expected.mustNotClaimRulesetConfigured).toBe(true);
  });
});
