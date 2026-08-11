import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
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
const maximumRegistrationDrafts = 10_000;
const noRegistrationDrafts = Object.freeze([] as const);
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
 * The project read model discovers registration candidates exclusively from this directory. It
 * deliberately returns only validated drafts and a count of rejected files: callers must never
 * surface a rejected file name, path, parse diagnostic, or its raw contents.
 */
export type ListHostRegistrationSetupDraftsResult =
  | Readonly<{
      state: "available";
      drafts: readonly RegistrationSetupDraft[];
      rejectedDraftCount: number;
    }>
  | Readonly<{
      state: "unavailable";
      drafts: readonly [];
      rejectedDraftCount: 0;
    }>;

async function readHostRegistrationSetupDraft(
  filePath: string,
): Promise<RegistrationSetupDraft | undefined> {
  try {
    // `O_NOFOLLOW` keeps discovery from opening a file under `secrets/` (or elsewhere on the
    // host) through a draft-file symlink.
    const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const fileStat = await handle.stat();
      if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.size > maximumDraftFileBytes) {
        return undefined;
      }
      const content = await handle.readFile("utf8");
      const json: unknown = JSON.parse(content);
      const parsed = draftEnvelopeSchema.safeParse(json);
      return parsed.success
        ? Object.freeze({
            project: parsed.data.project,
            config: parsed.data.config,
            linearAuditIssueId: parsed.data.linearAuditIssueId,
          })
        : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

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
  const draft = await readHostRegistrationSetupDraft(filePath);
  if (draft?.project.id !== expectedProjectId) {
    return Object.freeze({ ok: false, reason: "missing_or_invalid" });
  }
  return Object.freeze({ ok: true, value: draft });
}

/**
 * Scans exactly `${AGENT_TEAM_HOME}/config/registration/*.draft.json`, in lexical order. A
 * missing directory is an empty inventory; an unreadable directory is not silently treated as
 * empty because that would turn unknown registered projects into a false-green zero-project list.
 */
export async function listHostRegistrationSetupDrafts(
  agentTeamHome: string,
): Promise<ListHostRegistrationSetupDraftsResult> {
  if (!isAbsolute(agentTeamHome)) {
    return Object.freeze({
      state: "unavailable",
      drafts: noRegistrationDrafts,
      rejectedDraftCount: 0,
    });
  }
  const directory = join(agentTeamHome, "config", "registration");
  let names: readonly string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return Object.freeze({
        state: "available",
        drafts: noRegistrationDrafts,
        rejectedDraftCount: 0,
      });
    }
    return Object.freeze({
      state: "unavailable",
      drafts: noRegistrationDrafts,
      rejectedDraftCount: 0,
    });
  }

  const candidates = names.filter((name) => name.endsWith(".draft.json")).sort();
  if (candidates.length > maximumRegistrationDrafts) {
    return Object.freeze({
      state: "unavailable",
      drafts: noRegistrationDrafts,
      rejectedDraftCount: 0,
    });
  }

  const drafts: RegistrationSetupDraft[] = [];
  let rejectedDraftCount = 0;
  for (const name of candidates) {
    const draft = await readHostRegistrationSetupDraft(join(directory, name));
    if (draft === undefined || name !== `${draft.project.id}.draft.json`) rejectedDraftCount += 1;
    else drafts.push(draft);
  }

  return Object.freeze({
    state: "available",
    drafts: Object.freeze(drafts),
    rejectedDraftCount,
  });
}
