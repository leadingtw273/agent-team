/**
 * O009 decision #3: `setup start`, `setup approve`, and `probe run` all require a stdin
 * confirmation phrase, compared *exactly* (character-for-character) -- a typo must be zero side
 * effect. `setup start`/`setup approve` reuse the engine's own two existing phrases
 * (`registrationSetupPreviewConfirmationPhrase` / `registrationSetupFinalApprovalPhrase` in
 * setup-controller.ts); `probe run` has no such field in the O006 engine at all (its human-trigger
 * proof is the `RegistrationProbeAuthority` object, not a string), so this CLI defines and owns
 * its own fixed phrase for that gate.
 */

export const registrationProbeRunConfirmationPhrase = "RUN FULL REVALIDATION" as const;

export type StdinConfirmationResult =
  | Readonly<{ ok: true; value: string }>
  | Readonly<{ ok: false; reason: "too_large" | "invalid_encoding" }>;

export interface ReadStdinConfirmationOptions {
  readonly maximumBytes?: number;
}

const defaultMaximumBytes = 4_096;

/** Strips exactly one trailing line terminator (LF, or CRLF) -- never more. */
function stripSingleTrailingNewline(bytes: Uint8Array): Uint8Array {
  let end = bytes.byteLength;
  if (end > 0 && bytes[end - 1] === 0x0a) end -= 1;
  if (end > 0 && bytes[end - 1] === 0x0d) end -= 1;
  return bytes.slice(0, end);
}

/**
 * Reads a confirmation phrase from an async byte/string stream (defaults to `process.stdin`,
 * which works whether stdin is an interactive TTY or a non-TTY pipe -- decision #3 explicitly
 * allows piped input for tests). Strips exactly one trailing OS line terminator so a typical
 * `echo "PHRASE" | agent-team ...` invocation round-trips to the literal phrase; does *not* trim
 * any other whitespace, so a stray leading/trailing space or case difference is preserved and
 * therefore still fails an exact-match comparison by the caller.
 */
export async function readStdinConfirmation(
  stdin: AsyncIterable<Uint8Array | string> = process.stdin,
  options: ReadStdinConfirmationOptions = {},
): Promise<StdinConfirmationResult> {
  const maximumBytes = options.maximumBytes ?? defaultMaximumBytes;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stdin) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maximumBytes) return Object.freeze({ ok: false, reason: "too_large" });
    chunks.push(bytes);
  }
  const raw = Uint8Array.from(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  const stripped = stripSingleTrailingNewline(raw);
  try {
    return Object.freeze({
      ok: true,
      value: new TextDecoder("utf-8", { fatal: true }).decode(stripped),
    });
  } catch {
    return Object.freeze({ ok: false, reason: "invalid_encoding" });
  }
}
