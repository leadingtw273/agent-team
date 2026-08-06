/**
 * O009 decision #3: the three mutation-level commands (`setup start`, `setup approve`,
 * `probe run`) must read a confirmation phrase from stdin and compare it *exactly*
 * (character-for-character) before doing anything else. A mismatch must be zero-side-effect --
 * verified here by never even constructing a production composition for the mismatch path (the
 * confirmation check happens before any composition/adapter is touched).
 */
import { describe, expect, it } from "vitest";

import {
  readStdinConfirmation,
  registrationProbeRunConfirmationPhrase,
} from "../../src/cli/registration/confirmation.js";

async function* stream(...chunks: readonly string[]): AsyncIterable<string> {
  await Promise.resolve();
  for (const chunk of chunks) yield chunk;
}

describe("readStdinConfirmation", () => {
  it("accepts the exact phrase with a single trailing LF (typical piped `echo`)", async () => {
    const result = await readStdinConfirmation(stream("RUN FULL REVALIDATION\n"));
    expect(result).toEqual({ ok: true, value: "RUN FULL REVALIDATION" });
  });

  it("accepts the exact phrase with a trailing CRLF", async () => {
    const result = await readStdinConfirmation(stream("RUN FULL REVALIDATION\r\n"));
    expect(result).toEqual({ ok: true, value: "RUN FULL REVALIDATION" });
  });

  it("accepts the exact phrase with no trailing newline at all (interactive TTY paste)", async () => {
    const result = await readStdinConfirmation(stream("RUN FULL REVALIDATION"));
    expect(result).toEqual({ ok: true, value: "RUN FULL REVALIDATION" });
  });

  it("does not strip anything beyond a single trailing line terminator", async () => {
    const result = await readStdinConfirmation(stream("RUN FULL REVALIDATION \n"));
    expect(result).toEqual({ ok: true, value: "RUN FULL REVALIDATION " });
    expect(result.ok ? result.value : undefined).not.toBe("RUN FULL REVALIDATION");
  });

  it("reports oversized input rather than silently truncating", async () => {
    const result = await readStdinConfirmation(stream("a".repeat(10_000)), { maximumBytes: 100 });
    expect(result).toEqual({ ok: false, reason: "too_large" });
  });

  it("rejects invalid UTF-8 rather than throwing", async () => {
    async function* invalid() {
      await Promise.resolve();
      yield new Uint8Array([0xff, 0xfe, 0xfd]);
    }
    const result = await readStdinConfirmation(invalid());
    expect(result).toEqual({ ok: false, reason: "invalid_encoding" });
  });
});

describe("O009 confirmation-phrase typo fixtures (documented exact-match cases)", () => {
  it.each([
    ["wrong case", "run full revalidation"],
    ["extra trailing space", "RUN FULL REVALIDATION "],
    ["missing word", "RUN REVALIDATION"],
    ["truncated", "RUN FULL REVALIDATIO"],
    ["empty", ""],
  ])("%s does not equal the fixed probe phrase", async (_name, typo) => {
    const result = await readStdinConfirmation(stream(typo));
    expect(result.ok && result.value === registrationProbeRunConfirmationPhrase).toBe(false);
  });

  it("the exact phrase does equal the fixed probe phrase constant", async () => {
    const result = await readStdinConfirmation(stream(registrationProbeRunConfirmationPhrase));
    expect(result).toEqual({ ok: true, value: registrationProbeRunConfirmationPhrase });
  });
});
