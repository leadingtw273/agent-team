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

/**
 * O009f: optional host override for the CLI's own production poll defaults (see
 * `defaultProductionCiPoll`/`defaultProductionStatusPoll`/`defaultProductionProviderEventPoll` in
 * probe-composition.ts). Bounds are deliberately generous but finite: `maxAttempts` capped at 200
 * and `intervalMs` at 60s keeps any misconfiguration from hanging a `probe run` invocation for an
 * unreasonable wall-clock duration (200 * 60s = ~3.3h ceiling, an intentionally loose backstop,
 * not a recommended value) while still comfortably covering any legitimate CI/webhook latency a
 * host might need to tune for.
 */
const probeConfigPollOverrideSchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(200),
    intervalMs: z.number().int().min(0).max(60_000),
  })
  .strict();

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
    poll: z
      .object({
        ciPoll: probeConfigPollOverrideSchema.optional(),
        statusPoll: probeConfigPollOverrideSchema.optional(),
        providerEventPoll: probeConfigPollOverrideSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export interface RegistrationProbeConfigPollOverride {
  readonly maxAttempts: number;
  readonly intervalMs: number;
}

export interface RegistrationProbeHostConfig {
  readonly linearWorkflowStateId: string;
  readonly gitRemote: string;
  readonly webhookBaseUrls: Readonly<{ github: string; linear: string }>;
  readonly poll?: Readonly<{
    ciPoll?: RegistrationProbeConfigPollOverride;
    statusPoll?: RegistrationProbeConfigPollOverride;
    providerEventPoll?: RegistrationProbeConfigPollOverride;
  }>;
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
        ...(parsed.data.poll === undefined
          ? {}
          : {
              poll: Object.freeze({
                ...(parsed.data.poll.ciPoll === undefined
                  ? {}
                  : { ciPoll: Object.freeze({ ...parsed.data.poll.ciPoll }) }),
                ...(parsed.data.poll.statusPoll === undefined
                  ? {}
                  : { statusPoll: Object.freeze({ ...parsed.data.poll.statusPoll }) }),
                ...(parsed.data.poll.providerEventPoll === undefined
                  ? {}
                  : {
                      providerEventPoll: Object.freeze({ ...parsed.data.poll.providerEventPoll }),
                    }),
              }),
            }),
      }),
    });
  } catch {
    return Object.freeze({ ok: false, reason: "missing_or_invalid" });
  }
}
