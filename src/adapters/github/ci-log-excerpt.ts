/**
 * C017: pure, I/O-free extraction of "failure key lines" out of a raw GitHub Actions job log
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
 * - "Key lines" is a heuristic, not a parser: this has no notion of eslint/tsc/vitest-specific
 *   output grammar (each has its own, and a new CI tool arrives eventually anyway) -- it just
 *   keeps lines that look failure-relevant (`error`, `fail`, `exception`, or the `✖`/`✗` glyphs
 *   several linters use) plus a little surrounding context, in original order. When *no* line
 *   matches (a job can still exit non-zero -- and therefore fail its check run -- without ever
 *   printing one of those words), this falls back to the log's tail rather than returning nothing.
 * - GitHub Actions prepends a `YYYY-MM-DDTHH:MM:SS.ffffffffZ ` timestamp to every log line; that
 *   prefix is pure noise for a repair model and is stripped before matching/output.
 */

export const defaultCiFailureLogExcerptMaxBytes = 4_096;

/** Deliberately generous relative to `maxBytes` (truncation still applies) -- keeps the fallback
 * cheap even for a very long "everything printed 'OK'" log. */
const fallbackTailLines = 40;
/** Lines kept around a matched key line: this many before it, this many after. */
const contextLinesBefore = 1;
const contextLinesAfter = 2;

const timestampPrefixPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/u;
const keyLinePattern = /error|fail|exception|✖|✗/iu;
const truncationMarkerPrefix = "\n...[truncated:";

function stripTimestamp(line: string): string {
  return line.replace(timestampPrefixPattern, "");
}

function keyLineIndexes(lines: readonly string[]): number[] {
  const indexes = new Set<number>();
  lines.forEach((line, index) => {
    if (!keyLinePattern.test(line)) return;
    for (let offset = -contextLinesBefore; offset <= contextLinesAfter; offset += 1) {
      const target = index + offset;
      if (target >= 0 && target < lines.length) indexes.add(target);
    }
  });
  return [...indexes].sort((left, right) => left - right);
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

function truncate(text: string, maxBytes: number): string {
  const bound = Math.max(0, maxBytes);
  const originalBytes = Buffer.byteLength(text, "utf8");
  const kept = Buffer.from(text, "utf8").subarray(0, bound).toString("utf8");
  return `${kept}${truncationMarkerPrefix} showing first ${String(bound)} of ${String(originalBytes)} bytes]`;
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
  const lines = logText.split(/\r?\n/u).map(stripTimestamp);
  const matched = keyLineIndexes(lines);
  const selected = matched.length > 0 ? matched : tailIndexes(lines.length);
  const rendered = renderSelection(lines, selected);
  const renderedBytes = Buffer.byteLength(rendered, "utf8");
  if (renderedBytes <= maxBytes) return { text: rendered, truncated: false };
  return { text: truncate(rendered, maxBytes), truncated: true };
}
