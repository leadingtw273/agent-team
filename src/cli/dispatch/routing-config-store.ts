/**
 * C015a: host config loader for the dispatcher's `ModelRoutingConfig`. This is a single, global
 * (not per-project) file -- unlike the registration probe's per-project config -- because model
 * routing (which provider/model serves each `AgentRole`) is a host-wide policy, not a per-project
 * one. Reuses the existing `modelRoutingConfigSchema` (src/application/routing/model-routing.ts)
 * verbatim rather than defining a new schema; this module only adds the file-reading/size-
 * bounding/fail-closed envelope around it, mirroring `loadHostRegistrationProbeConfig`
 * (src/cli/registration/probe-config-store.ts) exactly.
 *
 * C015a scope note: this loader only validates the file's *shape* (schema-valid
 * `ModelRoutingConfig`) -- it does not stand up provider factories or verify the named
 * models/providers are actually reachable. That verification, and the provider adapters
 * themselves, are C015b's job.
 */
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import {
  modelRoutingConfigSchema,
  type ModelRoutingConfig,
} from "../../application/routing/index.js";

const maximumRoutingConfigFileBytes = 64 * 1024;

export function defaultDispatchRoutingConfigPath(agentTeamHome: string): string {
  return join(agentTeamHome, "config", "dispatch", "routing.json");
}

export type LoadHostDispatchRoutingConfigResult =
  | Readonly<{ ok: true; value: ModelRoutingConfig }>
  | Readonly<{ ok: false; reason: "missing_or_invalid" }>;

export async function loadHostDispatchRoutingConfig(
  filePath: string,
): Promise<LoadHostDispatchRoutingConfigResult> {
  if (!isAbsolute(filePath)) {
    return Object.freeze({ ok: false, reason: "missing_or_invalid" });
  }
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.size > maximumRoutingConfigFileBytes) {
      return Object.freeze({ ok: false, reason: "missing_or_invalid" });
    }
    const content = await readFile(filePath, "utf8");
    const json: unknown = JSON.parse(content);
    const parsed = modelRoutingConfigSchema.safeParse(json);
    if (!parsed.success) {
      return Object.freeze({ ok: false, reason: "missing_or_invalid" });
    }
    return Object.freeze({ ok: true, value: parsed.data });
  } catch {
    return Object.freeze({ ok: false, reason: "missing_or_invalid" });
  }
}
