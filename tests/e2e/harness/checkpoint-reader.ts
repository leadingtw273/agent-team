/**
 * E005: read-only checkpoint discovery over the existing F008 layout
 * (`${AGENT_TEAM_HOME}/.agent-team/state/checkpoints/<checkpointId>.yaml`, one file per
 * checkpoint -- see src/infrastructure/files/layout.ts's `state.checkpoints` and
 * src/adapters/checkpoint/local-yaml.ts's `LocalYamlCheckpointStore`/`serializeCheckpointYaml`,
 * which this file's own encoding deliberately mirrors).
 *
 * There is no existing checkpoint read-back/list port anywhere in src/** (only `persist`,
 * write-only, on `CheckpointPersistencePort`) -- and no existing production code writes/derives a
 * canonical mapping from "issueId + time window" to "which checkpoint id(s)". This harness lives
 * in tests/e2e/ specifically so it can do that discovery itself, entirely read-only, without
 * needing any src/** change: it scans the checkpoint directory (bounded, private, host-local
 * state -- never a network call) and extracts only the checkpoint schema's top-level *scalar*
 * fields (id/projectId/issueId/jobId/createdAt/reason) via a small line-based extractor matching
 * `serializeCheckpointYaml`'s own deterministic, restricted-subset-of-YAML output format --
 * deliberately not a general YAML parser, and deliberately not attempting to reconstruct the
 * full nested Checkpoint shape (worktree/tests/requirementSnapshot/...), which is unnecessary for
 * evidence *collection* (E007's later cross-source reconciliation is where deep field-by-field
 * checking belongs).
 */
import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../../src/domain/foundation/index.js";

export interface CheckpointTopLevelScalars {
  readonly id: string;
  readonly projectId: string;
  readonly issueId: string;
  readonly jobId: string;
  readonly createdAt: string;
  readonly reason: string;
}

const topLevelScalarLine = /^([a-zA-Z][a-zA-Z0-9]*): (.*)$/u;
const requiredKeys = ["id", "projectId", "issueId", "jobId", "createdAt", "reason"] as const;

function decodeScalar(rawValue: string): string {
  if (rawValue.startsWith('"')) {
    try {
      const decoded = JSON.parse(rawValue) as unknown;
      if (typeof decoded === "string") return decoded;
    } catch {
      // Fall through to the raw text below -- an unparseable quoted-looking value is simply not
      // one of this checkpoint's own scalar fields as far as this extractor is concerned.
    }
  }
  return rawValue;
}

/**
 * Extracts only the checkpoint schema's top-level scalar fields from a YAML document produced by
 * `serializeCheckpointYaml`. Returns `undefined` if any required field is missing (e.g. the file
 * is not actually a checkpoint document at all) -- this is a deliberately permissive scan (lines
 * this extractor does not recognize, such as nested object/array headers, are simply skipped),
 * never a full-schema validator.
 */
export function parseCheckpointTopLevelScalars(
  yamlText: string,
): CheckpointTopLevelScalars | undefined {
  const fields: Partial<Record<(typeof requiredKeys)[number], string>> = {};
  for (const line of yamlText.split("\n")) {
    if (line.length === 0 || line.startsWith(" ") || line.startsWith("\t")) continue;
    const match = topLevelScalarLine.exec(line);
    if (match === null) continue;
    const [, key, rawValue] = match;
    if (key === undefined || rawValue === undefined) continue;
    if ((requiredKeys as readonly string[]).includes(key)) {
      fields[key as (typeof requiredKeys)[number]] = decodeScalar(rawValue);
    }
  }
  if (requiredKeys.some((key) => fields[key] === undefined)) return undefined;
  return Object.freeze({
    id: fields.id ?? "",
    projectId: fields.projectId ?? "",
    issueId: fields.issueId ?? "",
    jobId: fields.jobId ?? "",
    createdAt: fields.createdAt ?? "",
    reason: fields.reason ?? "",
  });
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

async function readFileNoFollow(path: string): Promise<Result<string, DomainError>> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const buffer = await handle.readFile();
      return ok(buffer.toString("utf8"));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) return err(domainError("not_found"));
    return err(domainError("external_failure"));
  }
}

/**
 * Scans `directory` (the F008 checkpoint directory) for every `*.yaml` file, extracts each one's
 * top-level scalars, and returns only the checkpoints whose `issueId` matches and whose
 * `createdAt` falls inside `[from, to]` (inclusive; canonical ISO instants sort correctly as
 * plain strings). A missing directory is a genuine empty result (`ok([])`), not an error -- a
 * project that has never had a checkpoint written is a normal, real state, not a read failure.
 */
export async function readCheckpointsForIssue(
  directory: string,
  issueId: string,
  timeWindow: Readonly<{ from: string; to: string }>,
): Promise<Result<readonly CheckpointTopLevelScalars[], DomainError>> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) return ok(Object.freeze([]));
    return err(domainError("external_failure"));
  }

  const matches: CheckpointTopLevelScalars[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".yaml")).sort()) {
    const read = await readFileNoFollow(join(directory, entry));
    if (!read.ok) {
      if (read.error.code === "not_found") continue; // raced with a concurrent removal; skip
      return read;
    }
    const scalars = parseCheckpointTopLevelScalars(read.value);
    if (scalars === undefined) continue; // not a checkpoint document this extractor recognizes
    if (scalars.issueId !== issueId) continue;
    if (scalars.createdAt < timeWindow.from || scalars.createdAt > timeWindow.to) continue;
    matches.push(scalars);
  }
  return ok(Object.freeze(matches));
}
