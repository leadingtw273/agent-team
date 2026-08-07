/**
 * C015b: host config loader for the dispatcher's provider setup -- a single, global (not
 * per-project) file, mirroring `routing-config-store.ts`'s own file-reading/size-bounding/
 * fail-closed envelope exactly. Unlike `routing-config-store.ts` (which reuses an existing
 * application-layer schema), there is no pre-existing schema for "which Claude executable, which
 * models, which account" -- this is pure CLI-composition plumbing (it only ever feeds a
 * `ClaudeRunner` construction, src/adapters/providers/claude/runner.ts; no application-layer pure
 * function consumes it), so the schema is defined here rather than under `src/application`.
 *
 * `leadi 已裁決單 Claude provider 最小路徑` (decision layer: single-Claude-provider minimal
 * path) -- this schema therefore has exactly one provider key (`claude`), not a generic
 * provider-map. Adding `codex`/`gemini` later is an additive schema change, not a rewrite.
 */
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { z } from "zod";

const maximumProviderConfigFileBytes = 64 * 1024;

const claudeProviderConfigSchema = z
  .object({
    /** Absolute or bare-command executable path/name (mirrors `ClaudeRunnerOptions.executable`,
     * src/adapters/providers/claude/runner.ts) -- not validated for existence here (that is a
     * live capability check, not a config-shape check; see the C015b routeObservations
     * producer). */
    executable: z.string().trim().min(1).max(1024),
    models: z.array(z.string().trim().min(1).max(255)).min(1).max(20),
    /** An operator-chosen label identifying which Claude account/subscription this host is
     * configured against (e.g. for future quota/observation bookkeeping) -- never a secret
     * itself, and never logged verbatim without this same bound applied. */
    account: z.string().trim().min(1).max(255),
  })
  .strict();

export const dispatchProviderConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    claude: claudeProviderConfigSchema,
  })
  .strict();

export type DispatchProviderConfig = z.infer<typeof dispatchProviderConfigSchema>;

export function defaultDispatchProviderConfigPath(agentTeamHome: string): string {
  return join(agentTeamHome, "config", "dispatch", "providers.json");
}

export type LoadHostDispatchProviderConfigResult =
  | Readonly<{ ok: true; value: DispatchProviderConfig }>
  | Readonly<{ ok: false; reason: "missing_or_invalid" }>;

export async function loadHostDispatchProviderConfig(
  filePath: string,
): Promise<LoadHostDispatchProviderConfigResult> {
  if (!isAbsolute(filePath)) {
    return Object.freeze({ ok: false, reason: "missing_or_invalid" });
  }
  try {
    const fileStat = await stat(filePath);
    if (
      !fileStat.isFile() ||
      fileStat.size <= 0 ||
      fileStat.size > maximumProviderConfigFileBytes
    ) {
      return Object.freeze({ ok: false, reason: "missing_or_invalid" });
    }
    const content = await readFile(filePath, "utf8");
    const json: unknown = JSON.parse(content);
    const parsed = dispatchProviderConfigSchema.safeParse(json);
    if (!parsed.success) {
      return Object.freeze({ ok: false, reason: "missing_or_invalid" });
    }
    return Object.freeze({ ok: true, value: parsed.data });
  } catch {
    return Object.freeze({ ok: false, reason: "missing_or_invalid" });
  }
}
