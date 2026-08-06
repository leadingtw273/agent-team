import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { z } from "zod";

/**
 * O009 decision #5: probe's webhook base URLs come from a host-local config file (secrets
 * themselves are read separately by `readSecretFile`). The packet pins the two secret file paths
 * exactly, but not a filename for this remaining host config; this module defines
 * `${AGENT_TEAM_HOME}/config/registration/<projectId>.probe.json`, validated the same way the
 * draft-store loader validates its own file (strict schema, extra fields rejected).
 *
 * URL shape/loopback-or-HTTPS legality is deliberately *not* re-validated here: the O006 engine
 * itself already fails closed on an invalid `webhookBaseUrls` entry before any external mutation
 * (`allowedRuntimeBaseUrl` in proactive-probe.ts, proven fail-closed by its own integration
 * test), so duplicating that check here would only be redundant guessing at the exact same rule.
 */

const maximumProbeConfigFileBytes = 64 * 1024;

const probeConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    linearWorkflowStateId: z.string().trim().min(1).max(255),
    gitRemote: z.string().trim().min(1).max(255),
    webhookBaseUrls: z
      .object({
        github: z.string().trim().min(1).max(2_048),
        linear: z.string().trim().min(1).max(2_048),
      })
      .strict(),
  })
  .strict();

export interface RegistrationProbeHostConfig {
  readonly linearWorkflowStateId: string;
  readonly gitRemote: string;
  readonly webhookBaseUrls: Readonly<{ github: string; linear: string }>;
}

export function defaultRegistrationProbeConfigPath(
  agentTeamHome: string,
  projectId: string,
): string {
  return join(agentTeamHome, "config", "registration", `${projectId}.probe.json`);
}

export type LoadHostRegistrationProbeConfigResult =
  | Readonly<{ ok: true; value: RegistrationProbeHostConfig }>
  | Readonly<{ ok: false; reason: "missing_or_invalid" }>;

export async function loadHostRegistrationProbeConfig(
  filePath: string,
): Promise<LoadHostRegistrationProbeConfigResult> {
  if (!isAbsolute(filePath)) {
    return Object.freeze({ ok: false, reason: "missing_or_invalid" });
  }
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.size > maximumProbeConfigFileBytes) {
      return Object.freeze({ ok: false, reason: "missing_or_invalid" });
    }
    const content = await readFile(filePath, "utf8");
    const json: unknown = JSON.parse(content);
    const parsed = probeConfigSchema.safeParse(json);
    if (!parsed.success) {
      return Object.freeze({ ok: false, reason: "missing_or_invalid" });
    }
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        linearWorkflowStateId: parsed.data.linearWorkflowStateId,
        gitRemote: parsed.data.gitRemote,
        webhookBaseUrls: Object.freeze({ ...parsed.data.webhookBaseUrls }),
      }),
    });
  } catch {
    return Object.freeze({ ok: false, reason: "missing_or_invalid" });
  }
}
