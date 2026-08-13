import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { getuid } from "node:process";
import { isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

const maximumConfigBytes = 64 * 1024;

const canonicalAbsolutePath = z
  .string()
  .min(1)
  .refine((value) => {
    return isAbsolute(value) && resolve(value) === value && !/[\u0000-\u001f\u007f]/u.test(value);
  });

const exactVersion = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u);

export const quotaHostConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    claude: z
      .object({
        enabled: z.boolean(),
        statusSnapshotPath: canonicalAbsolutePath,
        expectedCliVersion: exactVersion,
        weeklyUsageLimitPercent: z.number().positive().max(100),
        terminalRemainingPercent: z.number().min(0).max(100),
        maxSampleAgeMs: z.number().int().positive(),
        activeRefresh: z
          .object({
            enabled: z.boolean(),
            workingDirectory: canonicalAbsolutePath,
          })
          .strict()
          .optional(),
      })
      .strict(),
    codex: z
      .object({
        diagnosticEnabled: z.boolean(),
        expectedCliVersion: exactVersion,
      })
      .strict(),
  })
  .strict();

export type QuotaHostConfig = z.infer<typeof quotaHostConfigSchema>;

export type QuotaHostConfigReadResult =
  | Readonly<{ ok: true; value: QuotaHostConfig }>
  | Readonly<{ ok: false; reason: "config_unavailable" }>;

export function defaultQuotaHostConfigPath(agentTeamHome: string): string {
  return join(agentTeamHome, "config", "quota.json");
}

export async function readQuotaHostConfig(
  filePath: string,
  expectedUid: number = getuid?.() ?? -1,
): Promise<QuotaHostConfigReadResult> {
  if (!isAbsolute(filePath) || resolve(filePath) !== filePath) {
    return Object.freeze({ ok: false, reason: "config_unavailable" });
  }
  try {
    const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.uid !== BigInt(expectedUid) ||
        (before.mode & 0o777n) !== 0o600n ||
        before.nlink !== 1n ||
        before.size <= 0n ||
        before.size > BigInt(maximumConfigBytes)
      ) {
        return Object.freeze({ ok: false, reason: "config_unavailable" });
      }
      const bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs
      ) {
        return Object.freeze({ ok: false, reason: "config_unavailable" });
      }
      const verified = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const canonical = await verified.stat({ bigint: true });
        if (canonical.dev !== before.dev || canonical.ino !== before.ino) {
          return Object.freeze({ ok: false, reason: "config_unavailable" });
        }
      } finally {
        await verified.close();
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const parsed: unknown = JSON.parse(text);
      const validated = quotaHostConfigSchema.safeParse(parsed);
      return validated.success
        ? Object.freeze({ ok: true, value: Object.freeze(validated.data) })
        : Object.freeze({ ok: false, reason: "config_unavailable" });
    } finally {
      await handle.close();
    }
  } catch {
    return Object.freeze({ ok: false, reason: "config_unavailable" });
  }
}
