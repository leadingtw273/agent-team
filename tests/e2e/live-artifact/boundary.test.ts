import { describe, expect, it } from "vitest";

import { hasSafeDataShape } from "./boundary.js";
import { parseArtifact, safeAuthorityRead } from "./schema.js";
import { z } from "zod";

describe("T09 raw boundary", () => {
  it("rejects own prototype keys, custom/null prototypes, symbols, getters, and cycles without invoking getters", () => {
    const ownProto = JSON.parse('{"__proto__":{"polluted":true}}') as unknown;
    const descriptorProto: Record<string, unknown> = {};
    Object.defineProperty(descriptorProto, "__proto__", { value: {}, enumerable: true });
    const getter = {} as Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(getter, "secret", {
      enumerable: true,
      get: () => {
        reads += 1;
        return "no";
      },
    });
    const symbol = { [Symbol("hidden")]: true };
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    for (const value of [
      ownProto,
      descriptorProto,
      { constructor: {} },
      { prototype: {} },
      Object.create(null),
      Object.create({}),
      getter,
      symbol,
      cyclic,
    ])
      expect(hasSafeDataShape(value)).toBe(false);
    expect(reads).toBe(0);
  });

  it("maps hostile and malformed authority results to fixed parse failures", async () => {
    const schema = z.object({ value: z.string() }).strict();
    for (const hostile of [
      null,
      "primitive",
      1,
      [],
      { state: "wat", value: {} },
      { state: "missing", reasonCode: "wat" },
      { state: "present", value: { value: "ok" }, extra: true },
      { state: "present", value: { value: "ok", extra: true } },
      JSON.parse('{"__proto__":{}}') as unknown,
    ]) {
      await expect(safeAuthorityRead(schema, Promise.resolve(hostile))).resolves.toEqual({
        state: "missing",
        reasonCode: "parse_failed",
      });
    }
    await expect(safeAuthorityRead(schema, Promise.resolve({ ok: false }))).resolves.toEqual({
      state: "missing",
      reasonCode: "read_failed",
    });
    await expect(
      safeAuthorityRead(schema, Promise.resolve({ state: "missing", reasonCode: "not_found" })),
    ).resolves.toEqual({ state: "missing", reasonCode: "not_found" });
    await expect(
      safeAuthorityRead(schema, Promise.reject(new Error("canary-provider-error"))),
    ).resolves.toEqual({ state: "missing", reasonCode: "read_failed" });
    expect(parseArtifact(JSON.parse('{"__proto__":{}}'))).toBeUndefined();
  });
});
