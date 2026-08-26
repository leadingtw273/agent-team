import { createHash } from "node:crypto";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { constants as fsConstants } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import { err, ok } from "../../domain/foundation/index.js";
import {
  computeSkillTreeIntegrity,
  jobSkillSnapshotSchema,
  resolveSkillSelection,
  skillCatalogSchema,
  skillRuntimeFailure,
  verifySkillReferences,
  type JobSkillSnapshot,
  type SkillRuntimePort,
} from "../../application/skills/index.js";
import type { SkillKnowledgeAttachment } from "../../application/ports/index.js";

export interface FileSkillRuntimeOptions {
  readonly skillsRoot: string;
}

async function readRegularFileContained(
  root: string,
  relativePath: string,
): Promise<Readonly<{ bytes: Buffer; sha256: string }> | undefined> {
  const canonicalRoot = await realpath(root);
  const candidate = join(root, relativePath);
  const handle = await open(candidate, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return undefined;
    const canonical = await realpath(candidate);
    if (!canonical.startsWith(`${canonicalRoot}${sep}`)) return undefined;
    const bytes = await handle.readFile();
    return Object.freeze({
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  } finally {
    await handle.close();
  }
}

export class FileSkillRuntime implements SkillRuntimePort {
  readonly #skillsRoot: string;

  constructor(options: FileSkillRuntimeOptions) {
    this.#skillsRoot = options.skillsRoot;
  }

  async #catalog(catalogId: string | undefined, catalogDigest: string | undefined) {
    if (!isAbsolute(this.#skillsRoot) || catalogId === undefined || catalogDigest === undefined) {
      return undefined;
    }
    try {
      const provenance = join(this.#skillsRoot, ".provenance");
      const provenanceStat = await lstat(provenance);
      if (!provenanceStat.isDirectory() || provenanceStat.isSymbolicLink()) return undefined;
      const canonicalProvenance = await realpath(provenance);
      const path = join(provenance, `${catalogId}.json`);
      const pathStat = await lstat(path);
      if (!pathStat.isFile() || pathStat.isSymbolicLink()) return undefined;
      const canonicalPath = await realpath(path);
      if (!canonicalPath.startsWith(`${canonicalProvenance}${sep}`)) return undefined;
      const bytes = await readFile(path);
      if (createHash("sha256").update(bytes).digest("hex") !== catalogDigest) return undefined;
      return skillCatalogSchema.safeParse(JSON.parse(bytes.toString("utf8")) as unknown);
    } catch {
      return undefined;
    }
  }

  async #integrityMatches(skill: JobSkillSnapshot["skills"][number]): Promise<boolean> {
    const root = join(this.#skillsRoot, skill.name);
    const integrity = await computeSkillTreeIntegrity(root);
    if (
      !integrity.ok ||
      integrity.value.treeDigest !== skill.installedTreeDigest ||
      !isDeepStrictEqual(integrity.value.fileDigests, skill.fileDigests)
    ) {
      return false;
    }
    const references = await verifySkillReferences({
      root,
      expectedFileDigests: skill.fileDigests,
      allowedReferences: skill.allowedReferences,
    });
    return references.ok;
  }

  async admit(input: Parameters<SkillRuntimePort["admit"]>[0]) {
    const catalog = await this.#catalog(input.policy.catalogId, input.policy.catalogDigest);
    if (!catalog?.success) {
      return err(skillRuntimeFailure("missing", input.policy.allowlist[0]));
    }
    const resolved = resolveSkillSelection({
      catalog: catalog.data,
      policy: input.policy,
      role: input.role,
      explicit: input.explicit,
    });
    if (resolved.state === "blocked") {
      return err(skillRuntimeFailure(resolved.reason, resolved.skillName));
    }

    const selected: (typeof resolved.selected)[number][] = [];
    const omitted = [...resolved.omitted];
    for (const skill of resolved.selected) {
      if (await this.#integrityMatches({ ...skill })) {
        selected.push(skill);
        continue;
      }
      if (skill.requirement === "required") {
        return err(skillRuntimeFailure("content_changed", skill.name));
      }
      omitted.push(Object.freeze({ name: skill.name, reason: "content_changed" as const }));
    }

    const snapshot = jobSkillSnapshotSchema.safeParse({
      schemaVersion: 1,
      jobId: input.job.id,
      projectId: input.job.projectId,
      skills: selected,
      omitted,
    });
    return snapshot.success
      ? ok(Object.freeze(snapshot.data))
      : err(skillRuntimeFailure("content_changed"));
  }

  async materialize(snapshot: JobSkillSnapshot) {
    const parsed = jobSkillSnapshotSchema.safeParse(snapshot);
    if (!parsed.success) return err(skillRuntimeFailure("content_changed"));
    const attachments: SkillKnowledgeAttachment[] = [];
    try {
      for (const skill of parsed.data.skills) {
        if (!(await this.#integrityMatches(skill))) {
          return err(skillRuntimeFailure("content_changed", skill.name));
        }
        const paths = [
          "SKILL.md",
          ...(skill.mode === "rubric_only" ? skill.allowedReferences : []),
        ];
        for (const relativePath of paths) {
          const file = await readRegularFileContained(
            join(this.#skillsRoot, skill.name),
            relativePath,
          );
          if (file === undefined || file.sha256 !== skill.fileDigests[relativePath]) {
            return err(skillRuntimeFailure("content_changed", skill.name));
          }
          attachments.push(
            Object.freeze({
              skillName: skill.name,
              displayName: skill.displayName,
              mode: skill.mode,
              source: `skill:${skill.name}/${relativePath}`,
              mediaType: "text/markdown" as const,
              content: file.bytes.toString("utf8"),
              sha256: file.sha256,
            }),
          );
        }
      }
      return ok(Object.freeze(attachments));
    } catch {
      return err(skillRuntimeFailure("content_changed"));
    }
  }
}
