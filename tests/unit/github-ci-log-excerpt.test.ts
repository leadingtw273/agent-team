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

  it("strips a leading UTF-8 BOM and ANSI SGR color codes before matching or output (C017b)", () => {
    const esc = "\x1b";
    const log = [
      `﻿2026-08-08T00:00:00.0000000Z ${esc}[32m✓${esc}[39m setup ok`,
      `2026-08-08T00:00:01.0000000Z [${esc}[33mwarn${esc}[39m] Code style issues found in 1 files.`,
      "2026-08-08T00:00:02.0000000Z ##[error]Process completed with exit code 1.",
    ].join("\n");

    const result = extractFailureKeyLines(log);

    expect(result.text).not.toContain(esc);
    expect(result.text).not.toMatch(/﻿/u);
    expect(result.text).toContain("[warn] Code style issues found in 1 files.");
    expect(result.text).toContain("##[error]Process completed with exit code 1.");
  });

  it("truncates on a UTF-8 character boundary, never producing a U+FFFD replacement character (C017b)", () => {
    // Every line is a multi-byte CJK failure line -- any naive byte-offset cut has a very high
    // chance of landing mid-codepoint unless boundary-aligned.
    const log = Array.from(
      { length: 400 },
      (_, index) => `error: 失敗した検証ケース番号${String(index)}メッセージ`,
    ).join("\n");

    const result = extractFailureKeyLines(log, 300);

    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain("�");
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(300 + 96);
  });
});

/**
 * C017b: `extractFailureKeyLines` is a diagnostic hint for a repair model, not a transcript --
 * this repo's own real CI failures proved the C017 heuristic missed that mark entirely (see
 * `/tmp/agent-team-c017b-packet.md`): 82%/62% of the excerpt was *passing* test names (this
 * repo names a lot of tests "fails closed"/"repairs failed CI", so the naive `/error|fail/iu`
 * heuristic lit up on green lines), the real failure was truncated away or never matched at all
 * (missing the vitest `×` glyph, prettier's `[warn]`/`Code style issues`), and the front-anchored
 * `truncate()` kept the *head* of a log whose failure is always at the *tail*.
 *
 * The two fixtures below are shaped after this repo's own real GitHub Actions job logs (ANSI SGR
 * color codes exactly as GitHub emits them, `YYYY-MM-DDTHH:MM:SS.fffffffZ ` per-line timestamps,
 * a leading UTF-8 BOM) -- not the raw 60 KB logs themselves, but representative excerpts of the
 * same shape, built here rather than fetched at test time so this suite stays hermetic.
 */
describe("extractFailureKeyLines effectiveness against real CI log shapes (C017b)", () => {
  const esc = "\x1b";
  function sgr(code: string, text: string): string {
    return `${esc}[${code}m${text}${esc}[0m`;
  }
  function actionsLine(timestamp: string, text: string): string {
    return `${timestamp} ${text}`;
  }
  function passLine(timestamp: string, name: string, tests: string, ms: string): string {
    return actionsLine(
      timestamp,
      ` ${sgr("32", "✓")} ${name} ${sgr("2", `(${tests})`)}${sgr("32", ` ${ms}ms`)}`,
    );
  }

  it("a prettier failure: keeps the [warn]/Code style issues/ELIFECYCLE/##[error] anchors, not the passing test names padding the log", () => {
    const noise = Array.from({ length: 60 }, (_, index) =>
      passLine(
        `2026-08-07T20:0${String(1 + Math.trunc(index / 30))}:${String(index % 60).padStart(2, "0")}.0000000Z`,
        `tests/unit/dispatch-resume-composition.test.ts > fails closed when attempt ${String(index)}`,
        "1 tests",
        "4",
      ),
    );
    const canary = actionsLine(
      "2026-08-07T20:02:00.0000000Z",
      ` ${sgr("32", "✓")} repairs failed CI on the same Worktree and Branch ${sgr("2", "(1 tests)")}${sgr("32", " 42ms")}`,
    );
    const failure = [
      actionsLine("2026-08-07T20:03:11.6989128Z", sgr("36;1", "pnpm format:check")),
      actionsLine(
        "2026-08-07T20:03:12.0196774Z",
        "> agent-team@0.1.0 format:check /home/runner/work/agent-team/agent-team",
      ),
      actionsLine("2026-08-07T20:03:12.0196774Z", "> prettier --check ."),
      actionsLine("2026-08-07T20:03:12.1076995Z", "Checking formatting..."),
      actionsLine(
        "2026-08-07T20:03:13.3195887Z",
        `[${sgr("33", "warn")}] src/adapters/git/local.ts`,
      ),
      actionsLine(
        "2026-08-07T20:03:13.4161759Z",
        `[${sgr("33", "warn")}] src/adapters/github/adapter.ts`,
      ),
      actionsLine(
        "2026-08-07T20:03:15.5968278Z",
        `[${sgr("33", "warn")}] src/cli/dispatch/handlers.ts`,
      ),
      actionsLine(
        "2026-08-07T20:03:20.9886529Z",
        `[${sgr("33", "warn")}] Code style issues found in 9 files. Run Prettier with --write to fix.`,
      ),
      actionsLine("2026-08-07T20:03:21.0877325Z", " ELIFECYCLE  Command failed with exit code 1."),
      actionsLine("2026-08-07T20:03:21.1256665Z", "##[error]Process completed with exit code 1."),
    ];
    const log = `﻿${[...noise, canary, ...noise, ...failure].join("\n")}`;

    const result = extractFailureKeyLines(log);

    // The real failure reason must survive -- this is the entire point of the ticket.
    expect(result.text).toContain("Code style issues found in 9 files");
    expect(result.text).toContain("ELIFECYCLE");
    expect(result.text).toContain("Command failed with exit code 1");
    expect(result.text).toContain("##[error]Process completed with exit code 1");
    expect(result.text).toContain("[warn] src/adapters/git/local.ts");
    // No ANSI escape byte and no GitHub timestamp prefix must leak into the prompt.
    expect(result.text).not.toContain(esc);
    expect(result.text).not.toMatch(/2026-08-07T/u);
    // The misleading canary line -- a *passing* test literally named after failure recovery --
    // must not appear at all: it is exactly what pointed a repair model at the wrong target.
    expect(result.text).not.toContain("repairs failed CI on the same Worktree and Branch");
    // Passing test names must not dominate the budget: count surviving lines that look like a
    // passing vitest line (a checkmark or leading "fails closed"-style name with no real anchor)
    // against total non-empty lines actually kept.
    const keptLines = result.text.split("\n").filter((line) => line.trim().length > 0);
    const passingLines = keptLines.filter((line) => /✓|✔|PASS/u.test(line));
    expect(passingLines.length / keptLines.length).toBeLessThanOrEqual(0.1);
  });

  it("a single failing vitest test: keeps the × failure and its AssertionError/Expected/Received detail, not truncated away by a wall of earlier passing tests", () => {
    const noise = Array.from({ length: 80 }, (_, index) =>
      passLine(
        `2026-08-08T01:1${String(Math.trunc(index / 60))}:${String(index % 60).padStart(2, "0")}.0000000Z`,
        `tests/unit/registration-setup.test.ts > fails closed when the transport is missing (case ${String(index)})`,
        "1 tests",
        "2",
      ),
    );
    const failure = [
      actionsLine(
        "2026-08-08T01:12:10.0000000Z",
        ` ${sgr("31", "❯")} tests/unit/ci-log-excerpt-effectiveness.test.ts ${sgr("2", "(6 tests | 1 failed)")}`,
      ),
      actionsLine(
        "2026-08-08T01:12:10.1000000Z",
        `   ${sgr("31", "×")} drops the multibyte boundary safely ${sgr("2", "3ms")}`,
      ),
      actionsLine(
        "2026-08-08T01:12:10.2000000Z",
        `     ${sgr("31", "AssertionError")}: expected 'available' to be false`,
      ),
      actionsLine("2026-08-08T01:12:10.3000000Z", `     ${sgr("32", "- Expected")}`),
      actionsLine("2026-08-08T01:12:10.4000000Z", `     ${sgr("31", "+ Received")}`),
      actionsLine("2026-08-08T01:12:10.5000000Z", "     Expected: false"),
      actionsLine("2026-08-08T01:12:10.6000000Z", "     Received: true"),
      actionsLine("2026-08-08T01:12:12.0000000Z", " Test Files  1 failed | 244 passed (245)"),
      actionsLine("2026-08-08T01:12:12.1000000Z", "      Tests  1 failed | 3120 passed (3121)"),
      actionsLine("2026-08-08T01:12:13.0000000Z", "##[error]Process completed with exit code 1."),
    ];
    const log = `﻿${[...noise, ...failure].join("\n")}`;

    const result = extractFailureKeyLines(log);

    expect(result.text).toContain("drops the multibyte boundary safely");
    expect(result.text).toContain("AssertionError");
    expect(result.text).toContain("Expected: false");
    expect(result.text).toContain("Received: true");
    expect(result.text).toContain("##[error]Process completed with exit code 1");
    expect(result.text).not.toContain(esc);
    expect(result.text).not.toMatch(/2026-08-08T/u);
    const keptLines = result.text.split("\n").filter((line) => line.trim().length > 0);
    const passingLines = keptLines.filter((line) => /✓|✔|PASS/u.test(line));
    expect(passingLines.length / keptLines.length).toBeLessThanOrEqual(0.1);
  });
});
