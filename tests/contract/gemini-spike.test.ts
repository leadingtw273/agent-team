import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const fixtureDirectory = new URL("../../fixtures/providers/gemini/", import.meta.url);

async function readFixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL(name, fixtureDirectory), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("Gemini spike evidence contract", () => {
  it("keeps every fixture versioned and free of account, session, or process identifiers", async () => {
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
        /"(?:email|accountId|session_id|sessionId|processId|pid|accessToken)"\s*:/iu,
      );
      expect(text, name).not.toMatch(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/u);
    }
  });

  it("classifies a structured harmless turn as currently available", async () => {
    const fixture = await readFixture("exec-success.json");
    const observed = fixture["observed"] as {
      exitCode: number;
      eventTypes: string[];
      toolNames: string[];
      assistantText: string;
      finalStatus: string;
    };

    expect(observed.exitCode).toBe(0);
    expect(observed.eventTypes).toContain("result");
    expect(observed.toolNames).toEqual([]);
    expect(observed.assistantText).toBe("GEMINI_PROBE_OK");
    expect(observed.finalStatus).toBe("success");
  });

  it("requires true image-read evidence and zero file changes for visual success", async () => {
    const fixture = await readFixture("visual-json-success.json");
    const observed = fixture["observed"] as {
      modelNames: string[];
      semanticResponse: {
        redSquareTopLeft: boolean;
        blueSquareBottomRight: boolean;
        providerPrefixPresent: boolean;
      };
      tools: { name: string; success: number; fail: number }[];
      filesChanged: { linesAdded: number; linesRemoved: number };
    };

    expect(observed.modelNames).toHaveLength(1);
    expect(observed.semanticResponse.redSquareTopLeft).toBe(true);
    expect(observed.semanticResponse.blueSquareBottomRight).toBe(true);
    expect(observed.semanticResponse.providerPrefixPresent).toBe(true);
    expect(observed.tools).toEqual([
      expect.objectContaining({ name: "read_file", success: 1, fail: 0 }),
    ]);
    expect(observed.filesChanged).toEqual({ linesAdded: 0, linesRemoved: 0 });
  });

  it("rejects truncated visual stream output even when the tool and result report success", async () => {
    const fixture = await readFixture("visual-stream-truncated.json");
    const observed = fixture["observed"] as {
      exitCode: number;
      toolResultStatuses: string[];
      assistantChunks: string[];
      finalStatus: string;
    };
    const expected = fixture["expected"] as {
      classification: string;
      streamJsonVisualOutputAdopted: boolean;
    };

    expect(observed.exitCode).toBe(0);
    expect(observed.toolResultStatuses).toEqual(["success"]);
    expect(observed.assistantChunks.join("")).not.toMatch(/red.*blue/iu);
    expect(observed.finalStatus).toBe("success");
    expect(expected.classification).toBe("truncated_response_not_valid_success_evidence");
    expect(expected.streamJsonVisualOutputAdopted).toBe(false);
  });

  it("classifies a headless approval failure before the outer exit code", async () => {
    const fixture = await readFixture("headless-permission-denied.json");
    const observed = fixture["observed"] as {
      exitCode: number;
      hasTopLevelError: boolean;
      tools: { name: string; success: number; fail: number }[];
      markerExists: boolean;
    };
    const expected = fixture["expected"] as { classification: string };

    expect(observed.exitCode).toBe(0);
    expect(observed.hasTopLevelError).toBe(false);
    expect(observed.tools).toEqual([
      expect.objectContaining({ name: "write_file", success: 0, fail: 1 }),
    ]);
    expect(observed.markerExists).toBe(false);
    expect(expected.classification).toBe("blocked_by_headless_approval");
  });

  it("detects unavailable and force-killed attempts without inventing success", async () => {
    const unavailable = await readFixture("unavailable-invalid-model.json");
    const signal = await readFixture("signal-escalation.json");
    const unavailableObserved = unavailable["observed"] as {
      exitCode: number;
      structuredError: boolean;
      modelNames: string[];
    };
    const signalObserved = signal["observed"] as {
      inventoryChecks: number;
      termEffective: boolean;
      killEscalated: boolean;
      exitSignal: string;
      resultEventObserved: boolean;
    };

    expect(unavailableObserved.exitCode).toBe(1);
    expect(unavailableObserved.structuredError).toBe(false);
    expect(unavailableObserved.modelNames).toEqual([]);
    expect(signalObserved.inventoryChecks).toBe(2);
    expect(signalObserved.termEffective).toBe(false);
    expect(signalObserved.killEscalated).toBe(true);
    expect(signalObserved.exitSignal).toBe("SIGKILL");
    expect(signalObserved.resultEventObserved).toBe(false);
  });

  it("uses an explicit deny-by-default read-only policy and never enables YOLO", async () => {
    const script = await readFile(
      new URL("../../spikes/gemini/cli-probe.mjs", import.meta.url),
      "utf8",
    );
    const policy = await readFile(
      new URL("../../spikes/gemini/read-only-review.toml", import.meta.url),
      "utf8",
    );

    expect(script).not.toContain('"--yolo"');
    expect(script).toContain('"--admin-policy"');
    expect(script).toContain('"plan"');
    expect(policy).toContain('toolName = ["read_file", "read_many_files"]');
    expect(policy).toContain('toolName = "*"');
    expect(policy).toContain('decision = "deny"');
  });
});
