import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  classifyGraphqlOutcome,
  classifyNonJsonOutcome,
  isSecureSecretFile,
  parseLinearApiKey,
  sanitizeProbeName,
} from "../../spikes/linear/graphql-probe.mjs";

const fixtureDirectory = new URL("../../fixtures/providers/linear/", import.meta.url);

async function readFixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL(name, fixtureDirectory), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("Linear spike evidence contract", () => {
  it("keeps observed fixtures versioned and free of secrets or object identities", async () => {
    const names = await readdir(fixtureDirectory);
    expect(names.sort()).toEqual([
      "graphql-failures.json",
      "inventory.json",
      "roundtrip.json",
      "upload-capability.json",
    ]);

    for (const name of names) {
      const text = await readFile(new URL(name, fixtureDirectory), "utf8");
      const fixture = JSON.parse(text) as {
        schemaVersion?: number;
        fixtureType?: string;
        provenance?: { source?: string; redactionMethod?: string; removedFields?: string[] };
      };
      expect(fixture.schemaVersion, name).toBe(1);
      expect(["observed-redacted", "synthetic"], name).toContain(fixture.fixtureType);
      expect(fixture.provenance?.source, name).toBeTruthy();
      expect(fixture.provenance?.redactionMethod, name).toBeTruthy();
      expect(fixture.provenance?.removedFields, name).toBeInstanceOf(Array);
      expect(text, name).not.toMatch(/lin_(?:api|oauth)_[A-Za-z0-9_-]+/u);
      expect(text, name).not.toMatch(
        /"(?:id|email|name|key|nodeId|token|url|userName|workspaceName|teamName|assetUrl|uploadUrl)"\s*:/iu,
      );
    }
  });

  it("fails closed on an assignment-form secret without echoing its value", () => {
    const marker = "lin_api_must_never_appear_in_output";
    let thrown: unknown;
    try {
      parseLinearApiKey(`LINEAR_API_KEY=${marker}\n`);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("invalid_secret_file");
    expect((thrown as Error).message).not.toContain(marker);
    expect(isSecureSecretFile({ isFile: () => true, mode: 0o600, uid: 1000 }, 1000)).toBe(true);
    expect(isSecureSecretFile({ isFile: () => true, mode: 0o644, uid: 1000 }, 1000)).toBe(false);
    expect(isSecureSecretFile({ isFile: () => true, mode: 0o600, uid: 2000 }, 1000)).toBe(false);
    expect(sanitizeProbeName(marker)).toBe("invalid_mode");
  });

  it("fails closed on HTTP authorization, rate limit, and partial GraphQL errors", async () => {
    const fixture = await readFixture("graphql-failures.json");
    const cases = fixture["cases"] as {
      status: number;
      body: unknown;
      expectedError: string;
    }[];

    for (const entry of cases) {
      expect(classifyGraphqlOutcome(entry.status, entry.body)).toEqual({
        ok: false,
        error: entry.expectedError,
      });
    }
    const nonJsonCases = fixture["nonJsonCases"] as {
      status: number;
      expectedError: string;
    }[];
    for (const entry of nonJsonCases) {
      expect(classifyNonJsonOutcome(entry.status)).toBe(entry.expectedError);
    }
  });

  it("proves viewer, workspace, team, and required mutation discovery", async () => {
    const fixture = await readFixture("inventory.json");
    const observed = fixture["observed"] as {
      success: boolean;
      registrationReady: boolean;
      connection: { viewerReadable: boolean; workspaceReadable: boolean };
      inventory: {
        teamCount: number;
        projectCount: number;
        selectedTeamCanceledStateAvailable: boolean;
        inventoryComplete: boolean;
      };
      mutationsPresent: Record<string, boolean>;
    };
    const expected = fixture["expected"] as {
      zeroProjectClassification: string;
      schemaPresenceDoesNotProveAccess: boolean;
      mustNotClaimProjectConfigured: boolean;
    };

    expect(observed.success).toBe(true);
    expect(observed.connection).toEqual({ viewerReadable: true, workspaceReadable: true });
    expect(observed.inventory.teamCount).toBeGreaterThan(0);
    expect(observed.inventory.projectCount).toBeGreaterThanOrEqual(0);
    expect(observed.inventory.selectedTeamCanceledStateAvailable).toBe(true);
    expect(observed.inventory.inventoryComplete).toBe(true);
    expect(Object.values(observed.mutationsPresent).every(Boolean)).toBe(true);
    expect(observed.registrationReady).toBe(
      observed.success && observed.inventory.projectCount > 0,
    );
    if (observed.inventory.projectCount === 0) {
      expect(expected.zeroProjectClassification).toBe(
        "adopt_with_project_registration_prerequisite",
      );
      expect(expected.mustNotClaimProjectConfigured).toBe(true);
    }
    expect(expected.schemaPresenceDoesNotProveAccess).toBe(true);
  });

  it("proves issue, comment, label-group, and template round-trips with cleanup", async () => {
    const fixture = await readFixture("roundtrip.json");
    const observed = fixture["observed"] as {
      success: boolean;
      failure: string | null;
      issue: Record<string, boolean>;
      labelGroup: Record<string, boolean>;
      template: Record<string, boolean>;
      upload: {
        signedUrlIssued: boolean;
        bytesUploaded: boolean;
        fullUploadSkipped: boolean;
        deleteClassification: string;
      };
      cleanup: Record<string, boolean>;
    };

    expect(observed.success).toBe(true);
    expect(observed.failure).toBeNull();
    expect(Object.values(observed.issue).every(Boolean)).toBe(true);
    expect(Object.values(observed.labelGroup).every(Boolean)).toBe(true);
    expect(Object.values(observed.template).every(Boolean)).toBe(true);
    expect(observed.upload).toEqual(
      expect.objectContaining({
        signedUrlIssued: true,
        bytesUploaded: false,
        fullUploadSkipped: true,
        deleteClassification: "not_applicable_no_bytes",
      }),
    );
    expect(observed.cleanup).toEqual({
      commentsDeleted: true,
      issueCanceled: true,
      uploadDeleted: false,
      templateDeleted: true,
      labelsDeleted: true,
    });
  });

  it("adopts upload while preserving the inaccessible deletion result", async () => {
    const fixture = await readFixture("upload-capability.json");
    const observed = fixture["observed"] as {
      success: boolean;
      failure: string | null;
      upload: {
        signedUrlIssued: boolean;
        returnedHeadersApplied: boolean;
        bytesUploaded: boolean;
        putStatus: number;
        embeddedInComment: boolean;
        fullUploadSkipped: boolean;
        deleteClassification: string;
      };
      cleanup: Record<string, boolean>;
    };
    const expected = fixture["expected"] as {
      classification: string;
      mustNotClaimUploadedAssetDeleted: boolean;
      persistentUnreferencedAssetRemains: boolean;
    };

    expect(observed.success).toBe(false);
    expect(observed.failure).toBeNull();
    expect(observed.upload).toEqual({
      signedUrlIssued: true,
      returnedHeadersApplied: true,
      bytesUploaded: true,
      putStatus: 200,
      embeddedInComment: true,
      fullUploadSkipped: false,
      deleteClassification: "graphql_feature_not_accessible",
    });
    expect(observed.cleanup).toEqual({
      commentsDeleted: true,
      issueCanceled: true,
      uploadDeleted: false,
      templateDeleted: true,
      labelsDeleted: true,
    });
    expect(expected.classification).toBe("adopt_upload_with_cleanup_degradation");
    expect(expected.mustNotClaimUploadedAssetDeleted).toBe(true);
    expect(expected.persistentUnreferencedAssetRemains).toBe(true);
  });
});
