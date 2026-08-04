import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const fixtureDirectory = new URL("../../fixtures/providers/claude/", import.meta.url);

async function readFixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL(name, fixtureDirectory), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("Claude spike evidence contract", () => {
  it("keeps fixtures versioned and free of account or session identifiers", async () => {
    const names = await readdir(fixtureDirectory);
    expect(names).toHaveLength(6);

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
        /"(?:email|orgId|organizationId|session_id|sessionId|message_id|messageId|accessToken)"\s*:/iu,
      );
      expect(text, name).not.toMatch(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/u);
    }
  });

  it("identifies a logged-in Team account without persisting its identity", async () => {
    const fixture = await readFixture("auth-team.json");
    const observed = fixture["observed"] as {
      loggedIn: boolean;
      apiProvider: string;
      subscriptionType: string;
    };
    const expected = fixture["expected"] as { accountIdentityPersisted: boolean };

    expect(observed.loggedIn).toBe(true);
    expect(observed.apiProvider).toBe("firstParty");
    expect(observed.subscriptionType).toBe("team");
    expect(expected.accountIdentityPersisted).toBe(false);
  });

  it("requires a structured result with no permission denial for success", async () => {
    const fixture = await readFixture("exec-success.json");
    const observed = fixture["observed"] as {
      exitCode: number;
      eventTypes: string[];
      permissionDenialTools: string[];
      finalResult: string;
      isError: boolean;
    };

    expect(observed.exitCode).toBe(0);
    expect(observed.eventTypes).toContain("result");
    expect(observed.permissionDenialTools).toEqual([]);
    expect(observed.finalResult).toBe("CLAUDE_PROBE_OK");
    expect(observed.isError).toBe(false);
  });

  it("proves the reviewer actually read while leaving the target and Git state unchanged", async () => {
    const fixture = await readFixture("read-only-review-resume.json");
    const observed = fixture["observed"] as {
      review: { toolNames: string[]; finalResult: string; isError: boolean };
      targetSha256Unchanged: boolean;
      gitStatusUnchanged: boolean;
      resume: { finalResult: string; isError: boolean };
    };

    expect(observed.review.toolNames).toEqual(["Read"]);
    expect(observed.review.finalResult).toBe("CLAUDE_REVIEW_OK");
    expect(observed.review.isError).toBe(false);
    expect(observed.targetSha256Unchanged).toBe(true);
    expect(observed.gitStatusUnchanged).toBe(true);
    expect(observed.resume.finalResult).toBe("CLAUDE_RESUME_OK");
    expect(observed.resume.isError).toBe(false);
  });

  it("classifies a permission denial before an otherwise successful process result", async () => {
    const fixture = await readFixture("permission-denied.json");
    const observed = fixture["observed"] as {
      exitCode: number;
      toolNames: string[];
      permissionDenialTools: string[];
      isError: boolean;
      markerExists: boolean;
    };
    const expected = fixture["expected"] as {
      classification: string;
      processExitZeroIsNotSuccess: boolean;
    };

    expect(observed.exitCode).toBe(0);
    expect(observed.toolNames).toContain("Bash");
    expect(observed.permissionDenialTools).toContain("Bash");
    expect(observed.isError).toBe(false);
    expect(observed.markerExists).toBe(false);
    expect(expected.classification).toBe("blocked_by_permission");
    expect(expected.processExitZeroIsNotSuccess).toBe(true);
  });

  it("adopts the structured weekly warning but fails closed for missing five-hour data", async () => {
    const exec = await readFixture("exec-success.json");
    const status = await readFixture("quota-print-unavailable.json");
    const tui = await readFixture("quota-tui-observed.json");
    const rateLimits = (
      exec["observed"] as {
        rateLimitEvents: {
          status: string;
          rateLimitType: string;
          utilization: number;
          resetsAt: number;
        }[];
      }
    ).rateLimitEvents;
    const printExpected = status["expected"] as {
      classification: string;
      startNewWork: boolean;
      mustNotTreatUnknownAsZero: boolean;
    };
    const tuiObserved = tui["observed"] as {
      structuredApi: boolean;
      currentSession: { usedPercent: number };
      currentWeekAllModels: { usedPercent: number };
    };

    expect(rateLimits).toEqual([
      expect.objectContaining({
        status: "allowed_warning",
        rateLimitType: "seven_day",
        utilization: 0.93,
      }),
    ]);
    expect(rateLimits[0]?.resetsAt).toBeGreaterThan(0);
    expect(printExpected.classification).toBe("quota_unknown");
    expect(printExpected.startNewWork).toBe(false);
    expect(printExpected.mustNotTreatUnknownAsZero).toBe(true);
    expect(tuiObserved.structuredApi).toBe(false);
    expect(tuiObserved.currentSession.usedPercent).toBe(5);
    expect(tuiObserved.currentWeekAllModels.usedPercent).toBe(93);
  });

  it("never enables Claude's permission bypass flag", async () => {
    const script = await readFile(
      new URL("../../spikes/claude/cli-probe.mjs", import.meta.url),
      "utf8",
    );
    expect(script).not.toContain("dangerously-skip-permissions");
    expect(script).toContain('"--safe-mode"');
    expect(script).toContain('"dontAsk"');
  });
});
