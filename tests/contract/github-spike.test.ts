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
    expect(names).toHaveLength(5);

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

  it("fails closed when auto-merge PATCH exits zero but read-back remains disabled", async () => {
    const fixture = await readFixture("auto-merge-unavailable.json");
    const observed = fixture["observed"] as {
      before: boolean;
      patchExitCode: number;
      patchResponse: boolean;
      readBack: boolean;
      configurationDrift: boolean;
      rulesetsAvailable: boolean;
      branchProtectionAvailable: boolean;
    };
    const expected = fixture["expected"] as {
      classification: string;
      mustNotClaimAutoMergeEnabled: boolean;
    };

    expect(observed.before).toBe(false);
    expect(observed.patchExitCode).toBe(0);
    expect(observed.patchResponse).toBe(false);
    expect(observed.readBack).toBe(false);
    expect(observed.configurationDrift).toBe(false);
    expect(observed.rulesetsAvailable).toBe(false);
    expect(observed.branchProtectionAvailable).toBe(false);
    expect(expected.classification).toBe("blocked_by_private_repository_plan");
    expect(expected.mustNotClaimAutoMergeEnabled).toBe(true);
  });
});
