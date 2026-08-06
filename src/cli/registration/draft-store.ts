import { stat, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { z } from "zod";

import { trustedProjectConfigSchema } from "../../application/projects/index.js";
import type { RegistrationSetupDraft } from "../../application/registration/index.js";
import { projectSchema } from "../../domain/project/index.js";

/**
 * O009 decision #4: the Setup draft comes exclusively from a host-local JSON file. This module
 * only reads and validates it; the returned `RegistrationSetupDraft` is handed to the existing
 * `HostRegistrationSetupDraftSource` (src/adapters/registration/setup-draft-source.ts), which
 * re-validates it again on every read from its own in-memory snapshot -- this loader's own
 * top-level `.strict()` envelope schema exists specifically to reject extra top-level fields
 * (e.g. an accidental secret leaking into the file) *before* that point, since
 * `HostRegistrationSetupDraftSource` itself only checks `project`/`config`/`linearAuditIssueId`
 * individually and never rejects an unrelated sibling key.
 */

const maximumDraftFileBytes = 2 * 1024 * 1024;
const linearAuditIssueIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:@+-]{0,220}$/u);

const draftEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    project: projectSchema,
    config: trustedProjectConfigSchema,
    linearAuditIssueId: linearAuditIssueIdSchema,
  })
  .strict();

export function defaultRegistrationDraftPath(agentTeamHome: string, projectId: string): string {
  return join(agentTeamHome, "config", "registration", `${projectId}.draft.json`);
}

export type LoadHostRegistrationSetupDraftResult =
  | Readonly<{ ok: true; value: RegistrationSetupDraft }>
  | Readonly<{ ok: false; reason: "missing_or_invalid" }>;

/**
 * Reads, size-bounds, JSON-parses, and schema-validates the host draft file, and confirms the
 * embedded `project.id` matches the `--project` the operator actually asked for (defense against
 * pointing `--draft` at a stale or mismatched file). Every failure collapses to the same
 * `missing_or_invalid` reason -- this is a local file the operator themselves controls, so unlike
 * the secret reader there is no oracle concern, but a single fail-closed reason keeps the CLI's
 * exit-3 messaging uniform and avoids leaking parse-error detail that could embed file content.
 */
export async function loadHostRegistrationSetupDraft(
  filePath: string,
  expectedProjectId: string,
): Promise<LoadHostRegistrationSetupDraftResult> {
  if (!isAbsolute(filePath)) {
    return Object.freeze({ ok: false, reason: "missing_or_invalid" });
  }
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.size > maximumDraftFileBytes) {
      return Object.freeze({ ok: false, reason: "missing_or_invalid" });
    }
    const content = await readFile(filePath, "utf8");
    const json: unknown = JSON.parse(content);
    const parsed = draftEnvelopeSchema.safeParse(json);
    if (!parsed.success || parsed.data.project.id !== expectedProjectId) {
      return Object.freeze({ ok: false, reason: "missing_or_invalid" });
    }
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        project: parsed.data.project,
        config: parsed.data.config,
        linearAuditIssueId: parsed.data.linearAuditIssueId,
      }),
    });
  } catch {
    return Object.freeze({ ok: false, reason: "missing_or_invalid" });
  }
}
