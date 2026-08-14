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
 * path) originally shaped this schema with exactly one provider key (`claude`). E102-2 makes the
 * first additive change that note anticipated: an *optional* `gemini` key for the real visual-
 * review provider (`GeminiRunner`, src/adapters/providers/gemini/runner.ts). It is optional, not
 * required, on purpose -- a host with no `gemini` key can still run `code_review`-only work; only
 * `dual_review`/`visual_review` jobs need it, and the reviewer composition root
 * (reviewer-composition.ts) is what turns "no `gemini` key" into a fail-closed outcome for those
 * jobs specifically (never a silent fallback to the `claude` key for the visual role -- see that
 * file's own header). `adminPolicyPath` is required whenever `gemini` is present at all: it is
 * `GeminiRunnerOptions.adminPolicyPath`, and `GeminiRunner.start()` itself refuses to run
 * (`permission_denied`) unless this is an absolute path, so the schema enforces the same shape
 * up front rather than deferring an avoidable failure to run time.
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

const codexProviderConfigSchema = z
  .object({
    executable: z.string().trim().min(1).max(1024),
    models: z.array(z.string().trim().min(1).max(255)).min(1).max(20),
    /** Operator label only. Authentication identity still comes from the Codex App Server. */
    account: z.string().trim().min(1).max(255),
  })
  .strict();

/** S003/E102-2: the `gemini` provider config -- feeds `buildGeminiRunner` (gemini-factory.ts),
 * the same additive-schema shape `claudeProviderConfigSchema` already established (`executable`/
 * `models`/`account`), plus the one field Gemini's real adapter requires that Claude's does not:
 * `adminPolicyPath`, the supplemental read-only admin policy file
 * (`spikes/gemini/read-only-review.toml`'s production analogue) `GeminiRunner` passes via
 * `--admin-policy` to keep the visual-review role from ever writing to the worktree. Required to
 * be absolute here (not merely "non-empty") because `GeminiRunner.start()` treats a relative path
 * as `permission_denied` -- failing that shape at config-load time is strictly more useful than
 * failing it on the first real review run. */
const geminiProviderConfigSchema = z
  .object({
    executable: z.string().trim().min(1).max(1024),
    models: z.array(z.string().trim().min(1).max(255)).min(1).max(20),
    account: z.string().trim().min(1).max(255),
    adminPolicyPath: z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .refine(isAbsolute, "adminPolicyPath must be an absolute path"),
  })
  .strict();

export const dispatchProviderConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    codex: codexProviderConfigSchema,
    claude: claudeProviderConfigSchema,
    /** Optional on purpose -- see this file's own header. Absent means "no visual-review
     * provider is configured on this host," not "use Claude instead." */
    gemini: geminiProviderConfigSchema.optional(),
  })
  .strict();

export type DispatchProviderConfig = z.infer<typeof dispatchProviderConfigSchema>;
export type CodexProviderConfig = DispatchProviderConfig["codex"];
export type GeminiProviderConfig = NonNullable<DispatchProviderConfig["gemini"]>;

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
