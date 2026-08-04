import { resolve } from "node:path";

import { projectSchema, type Project } from "../../domain/project/index.js";
import type { ReadOptions } from "../ports/common.js";
import { TrustedProjectConfigLoader, type TrustedProjectLoadResult } from "./loader.js";

export interface ProjectRegistrySnapshot {
  readonly ready: readonly Extract<TrustedProjectLoadResult, { state: "ready" }>[];
  readonly rejected: readonly Extract<TrustedProjectLoadResult, { state: "rejected" }>[];
}

function conflictingIndexes(projects: readonly Project[]): ReadonlySet<number> {
  const conflicts = new Set<number>();
  const fields = [
    (project: Project) => project.id,
    (project: Project) => resolve(project.localRepositoryPath),
    (project: Project) => `${project.sourceControl.provider}:${project.sourceControl.repository}`,
  ];
  for (const select of fields) {
    const seen = new Map<string, number>();
    projects.forEach((project, index) => {
      const value = select(project);
      const previous = seen.get(value);
      if (previous === undefined) seen.set(value, index);
      else {
        conflicts.add(previous);
        conflicts.add(index);
      }
    });
  }
  return conflicts;
}

export class ProjectRegistry {
  constructor(readonly loader: TrustedProjectConfigLoader) {}

  async load(
    projectInputs: readonly Project[],
    options: ReadOptions = {},
  ): Promise<ProjectRegistrySnapshot> {
    const parsed = projectInputs.map((project) => projectSchema.safeParse(project));
    const valid = parsed.flatMap((result) => (result.success ? [result.data] : []));
    const conflicts = conflictingIndexes(valid);
    const loaded = await Promise.all(
      valid.map((project, index) =>
        conflicts.has(index)
          ? Promise.resolve(
              Object.freeze({
                state: "rejected" as const,
                project,
                reason: "registry_conflict" as const,
              }),
            )
          : this.loader.load(project, options),
      ),
    );
    const invalid = parsed
      .filter((result) => !result.success)
      .map(() =>
        Object.freeze({ state: "rejected" as const, reason: "invalid_registry_entry" as const }),
      );
    const entries = [...loaded, ...invalid];
    return Object.freeze({
      ready: Object.freeze(
        entries.filter(
          (entry): entry is Extract<TrustedProjectLoadResult, { state: "ready" }> =>
            entry.state === "ready",
        ),
      ),
      rejected: Object.freeze(
        entries.filter(
          (entry): entry is Extract<TrustedProjectLoadResult, { state: "rejected" }> =>
            entry.state === "rejected",
        ),
      ),
    });
  }
}
