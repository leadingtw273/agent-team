/**
 * E118a positive control: this is the test that proves `assertNoCanaryLeak` is not a rubber
 * stamp. Per sink kind, per leak shape (canary marker, and each Redactor-supported fake-token
 * shape this ticket is scoped to), a mutation fixture that actually carries the leak must fail
 * that exact sink's rule -- and every other sink's rule must stay green. A clean scan (no
 * mutation) must report `overall: "pass"` with every rule passing. Without this file, a validator
 * that always returned `overall: "pass"` would look identical to a working one on the happy path
 * alone -- exactly the failure mode the task's own design decision (a validator must have a red
 * case, not just a green one) exists to catch.
 */
import { describe, expect, it } from "vitest";

import { containsSensitiveValue } from "../../../src/infrastructure/redaction/index.js";
import { e118SinkKinds, type E118Sink, type E118SinkKind } from "./e118-case.js";
import {
  buildCleanSinks,
  buildFixtureCase,
  buildSinksWithImperativeButNoLeak,
  buildSinksWithLeak,
  fixtureCanary,
  fixtureFakeTokens,
} from "./e118-fixtures.js";
import { assertNoCanaryLeak, e118LeakRuleIds, type E118LeakScanReport } from "./e118-validator.js";

function finding(report: E118LeakScanReport, kind: E118SinkKind) {
  const found = report.findings.find((candidate) => candidate.sinkKind === kind);
  if (found === undefined) throw new Error(`no finding for sink kind ${kind}`);
  return found;
}

function otherSinksStillPass(report: E118LeakScanReport, leakingKind: E118SinkKind): void {
  for (const result of report.findings) {
    if (result.sinkKind === leakingKind) continue;
    expect(result.status, `expected ${result.sinkKind} to still pass`).toBe("pass");
    expect(result.reasonCode).toBe("ok");
  }
}

const testCase = buildFixtureCase();
const markers = { canary: testCase.canary, fakeTokens: testCase.fakeTokens };

describe("assertNoCanaryLeak: happy path", () => {
  it("reports overall pass, one rule per sink kind in a fixed order, when every sink is clean", () => {
    const report = assertNoCanaryLeak(buildCleanSinks(), markers);

    expect(report.schemaVersion).toBe(1);
    expect(report.overall).toBe("pass");
    expect(report.findings.map((result) => result.ruleId)).toEqual([...e118LeakRuleIds]);
    for (const result of report.findings) {
      expect(result.status).toBe("pass");
      expect(result.reasonCode).toBe("ok");
    }
  });

  it("does not false-positive on hostile imperative language that carries no canary or fake token", () => {
    const report = assertNoCanaryLeak(buildSinksWithImperativeButNoLeak(), markers);

    expect(report.overall).toBe("pass");
    for (const result of report.findings) expect(result.status).toBe("pass");
  });
});

describe("assertNoCanaryLeak: canary leak (positive control, 每個 sink 必紅)", () => {
  it.each(e118SinkKinds)(
    "fails exactly %s's rule when that sink carries the canary marker",
    (kind) => {
      const sinks = buildSinksWithLeak(kind, { canary: fixtureCanary });

      const report = assertNoCanaryLeak(sinks, markers);

      expect(report.overall).toBe("fail");
      expect(finding(report, kind)).toMatchObject({
        ruleId: `${kind}_no_leak`,
        status: "fail",
        reasonCode: "canary_leak",
      });
      otherSinksStillPass(report, kind);
    },
  );
});

describe("assertNoCanaryLeak: fake token leak (positive control, 每個 sink × 每種 token 必紅)", () => {
  for (const [tokenLabel, token] of [
    ["ghp_", fixtureFakeTokens[0]],
    ["github_pat_", fixtureFakeTokens[1]],
    ["sk-", fixtureFakeTokens[2]],
  ] as const) {
    it.each(e118SinkKinds)(
      `fails exactly %s's rule when that sink carries a ${tokenLabel}-shaped fake token`,
      (kind) => {
        const sinks = buildSinksWithLeak(kind, { fakeToken: token });

        const report = assertNoCanaryLeak(sinks, markers);

        expect(report.overall).toBe("fail");
        expect(finding(report, kind)).toMatchObject({
          ruleId: `${kind}_no_leak`,
          status: "fail",
          reasonCode: "fake_token_leak",
        });
        otherSinksStillPass(report, kind);
      },
    );
  }
});

describe("assertNoCanaryLeak: dual leak precedence", () => {
  it("reports canary_leak, not fake_token_leak, when one sink carries both", () => {
    const sinks: readonly E118Sink[] = buildCleanSinks().map((sink) =>
      sink.kind === "linear_comment"
        ? { ...sink, content: `${sink.content} ${fixtureCanary} ${fixtureFakeTokens[0]}` }
        : sink,
    );

    const report = assertNoCanaryLeak(sinks, markers);

    expect(finding(report, "linear_comment")).toMatchObject({
      status: "fail",
      reasonCode: "canary_leak",
    });
  });
});

describe("assertNoCanaryLeak: tampered input rejected by schema", () => {
  it("throws when a sink carries an unexpected extra field", () => {
    const tampered = buildCleanSinks().map((sink, index) =>
      index === 0 ? { ...sink, extraField: "not part of the schema" } : sink,
    ) as unknown as readonly E118Sink[];

    expect(() => assertNoCanaryLeak(tampered, markers)).toThrow();
  });

  it("throws when the markers object carries an unexpected extra field", () => {
    const tamperedMarkers = { ...markers, extraField: "not part of the schema" };

    expect(() => assertNoCanaryLeak(buildCleanSinks(), tamperedMarkers)).toThrow();
  });

  it("throws when canary is an empty string (an unbounded/no-op marker would make every scan vacuously pass)", () => {
    expect(() =>
      assertNoCanaryLeak(buildCleanSinks(), { canary: "", fakeTokens: markers.fakeTokens }),
    ).toThrow();
  });

  it("throws when fakeTokens is empty", () => {
    expect(() =>
      assertNoCanaryLeak(buildCleanSinks(), { canary: fixtureCanary, fakeTokens: [] }),
    ).toThrow();
  });
});

describe("fixture hygiene: fake tokens are real Redactor-recognized shapes", () => {
  it("every fixture fake token is a shape the shared Redactor actually recognizes as sensitive", () => {
    for (const token of fixtureFakeTokens) expect(containsSensitiveValue(token)).toBe(true);
  });

  it("the canary marker itself is not, by shape alone, something the shared Redactor would mask", () => {
    // Deliberate: the canary tests structural leakage (did it escape to a sink at all), not
    // masking. If this ever started failing, the canary fixture would no longer be exercising
    // what this ticket's design intends -- masking is the fake tokens' job, not the canary's.
    expect(containsSensitiveValue(fixtureCanary)).toBe(false);
  });
});
