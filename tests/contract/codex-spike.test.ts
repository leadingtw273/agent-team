import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const fixtureDirectory = new URL("../../fixtures/providers/codex/", import.meta.url);

async function readFixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL(name, fixtureDirectory), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("Codex spike evidence contract", () => {
  it("keeps every fixture versioned and free of account identifiers", async () => {
    const names = await readdir(fixtureDirectory);
    expect(names).toHaveLength(7);

    for (const name of names) {
      const text = await readFile(new URL(name, fixtureDirectory), "utf8");
      const fixture = JSON.parse(text) as {
        schemaVersion?: number;
        fixtureType?: string;
        provenance?: { source?: string; redactionMethod?: string; removedFields?: string[] };
      };

      expect(fixture.schemaVersion, name).toBe(1);
      expect(fixture.fixtureType, name).toMatch(
        /^(?:observed-redacted|synthetic-official-schema)$/u,
      );
      expect(fixture.provenance?.source, name).toBeTruthy();
      expect(fixture.provenance?.redactionMethod, name).toBeTruthy();
      expect(fixture.provenance?.removedFields, name).toBeInstanceOf(Array);
      expect(text, name).not.toMatch(/"(?:email|accessToken|thread_id|threadId)"\s*:/iu);
      expect(text, name).not.toMatch(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/u);
    }
  });

  it("requires a completed turn for non-interactive success", async () => {
    const fixture = await readFixture("exec-success.json");
    const observed = fixture["observed"] as { exitCode: number; eventTypes: string[] };

    expect(observed.exitCode).toBe(0);
    expect(observed.eventTypes).toContain("turn.completed");
  });

  it("rejects agent self-report when no command event exists", async () => {
    const fixture = await readFixture("exec-unverified-self-report.json");
    const observed = fixture["observed"] as { commandExecutionEvents: number };
    const expected = fixture["expected"] as { validCommandEvidence: boolean };

    expect(observed.commandExecutionEvents).toBe(0);
    expect(expected.validCommandEvidence).toBe(false);
  });

  it("fails closed when the five-hour quota bucket is absent", async () => {
    const fixture = await readFixture("account-rate-limits.json");
    const observed = fixture["observed"] as {
      rateLimits: {
        current: { primary: { windowDurationMins: number }; secondary: unknown };
        buckets: { limitId: string; primary: { windowDurationMins: number } }[];
      };
    };
    const expected = fixture["expected"] as {
      fiveHourSignal: string;
      mustNotTreatMissingBucketAsZero: boolean;
    };

    expect(observed.rateLimits.current.primary.windowDurationMins).toBe(10_080);
    expect(observed.rateLimits.current.secondary).toBeNull();
    expect(observed.rateLimits.buckets).toHaveLength(2);
    expect(observed.rateLimits.buckets.every((bucket) => bucket.limitId.length > 0)).toBe(true);
    expect(expected.fiveHourSignal).toBe("unknown");
    expect(expected.mustNotTreatMissingBucketAsZero).toBe(true);
  });

  it("proves sandbox, approval, interrupt, and quota failures are explicit", async () => {
    const sandbox = await readFixture("sandbox-denied.json");
    const approval = await readFixture("approval-declined.json");
    const interrupt = await readFixture("interrupt-resume.json");
    const quota = await readFixture("usage-limit-exceeded.json");

    expect((sandbox["observed"] as { markerExists: boolean }).markerExists).toBe(false);
    expect((approval["observed"] as { markerExists: boolean }).markerExists).toBe(false);
    const interrupted = interrupt["observed"] as {
      interruptedStatus: string;
      resumedMessage: string;
    };
    expect(interrupted.interruptedStatus).toBe("interrupted");
    expect(interrupted.resumedMessage).toBe("INTERRUPT_RESUME_OK");
    expect((quota["observed"] as { turnStatus: string }).turnStatus).toBe("failed");
  });
});
