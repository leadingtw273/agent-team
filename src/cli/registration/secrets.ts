import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

/**
 * O009 decision #5: probe webhook secrets come from
 * `${AGENT_TEAM_HOME}/secrets/{github,linear}-webhook-secret`, and must be exactly 0600. This
 * mirrors the read-security properties of the existing local webhook ingest handler's own
 * `readSecret`/`readNoFollow` (src/cli/ingest/github.ts) -- `O_NOFOLLOW`, a byte-size cap, an
 * exact-mode check, one stripped trailing newline -- duplicated here (rather than imported)
 * specifically so this task never has to touch that P0 security module.
 */

const maximumSecretBytes = 64 * 1024;

export type ReadSecretFileResult =
  | Readonly<{ ok: true; value: Uint8Array }>
  | Readonly<{ ok: false; reason: "missing_or_insecure" }>;

function stripTerminalNewline(bytes: Uint8Array): Uint8Array {
  let end = bytes.byteLength;
  if (end > 0 && bytes[end - 1] === 0x0a) end -= 1;
  if (end > 0 && bytes[end - 1] === 0x0d) end -= 1;
  return bytes.slice(0, end);
}

/**
 * Reads a host-local secret file. Fails closed -- with the *same* reason code -- for every
 * unsafe or absent condition (missing, symlinked, wrong mode, empty, oversized, not a regular
 * file, relative path) so a caller cannot use the failure reason as an existence oracle.
 */
export async function readSecretFile(filePath: string): Promise<ReadSecretFileResult> {
  if (!isAbsolute(filePath)) {
    return Object.freeze({ ok: false, reason: "missing_or_insecure" });
  }
  try {
    const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > maximumSecretBytes) {
        return Object.freeze({ ok: false, reason: "missing_or_insecure" });
      }
      if ((stat.mode & 0o777) !== 0o600) {
        return Object.freeze({ ok: false, reason: "missing_or_insecure" });
      }
      const secret = stripTerminalNewline(Uint8Array.from(await handle.readFile()));
      if (secret.byteLength === 0) {
        return Object.freeze({ ok: false, reason: "missing_or_insecure" });
      }
      return Object.freeze({ ok: true, value: secret });
    } finally {
      await handle.close();
    }
  } catch {
    return Object.freeze({ ok: false, reason: "missing_or_insecure" });
  }
}

export type ReadLinearApiKeyResult =
  Readonly<{ ok: true; value: string }> | Readonly<{ ok: false; reason: "missing" }>;

/**
 * `LinearGraphqlTransport` needs an API key; no production code path has ever sourced one
 * before this task (grep confirms zero non-test constructors of `LinearGraphqlTransport`
 * anywhere in the repo). `LINEAR_API_KEY` is the reserved name -- it is already the exact
 * credential-shaped env var the O006 integration test clears before every run
 * (tests/integration/registration-proactive-probe.test.ts) to guarantee zero live leakage.
 */
export function readLinearApiKey(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ReadLinearApiKeyResult {
  const raw = environment["LINEAR_API_KEY"];
  const trimmed = raw?.trim() ?? "";
  return trimmed.length === 0
    ? Object.freeze({ ok: false, reason: "missing" })
    : Object.freeze({ ok: true, value: trimmed });
}
