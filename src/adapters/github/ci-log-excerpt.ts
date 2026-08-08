/**
 * C017/C017b: pure, I/O-free extraction of "failure key lines" out of a raw GitHub Actions job log
 * (`GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs`, plain text, one line per timestamped
 * entry -- see `adapter.ts`'s `getFailedCheckLogExcerpts` for the only caller). CI-recovery was
 * previously blind to *why* CI failed (only check name/status/conclusion/URL reached the repair
 * prompt, never a single log line) -- this closes that gap while staying strictly bounded:
 *
 * - A job log can be megabytes; the repair prompt budget is not. This module never returns more
 *   than `maxBytes` (default `defaultCiFailureLogExcerptMaxBytes`, 4 KiB -- deliberately small:
 *   this is a diagnostic hint for the repair model, not a transcript, and it competes for space
 *   inside `buildProviderJobContext`'s own multi-MB context budget alongside the requirement
 *   snapshot, project rules, and any other external data).
 *
 * C017b rewrite -- C017's original heuristic (a single `/error|fail|.../iu` line-or-nothing pass,
 * front-truncated) was proven ineffective against this repository's own real failing CI logs
 * (see `/tmp/agent-team-c017b-packet.md`): 82%/62% of the excerpt was *passing* test names (this
 * codebase names a great many tests "fails closed"/"repairs failed ..."), the real failure was
 * either truncated away (a job log's failure is always near the *tail*, but the old `truncate()`
 * kept the *head*) or never matched at all (missing vitest's `×` U+00D7 glyph; prettier's
 * `[warn]`/`Code style issues` contain neither "error" nor "fail"). The design now is two-phase:
 *
 * 1. **Tool-anchor phase** (`anchorPatterns` below): line-level patterns that are specific enough
 *    to real CI-tool failure output (`##[error]`, `ELIFECYCLE`, vitest's `×`, prettier's `[warn] `,
 *    TypeScript's `error TS\d+`, ...) that they essentially never fire on a passing test's own
 *    name. Scanned from the **tail of the log backward** -- the most recent (and therefore most
 *    relevant) occurrence of each anchor category wins -- with a small per-category repeat cap so
 *    one anchor type (e.g. a long wall of `×` lines) cannot alone crowd out every other category.
 * 2. **General heuristic phase**: only fills whatever budget the anchor phase left, using the
 *    original broad `error|fail|exception` pattern, but explicitly excluding lines that open with
 *    a success marker (`✓`, `✔`, `PASS`) even when they otherwise contain "fail" (that misleading
 *    case -- a *passing* test named after failure recovery -- is exactly what pointed a repair
 *    model at the wrong target in the real log this ticket was filed against). This phase never
 *    removes or overwrites anything the anchor phase already selected.
 *
 * Selected lines are always rendered back in original (ascending, chronological) order for
 * readability; only *which* lines get selected favors the tail. Final byte-budget enforcement
 * (`truncateKeepingTail`) also keeps the tail -- cutting from the front, never the back -- and
 * character-boundary-aligns the cut so a multi-byte UTF-8 sequence is never split (no `U+FFFD`).
 *
 * ANSI SGR escape sequences and a leading UTF-8 BOM are stripped before anything else -- GitHub's
 * raw log bytes carry both (color codes for `[warn]`/`✓`/`×` throughout, a BOM on the very first
 * byte of the stream) -- so neither ever eats into the byte budget or breaks a pattern match that
 * assumes contiguous plain text (e.g. `[warn] ` split across an SGR code becomes `[` + escape +
 * `warn` + escape + `] ` in the raw bytes).
 *
 * GitHub Actions also prepends a `YYYY-MM-DDTHH:MM:SS.ffffffffZ ` timestamp to every log line;
 * that prefix is pure noise for a repair model and is stripped before matching/output.
 *
 * This is still a heuristic, not a parser: it has no notion of eslint/tsc/vitest-specific output
 * grammar (each has its own, and a new CI tool arrives eventually anyway) -- when *no* line
 * matches anything (a job can still exit non-zero -- and therefore fail its check run -- without
 * ever printing one of these words/glyphs), this falls back to the log's tail rather than nothing.
 */

export const defaultCiFailureLogExcerptMaxBytes = 4_096;

/** Deliberately generous relative to `maxBytes` (truncation still applies) -- keeps the fallback
 * cheap even for a very long "everything printed 'OK'" log. */
const fallbackTailLines = 40;
/** Lines kept around a matched key line: this many before it, this many after. */
const contextLinesBefore = 1;
const contextLinesAfter = 2;
/** Caps how many anchor hits of the *same* category the anchor phase will select (each with its
 * own context window) -- without this, a long run of one repeated anchor (e.g. a wall of vitest
 * `×` lines) could alone consume the whole budget and crowd out every other failure signal. */
const maxAnchorHitsPerCategory = 4;
/** The anchor phase is allowed to over-select relative to `maxBytes` -- final truncation always
 * keeps the byte-wise *tail* of the rendered (ascending-order) selection, which -- because anchor
 * selection itself walks from the log's tail backward -- already favors the most recent anchors of
 * each category. This multiplier just bounds how much scanning/selection work happens before that
 * backstop kicks in; it is not itself a hard content guarantee. */
const anchorPhaseBudgetMultiplier = 3;

const timestampPrefixPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/u;
const bomPattern = /^﻿/u;
/** Matches GitHub Actions' raw ANSI SGR sequences (`\x1b[<params>m`), the only escape family its
 * job logs actually emit (terminal color codes for `[warn]`/`✓`/`×`/etc). */
const ansiSgrPattern = /\x1b\[[0-9;]*m/gu;
/** General fallback heuristic (unchanged from C017): broad, cheap, and deliberately generic --
 * the two-phase design above only lets this phase fill *leftover* budget after tool anchors. */
const keyLinePattern = /error|fail|exception|✖|✗/iu;
/** A line opening with one of these must never be selected by the general heuristic phase, even
 * if it otherwise contains "fail"/"error" -- this repo's own tests are named "fails closed", and a
 * *passing* one of those is exactly the misleading signal C017's real-log failure demonstrated. */
const successPrefixPattern = /^\s*(?:✓|✔|PASS\b)/u;

interface AnchorPattern {
  readonly category: string;
  readonly pattern: RegExp;
}

/** Line-level, tool-specific failure anchors -- see this module's header for why these are safe
 * against false-positiving on this repo's own (very failure-word-heavy) passing test names. Order
 * only matters for which category a line lands in when a line happens to match more than one. */
const anchorPatterns: readonly AnchorPattern[] = [
  { category: "gha_error", pattern: /##\[error\]/u },
  { category: "elifecycle", pattern: /ELIFECYCLE/u },
  { category: "fail_marker", pattern: /FAIL /u },
  { category: "failed_tests", pattern: /Failed Tests/u },
  { category: "ts_error", pattern: /error TS\d/u },
  { category: "heavy_ballot_x", pattern: /✖/u },
  { category: "multiplication_x", pattern: /×/u },
  { category: "warn_bracket", pattern: /\[warn\] /u },
  { category: "code_style_issues", pattern: /Code style issues/u },
  { category: "npm_err", pattern: /npm ERR!/u },
  { category: "pnpm_err", pattern: /ERR_PNPM_/u },
  { category: "assertion_error", pattern: /AssertionError/u },
  { category: "expected_value", pattern: /Expected:/u },
  { category: "received_value", pattern: /Received:/u },
  { category: "exit_code", pattern: /Process completed with exit code/u },
];

function stripAnsiAndBom(text: string): string {
  return text.replace(bomPattern, "").replace(ansiSgrPattern, "");
}

function stripTimestamp(line: string): string {
  return line.replace(timestampPrefixPattern, "");
}

function classifyAnchor(line: string): string | undefined {
  for (const { category, pattern } of anchorPatterns) {
    if (pattern.test(line)) return category;
  }
  return undefined;
}

function contextIndexes(index: number, lineCount: number): number[] {
  const result: number[] = [];
  for (let offset = -contextLinesBefore; offset <= contextLinesAfter; offset += 1) {
    const target = index + offset;
    if (target >= 0 && target < lineCount) result.push(target);
  }
  return result;
}

function estimatedBytes(lines: readonly string[], indexes: ReadonlySet<number>): number {
  let total = 0;
  for (const index of indexes) total += Buffer.byteLength(lines[index] ?? "", "utf8") + 1;
  return total;
}

/**
 * Phase 1: walks the log from its last line backward, selecting tool-anchor lines (plus their
 * small context window) -- capped per anchor category (`maxAnchorHitsPerCategory`) so one anchor
 * type cannot alone exhaust the budget, and capped overall by a generous multiple of `maxBytes`
 * (`anchorPhaseBudgetMultiplier`) as a scanning backstop, not a precise content guarantee (final
 * truncation is what actually enforces `maxBytes`, and it too keeps the tail -- see module header).
 */
function selectAnchorIndexes(lines: readonly string[], maxBytes: number): Set<number> {
  const selected = new Set<number>();
  const hitsPerCategory = new Map<string, number>();
  const budgetCeiling = Math.max(maxBytes, 1) * anchorPhaseBudgetMultiplier;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const category = classifyAnchor(lines[index] ?? "");
    if (category === undefined) continue;
    const hits = hitsPerCategory.get(category) ?? 0;
    if (hits >= maxAnchorHitsPerCategory) continue;
    hitsPerCategory.set(category, hits + 1);
    for (const target of contextIndexes(index, lines.length)) selected.add(target);
    if (estimatedBytes(lines, selected) >= budgetCeiling) break;
  }
  return selected;
}

/**
 * Phase 2: fills only whatever budget phase 1 left, using the broad `error|fail|exception|✖|✗`
 * heuristic -- excluding success-prefixed lines (see `successPrefixPattern`) and never selecting
 * (or overwriting) anything phase 1 already chose. Also walks tail-to-head, for the same "most
 * recent occurrence wins" reasoning as phase 1.
 */
function selectHeuristicIndexes(
  lines: readonly string[],
  already: ReadonlySet<number>,
  maxBytes: number,
): Set<number> {
  const selected = new Set<number>();
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (already.has(index) || selected.has(index)) continue;
    const line = lines[index] ?? "";
    if (successPrefixPattern.test(line)) continue;
    if (!keyLinePattern.test(line)) continue;
    for (const target of contextIndexes(index, lines.length)) {
      if (!already.has(target)) selected.add(target);
    }
    const combinedEstimate = estimatedBytes(lines, selected) + estimatedBytes(lines, already);
    if (combinedEstimate >= maxBytes) break;
  }
  return selected;
}

function tailIndexes(lineCount: number): number[] {
  const size = Math.min(lineCount, fallbackTailLines);
  return Array.from({ length: size }, (_, index) => lineCount - size + index);
}

function renderSelection(lines: readonly string[], indexes: readonly number[]): string {
  const segments: string[] = [];
  let previous: number | undefined;
  for (const index of indexes) {
    if (previous !== undefined && index > previous + 1) segments.push("...");
    const line = lines[index];
    if (line !== undefined) segments.push(line);
    previous = index;
  }
  return segments.join("\n");
}

/**
 * Keeps only the byte-wise *tail* of `text`, aligned to a UTF-8 character boundary so a
 * multi-byte sequence is never split (which would otherwise decode as `U+FFFD` replacement
 * characters). Alignment works by treating any byte in `0x80..0xBF` (a UTF-8 continuation byte) at
 * the cut point as mid-sequence and advancing past it -- since `text` originated from a valid JS
 * string, the bytes from the first non-continuation byte onward always re-decode cleanly.
 */
function truncateKeepingTail(
  text: string,
  maxBytes: number,
): { readonly kept: string; readonly droppedBytes: number; readonly originalBytes: number } {
  const buffer = Buffer.from(text, "utf8");
  const originalBytes = buffer.length;
  const bound = Math.max(0, maxBytes);
  if (originalBytes <= bound) return { kept: text, droppedBytes: 0, originalBytes };
  let start = originalBytes - bound;
  while (start < originalBytes && ((buffer[start] ?? 0) & 0xc0) === 0x80) start += 1;
  return { kept: buffer.subarray(start).toString("utf8"), droppedBytes: start, originalBytes };
}

export interface CiFailureLogExcerptResult {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Extracts, at most, `maxBytes` worth of failure-relevant lines from `logText`. Never throws --
 * `logText` is fully untrusted external content (see `ci-recovery.ts`'s own external-data boundary
 * for how the result is handed to the repair model) -- and always returns a result, even for an
 * empty or entirely benign-looking log.
 */
export function extractFailureKeyLines(
  logText: string,
  maxBytes: number = defaultCiFailureLogExcerptMaxBytes,
): CiFailureLogExcerptResult {
  const cleaned = stripAnsiAndBom(logText);
  const lines = cleaned.split(/\r?\n/u).map(stripTimestamp);
  const anchorSelected = selectAnchorIndexes(lines, maxBytes);
  const heuristicSelected = selectHeuristicIndexes(lines, anchorSelected, maxBytes);
  const combined = new Set([...anchorSelected, ...heuristicSelected]);
  const selectedIndexes =
    combined.size > 0
      ? [...combined].sort((left, right) => left - right)
      : tailIndexes(lines.length);
  const rendered = renderSelection(lines, selectedIndexes);
  const renderedBytes = Buffer.byteLength(rendered, "utf8");
  if (renderedBytes <= maxBytes) return { text: rendered, truncated: false };
  const { kept, droppedBytes, originalBytes } = truncateKeepingTail(rendered, maxBytes);
  const marker = `...[truncated: dropped first ${String(droppedBytes)}/${String(originalBytes)}b, tail kept]\n`;
  return { text: `${marker}${kept}`, truncated: true };
}
