/**
 * C017: pure, I/O-free extraction of "failure key lines" from a raw GitHub Actions job log --
 * strips the per-line ISO-8601 timestamp prefix Actions always prepends, keeps only lines that
 * look failure-relevant (plus a little surrounding context), and enforces a hard byte cap so this
 * can never blow up the provider prompt it eventually feeds (ci-recovery.ts). See that file's own
 * header and adapters/github/ci-log-excerpt.ts for the full design note.
 */
import { describe, expect, it } from "vitest";

import {
  defaultCiFailureLogExcerptMaxBytes,
  extractFailureKeyLines,
} from "../../src/adapters/github/ci-log-excerpt.js";

function actionsLine(timestamp: string, text: string): string {
  return `${timestamp} ${text}`;
}

describe("extractFailureKeyLines", () => {
  it("keeps only lines near a failure keyword, stripped of their Actions timestamp prefix", () => {
    const log = [
      actionsLine("2026-08-08T01:21:20.0000000Z", "Run pnpm lint"),
      actionsLine("2026-08-08T01:21:20.1000000Z", "> eslint . --max-warnings 0"),
      actionsLine("2026-08-08T01:21:21.2000000Z", "  12:3  error  Unnecessary type parameter"),
      actionsLine("2026-08-08T01:21:21.3000000Z", "✖ 1 problem (1 error, 0 warnings)"),
      actionsLine("2026-08-08T01:21:22.4000000Z", "##[error]Process completed with exit code 1."),
      actionsLine("2026-08-08T01:21:23.5000000Z", "Cleaning up orphan processes"),
    ].join("\n");

    const result = extractFailureKeyLines(log);

    expect(result.truncated).toBe(false);
    expect(result.text).not.toContain("2026-08-08T");
    expect(result.text).toContain("12:3  error  Unnecessary type parameter");
    expect(result.text).toContain("Process completed with exit code 1.");
    // Unrelated setup noise far from any failure keyword must not be dragged in.
    expect(result.text).not.toContain("Run pnpm lint");
  });

  it("falls back to the log tail when no failure keyword is present at all", () => {
    const lines = Array.from({ length: 50 }, (_, index) =>
      actionsLine("2026-08-08T01:21:20.0000000Z", `step ${String(index)} ok`),
    );
    const result = extractFailureKeyLines(lines.join("\n"));

    expect(result.text).toContain("step 49 ok");
    expect(result.text).not.toContain("step 0 ok");
  });

  it("enforces a hard byte cap and marks the result truncated", () => {
    const log = Array.from(
      { length: 500 },
      (_, index) => `error: repeated failure line number ${String(index)}`,
    ).join("\n");

    const result = extractFailureKeyLines(log, 256);

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(256 + 64);
    expect(result.text).toContain("truncated");
  });

  it("uses the exported default cap when none is provided", () => {
    const log = Array.from({ length: 5_000 }, (_, index) => `error: line ${String(index)}`).join(
      "\n",
    );

    const result = extractFailureKeyLines(log);

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(
      defaultCiFailureLogExcerptMaxBytes + 64,
    );
  });

  it("merges overlapping context windows with a single ellipsis, not duplicate lines", () => {
    const log = ["error one", "context", "error two", "trailer"].join("\n");
    const result = extractFailureKeyLines(log);

    expect(result.text.match(/error one/gu)).toHaveLength(1);
    expect(result.text.match(/error two/gu)).toHaveLength(1);
  });
});
