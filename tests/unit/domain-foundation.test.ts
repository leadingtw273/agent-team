import { describe, expect, it } from "vitest";

import {
  createClock,
  createFixedClock,
  domainError,
  domainErrorDefinitions,
  err,
  flatMapResult,
  generateIdentifier,
  mapResult,
  ok,
  parseIdentifier,
  parseInstant,
  serializeDomainError,
  type Result,
} from "../../src/domain/foundation/index.js";

const fixedUuid = "018f47d2-77a4-7cc1-8ef2-0123456789ab";
const fixedInstantText = "2026-08-04T13:00:00.000Z";

describe("domain foundation", () => {
  it("generates and parses scoped identifiers with stable string serialization", () => {
    const generated = generateIdentifier("job", () => fixedUuid.toUpperCase());

    expect(generated).toEqual({ ok: true, value: `job_${fixedUuid}` });
    if (!generated.ok) throw new Error("expected identifier generation to succeed");
    expect(parseIdentifier("job", generated.value)).toEqual(generated);
    expect(JSON.stringify({ id: generated.value })).toBe(`{"id":"job_${fixedUuid}"}`);
  });

  it.each([
    ["invalid scope", "BadScope", `BadScope_${fixedUuid}`],
    ["wrong scope", "job", `issue_${fixedUuid}`],
    ["non-UUID value", "job", "job_not-a-uuid"],
  ])("rejects %s", (_name, scope, value) => {
    expect(parseIdentifier(scope, value)).toEqual({
      ok: false,
      error: domainError("invalid_identifier"),
    });
  });

  it("normalizes time at the boundary and supports injected clocks", () => {
    const parsed = parseInstant(fixedInstantText);
    expect(parsed).toEqual({ ok: true, value: fixedInstantText });
    if (!parsed.ok) throw new Error("expected instant parsing to succeed");

    const injected = createClock(() => new Date(fixedInstantText));
    const fixed = createFixedClock(parsed.value);
    expect(injected.now()).toBe(fixedInstantText);
    expect(fixed.now()).toBe(fixedInstantText);
  });

  it.each(["2026-08-04", "2026-08-04T13:00:00Z", "not-a-date"])(
    "rejects non-canonical instant %s",
    (value) => {
      expect(parseInstant(value)).toEqual({
        ok: false,
        error: domainError("invalid_instant"),
      });
    },
  );

  it("maps successful results without invoking transforms on failures", () => {
    const failure: Result<number, "blocked"> = err("blocked");
    let invoked = false;

    expect(mapResult(ok(2), (value) => value * 3)).toEqual({ ok: true, value: 6 });
    expect(flatMapResult(ok(2), (value) => (value > 0 ? ok(value + 1) : err("invalid")))).toEqual({
      ok: true,
      value: 3,
    });
    expect(
      mapResult(failure, () => {
        invoked = true;
        return 0;
      }),
    ).toBe(failure);
    expect(invoked).toBe(false);
  });

  it("serializes only predefined, secret-free domain errors", () => {
    const allowedKeys = ["kind", "code", "category", "message", "retryable"];
    const errors = Object.keys(domainErrorDefinitions).map((code) =>
      domainError(code as keyof typeof domainErrorDefinitions),
    );
    const serialized = errors.map(serializeDomainError);

    expect(serialized).toHaveLength(12);
    for (const error of errors) expect(Object.keys(error)).toEqual(allowedKeys);
    for (const value of serialized) {
      const parsed = JSON.parse(value) as unknown;
      expect(parsed).toBeTypeOf("object");
      expect(Object.keys(parsed as Record<string, unknown>)).toEqual(allowedKeys);
    }
    expect(JSON.parse(serialized[0] ?? "{}")).toEqual({
      kind: "domain_error",
      code: "invalid_identifier",
      category: "validation",
      message: "The identifier is invalid.",
      retryable: false,
    });
    expect(Object.isFrozen(domainError("timeout"))).toBe(true);
  });
});
