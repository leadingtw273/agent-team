/**
 * E118a: unit tests for the case vocabulary itself (`e118-case.ts`) -- no scanning, no sinks, just
 * "does the schema accept a well-formed case and reject the malformed/contradictory shapes it
 * must reject". `e118-validator.test.ts` covers the scanning behavior; this file only covers the
 * case/sink schema contract those tests (and later E118b) rely on.
 */
import { describe, expect, it } from "vitest";

import {
  e118InjectionCaseSchema,
  e118SinkKinds,
  e118SinkSchema,
  type E118InjectionCase,
} from "./e118-case.js";
import {
  buildFixtureCase,
  fixtureCanary,
  fixtureFakeTokens,
  fixtureRunIdentity,
} from "./e118-fixtures.js";

describe("e118InjectionCaseSchema", () => {
  it("accepts a well-formed case (fixture hygiene)", () => {
    const parsed = buildFixtureCase();
    expect(parsed.canary).toBe(fixtureCanary);
    expect(parsed.fakeTokens).toEqual(fixtureFakeTokens);
  });

  it("rejects an unexpected extra top-level field", () => {
    const tampered = { ...buildFixtureCase(), extraField: "nope" } as unknown as E118InjectionCase;
    expect(() => e118InjectionCaseSchema.parse(tampered)).toThrow();
  });

  it("rejects when allowedSinkKinds and deniedSinkKinds overlap", () => {
    expect(() =>
      e118InjectionCaseSchema.parse({
        runIdentity: fixtureRunIdentity(),
        canary: fixtureCanary,
        fakeTokens: fixtureFakeTokens,
        allowedSinkKinds: ["linear_comment"],
        deniedSinkKinds: ["linear_comment"],
      }),
    ).toThrow();
  });

  it("rejects a duplicate fakeTokens literal", () => {
    expect(() =>
      e118InjectionCaseSchema.parse({
        runIdentity: fixtureRunIdentity(),
        canary: fixtureCanary,
        fakeTokens: [fixtureFakeTokens[0], fixtureFakeTokens[0]],
        allowedSinkKinds: [],
        deniedSinkKinds: [],
      }),
    ).toThrow();
  });

  it("rejects a canary that also appears in fakeTokens (must be a distinct marker)", () => {
    expect(() =>
      e118InjectionCaseSchema.parse({
        runIdentity: fixtureRunIdentity(),
        canary: fixtureFakeTokens[0],
        fakeTokens: fixtureFakeTokens,
        allowedSinkKinds: [],
        deniedSinkKinds: [],
      }),
    ).toThrow();
  });

  it("rejects a canary containing whitespace or JSON-breaking syntax", () => {
    for (const badCanary of ['{"canary":"x"}', "has space", "line\nbreak"]) {
      expect(() =>
        e118InjectionCaseSchema.parse({
          runIdentity: fixtureRunIdentity(),
          canary: badCanary,
          fakeTokens: fixtureFakeTokens,
          allowedSinkKinds: [],
          deniedSinkKinds: [],
        }),
      ).toThrow();
    }
  });

  it("rejects an unknown sink kind in either list", () => {
    expect(() =>
      e118InjectionCaseSchema.parse({
        runIdentity: fixtureRunIdentity(),
        canary: fixtureCanary,
        fakeTokens: fixtureFakeTokens,
        allowedSinkKinds: ["not_a_real_sink"],
        deniedSinkKinds: [],
      }),
    ).toThrow();
  });

  it("accepts a case naming a sink kind in neither list (out of scope for that case)", () => {
    const parsed = e118InjectionCaseSchema.parse({
      runIdentity: fixtureRunIdentity(),
      canary: fixtureCanary,
      fakeTokens: fixtureFakeTokens,
      allowedSinkKinds: ["provider_job_event"],
      deniedSinkKinds: ["linear_comment"],
    });
    const namedKinds = new Set([...parsed.allowedSinkKinds, ...parsed.deniedSinkKinds]);
    expect(e118SinkKinds.some((kind) => !namedKinds.has(kind))).toBe(true);
  });
});

describe("e118SinkSchema", () => {
  it("rejects a sink with an extra field", () => {
    expect(() =>
      e118SinkSchema.parse({
        kind: "linear_comment",
        sinkId: "s1",
        content: "hello",
        extra: "nope",
      }),
    ).toThrow();
  });

  it("rejects an empty sinkId", () => {
    expect(() =>
      e118SinkSchema.parse({ kind: "linear_comment", sinkId: "", content: "hello" }),
    ).toThrow();
  });
});
