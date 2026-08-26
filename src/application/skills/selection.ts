import type { AgentRole } from "../../domain/project/index.js";
import type {
  JobSkillSelection,
  ProjectSkillPolicy,
  SkillCatalog,
  SkillCatalogEntry,
  SkillPublicReason,
  SkillRequirement,
} from "./model.js";

export type SkillSelectionOutcome =
  | Readonly<{
      state: "admitted";
      selected: readonly Readonly<SkillCatalogEntry & { requirement: SkillRequirement }>[];
      omitted: readonly Readonly<{ name: string; reason: SkillPublicReason }>[];
    }>
  | Readonly<{
      state: "blocked";
      skillName: string;
      reason: Extract<SkillPublicReason, "missing" | "not_allowed">;
    }>;

export function resolveSkillSelection(
  input: Readonly<{
    catalog: SkillCatalog;
    policy: ProjectSkillPolicy;
    role: AgentRole;
    explicit: readonly JobSkillSelection[];
  }>,
): SkillSelectionOutcome {
  const allowed = new Set(input.policy.allowlist);
  const catalog = new Map(input.catalog.skills.map((entry) => [entry.name, entry]));
  const requirements = new Map<string, SkillRequirement>();
  for (const name of input.policy.roleDefaults?.[input.role] ?? []) {
    if (allowed.has(name)) requirements.set(name, "optional");
  }
  for (const selection of input.explicit) {
    const current = requirements.get(selection.name);
    if (current !== "required" || selection.requirement === "required") {
      requirements.set(selection.name, selection.requirement);
    }
  }

  const selected: Readonly<SkillCatalogEntry & { requirement: SkillRequirement }>[] = [];
  const omitted: Readonly<{ name: string; reason: SkillPublicReason }>[] = [];
  for (const [name, requirement] of [...requirements.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    if (!allowed.has(name)) {
      if (requirement === "required")
        return { state: "blocked", skillName: name, reason: "not_allowed" };
      omitted.push(Object.freeze({ name, reason: "not_allowed" }));
      continue;
    }
    const entry = catalog.get(name);
    if (entry === undefined) {
      if (requirement === "required")
        return { state: "blocked", skillName: name, reason: "missing" };
      omitted.push(Object.freeze({ name, reason: "missing" }));
      continue;
    }
    selected.push(Object.freeze({ ...entry, requirement }));
  }
  return Object.freeze({
    state: "admitted",
    selected: Object.freeze(selected),
    omitted: Object.freeze(omitted),
  });
}
